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
const number=value=>Number(value);
const close=(actual,expected,message)=>assert.ok(Math.abs(number(actual)-expected)<0.00001,`${message}: ${actual} != ${expected}`);
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

await db.connect();
let installedBefore=false;
try{
  installedBefore=(await one(`select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='invoice'
      and column_name='autorent_total_amount'
  ) value`)).value;

  await db.query('begin');
  await db.query("set local lock_timeout='15s';set local statement_timeout='120s'");
  const migration=await readFile(
    new URL('../supabase/migrations/20260929100000_colombia_income_autorent.sql',import.meta.url),
    'utf8'
  );
  await db.query(migration);

  let colombia=await one(`
    select country_id from public.countries
    where upper(coalesce(country_code_iso2,''))='CO'
      or upper(coalesce(country_code_iso3,''))='COL'
      or lower(btrim(name))='colombia'
    order by country_id limit 1
  `);
  if(!colombia){
    colombia=await one(`
      insert into public.countries(name,country_code_iso2,country_code_iso3)
      values('Colombia','CO','COL') returning country_id
    `);
  }
  const otherCountry=await one(`
    select country_id from public.countries where country_id<>$1 order by country_id limit 1
  `,[colombia.country_id]);
  assert.ok(otherCountry,'Se requieren dos paises para validar la restriccion geografica.');

  const context=await one(`
    select u.user_id,u.email,au.id sub,ucs.session_id,ucs.subsidiary_id
    from public.user_company_sessions ucs
    join public.users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    where(
      select count(distinct p.code)
      from public.user_roles ur
      join public.role_permissions rp using(role_id)
      join public.permissions p using(permission_id)
      where ur.user_id=u.user_id
        and p.code in('sales:invoice:create','sales:invoice:update','sales:note:create','sales:note:update')
    )=4
      and exists(
        select 1 from public.fiscal_periods fp
        where fp.subsidiary_id=ucs.subsidiary_id
          and not fp.is_closed and not coalesce(fp.ar_closed,false)
      )
      and exists(
        select 1 from public.entity_subsidiaries es
        where es.subsidiary_id=ucs.subsidiary_id
          and not exists(
            select 1 from public.entity_withholding_rules ewr
            where ewr.customer_id=es.customer_id and ewr.subsidiary_id=ucs.subsidiary_id
          )
      )
      and exists(
        select 1 from public.products p
        join public.product_subsidiaries ps using(product_id)
        join public.chart_accounts a on a.account_id=p.sales_account_id
        where ps.subsidiary_id=ucs.subsidiary_id and ps.is_active
          and p.is_active and p.product_usage in('Venta','Ambas')
          and a.category='Ingreso'
      )
      and exists(
        select 1 from public.chart_accounts a join public.account_subsidiaries sa using(account_id)
        where sa.subsidiary_id=ucs.subsidiary_id and sa.is_active
          and a.category='Activo' and a.financial_statement='Balance General'
          and a.accepts_entries and not a.is_inactive
      )
      and exists(
        select 1 from public.chart_accounts a join public.account_subsidiaries sa using(account_id)
        where sa.subsidiary_id=ucs.subsidiary_id and sa.is_active
          and a.category='Pasivo' and a.financial_statement='Balance General'
          and a.accepts_entries and not a.is_inactive
      )
      and exists(
        select 1 from public.tax_codes tc
        join public.tax_code_subsidiaries tcs using(tax_code_id)
        join public.tax_types tt using(tax_type_id)
        where tcs.subsidiary_id=ucs.subsidiary_id and tc.rate_percentage>0
          and tt.liability_account_id is not null
      )
      and exists(select 1 from public.accounting_books b where b.subsidiary_id=ucs.subsidiary_id and b.is_active)
    order by ucs.selected_at desc limit 1
  `);
  assert.ok(context,'Se requiere una sesion con permisos y catalogos completos de ventas.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
  close((await one('select public.active_subsidiary_id() value')).value,number(context.subsidiary_id),'Subsidiaria activa');

  const setup=await one(`
    select
      (select es.customer_id from public.entity_subsidiaries es
       where es.subsidiary_id=$1 and not exists(
         select 1 from public.entity_withholding_rules r
         where r.customer_id=es.customer_id and r.subsidiary_id=$1
       )order by es.customer_id limit 1) customer_id,
      (select p.product_id from public.products p
       join public.product_subsidiaries ps using(product_id)
       join public.chart_accounts a on a.account_id=p.sales_account_id
       where ps.subsidiary_id=$1 and ps.is_active and p.is_active
         and p.product_usage in('Venta','Ambas') and a.category='Ingreso'
       order by p.product_id limit 1) product_id,
      (select fp.fiscal_period_id from public.fiscal_periods fp
       where fp.subsidiary_id=$1 and not fp.is_closed and not coalesce(fp.ar_closed,false)
       order by fp.start_date limit 1) fiscal_period_id,
      (select fp.start_date from public.fiscal_periods fp
       where fp.subsidiary_id=$1 and not fp.is_closed and not coalesce(fp.ar_closed,false)
       order by fp.start_date limit 1) document_date,
      (select s.currency_id from public.subsidiaries s where s.subsidiary_id=$1) currency_id,
      (select pt.term_id from public.payment_terms pt order by pt.term_id limit 1) payment_term_id,
      (select a.account_id from public.chart_accounts a join public.account_subsidiaries sa using(account_id)
       where sa.subsidiary_id=$1 and sa.is_active and a.category='Activo'
         and a.financial_statement='Balance General' and a.accepts_entries and not a.is_inactive
       order by(case when a.account_name~*'autorret' then 0 else 1 end),a.account_id limit 1) active_account_id,
      (select a.account_id from public.chart_accounts a join public.account_subsidiaries sa using(account_id)
       where sa.subsidiary_id=$1 and sa.is_active and a.category='Pasivo'
         and a.financial_statement='Balance General' and a.accepts_entries and not a.is_inactive
       order by(case when a.account_name~*'autorret' then 0 else 1 end),a.account_id limit 1) passive_account_id,
      (select tc.tax_code_id from public.tax_codes tc
       join public.tax_code_subsidiaries tcs using(tax_code_id)
       join public.tax_types tt using(tax_type_id)
       where tcs.subsidiary_id=$1 and tc.rate_percentage>0 and tt.liability_account_id is not null
       order by tc.tax_code_id limit 1) tax_code_id,
      (select tc.rate_percentage from public.tax_codes tc
       join public.tax_code_subsidiaries tcs using(tax_code_id)
       join public.tax_types tt using(tax_type_id)
       where tcs.subsidiary_id=$1 and tc.rate_percentage>0 and tt.liability_account_id is not null
       order by tc.tax_code_id limit 1) tax_rate
  `,[context.subsidiary_id]);
  assert.ok(setup.customer_id&&setup.product_id&&setup.fiscal_period_id&&setup.currency_id&&setup.payment_term_id);
  assert.ok(setup.active_account_id&&setup.passive_account_id&&setup.tax_code_id&&setup.tax_rate);

  await expectRejected(`
    update public.subsidiaries set country_id=$2,applies_income_autorent=true,
      autorent_active_account_id=$3,autorent_passive_account_id=$4,autorent_percentage=.0110
    where subsidiary_id=$1
  `,[context.subsidiary_id,otherCountry.country_id,setup.active_account_id,setup.passive_account_id],/solo puede activarse.*Colombia/i);

  await db.query('update public.subsidiaries set country_id=$2 where subsidiary_id=$1',[context.subsidiary_id,colombia.country_id]);
  await expectRejected(`
    update public.subsidiaries set applies_income_autorent=true,
      autorent_active_account_id=$2,autorent_passive_account_id=$3,autorent_percentage=.0110
    where subsidiary_id=$1
  `,[context.subsidiary_id,setup.passive_account_id,setup.active_account_id],/cuenta de anticipo.*Activo/i);
  await expectRejected(`
    update public.subsidiaries set applies_income_autorent=true,
      autorent_active_account_id=$2,autorent_passive_account_id=$3,autorent_percentage=0
    where subsidiary_id=$1
  `,[context.subsidiary_id,setup.active_account_id,setup.passive_account_id],/tarifa de autorretencion|subsidiaries_income_autorent_complete_check|viola.*restricci/i);

  await db.query(`
    update public.subsidiaries set applies_income_autorent=true,
      autorent_active_account_id=$2,autorent_passive_account_id=$3,autorent_percentage=.0110
    where subsidiary_id=$1
  `,[context.subsidiary_id,setup.active_account_id,setup.passive_account_id]);

  const invoicePayload={
    invoice_number:'AUTO',customer_id:setup.customer_id,payment_term_id:setup.payment_term_id,
    invoice_date:setup.document_date,fiscal_period_id:setup.fiscal_period_id,
    currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible de autorretencion',
    lines:[{
      product_id:setup.product_id,quantity:1,unit_price:100,tax_code_id:'',tax_rate:0,
      service_country_id:colombia.country_id,service_month:String(setup.document_date).slice(0,7),
      note:'Ingreso sujeto a autorretencion',department_id:'',cost_center_id:'',class_id:'',related_company_id:''
    }]
  };
  const created=(await one('select public.save_sales_invoice($1::jsonb,null) value',[JSON.stringify(invoicePayload)])).value;
  const invoice=await one(`
    select i.*,t.total_amount transaction_total,j.total_debit,j.total_credit
    from public.invoice i join public."transaction" t using(transaction_id)
    join public.journal j using(journal_id) where i.invoice_id=$1
  `,[created.invoiceId]);
  close(invoice.total_amount,100,'Total de factura');
  close(invoice.receivable_amount,100,'CxC de factura');
  close(invoice.transaction_total,100,'Total transaccional de factura');
  close(invoice.autorent_base_amount,100,'Base de factura');
  close(invoice.autorent_percentage_applied,.011,'Snapshot de tarifa');
  close(invoice.autorent_total_amount,1.1,'Autorretencion de factura');
  close(invoice.total_debit,101.1,'Debitos de factura');
  close(invoice.total_credit,101.1,'Creditos de factura');

  const invoiceLines=(await db.query(`
    select account_id,debit,credit,note from public.journal_line where journal_id=$1
  `,[created.journalId])).rows;
  const arLine=invoiceLines.find(line=>String(line.note).startsWith('Cuenta por cobrar'));
  const activeLine=invoiceLines.find(line=>line.note==='Autorretencion de renta - anticipo');
  const passiveLine=invoiceLines.find(line=>line.note==='Autorretencion de renta - por pagar');
  close(arLine?.debit,100,'Debito de CxC sin alteracion');
  close(activeLine?.debit,1.1,'Debito de anticipo');
  close(passiveLine?.credit,1.1,'Credito por pagar');
  assert.equal(String(activeLine.account_id),String(setup.active_account_id));
  assert.equal(String(passiveLine.account_id),String(setup.passive_account_id));

  const invoiceGl=await one(`
    select sum(debit_amount) debit,sum(credit_amount) credit,
      sum(debit_amount-credit_amount) balance
    from public.gl_impact where transaction_id=$1
  `,[invoice.transaction_id]);
  close(invoiceGl.debit,101.1,'GL debito factura');
  close(invoiceGl.credit,101.1,'GL credito factura');
  close(invoiceGl.balance,0,'GL balance factura');

  // Master disabled and cleared: editing must retain the issued snapshot and
  // the accounts captured in its existing journal.
  await db.query(`
    update public.subsidiaries set applies_income_autorent=false,
      autorent_active_account_id=null,autorent_passive_account_id=null,autorent_percentage=null
    where subsidiary_id=$1
  `,[context.subsidiary_id]);
  invoicePayload.invoice_number=created.transactionNumber;
  invoicePayload.lines[0].unit_price=200;
  const edited=(await one('select public.save_sales_invoice($1::jsonb,$2) value',[JSON.stringify(invoicePayload),created.invoiceId])).value;
  const editedInvoice=await one('select * from public.invoice where invoice_id=$1',[created.invoiceId]);
  close(editedInvoice.total_amount,200,'Total editado');
  close(editedInvoice.receivable_amount,200,'CxC editada');
  close(editedInvoice.autorent_base_amount,200,'Base editada');
  close(editedInvoice.autorent_percentage_applied,.011,'Snapshot inmutable de factura');
  close(editedInvoice.autorent_total_amount,2.2,'Autorretencion editada a tarifa historica');
  close(edited.autorentTotal,2.2,'Respuesta de factura editada');
  assert.equal(number((await one(`select count(*) value from public.journal_line
    where journal_id=$1 and note like 'Autorretencion de renta - %'`,[created.journalId])).value),2,
  'Editar factura debe conservar exactamente dos lineas de autorretencion');

  const notePayload=amount=>({
    invoice_id:created.invoiceId,note_date:setup.document_date,fiscal_period_id:setup.fiscal_period_id,
    currency_id:setup.currency_id,exchange_rate:1,memo:'Prueba reversible de nota con autorretencion',
    lines:[{product_id:setup.product_id,quantity:1,unit_price:amount,tax_code_id:'',tax_rate:0,
      service_month:String(setup.document_date).slice(0,7),note:'Ajuste sujeto a autorretencion',
      department_id:'',cost_center_id:'',class_id:''}]
  });

  const wrongCreditRate=notePayload(10);
  wrongCreditRate.exchange_rate=2;
  await expectRejected(
    "select public.save_sales_note('CREDIT',$1::jsonb,null)",
    [JSON.stringify(wrongCreditRate)],
    /mismo tipo de cambio.*factura original/i
  );

  const credit=(await one("select public.save_sales_note('CREDIT',$1::jsonb,null) value",[JSON.stringify(notePayload(50))])).value;
  const creditNote=await one(`
    select n.*,t.total_amount transaction_total,j.total_debit,j.total_credit
    from public.credit_note n join public."transaction" t using(transaction_id)
    join public.journal j using(journal_id) where n.cn_id=$1
  `,[credit.noteId]);
  close(creditNote.amount,50,'Total NC');
  close(creditNote.transaction_total,50,'Total transaccional NC');
  close(creditNote.autorent_base_amount,50,'Base NC');
  close(creditNote.autorent_percentage_applied,.011,'Snapshot NC');
  close(creditNote.autorent_total_amount,.55,'Reversion autorretencion NC');
  close(creditNote.total_debit,50.55,'Debitos NC');
  close(creditNote.total_credit,50.55,'Creditos NC');
  const creditLines=(await db.query('select account_id,debit,credit,note from public.journal_line where journal_id=$1',[credit.journalId])).rows;
  close(creditLines.find(line=>line.note==='Cuenta por cobrar')?.credit,50,'Credito CxC NC');
  close(creditLines.find(line=>line.note==='Autorretencion de renta - por pagar')?.debit,.55,'Debito pasivo NC');
  close(creditLines.find(line=>line.note==='Autorretencion de renta - anticipo')?.credit,.55,'Credito activo NC');

  // A new debit note snapshots the master rate in force on its own issue date.
  await db.query(`
    update public.subsidiaries set applies_income_autorent=true,
      autorent_active_account_id=$2,autorent_passive_account_id=$3,autorent_percentage=.0055
    where subsidiary_id=$1
  `,[context.subsidiary_id,setup.active_account_id,setup.passive_account_id]);
  const debitPayload=notePayload(25);
  const debit=(await one("select public.save_sales_note('DEBIT',$1::jsonb,null) value",[JSON.stringify(debitPayload)])).value;
  const debitNote=await one(`
    select n.*,t.total_amount transaction_total,j.total_debit,j.total_credit
    from public.debit_note n join public."transaction" t using(transaction_id)
    join public.journal j using(journal_id) where n.dn_id=$1
  `,[debit.noteId]);
  close(debitNote.amount,25,'Total ND');
  close(debitNote.transaction_total,25,'Total transaccional ND');
  close(debitNote.autorent_base_amount,25,'Base ND');
  close(debitNote.autorent_percentage_applied,.0055,'Snapshot propio ND');
  close(debitNote.autorent_total_amount,.1375,'Incremento autorretencion ND');
  close(debitNote.total_debit,25.1375,'Debitos ND');
  close(debitNote.total_credit,25.1375,'Creditos ND');
  const debitLines=(await db.query('select account_id,debit,credit,note from public.journal_line where journal_id=$1',[debit.journalId])).rows;
  close(debitLines.find(line=>line.note==='Cuenta por cobrar')?.debit,25,'Debito CxC ND');
  close(debitLines.find(line=>line.note==='Autorretencion de renta - anticipo')?.debit,.1375,'Debito activo ND');
  close(debitLines.find(line=>line.note==='Autorretencion de renta - por pagar')?.credit,.1375,'Credito pasivo ND');

  // Disabling and clearing the master must not alter the debit-note rate or
  // accounts already captured in its journal when that note is edited.
  await db.query(`update public.subsidiaries set applies_income_autorent=false,
    autorent_active_account_id=null,autorent_passive_account_id=null,autorent_percentage=null
    where subsidiary_id=$1`,[context.subsidiary_id]);
  debitPayload.lines[0].unit_price=30;
  await one("select public.save_sales_note('DEBIT',$1::jsonb,$2) value",[JSON.stringify(debitPayload),debit.noteId]);
  const editedDebit=await one('select * from public.debit_note where dn_id=$1',[debit.noteId]);
  close(editedDebit.autorent_base_amount,30,'Base ND editada');
  close(editedDebit.autorent_percentage_applied,.0055,'Snapshot inmutable ND');
  close(editedDebit.autorent_total_amount,.165,'Autorretencion ND editada');
  assert.equal(number((await one(`select count(*) value from public.journal_line
    where journal_id=$1 and note like 'Autorretencion de renta - %'`,[debit.journalId])).value),2,
  'Editar ND debe conservar exactamente dos lineas de autorretencion');

  await expectRejected(
    "select public.save_sales_note('CREDIT',$1::jsonb,null)",
    [JSON.stringify(notePayload(151))],
    /no puede superar.*factura original/i
  );

  // The final NC consumes the remaining invoice autorent exactly. The ND is
  // independent and must not enlarge this reversal pool.
  const finalCredit=(await one("select public.save_sales_note('CREDIT',$1::jsonb,null) value",[JSON.stringify(notePayload(150))])).value;
  const finalCreditNote=await one(`
    select n.*,j.total_debit,j.total_credit from public.credit_note n
    join public.journal j using(journal_id) where n.cn_id=$1
  `,[finalCredit.noteId]);
  close(finalCreditNote.autorent_base_amount,150,'Base NC final');
  close(finalCreditNote.autorent_percentage_applied,.011,'NC conserva tasa de factura');
  close(finalCreditNote.autorent_total_amount,1.65,'NC final agota autorretencion de factura');
  close(finalCreditNote.total_debit,151.65,'Debitos NC final');
  close(finalCreditNote.total_credit,151.65,'Creditos NC final');
  const pool=await one(`
    select i.autorent_base_amount
        -coalesce((select sum(c.autorent_base_amount)from public.credit_note c where c.invoice_id=i.invoice_id),0) base,
      i.autorent_total_amount
        -coalesce((select sum(c.autorent_total_amount)from public.credit_note c where c.invoice_id=i.invoice_id),0) amount
    from public.invoice i where i.invoice_id=$1
  `,[created.invoiceId]);
  close(pool.base,0,'Base de factura agotada por NC');
  close(pool.amount,0,'Autorretencion de factura agotada por NC');

  const reducedInvoice={...invoicePayload,lines:[{...invoicePayload.lines[0],unit_price:190}]};
  await expectRejected(
    'select public.save_sales_invoice($1::jsonb,$2)',
    [JSON.stringify(reducedInvoice),created.invoiceId],
    /debajo de la autorretencion.*notas de credito/i
  );

  const noteGl=await one(`
    select
      (select sum(debit_amount-credit_amount) from public.gl_impact where transaction_id=$1) credit_balance,
      (select sum(debit_amount-credit_amount) from public.gl_impact where transaction_id=$2) debit_balance
  `,[creditNote.transaction_id,debitNote.transaction_id]);
  close(noteGl.credit_balance,0,'GL balance NC');
  close(noteGl.debit_balance,0,'GL balance ND');

  await db.query(`update public.subsidiaries set applies_income_autorent=true,
    autorent_active_account_id=$2,autorent_passive_account_id=$3,autorent_percentage=.0200
    where subsidiary_id=$1`,[context.subsidiary_id,setup.active_account_id,setup.passive_account_id]);

  // Real IVA plus a non-unit exchange rate verifies that journal headers use
  // gross document total, while GL receives local currency at the journal TC.
  const taxedPayload={
    ...invoicePayload,invoice_number:'AUTO',exchange_rate:2.5,memo:'Prueba IVA y TC autorretencion',
    lines:[{...invoicePayload.lines[0],unit_price:100,tax_code_id:setup.tax_code_id,tax_rate:number(setup.tax_rate)}]
  };
  const taxed=(await one('select public.save_sales_invoice($1::jsonb,null) value',[JSON.stringify(taxedPayload)])).value;
  const taxedInvoice=await one(`select i.*,j.total_debit,j.total_credit from public.invoice i
    join public.journal j using(journal_id)where i.invoice_id=$1`,[taxed.invoiceId]);
  const expectedGross=100+number(setup.tax_rate);
  close(taxedInvoice.total_amount,expectedGross,'Factura con IVA');
  close(taxedInvoice.receivable_amount,expectedGross,'CxC con IVA');
  close(taxedInvoice.autorent_base_amount,100,'Base antes de IVA');
  close(taxedInvoice.autorent_percentage_applied,.02,'Tasa vigente factura IVA');
  close(taxedInvoice.autorent_total_amount,2,'Autorretencion factura IVA');
  close(taxedInvoice.total_debit,expectedGross+2,'Header debito IVA + autorretencion');
  close(taxedInvoice.total_credit,expectedGross+2,'Header credito IVA + autorretencion');
  const taxedGl=await one(`select
      count(*)filter(where account_id=$2 and debit_amount=5 and debit_fx=2) active_matches,
      count(*)filter(where account_id=$3 and credit_amount=5 and credit_fx=2) passive_matches,
      sum(debit_amount-credit_amount) balance
    from public.gl_impact where transaction_id=$1`,
    [taxedInvoice.transaction_id,setup.active_account_id,setup.passive_account_id]);
  assert.equal(number(taxedGl.active_matches),1,'Debe existir el debito de autorretencion en moneda local y de documento.');
  assert.equal(number(taxedGl.passive_matches),1,'Debe existir el credito de autorretencion en moneda local y de documento.');
  close(taxedGl.balance,0,'GL balance factura IVA/TC');

  await db.query(`update public.subsidiaries set applies_income_autorent=false,
    autorent_active_account_id=null,autorent_passive_account_id=null,autorent_percentage=null
    where subsidiary_id=$1`,[context.subsidiary_id]);
  const disabledPayload={...invoicePayload,invoice_number:'AUTO',exchange_rate:1,memo:'Prueba sin autorretencion',
    lines:[{...invoicePayload.lines[0],unit_price:10,tax_code_id:'',tax_rate:0}]};
  const disabled=(await one('select public.save_sales_invoice($1::jsonb,null)value',[JSON.stringify(disabledPayload)])).value;
  const disabledInvoice=await one('select * from public.invoice where invoice_id=$1',[disabled.invoiceId]);
  close(disabledInvoice.autorent_base_amount,0,'Base con configuracion apagada');
  close(disabledInvoice.autorent_percentage_applied,0,'Tasa con configuracion apagada');
  close(disabledInvoice.autorent_total_amount,0,'Importe con configuracion apagada');
  assert.equal(number((await one(`select count(*) value from public.journal_line
    where journal_id=$1 and note like 'Autorretencion de renta - %'`,[disabled.journalId])).value),0);

  await db.query('rollback');
  const installedAfter=(await one(`select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='invoice' and column_name='autorent_total_amount'
  ) value`)).value;
  assert.equal(installedAfter,installedBefore,'El rollback debe restaurar el esquema previo.');

  console.log(JSON.stringify({
    migration:installedBefore?'already-installed-revalidated':'validated-with-rollback',
    colombiaOnly:true,accountCategories:true,decimalFactor:true,
    invoice:{base:200,rate:.011,amount:2.2,receivableUnchanged:true,snapshotImmutable:true},
    creditNote:{initialBase:50,initialAmount:.55,finalBase:150,finalAmount:1.65,reversal:true,invoiceOnlyPool:true},
    debitNote:{base:30,rate:.0055,amount:.165,increase:true,snapshotImmutable:true},
    vatHeader:true,fxRate:2.5,disabledCompanyZero:true,idempotentLines:true,
    glBalanced:true,rollback:true
  }));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
