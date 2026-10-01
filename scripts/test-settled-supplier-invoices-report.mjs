import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260930165000_settled_supplier_invoices_report.sql',import.meta.url),'utf8'));
  const context=(await db.query(`select u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id
    from user_company_sessions ucs join users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    where exists(select 1 from bank_account b where b.subsidiary_id=ucs.subsidiary_id)
      and exists(select 1 from fiscal_periods f where f.subsidiary_id=ucs.subsidiary_id)
    order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(context,'Se requiere una sesión activa con banco y período fiscal.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[
    JSON.stringify({sub:context.auth_id,email:context.email,session_id:context.session_id,role:'authenticated'})
  ]);
  const sid=(await db.query('select active_subsidiary_id() sid')).rows[0].sid;
  assert.equal(String(sid),String(context.subsidiary_id));
  const catalogs=(await db.query(`select
    (select currency_id from subsidiaries where subsidiary_id=$1)currency_id,
    (select currency_id from subsidiary_currencies where subsidiary_id=$1
      and currency_id<>(select currency_id from subsidiaries where subsidiary_id=$1)order by currency_id limit 1)foreign_currency_id,
    (select bank_account_id from bank_account where subsidiary_id=$1 order by bank_account_id limit 1)bank_account_id,
    (select fiscal_period_id from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1)fiscal_period_id,
    (select start_date from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1)start_date,
    (select to_char(start_date,'YYYY-MM')from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1)period_month,
    (select status_id from status where upper(code)in('APROBADO','APPROVED','CONTABILIZADO')order by case when upper(code)='APROBADO'then 0 else 1 end limit 1)approved_status_id,
    (select status_id from status where upper(code)in('ANULADO','CANCELADO','VOID')order by case when upper(code)='ANULADO'then 0 else 1 end limit 1)cancelled_status_id,
    (select transaction_type_id from transaction_types order by transaction_type_id limit 1)transaction_type_id,
    (select tax_code_id from tax_codes order by tax_code_id limit 1)tax_code_id,
    (select account_id from chart_accounts order by account_id limit 1)account_id,
    (select journal_line_id from journal_line order by journal_line_id limit 1)source_line_id`,[sid])).rows[0];
  for(const field of['currency_id','bank_account_id','fiscal_period_id','start_date','approved_status_id','cancelled_status_id','transaction_type_id'])assert.ok(catalogs[field],`Falta el catálogo ${field}.`);

  const stamp=`SETTLED-SUPPLIER-${Date.now()}`;
  const supplier=(await db.query(`insert into suppliers(supplier_number,company_name,tax_id,primary_subsidiary_id,currency_id)
    values($1,$2,$1,$3,$4)returning supplier_id`,[stamp,`${stamp} Proveedor`,sid,catalogs.currency_id])).rows[0];
  await db.query(`insert into entity_subsidiaries(supplier_id,subsidiary_id,is_primary)
    values($1,$2,true)on conflict do nothing`,[supplier.supplier_id,sid]);
  const startIso=catalogs.start_date instanceof Date?catalogs.start_date.toISOString().slice(0,10):String(catalogs.start_date).slice(0,10);
  const start=new Date(`${startIso}T12:00:00Z`),day=offset=>{const value=new Date(start);value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10)};
  const makeTransaction=async(suffix,date,total,statusId=catalogs.approved_status_id,owner=supplier.supplier_id,rate=1)=>(await db.query(`insert into "transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,supplier_id,total_amount,status_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)returning transaction_id`,[
      `${stamp}-${suffix}`,date,catalogs.transaction_type_id,sid,catalogs.currency_id,
      rate,catalogs.fiscal_period_id,owner,total,statusId
    ])).rows[0];
  const makeInvoice=async(suffix,total,payable=total,owner=supplier.supplier_id,rate=1)=>{
    const transaction=await makeTransaction(`TR-${suffix}`,day(0),total,catalogs.approved_status_id,owner,rate);
    return(await db.query(`insert into supplier_invoice(invoice_number,transaction_id,supplier_id,subsidiary_id,due_date,total_amount,
        invoice_date,fiscal_period_id,currency_id,exchange_rate,subtotal_amount,tax_total,withholding_total,payable_amount)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,0,$11,$12)returning invoice_id`,[
        `${stamp}-${suffix}`,transaction.transaction_id,owner,sid,day(25),total,day(0),
        catalogs.fiscal_period_id,catalogs.currency_id,rate,total-payable,payable
      ])).rows[0];
  };
  const makePayment=async(suffix,invoiceId,amount,date,cashAmount=amount)=>{
    const transaction=await makeTransaction(`TR-PAY-${suffix}`,date,amount);
    const payment=(await db.query(`insert into supplier_payment(payment_number,transaction_id,supplier_id,bank_account_id,payment_date,
        amount_paid,bank_reference,currency_id,exchange_rate,fiscal_period_id,status)
      values($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'APROBADO')returning payment_id`,[
        `${stamp}-PAY-${suffix}`,transaction.transaction_id,supplier.supplier_id,catalogs.bank_account_id,date,
        Math.max(cashAmount,.01),`${stamp}-BANK-${suffix}`,catalogs.currency_id,catalogs.fiscal_period_id
      ])).rows[0];
    await db.query(`insert into supplier_payment_application(payment_id,invoice_id,amount,application_date)
      values($1,$2,$3,$4)`,[payment.payment_id,invoiceId,amount,date]);
    if(cashAmount>0)await db.query(`insert into bank_transaction(tran_date,bank_account_id,transaction_id,amount,tran_type,reference_number)
      values($1,$2,$3,$4,'EGRESO',$5)`,[date,catalogs.bank_account_id,transaction.transaction_id,-cashAmount,`${stamp}-BANK-${suffix}`]);
    return payment;
  };
  const makeCredit=async(suffix,invoiceId,amount,date,statusId=catalogs.approved_status_id)=>{
    const transaction=await makeTransaction(`TR-CN-${suffix}`,date,amount,statusId);
    return(await db.query(`insert into supplier_credit_note(cn_number,transaction_id,supplier_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning cn_id`,[
        `${stamp}-CN-${suffix}`,transaction.transaction_id,supplier.supplier_id,invoiceId,amount,date,catalogs.fiscal_period_id,catalogs.currency_id
      ])).rows[0];
  };
  const makeDebit=async(suffix,invoiceId,amount,date)=>{
    const transaction=await makeTransaction(`TR-DN-${suffix}`,date,amount);
    return(await db.query(`insert into supplier_debit_note(dn_number,transaction_id,supplier_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning dn_id`,[
        `${stamp}-DN-${suffix}`,transaction.transaction_id,supplier.supplier_id,invoiceId,amount,date,catalogs.fiscal_period_id,catalogs.currency_id
      ])).rows[0];
  };

  const paid=await makeInvoice('CASH',100),paidPayment=await makePayment('CASH',paid.invoice_id,100,day(3),75);
  if(catalogs.source_line_id)await db.query(`insert into supplier_advance_application(payment_id,source_journal_line_id,amount)
    values($1,$2,20)`,[paidPayment.payment_id,catalogs.source_line_id]);
  let paymentWithholding=0;
  if(catalogs.tax_code_id&&catalogs.account_id){
    const rule=(await db.query(`insert into supplier_invoice_withholding(invoice_id,tax_code_id,liability_account_id,calculation_base,
        base_amount,rate_percentage,withholding_amount,application_moment,recognized_at_invoice)
      values($1,$2,$3,'Total de la factura con impuestos',100,5,5,'Al aplicar el pago',false)returning invoice_withholding_id`,[
        paid.invoice_id,catalogs.tax_code_id,catalogs.account_id
      ])).rows[0];
    await db.query(`insert into supplier_payment_withholding(payment_id,invoice_id,invoice_withholding_id,tax_code_id,liability_account_id,
      base_applied,withholding_amount)values($1,$2,$3,$4,$5,100,5)`,[
        paidPayment.payment_id,paid.invoice_id,rule.invoice_withholding_id,catalogs.tax_code_id,catalogs.account_id
      ]);paymentWithholding=5;
  }
  const credited=await makeInvoice('CREDIT',200);await makeCredit('CREDIT',credited.invoice_id,200,day(4));
  const mixed=await makeInvoice('MIXED',110,100);await makePayment('MIX-A',mixed.invoice_id,60,day(5),60);
  await makeCredit('MIXED',mixed.invoice_id,40,day(6));await makeDebit('REOPEN',mixed.invoice_id,20,day(7));await makePayment('MIX-B',mixed.invoice_id,20,day(8),20);
  const voided=await makeInvoice('VOIDED',50);await makeCredit('VOIDED',voided.invoice_id,50,day(9),catalogs.cancelled_status_id);

  const allocationSupplier=(await db.query(`insert into suppliers(supplier_number,company_name,tax_id,primary_subsidiary_id,currency_id)
    values($1,$2,$1,$3,$4)returning supplier_id`,[`${stamp}-ALLOC`,`${stamp} Distribución`,sid,catalogs.currency_id])).rows[0];
  await db.query(`insert into entity_subsidiaries(supplier_id,subsidiary_id,is_primary)
    values($1,$2,true)on conflict do nothing`,[allocationSupplier.supplier_id,sid]);
  const allocationA=await makeInvoice('ALLOC-A',100,100,allocationSupplier.supplier_id);
  const allocationB=await makeInvoice('ALLOC-B',100,100,allocationSupplier.supplier_id);
  const allocationTransaction=await makeTransaction('TR-PAY-ALLOC',day(10),200,catalogs.approved_status_id,allocationSupplier.supplier_id,1.1);
  const allocationPayment=(await db.query(`insert into supplier_payment(payment_number,transaction_id,supplier_id,bank_account_id,payment_date,
      amount_paid,bank_reference,currency_id,exchange_rate,fiscal_period_id,status)
    values($1,$2,$3,$4,$5,180,$6,$7,1.1,$8,'APROBADO')returning payment_id`,[
      `${stamp}-PAY-ALLOC`,allocationTransaction.transaction_id,allocationSupplier.supplier_id,catalogs.bank_account_id,day(10),
      `${stamp}-BANK-ALLOC`,catalogs.currency_id,catalogs.fiscal_period_id
    ])).rows[0];
  await db.query(`insert into supplier_payment_application(payment_id,invoice_id,amount,application_date)
    values($1,$2,100,$4),($1,$3,100,$4)`,[allocationPayment.payment_id,allocationA.invoice_id,allocationB.invoice_id,day(10)]);
  await db.query(`insert into bank_transaction(tran_date,bank_account_id,transaction_id,amount,tran_type,reference_number)
    values($1,$2,$3,-180,'EGRESO',$4)`,[day(10),catalogs.bank_account_id,allocationTransaction.transaction_id,`${stamp}-BANK-ALLOC`]);
  if(catalogs.tax_code_id&&catalogs.account_id){
    const rule=(await db.query(`insert into supplier_invoice_withholding(invoice_id,tax_code_id,liability_account_id,calculation_base,
        base_amount,rate_percentage,withholding_amount,application_moment,recognized_at_invoice)
      values($1,$2,$3,'Total de la factura con impuestos',100,20,20,'Al aplicar el pago',false)returning invoice_withholding_id`,[
        allocationB.invoice_id,catalogs.tax_code_id,catalogs.account_id
      ])).rows[0];
    await db.query(`insert into supplier_payment_withholding(payment_id,invoice_id,invoice_withholding_id,tax_code_id,liability_account_id,
      base_applied,withholding_amount)values($1,$2,$3,$4,$5,100,20)`,[
        allocationPayment.payment_id,allocationB.invoice_id,rule.invoice_withholding_id,catalogs.tax_code_id,catalogs.account_id
      ]);
  }
  let crossCurrencySupplier=null;
  if(catalogs.foreign_currency_id){
    crossCurrencySupplier=(await db.query(`insert into suppliers(supplier_number,company_name,tax_id,primary_subsidiary_id,currency_id)
      values($1,$2,$1,$3,$4)returning supplier_id`,[`${stamp}-FX`,`${stamp} Moneda Cruzada`,sid,catalogs.currency_id])).rows[0];
    await db.query(`insert into entity_subsidiaries(supplier_id,subsidiary_id,is_primary)
      values($1,$2,true)on conflict do nothing`,[crossCurrencySupplier.supplier_id,sid]);
    const crossInvoice=await makeInvoice('FX-CREDIT',100,100,crossCurrencySupplier.supplier_id,1);
    const noteTransaction=(await db.query(`insert into "transaction"(
        tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,supplier_id,total_amount,status_id)
      values($1,$2,$3,$4,$5,2,$6,$7,50,$8)returning transaction_id`,[
        `${stamp}-TR-CN-FX`,day(11),catalogs.transaction_type_id,sid,catalogs.foreign_currency_id,
        catalogs.fiscal_period_id,crossCurrencySupplier.supplier_id,catalogs.approved_status_id
      ])).rows[0];
    await db.query(`insert into supplier_credit_note(cn_number,transaction_id,supplier_id,invoice_id,amount,note_date,
        fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,50,$5,$6,$7,2)`,[
        `${stamp}-CN-FX`,noteTransaction.transaction_id,crossCurrencySupplier.supplier_id,crossInvoice.invoice_id,day(11),
        catalogs.fiscal_period_id,catalogs.foreign_currency_id
      ]);
  }

  await db.query('set local role authenticated');
  const run=async(settlementType='ALL')=>(await db.query('select run_settled_supplier_invoice_report($1::jsonb)value',[
    JSON.stringify({periodMonth:catalogs.period_month,supplierIds:[supplier.supplier_id],settlementType,groupBySettlementType:true,page:1,pageSize:50})
  ])).rows[0].value;
  const report=await run();
  assert.equal(Number(report.total),3);assert.equal(Number(report.summary.invoiceCount),3);
  assert.equal(Number(report.summary.paymentCount),1);assert.equal(Number(report.summary.creditNoteCount),1);assert.equal(Number(report.summary.mixedCount),1);
  assert.equal(Number(report.summary.invoiceAmount),410);assert.equal(Number(report.summary.payableAmount),400);
  assert.equal(Number(report.summary.invoiceWithholdingAmount),10);assert.equal(Number(report.summary.settlementBaseAmount),420);
  assert.equal(Number(report.summary.paymentAppliedAmount),180);assert.equal(Number(report.summary.creditNoteAmount),240);assert.equal(Number(report.summary.debitNoteAmount),20);
  assert.equal(Number(report.summary.cashAmount),155);assert.equal(Number(report.summary.advanceAmount),catalogs.source_line_id?20:0);
  assert.equal(Number(report.summary.withholdingAmount),paymentWithholding);
  assert.equal(Number(report.summary.otherFundingAmount),catalogs.source_line_id?5-paymentWithholding:25-paymentWithholding);
  assert.equal(Number(report.summary.appliedAmount),420);assert.equal(Number(report.summary.overappliedAmount),0);
  const paidRow=report.rows.find(row=>row.invoiceNumber.endsWith('-CASH')),mixedRow=report.rows.find(row=>row.invoiceNumber.endsWith('-MIXED'));
  assert.equal(paidRow.settlementType,'PAYMENT');assert.equal(Number(paidRow.cashAmount),75);
  assert.equal(Number(paidRow.advanceAmount),catalogs.source_line_id?20:0);assert.equal(Number(paidRow.withholdingAmount),paymentWithholding);
  assert.equal(mixedRow.settlementType,'MIXED');assert.equal(Number(mixedRow.invoiceWithholdingAmount),10);
  assert.equal(String(mixedRow.settlementDate).slice(0,10),day(8));assert.ok(mixedRow.applications.some(item=>item.type==='DEBIT_NOTE'));
  assert.ok(!report.rows.some(row=>row.invoiceNumber.endsWith('-VOIDED')),'Una nota anulada liquidó indebidamente una factura.');
  const cashOnly=await run('CASH_PAYMENTS_ONLY');assert.equal(Number(cashOnly.total),2);
  const creditsOnly=await run('CREDIT_NOTES_ONLY');assert.equal(Number(creditsOnly.total),1);
  const options=(await db.query('select settled_supplier_invoice_report_options()value')).rows[0].value;
  assert.ok(options.suppliers.some(item=>String(item.id)===String(supplier.supplier_id)));
  const allocationReport=(await db.query('select run_settled_supplier_invoice_report($1::jsonb)value',[
    JSON.stringify({periodMonth:catalogs.period_month,supplierIds:[allocationSupplier.supplier_id],settlementType:'ALL',page:1,pageSize:50})
  ])).rows[0].value;
  assert.equal(Number(allocationReport.total),2);
  assert.equal(Number(allocationReport.summary.overappliedAmount),0,'Una diferencia cambiaria no puede mostrarse como sobreaplicación.');
  assert.equal(Number(allocationReport.summary.exchangeDifferenceAmount),20);
  assert.equal(Number(allocationReport.summary.paymentAppliedAmount),220);
  assert.equal(Number(allocationReport.summary.cashAmount),198);
  assert.equal(Number(allocationReport.summary.withholdingAmount),catalogs.tax_code_id&&catalogs.account_id?22:0);
  assert.equal(Number(allocationReport.summary.otherFundingAmount),catalogs.tax_code_id&&catalogs.account_id?0:22);
  for(const row of allocationReport.rows){
    const composition=Number(row.cashAmount)+Number(row.advanceAmount)+Number(row.withholdingAmount)+Number(row.otherFundingAmount);
    assert.ok(Math.abs(composition-Number(row.paymentAmount))<0.000001,`El pago ${row.invoiceNumber} no reconcilia por fuente.`);
  }
  if(catalogs.tax_code_id&&catalogs.account_id){
    const rowA=allocationReport.rows.find(row=>row.invoiceNumber.endsWith('ALLOC-A'));
    const rowB=allocationReport.rows.find(row=>row.invoiceNumber.endsWith('ALLOC-B'));
    assert.equal(Number(rowA.cashAmount),100);assert.equal(Number(rowA.withholdingAmount),0);
    assert.equal(Number(rowB.cashAmount),80);assert.equal(Number(rowB.withholdingAmount),20);
  }
  if(crossCurrencySupplier){
    const crossReport=(await db.query('select run_settled_supplier_invoice_report($1::jsonb)value',[
      JSON.stringify({periodMonth:catalogs.period_month,supplierIds:[crossCurrencySupplier.supplier_id],settlementType:'ALL',page:1,pageSize:50})
    ])).rows[0].value;
    assert.equal(Number(crossReport.total),1);assert.equal(Number(crossReport.rows[0].creditNoteAmount),100);
    assert.equal(Number(crossReport.rows[0].rawBalance),0);assert.equal(Number(crossReport.summary.appliedAmount),100);
  }
  console.log(JSON.stringify({database:true,paid:1,creditNote:1,mixed:1,reopenedAndResettled:true,voidedExcluded:true,
    cashFlowAllocation:true,multiInvoiceFunding:true,exchangeDifference:true,crossCurrency:Boolean(crossCurrencySupplier),advanceBreakdown:Boolean(catalogs.source_line_id),invoiceWithholding:true,paymentWithholding:paymentWithholding>0,filters:true,scope:true,rollback:true}));
  await db.query('reset role');await db.query('rollback');
}catch(error){try{await db.query('reset role');await db.query('rollback')}catch{}throw error}
finally{await db.end()}
