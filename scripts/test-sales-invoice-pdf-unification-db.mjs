import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const one=async(sql,values=[])=>(await db.query(sql,values)).rows[0];
const value=async(sql,values=[])=>(await one(sql,values))?.value;
const expectRejected=async(sql,values,pattern)=>{
  const savepoint=`sp_${Date.now()}_${Math.floor(Math.random()*100000)}`;
  await db.query(`savepoint ${savepoint}`);
  try{
    await db.query(sql,values);
    assert.fail(`Se esperaba rechazo: ${pattern}`);
  }catch(error){
    await db.query(`rollback to savepoint ${savepoint}`);
    assert.match(String(error.message),pattern);
  }
  await db.query(`release savepoint ${savepoint}`);
};
const immutableInvoiceState=invoiceId=>one(`select
  (select count(*)::int from public.sales_invoice_line line where line.invoice_id=$1) commercial_line_count,
  md5(coalesce((select jsonb_agg(to_jsonb(line) order by line.line_id)
    from public.sales_invoice_line line where line.invoice_id=$1),'[]'::jsonb)::text) commercial_line_hash,
  (select count(*)::int from public.journal_line line
    where line.journal_id=(select invoice.journal_id from public.invoice invoice where invoice.invoice_id=$1)) journal_line_count,
  md5(coalesce((select jsonb_agg(to_jsonb(line) order by line.journal_line_id)
    from public.journal_line line
    where line.journal_id=(select invoice.journal_id from public.invoice invoice where invoice.invoice_id=$1)),'[]'::jsonb)::text) journal_line_hash,
  (select count(*)::int from public.gl_impact impact
    where impact.transaction_id=(select invoice.transaction_id from public.invoice invoice where invoice.invoice_id=$1)) gl_impact_count,
  md5(coalesce((select jsonb_agg(to_jsonb(impact) order by impact.gl_impact_id)
    from public.gl_impact impact
    where impact.transaction_id=(select invoice.transaction_id from public.invoice invoice where invoice.invoice_id=$1)),'[]'::jsonb)::text) gl_impact_hash,
  (select count(*)::int from public.sales_invoice_withholding withholding
    where withholding.invoice_id=$1) withholding_count,
  md5(coalesce((select jsonb_agg(to_jsonb(withholding) order by withholding.invoice_withholding_id)
    from public.sales_invoice_withholding withholding
    where withholding.invoice_id=$1),'[]'::jsonb)::text) withholding_hash
`,[invoiceId]);

