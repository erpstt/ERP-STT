import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

const close=(actual,expected,tolerance=.005)=>Math.abs(Number(actual)-Number(expected))<=tolerance;
const invoiceNumbers=['FAC-00000669','FAC-00000670','FAC-00000671','FAC-00000672','FAC-00000673'];
const expectedInvoiceTotals=new Map([
  ['FAC-00000669',27657.52],['FAC-00000670',9558.80],['FAC-00000671',8989.58],
  ['FAC-00000672',8259.18],['FAC-00000673',9318.43]
]);
const expectedApplications=new Map([
  ['FAC-00000669',27657.52],['FAC-00000670',9558.80],['FAC-00000671',8989.58],
  ['FAC-00000672',8259.18],['FAC-00000673',9318.43]
]);
const expectedPayments=new Map([
  [69,{number:'COB_CLI-20261026194153919',applied:35916.70,bank:35887.09,fee:29.61,arLocal:5710173.449460,gainLocal:23751.713710}],
  [70,{number:'COB_CLI-20261026200218988',applied:27866.81,bank:27837.20,fee:29.61,arLocal:4430371.347678,gainLocal:18428.321453}]
]);

await db.connect();
try{
  await db.query('begin transaction read only');

  const installation=(await db.query(`select
    to_regprocedure('public.sales_invoice_official_exchange_rate(bigint,date,bigint)')is not null resolver,
    to_regprocedure('public.save_sales_invoice_before_fx_guard(jsonb,bigint)')is not null inner_save,
    to_regprocedure('public.apply_customer_payment_receivable_accounts(bigint,numeric)')is not null payment_rebuild,
    to_regclass('public.sales_invoice_fx_correction_audit')is not null audit_table,
    position('sales_invoice_official_exchange_rate' in
      pg_get_functiondef('public.save_sales_invoice(jsonb,bigint)'::regprocedure))>0 guarded_save`)).rows[0];
  for(const [key,value] of Object.entries(installation))assert.equal(value,true,`Instalación FX incompleta: ${key}.`);

  const currencies=(await db.query(`select currency_id,currency_code from currencies
    where currency_code in('USD','JMD')`)).rows;
  const usd=currencies.find(row=>row.currency_code==='USD');
  assert.ok(usd,'No existe la moneda USD.');
  const official=Number((await db.query(
    `select public.sales_invoice_official_exchange_rate($1,'2026-10-19',$2) rate`,
    [usd.currency_id,24]
  )).rows[0].rate);
  assert.ok(close(official,158.9838,.000000001),`La tasa oficial resuelta fue ${official}.`);

  const invoices=(await db.query(`select invoice.invoice_id,invoice.invoice_number,
      to_char(invoice.invoice_date,'YYYY-MM-DD') invoice_date,invoice.total_amount,invoice.exchange_rate invoice_rate,
      tran.exchange_rate transaction_rate,journal.exchange_rate journal_rate,
      journal.journal_id,tran.transaction_id,
      coalesce(sum(impact.debit_amount),0) local_debit,
      coalesce(sum(impact.credit_amount),0) local_credit
    from invoice
    join "transaction" tran using(transaction_id)
    join journal using(journal_id)
    left join gl_impact impact on impact.transaction_id=tran.transaction_id
    left join accounting_books book on book.accounting_book_id=impact.accounting_book_id
    where invoice.subsidiary_id=24 and invoice.invoice_number=any($1)
      and(impact.gl_impact_id is null or book.is_primary)
    group by invoice.invoice_id,invoice.invoice_number,invoice.invoice_date,
      invoice.total_amount,invoice.exchange_rate,tran.exchange_rate,
      journal.exchange_rate,journal.journal_id,tran.transaction_id
    order by invoice.invoice_number`,[invoiceNumbers])).rows;
  assert.equal(invoices.length,5,'No se encontraron exactamente las cinco facturas reparadas.');
  for(const invoice of invoices){
    assert.equal(String(invoice.invoice_date).slice(0,10),'2026-10-19');
    assert.ok(close(invoice.total_amount,expectedInvoiceTotals.get(invoice.invoice_number)),`Cambió el total original de ${invoice.invoice_number}.`);
    assert.ok(close(invoice.invoice_rate,official,.000000001),`Tasa incorrecta en invoice para ${invoice.invoice_number}.`);
    assert.ok(close(invoice.transaction_rate,official,.000000001),`Tasa incorrecta en transaction para ${invoice.invoice_number}.`);
    assert.ok(close(invoice.journal_rate,official,.000000001),`Tasa incorrecta en journal para ${invoice.invoice_number}.`);
    const expectedLocal=Number(invoice.total_amount)*official;
    assert.ok(close(invoice.local_debit,expectedLocal),`Débito local incorrecto en ${invoice.invoice_number}.`);
    assert.ok(close(invoice.local_credit,expectedLocal),`Crédito local incorrecto en ${invoice.invoice_number}.`);
  }

  const applications=(await db.query(`select invoice.invoice_number,application.payment_id,
      application.amount
    from customer_payment_application application
    join invoice using(invoice_id)
    where invoice.invoice_number=any($1)
    order by invoice.invoice_number`,[invoiceNumbers])).rows;
  assert.equal(applications.length,5,'Se alteró la cantidad de aplicaciones de las facturas.');
  for(const application of applications){
    assert.ok(expectedPayments.has(Number(application.payment_id)),`Pago inesperado ${application.payment_id}.`);
    assert.ok(close(application.amount,expectedApplications.get(application.invoice_number)),`Cambió la aplicación de ${application.invoice_number}.`);
  }

  for(const [paymentId,expected] of expectedPayments){
    const payment=(await db.query(`select payment.payment_number,payment.exchange_rate,
        payment.amount_received,payment.journal_id,payment.transaction_id,
        coalesce(fee.amount,0) fee
      from customer_payment payment
      left join customer_payment_bank_fee fee using(payment_id)
      where payment.payment_id=$1`,[paymentId])).rows[0];
    assert.ok(payment,`No existe el cobro ${paymentId}.`);
    assert.equal(payment.payment_number,expected.number);
    assert.ok(close(payment.exchange_rate,159.6451,.000000001),`Cambió la tasa del cobro ${paymentId}.`);
    assert.ok(close(payment.amount_received,expected.applied),`Cambió el total del cobro ${paymentId}.`);
    assert.ok(close(payment.fee,expected.fee),`Cambió la comisión del cobro ${paymentId}.`);

    const journal=(await db.query(`select
        coalesce(sum(line.debit),0) debit,coalesce(sum(line.credit),0) credit,
        coalesce(sum(case when account.account_number='111005' then line.debit else 0 end),0) bank,
        coalesce(sum(case when account.account_number='631002' then line.debit else 0 end),0) fee
      from journal_line line join chart_accounts account using(account_id)
      where line.journal_id=$1`,[payment.journal_id])).rows[0];
    assert.ok(close(journal.debit,journal.credit),`El asiento del cobro ${paymentId} no cuadra en moneda transaccional.`);
    assert.ok(close(journal.bank,expected.bank),`Cambió el ingreso bancario neto del cobro ${paymentId}.`);
    assert.ok(close(journal.fee,expected.fee),`Cambió la línea de comisión del cobro ${paymentId}.`);

    const ledger=(await db.query(`select
        coalesce(sum(impact.debit_amount),0) debit,
        coalesce(sum(impact.credit_amount),0) credit,
        coalesce(sum(case when account.account_number='113001' then impact.credit_amount else 0 end),0) ar_credit,
        coalesce(sum(case when account.account_number='422001' then impact.credit_amount else 0 end),0) fx_gain
      from gl_impact impact
      join chart_accounts account using(account_id)
      join accounting_books book using(accounting_book_id)
      where impact.transaction_id=$1 and book.is_primary`,[payment.transaction_id])).rows[0];
    assert.ok(close(ledger.debit,ledger.credit),`El Mayor del cobro ${paymentId} no cuadra.`);
    assert.ok(close(ledger.ar_credit,expected.arLocal),`La CxC del cobro ${paymentId} no usa la tasa histórica de sus facturas.`);
    assert.ok(close(ledger.fx_gain,expected.gainLocal),`La ganancia cambiaria del cobro ${paymentId} es incorrecta.`);
  }

  const reconciliation=(await db.query(`with invoice_side as(
      select coalesce(sum(impact.debit_amount-impact.credit_amount),0) amount
      from invoice join gl_impact impact using(transaction_id)
      join chart_accounts account using(account_id)
      join accounting_books book using(accounting_book_id)
      where invoice.invoice_number=any($1) and account.account_number='113001' and book.is_primary
    ),payment_side as(
      select coalesce(sum(impact.credit_amount-impact.debit_amount),0) amount
      from customer_payment payment join gl_impact impact using(transaction_id)
      join chart_accounts account using(account_id)
      join accounting_books book using(accounting_book_id)
      where payment.payment_id=any($2) and account.account_number='113001' and book.is_primary
    ),gain as(
      select coalesce(sum(impact.credit_amount-impact.debit_amount),0) amount
      from customer_payment payment join gl_impact impact using(transaction_id)
      join chart_accounts account using(account_id)
      join accounting_books book using(accounting_book_id)
      where payment.payment_id=any($2) and account.account_number='422001' and book.is_primary
    )select invoice_side.amount invoice_ar,payment_side.amount payment_ar,
      invoice_side.amount-payment_side.amount ar_difference,gain.amount fx_gain
    from invoice_side,payment_side,gain`,[invoiceNumbers,[69,70]])).rows[0];
  assert.ok(close(reconciliation.invoice_ar,10140544.797138),'El total local de las facturas no coincide.');
  assert.ok(close(reconciliation.payment_ar,10140544.797138),'Los cobros no cancelan la CxC histórica.');
  assert.ok(close(reconciliation.ar_difference,0),'La CxC local conserva un saldo después de los cobros.');
  assert.ok(close(reconciliation.fx_gain,42180.035163),'La ganancia cambiaria realizada total no coincide.');

  const auditCount=Number((await db.query(`select count(*) count
    from sales_invoice_fx_correction_audit where invoice_id=any(
      select invoice_id from invoice where invoice_number=any($1)
    )`,[invoiceNumbers])).rows[0].count);
  assert.equal(auditCount,5,'La reparación no dejó una traza por cada factura.');

  console.log(JSON.stringify({
    passed:true,invoicesCorrected:invoices.length,officialRate:official,
    invoiceLocalTotal:Number(reconciliation.invoice_ar),
    realizedFxGain:Number(reconciliation.fx_gain),paymentsBalanced:true,
    receivableCleared:true,applicationsPreserved:true,bankAndFeesPreserved:true,
    auditRows:auditCount,readOnly:true
  }));
  await db.query('rollback');
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{await db.end();}
