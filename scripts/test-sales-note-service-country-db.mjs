import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];
const countries=rows=>rows.map(row=>String(row.service_country_id));

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  const installed=await one(`select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_country_id')
    and position('save_sales_note_before_service_country_fix' in pg_get_functiondef('public.save_sales_note(text,jsonb,bigint)'::regprocedure))>0 value`);
  if(!installed.value){
    await db.query(await readFile(
      new URL('../supabase/migrations/20261001120000_add_sales_note_service_country.sql',import.meta.url),'utf8'
    ));
  }
  assert.equal((await one('select count(*)::int value from public.sales_note_line where service_country_id is null')).value,0);

  const context=await one(`select distinct u.email,session.session_id,auth_user.id sub,session.subsidiary_id
    from public.user_company_sessions session
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    where(
      select count(distinct permission.code)
      from public.user_roles ur join public.role_permissions rp using(role_id)
      join public.permissions permission using(permission_id)
      where ur.user_id=u.user_id and permission.code in(
        'sales:invoice:create','sales:invoice:update','sales:note:create','sales:note:update'
      )
    )=4
      and exists(select 1 from public.fiscal_periods period
        where period.subsidiary_id=session.subsidiary_id
          and not period.is_closed and not coalesce(period.ar_closed,false))
      and exists(select 1 from public.entity_subsidiaries entity
        where entity.subsidiary_id=session.subsidiary_id)
      and exists(select 1 from public.products product
        join public.product_subsidiaries link using(product_id)
        join public.chart_accounts account on account.account_id=product.sales_account_id
        where link.subsidiary_id=session.subsidiary_id and link.is_active
          and product.is_active and product.product_usage in('Venta','Ambas')
          and account.category='Ingreso')
    order by session.session_id desc limit 1`);
  assert.ok(context,'Se requiere una sesión autorizada con catálogos de ventas.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);

  const setup=await one(`select
      (select entity.customer_id from public.entity_subsidiaries entity
       where entity.subsidiary_id=$1 order by entity.customer_id limit 1) customer_id,
      (select product.product_id from public.products product
       join public.product_subsidiaries link using(product_id)
       join public.chart_accounts account on account.account_id=product.sales_account_id
       where link.subsidiary_id=$1 and link.is_active and product.is_active
         and product.product_usage in('Venta','Ambas') and account.category='Ingreso'
       order by product.product_id limit 1) product_id,
      (select period.fiscal_period_id from public.fiscal_periods period
       where period.subsidiary_id=$1 and not period.is_closed and not coalesce(period.ar_closed,false)
       order by period.start_date limit 1) fiscal_period_id,
      (select to_char(period.start_date,'YYYY-MM-DD') from public.fiscal_periods period
       where period.subsidiary_id=$1 and not period.is_closed and not coalesce(period.ar_closed,false)
       order by period.start_date limit 1) document_date,
      (select subsidiary.currency_id from public.subsidiaries subsidiary where subsidiary.subsidiary_id=$1) currency_id,
      (select term.term_id from public.payment_terms term order by term.term_id limit 1) payment_term_id,
      (select country.country_id from public.countries country order by country.country_id limit 1) first_country_id,
      (select country.country_id from public.countries country order by country.country_id offset 1 limit 1) second_country_id`,
    [context.subsidiary_id]);
  assert.ok(setup.customer_id&&setup.product_id&&setup.fiscal_period_id&&setup.currency_id&&setup.payment_term_id&&setup.first_country_id);
  const secondCountry=setup.second_country_id||setup.first_country_id;
  const line=(price,month,country,note)=>({
    product_id:setup.product_id,quantity:1,unit_price:price,tax_code_id:'',tax_rate:0,
    service_month:month,service_country_id:country,note,
    department_id:'',cost_center_id:'',class_id:'',related_company_id:''
  });
  const invoicePayload={
    invoice_number:'AUTO',customer_id:setup.customer_id,payment_term_id:setup.payment_term_id,
    invoice_date:setup.document_date,fiscal_period_id:setup.fiscal_period_id,
    currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible de país en notas',
    lines:[
      line(100,'2026-04',setup.first_country_id,'Servicio país 1'),
      line(120,'2026-05',secondCountry,'Servicio país 2')
    ]
  };

  await db.query('set local role authenticated');
  const invoice=(await one('select public.save_sales_invoice($1::jsonb,null) value',[JSON.stringify(invoicePayload)])).value;
  const expected=[String(setup.first_country_id),String(secondCountry)];

  const verifyNote=async kind=>{
    const payload={
      invoice_id:invoice.invoiceId,note_date:setup.document_date,
      fiscal_period_id:setup.fiscal_period_id,currency_id:setup.currency_id,
      exchange_rate:1,memo:`Prueba ${kind} con país de servicio`,
      lines:[
        line(kind==='CREDIT'?10:5,'2026-03','',`Ajuste ${kind} 1`),
        line(kind==='CREDIT'?15:7,'2026-04','',`Ajuste ${kind} 2`)
      ]
    };
    const note=(await one('select public.save_sales_note($1,$2::jsonb,null) value',[kind,JSON.stringify(payload)])).value;
    let rows=(await db.query(`select service_country_id from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,note.noteId])).rows;
    assert.deepEqual(countries(rows),expected,'La nota debe heredar los países de la factura por línea.');
    let accounting=(await db.query(`select line.service_country_id from public.journal_line line
      join public.chart_accounts account using(account_id)
      where line.journal_id=$1 and account.category='Ingreso' order by line.journal_line_id`,[note.journalId])).rows;
    assert.deepEqual(countries(accounting),expected,'El asiento debe conservar los países de la nota.');

    payload.lines[0].service_country_id=secondCountry;
    payload.lines[1].service_country_id=setup.first_country_id;
    const editedExpected=[String(secondCountry),String(setup.first_country_id)];
    await db.query('select public.save_sales_note($1,$2::jsonb,$3)',[kind,JSON.stringify(payload),note.noteId]);
    rows=(await db.query(`select service_country_id from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,note.noteId])).rows;
    assert.deepEqual(countries(rows),editedExpected);

    payload.lines=payload.lines.map(({service_country_id,...item})=>item);
    await db.query('select public.save_sales_note($1,$2::jsonb,$3)',[kind,JSON.stringify(payload),note.noteId]);
    rows=(await db.query(`select service_country_id from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,note.noteId])).rows;
    assert.deepEqual(countries(rows),editedExpected,'Un cliente anterior no debe borrar los países guardados.');
  };

  await verifyNote('CREDIT');
  await verifyNote('DEBIT');
  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    migration:installed.value?'already-installed':'validated-with-rollback',
    invoiceCountry:true,creditInheritance:true,debitInheritance:true,
    creditEdit:true,debitEdit:true,legacyEditPreservesCountry:true,
    accountingCountry:true,historicalBackfill:true,rollback:true
  }));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
