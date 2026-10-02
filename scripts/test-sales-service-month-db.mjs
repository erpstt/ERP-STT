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
const months=rows=>rows.map(row=>row.service_month);
const expectRejected=async(sql,values,pattern)=>{
  await db.query('savepoint expected_failure');
  try{await db.query(sql,values);assert.fail('La operación debía rechazarse.');}
  catch(error){assert.match(error.message,pattern)}
  finally{await db.query('rollback to savepoint expected_failure')}
};

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  const installed=await one(`select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_invoice_line' and column_name='service_month')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_month')
    and exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
      where ns.nspname='public' and proc.proname in('save_sales_invoice','save_sales_invoice_before_service_country_integrity')
        and position('save_sales_invoice_before_service_month_fix' in pg_get_functiondef(proc.oid))>0)
    and exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
      where ns.nspname='public' and proc.proname in('save_sales_note','save_sales_note_before_service_country_fix')
        and position('save_sales_note_before_service_month_fix' in pg_get_functiondef(proc.oid))>0) value`);
  if(!installed.value){
    await db.query(await readFile(
      new URL('../supabase/migrations/20261001110000_fix_sales_service_month.sql',import.meta.url),'utf8'
    ));
  }

  const historical=await one(`select
    (select count(*)::int from public.sales_invoice_line) invoice_lines,
    (select count(*)::int from public.sales_invoice_line where service_month is null) invoice_missing,
    (select count(*)::int from public.sales_note_line) note_lines,
    (select count(*)::int from public.sales_note_line where service_month is null) note_missing`);
  assert.equal(historical.invoice_missing,0);
  assert.equal(historical.note_missing,0);

  const context=await one(`select distinct u.email,session.session_id,auth_user.id sub,session.subsidiary_id
    from public.user_company_sessions session
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    where exists(
      select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
      join public.permissions permission using(permission_id)
      where ur.user_id=u.user_id and permission.code='sales:invoice:create'
    ) and exists(
      select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
      join public.permissions permission using(permission_id)
      where ur.user_id=u.user_id and permission.code='sales:invoice:update'
    ) and exists(
      select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
      join public.permissions permission using(permission_id)
      where ur.user_id=u.user_id and permission.code='sales:note:create'
    ) and exists(
      select 1 from public.user_roles ur join public.role_permissions rp using(role_id)
      join public.permissions permission using(permission_id)
      where ur.user_id=u.user_id and permission.code='sales:note:update'
    ) and exists(
      select 1 from public.fiscal_periods period
      where period.subsidiary_id=session.subsidiary_id
        and not period.is_closed and not coalesce(period.ar_closed,false)
    ) and exists(
      select 1 from public.entity_subsidiaries entity
      where entity.subsidiary_id=session.subsidiary_id
    ) and exists(
      select 1 from public.products product
      join public.product_subsidiaries link using(product_id)
      join public.chart_accounts account on account.account_id=product.sales_account_id
      where link.subsidiary_id=session.subsidiary_id and link.is_active
        and product.is_active and product.product_usage in('Venta','Ambas')
        and account.category='Ingreso'
    )
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
      (select period.start_date from public.fiscal_periods period
       where period.subsidiary_id=$1 and not period.is_closed and not coalesce(period.ar_closed,false)
       order by period.start_date limit 1) document_date,
      (select subsidiary.currency_id from public.subsidiaries subsidiary where subsidiary.subsidiary_id=$1) currency_id,
      (select term.term_id from public.payment_terms term order by term.term_id limit 1) payment_term_id,
      (select country.country_id from public.countries country order by country.country_id limit 1) country_id`,
    [context.subsidiary_id]);
  assert.ok(setup.customer_id&&setup.product_id&&setup.fiscal_period_id&&setup.currency_id&&setup.payment_term_id&&setup.country_id);

  const line=(price,month,note)=>({
    product_id:setup.product_id,quantity:1,unit_price:price,tax_code_id:'',tax_rate:0,
    service_country_id:setup.country_id,service_month:month,note,
    department_id:'',cost_center_id:'',class_id:'',related_company_id:''
  });
  const invoicePayload={
    invoice_number:'AUTO',customer_id:setup.customer_id,payment_term_id:setup.payment_term_id,
    invoice_date:setup.document_date,fiscal_period_id:setup.fiscal_period_id,
    currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible de mes de servicio',
    lines:[line(100,'2026-04','Servicio abril'),line(120,'2026-05','Servicio mayo')]
  };

  await db.query('set local role authenticated');
  const created=(await one('select public.save_sales_invoice($1::jsonb,null) value',[JSON.stringify(invoicePayload)])).value;
  let saved=(await db.query('select service_month from public.sales_invoice_line where invoice_id=$1 order by line_id',[created.invoiceId])).rows;
  assert.deepEqual(months(saved),['2026-04','2026-05']);
  let accounting=(await db.query(`select line.service_month from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=$1 and account.category='Ingreso' order by line.journal_line_id`,[created.journalId])).rows;
  assert.deepEqual(months(accounting),['2026-04','2026-05']);

  invoicePayload.invoice_number=created.transactionNumber;
  invoicePayload.lines[0].service_month='2026-06';
  invoicePayload.lines[1].service_month='2026-07';
  await db.query('select public.save_sales_invoice($1::jsonb,$2)',[JSON.stringify(invoicePayload),created.invoiceId]);
  saved=(await db.query('select service_month from public.sales_invoice_line where invoice_id=$1 order by line_id',[created.invoiceId])).rows;
  assert.deepEqual(months(saved),['2026-06','2026-07']);

  invoicePayload.lines=invoicePayload.lines.map(({service_month,...item})=>item);
  await db.query('select public.save_sales_invoice($1::jsonb,$2)',[JSON.stringify(invoicePayload),created.invoiceId]);
  saved=(await db.query('select service_month from public.sales_invoice_line where invoice_id=$1 order by line_id',[created.invoiceId])).rows;
  assert.deepEqual(months(saved),['2026-06','2026-07']);

  const notePayload=(prices,monthValues)=>({
    invoice_id:created.invoiceId,note_date:setup.document_date,
    fiscal_period_id:setup.fiscal_period_id,currency_id:setup.currency_id,
    exchange_rate:1,memo:'Prueba reversible de nota con mes de servicio',
    lines:prices.map((price,index)=>line(price,monthValues[index],`Ajuste ${index+1}`))
  });

  const verifyNote=async kind=>{
    const initial=notePayload(kind==='CREDIT'?[10,15]:[5,7],['2026-03','2026-04']);
    const createdNote=(await one('select public.save_sales_note($1,$2::jsonb,null) value',[kind,JSON.stringify(initial)])).value;
    let noteLines=(await db.query(`select service_month from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,createdNote.noteId])).rows;
    assert.deepEqual(months(noteLines),['2026-03','2026-04']);
    let noteAccounting=(await db.query(`select line.service_month from public.journal_line line
      join public.chart_accounts account using(account_id)
      where line.journal_id=$1 and account.category='Ingreso' order by line.journal_line_id`,[createdNote.journalId])).rows;
    assert.deepEqual(months(noteAccounting),['2026-03','2026-04']);

    initial.lines[0].service_month='2026-08';
    initial.lines[1].service_month='2026-09';
    await db.query('select public.save_sales_note($1,$2::jsonb,$3)',[kind,JSON.stringify(initial),createdNote.noteId]);
    noteLines=(await db.query(`select service_month from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,createdNote.noteId])).rows;
    assert.deepEqual(months(noteLines),['2026-08','2026-09']);

    initial.lines=initial.lines.map(({service_month,...item})=>item);
    await db.query('select public.save_sales_note($1,$2::jsonb,$3)',[kind,JSON.stringify(initial),createdNote.noteId]);
    noteLines=(await db.query(`select service_month from public.sales_note_line
      where note_kind=$1 and note_id=$2 order by line_id`,[kind,createdNote.noteId])).rows;
    assert.deepEqual(months(noteLines),['2026-08','2026-09']);
    return createdNote;
  };

  await verifyNote('CREDIT');
  await verifyNote('DEBIT');

  const invalid={...invoicePayload,lines:[{...invoicePayload.lines[0],service_month:'2026-13'}]};
  await expectRejected('select public.save_sales_invoice($1::jsonb,null)',[JSON.stringify(invalid)],/Mes de servicio inválido/i);

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    migration:installed.value?'already-installed':'validated-with-rollback',
    invoiceCreate:true,invoiceEdit:true,invoiceLegacyEdit:true,
    creditCreateEdit:true,debitCreateEdit:true,noteLegacyEdit:true,
    accountingDimensions:true,formatValidation:true,historicalBackfill:true,rollback:true
  }));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
