import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const session=(await db.query(`
    select ucs.session_id,ucs.subsidiary_id,u.email,auth_user.id auth_id
    from user_company_sessions ucs
    join user_role_sessions urs using(session_id,user_id)
    join roles role using(role_id)
    join users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    where lower(role.role_name)in('administrador','administrator','admin')
      and u.is_active
    order by ucs.selected_at desc limit 1
  `)).rows[0];
  assert.ok(session,'Se requiere una sesión administrativa activa para la prueba.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
    sub:session.auth_id,email:session.email,session_id:session.session_id,role:'authenticated'
  })]);

  const candidate=(await db.query(`
    with sources as(
      select journal.journal_id source_id,line.customer_id,journal.subsidiary_id,journal.pending_balance_local balance
      from journal
      join lateral(
        select customer_id from journal_line
        where journal_id=journal.journal_id and customer_id is not null
        order by journal_line_id limit 1
      )line on true
      where journal.subsidiary_id=$1 and journal.status='CONTABILIZADO'
        and journal.reversal_status in('PENDIENTE','REVERSADO_PARCIAL')
        and journal.pending_balance_local>.01
        and(journal.journal_number like'ASI_PEN-%'or journal.journal_type='Asientos Pendientes de Facturar')
      union all
      select -item.id,item.customer_id,item.subsidiary_id,item.balance_local
      from opening_pending_invoice_items item
      join opening_balance_runs run on run.id=item.run_id and run.status='POSTED'
      where item.subsidiary_id=$1 and item.is_active
        and item.reversal_status in('PENDIENTE','REVERSADO_PARCIAL')and item.balance_local>.01
    )
    select source.source_id,source.balance,invoice.invoice_id,invoice.invoice_date,invoice.total_amount,
      coalesce((select sum(line.amount)from sales_invoice_line line where line.invoice_id=invoice.invoice_id),
        greatest(invoice.total_amount-coalesce((select sum(line.tax_amount)from sales_invoice_line line where line.invoice_id=invoice.invoice_id),0),0))subtotal
    from sources source
    join invoice on invoice.subsidiary_id=source.subsidiary_id and invoice.customer_id=source.customer_id
    where coalesce((select sum(line.amount)from sales_invoice_line line where line.invoice_id=invoice.invoice_id),invoice.total_amount)>.01
    order by invoice.invoice_date desc,source.source_id limit 1
  `,[session.subsidiary_id])).rows[0];
  assert.ok(candidate,'Se requiere un pendiente abierto y una factura del mismo cliente para la prueba.');

  const options=(await db.query(
    'select pending_invoice_reversal_options($1,$2::date)value',
    [candidate.source_id,candidate.invoice_date]
  )).rows[0].value;
  const invoice=options.invoices.find(item=>String(item.id)===String(candidate.invoice_id));
  assert.ok(invoice,'La factura candidata debe estar disponible en el mes de la reversión.');
  assert.equal(Number(invoice.subtotal),Number(candidate.subtotal));
  assert.equal(Number(invoice.available),Math.max(Number(invoice.subtotal)-Number(invoice.applied),0));

  const journalCount=Number((await db.query('select count(*) value from journal')).rows[0].value);
  await db.query('savepoint over_invoice_subtotal');
  await assert.rejects(
    db.query('select reverse_pending_invoice_journal($1,$2::jsonb)',[
      candidate.source_id,
      JSON.stringify({
        reversalDate:candidate.invoice_date,
        amount:Number(candidate.subtotal)+1,
        type:'FACTURACION',invoiceId:candidate.invoice_id
      })
    ]),
    /supera el subtotal de la factura sin impuestos/
  );
  await db.query('rollback to savepoint over_invoice_subtotal');
  assert.equal(Number((await db.query('select count(*) value from journal')).rows[0].value),journalCount);

  console.log(JSON.stringify({
    optionsExposeSubtotal:true,
    availableTracksPriorUse:true,
    overSubtotalBlocked:true,
    noJournalCreated:true,
    rollback:true
  }));
}finally{
  await db.query('rollback').catch(()=>{});
  await db.end();
}