await db.connect();
let installedBefore=false;
try{
  installedBefore=await value(`select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='invoice'
      and column_name='unificar_lineas_pdf'
  ) value`);

  await db.query('begin');
  await db.query("set local lock_timeout='15s';set local statement_timeout='120s'");
  const migration=await readFile(
    new URL('../supabase/migrations/20261013090000_sales_invoice_pdf_line_unification.sql',import.meta.url),
    'utf8'
  );
  // Applying it twice inside the same rolled-back transaction verifies that the
  // wrapper does not rename itself or lose the previous accounting workflow.
  await db.query(migration);
  await db.query(migration);

  const column=await one(`
    select data_type,is_nullable,column_default
    from information_schema.columns
    where table_schema='public' and table_name='invoice'
      and column_name='unificar_lineas_pdf'
  `);
  assert.equal(column.data_type,'boolean');
  assert.equal(column.is_nullable,'NO');
  assert.match(String(column.column_default),/false/i);

  const functions=await one(`select
    pg_get_functiondef('public.save_sales_invoice(jsonb,bigint)'::regprocedure) save_definition,
    pg_get_functiondef('public.sales_invoice_delivery_snapshot(bigint)'::regprocedure) snapshot_definition,
    pg_get_functiondef('public.set_sales_invoice_pdf_line_unification(bigint,boolean)'::regprocedure) setter_definition,
    to_regprocedure('public.save_sales_invoice_before_pdf_line_unification(jsonb,bigint)') is not null predecessor_exists
  `);
  assert.equal(functions.predecessor_exists,true);
  assert.match(functions.save_definition,/save_sales_invoice_before_pdf_line_unification/);
  assert.match(functions.save_definition,/unificar_lineas_pdf/);
  assert.match(functions.snapshot_definition,/'unifyLinesPdf'/);
  assert.match(functions.snapshot_definition,/'taxCodeId'/);
  assert.match(functions.snapshot_definition,/'taxCode'/);
  assert.match(functions.snapshot_definition,/order by l\.line_id/i);
  assert.match(functions.snapshot_definition,/i\.subsidiary_id\s*=\s*sid/i);
  assert.match(functions.setter_definition,/sales:invoice:update/);
  assert.match(functions.setter_definition,/app_active_role_id/);
  assert.match(functions.setter_definition,/invoice\.subsidiary_id\s*=\s*sid/i);
  assert.doesNotMatch(functions.setter_definition,/sales_invoice_line|journal_line|gl_impact/i);

  const privileges=await one(`select
    has_function_privilege('authenticated','public.save_sales_invoice(jsonb,bigint)','execute') save_authenticated,
    has_function_privilege('anon','public.save_sales_invoice(jsonb,bigint)','execute') save_anon,
    has_function_privilege('authenticated','public.save_sales_invoice_before_pdf_line_unification(jsonb,bigint)','execute') predecessor_authenticated,
    has_function_privilege('authenticated','public.sales_invoice_delivery_snapshot(bigint)','execute') snapshot_authenticated,
    has_function_privilege('anon','public.sales_invoice_delivery_snapshot(bigint)','execute') snapshot_anon,
    has_function_privilege('authenticated','public.set_sales_invoice_pdf_line_unification(bigint,boolean)','execute') setter_authenticated,
    has_function_privilege('anon','public.set_sales_invoice_pdf_line_unification(bigint,boolean)','execute') setter_anon
  `);
  assert.equal(privileges.save_authenticated,true);
  assert.equal(privileges.save_anon,false);
  assert.equal(privileges.predecessor_authenticated,false);
  assert.equal(privileges.snapshot_authenticated,true);
  assert.equal(privileges.snapshot_anon,false);
  assert.equal(privileges.setter_authenticated,true);
  assert.equal(privileges.setter_anon,false);

  const context=await one(`
    select u.user_id,u.email,au.id sub,ucs.session_id,ucs.subsidiary_id,urs.role_id
    from public.user_company_sessions ucs
    join public.users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    join public.user_role_sessions urs
      on urs.session_id=ucs.session_id and urs.user_id=ucs.user_id
    where exists(
      select 1 from public.role_permissions rp
      join public.permissions permission using(permission_id)
      where rp.role_id=urs.role_id and permission.code='sales:invoice:create'
    )
      and exists(
        select 1 from public.role_permissions rp
        join public.permissions permission using(permission_id)
        where rp.role_id=urs.role_id and permission.code='sales:invoice:update'
      )
      and exists(
        select 1 from public.fiscal_periods period
        where period.subsidiary_id=ucs.subsidiary_id
          and not period.is_closed and not coalesce(period.ar_closed,false)
      )
      and exists(
        select 1 from public.entity_subsidiaries entity
        where entity.subsidiary_id=ucs.subsidiary_id
      )
      and exists(
        select 1 from public.products product
        join public.product_subsidiaries assignment using(product_id)
        where assignment.subsidiary_id=ucs.subsidiary_id
          and product.is_active and product.product_usage in('Venta','Ambas')
          and product.sales_account_id is not null
      )
      and exists(
        select 1 from public.tax_codes tax
        join public.tax_code_subsidiaries assignment using(tax_code_id)
        join public.tax_types tax_type using(tax_type_id)
        where assignment.subsidiary_id=ucs.subsidiary_id
          and not tax.is_withholding and tax.rate_percentage>0
          and tax_type.liability_account_id is not null
      )
      and exists(
        select 1 from public.chart_accounts account
        join public.account_subsidiaries assignment using(account_id)
        where assignment.subsidiary_id=ucs.subsidiary_id and assignment.is_active
          and account.category='Activo'
          and lower(account.account_name)~'(cuenta.*por cobrar|cliente.*por cobrar)'
      )
      and exists(
        select 1 from public.accounting_books book
        where book.subsidiary_id=ucs.subsidiary_id and book.is_active
      )
      and exists(
        select 1 from public.bank_account account
        where account.subsidiary_id=ucs.subsidiary_id
      )
    order by ucs.selected_at desc nulls last,ucs.session_id desc
    limit 1
  `);
  assert.ok(context,'Se requiere una sesión autorizada con catálogos completos de venta.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
  assert.equal(String(await value('select public.active_subsidiary_id() value')),String(context.subsidiary_id));
  assert.equal(String(await value('select public.app_active_role_id() value')),String(context.role_id));

  const setup=await one(`select
    (select entity.customer_id from public.entity_subsidiaries entity
     where entity.subsidiary_id=$1 order by entity.customer_id limit 1) customer_id,
    (select product.product_id from public.products product
     join public.product_subsidiaries assignment using(product_id)
     where assignment.subsidiary_id=$1 and product.is_active
       and product.product_usage in('Venta','Ambas')
       and product.sales_account_id is not null
     order by product.product_id limit 1) product_id,
    (select period.fiscal_period_id from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ar_closed,false)
     order by period.end_date desc limit 1) fiscal_period_id,
    (select to_char(greatest(period.start_date,least(current_date,period.end_date)),'YYYY-MM-DD')
     from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ar_closed,false)
     order by period.end_date desc limit 1) invoice_date,
    (select subsidiary.currency_id from public.subsidiaries subsidiary
     where subsidiary.subsidiary_id=$1) currency_id,
    (select subsidiary.country_id from public.subsidiaries subsidiary
     where subsidiary.subsidiary_id=$1) country_id,
    (select terms.term_id from public.payment_terms terms order by terms.term_id limit 1) payment_term_id,
    (select account.bank_account_id from public.bank_account account
     where account.subsidiary_id=$1 order by account.bank_account_id limit 1) bank_account_id,
    (select tax.tax_code_id from public.tax_codes tax
     join public.tax_code_subsidiaries assignment using(tax_code_id)
     join public.tax_types tax_type using(tax_type_id)
     where assignment.subsidiary_id=$1 and not tax.is_withholding
       and tax.rate_percentage>0 and tax_type.liability_account_id is not null
     order by tax.tax_code_id limit 1) tax_code_id,
    (select tax.code_name from public.tax_codes tax
     join public.tax_code_subsidiaries assignment using(tax_code_id)
     join public.tax_types tax_type using(tax_type_id)
     where assignment.subsidiary_id=$1 and not tax.is_withholding
       and tax.rate_percentage>0 and tax_type.liability_account_id is not null
     order by tax.tax_code_id limit 1) tax_code,
    (select tax.rate_percentage from public.tax_codes tax
     join public.tax_code_subsidiaries assignment using(tax_code_id)
     join public.tax_types tax_type using(tax_type_id)
     where assignment.subsidiary_id=$1 and not tax.is_withholding
       and tax.rate_percentage>0 and tax_type.liability_account_id is not null
     order by tax.tax_code_id limit 1) tax_rate
  `,[context.subsidiary_id]);
  for(const key of ['customer_id','product_id','fiscal_period_id','invoice_date','currency_id','country_id','payment_term_id','bank_account_id','tax_code_id','tax_code','tax_rate']){
    assert.ok(setup[key]!==null&&setup[key]!==undefined,`Falta configuración de prueba: ${key}`);
  }

  const line=(quantity,unitPrice,note)=>({
    product_id:setup.product_id,quantity,unit_price:unitPrice,
    tax_code_id:setup.tax_code_id,tax_rate:Number(setup.tax_rate),
    service_country_id:setup.country_id,
    service_month:String(setup.invoice_date).slice(0,7),note,
    department_id:'',cost_center_id:'',class_id:'',related_company_id:''
  });
  const payload={
    invoice_number:'AUTO',customer_id:setup.customer_id,
    payment_term_id:setup.payment_term_id,invoice_date:setup.invoice_date,
    fiscal_period_id:setup.fiscal_period_id,currency_id:setup.currency_id,
    exchange_rate:1,memo:'Prueba reversible de presentación PDF',
    unificar_lineas_pdf:true,
    lines:[line(2,50,'Detalle original A'),line(1,200,'Detalle original B')]
  };

  const created=await value(
    'select public.save_sales_invoice($1::jsonb,null) value',
    [JSON.stringify(payload)]
  );
  assert.equal(created.unifyLinesPdf,true);
  assert.equal(await value('select unificar_lineas_pdf value from public.invoice where invoice_id=$1',[created.invoiceId]),true);
  assert.equal(Number(await value('select count(*)::int value from public.sales_invoice_line where invoice_id=$1',[created.invoiceId])),2);

  let snapshot=await value('select public.sales_invoice_delivery_snapshot($1) value',[created.invoiceId]);
  assert.equal(snapshot.unifyLinesPdf,true);
  assert.equal(snapshot.lines.length,2,'El snapshot debe conservar todas las líneas originales.');
  assert.deepEqual(snapshot.lines.map(item=>item.description),['Detalle original A','Detalle original B']);
  assert.deepEqual(snapshot.lines.map(item=>Number(item.quantity)),[2,1]);
  for(const item of snapshot.lines){
    assert.equal(String(item.taxCodeId),String(setup.tax_code_id));
    assert.equal(item.taxCode,setup.tax_code);
  }

  payload.invoice_number=created.transactionNumber;
  delete payload.unificar_lineas_pdf;
  const legacyEdit=await value(
    'select public.save_sales_invoice($1::jsonb,$2) value',
    [JSON.stringify(payload),created.invoiceId]
  );
  assert.equal(legacyEdit.unifyLinesPdf,true);
  assert.equal(await value('select unificar_lineas_pdf value from public.invoice where invoice_id=$1',[created.invoiceId]),true);

  payload.unificar_lineas_pdf=false;
  const explicitEdit=await value(
    'select public.save_sales_invoice($1::jsonb,$2) value',
    [JSON.stringify(payload),created.invoiceId]
  );
  assert.equal(explicitEdit.unifyLinesPdf,false);
  snapshot=await value('select public.sales_invoice_delivery_snapshot($1) value',[created.invoiceId]);
  assert.equal(snapshot.unifyLinesPdf,false);
  assert.equal(snapshot.lines.length,2);

  const legacyCreatePayload={...payload,invoice_number:'AUTO',memo:'Prueba default false'};
  delete legacyCreatePayload.unificar_lineas_pdf;
  const legacyCreate=await value(
    'select public.save_sales_invoice($1::jsonb,null) value',
    [JSON.stringify(legacyCreatePayload)]
  );
  assert.equal(legacyCreate.unifyLinesPdf,false);
  assert.equal(await value('select unificar_lineas_pdf value from public.invoice where invoice_id=$1',[legacyCreate.invoiceId]),false);

  // A settled invoice with a real application must still allow this
  // presentation-only preference. Its commercial and accounting records must
  // remain byte-for-byte equal.
  const amountDue=Number(await value(`select coalesce(nullif(receivable_amount,0),total_amount) value
    from public.invoice where invoice_id=$1`,[created.invoiceId]));
  const payment=await one(`insert into public.customer_payment(
      payment_number,customer_id,bank_account_id,payment_date,amount_received,
      currency_id,exchange_rate,fiscal_period_id,status
    )values($1,$2,$3,$4,$5,$6,1,$7,'APROBADO')returning payment_id`,[
      `TEST-PDF-${Date.now()}`,setup.customer_id,setup.bank_account_id,
      setup.invoice_date,amountDue,setup.currency_id,setup.fiscal_period_id
    ]);
  await db.query(`insert into public.customer_payment_application(
    payment_id,invoice_id,amount,application_date
  )values($1,$2,$3,$4)`,[payment.payment_id,created.invoiceId,amountDue,setup.invoice_date]);
  assert.equal(Number(await value(`select sum(amount) value from public.customer_payment_application
    where invoice_id=$1`,[created.invoiceId])),amountDue);
  const immutableBefore=await immutableInvoiceState(created.invoiceId);
  const preference=await value(
    'select public.set_sales_invoice_pdf_line_unification($1,$2) value',
    [created.invoiceId,true]
  );
  assert.equal(String(preference.invoiceId),String(created.invoiceId));
  assert.equal(preference.unifyLinesPdf,true);
  const paidHeader=await one(`select unificar_lineas_pdf,coalesce(nullif(receivable_amount,0),total_amount) receivable_amount
    from public.invoice where invoice_id=$1`,[created.invoiceId]);
  assert.equal(paidHeader.unificar_lineas_pdf,true);
  assert.equal(Number(paidHeader.receivable_amount),amountDue);
  const immutableAfter=await immutableInvoiceState(created.invoiceId);
  assert.deepEqual(immutableAfter,immutableBefore,'La preferencia PDF no puede alterar líneas ni asientos.');

  await expectRejected(
    'select public.set_sales_invoice_pdf_line_unification($1,$2)',
    [created.invoiceId,null],
    /Indique si las líneas deben unificarse/i
  );

  await db.query('savepoint permission_removed');
  const removed=await db.query(`delete from public.role_permissions grant_record
    using public.permissions permission
    where grant_record.permission_id=permission.permission_id
      and grant_record.role_id=$1 and permission.code='sales:invoice:update'`,[context.role_id]);
  assert.equal(removed.rowCount,1,'El rol activo debe tener el permiso técnico de edición.');
  await expectRejected(
    'select public.set_sales_invoice_pdf_line_unification($1,$2)',
    [created.invoiceId,false],
    /No tiene permiso para modificar la presentación PDF/i
  );
  await db.query('rollback to savepoint permission_removed');
  await db.query('release savepoint permission_removed');

  await expectRejected(
    'select public.save_sales_invoice($1::jsonb,$2)',
    [JSON.stringify({...payload,unificar_lineas_pdf:'sí'}),created.invoiceId],
    /debe ser verdadera o falsa/i
  );

  const foreignInvoice=await one(`
    select invoice_id from public.invoice
    where subsidiary_id<>$1 order by invoice_id desc limit 1
  `,[context.subsidiary_id]);
  if(foreignInvoice){
    await expectRejected(
      'select public.sales_invoice_delivery_snapshot($1)',
      [foreignInvoice.invoice_id],
      /no existe en la subsidiaria activa/i
    );
    await expectRejected(
      'select public.set_sales_invoice_pdf_line_unification($1,$2)',
      [foreignInvoice.invoice_id,true],
      /no existe en la subsidiaria activa/i
    );
  }

  await db.query('rollback');
  console.log(JSON.stringify({
    migration:installedBefore?'already-installed-revalidated':'validated-with-rollback',
    idempotentMigration:true,columnDefaultFalse:true,createPersistsFlag:true,
    legacyCreateDefaultsFalse:true,legacyEditPreservesFlag:true,explicitEditUpdatesFlag:true,
    snapshotFlag:true,snapshotOriginalLines:true,snapshotTaxCode:true,
    paidInvoicePreferenceUpdate:true,commercialLinesUnchanged:true,journalLinesUnchanged:true,
    glImpactsUnchanged:true,withholdingsUnchanged:true,technicalPermissionRequired:true,
    activeSubsidiaryGuard:true,leastPrivilegeFunctions:true,rollback:true
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
