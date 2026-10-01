import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false}
});

await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260930161500_settled_sales_invoice_report_precision.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/20260930163000_settled_sales_invoice_funding_breakdown.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/20260930163500_customer_receivable_application_guard.sql',import.meta.url),'utf8'));
  const ctx=(await db.query(`select u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id
    from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)
    where exists(select 1 from bank_account b where b.subsidiary_id=ucs.subsidiary_id)
      and exists(select 1 from fiscal_periods f where f.subsidiary_id=ucs.subsidiary_id)
    order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(ctx,'Se requiere una sesión activa con banco y período fiscal.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ctx.auth_id,email:ctx.email,session_id:ctx.session_id,role:'authenticated'})]);
  const sid=(await db.query('select active_subsidiary_id() sid')).rows[0].sid;
  assert.equal(String(sid),String(ctx.subsidiary_id));
  const sub=(await db.query('select currency_id from subsidiaries where subsidiary_id=$1',[sid])).rows[0];
  const period=(await db.query(`select fiscal_period_id,start_date,end_date,to_char(start_date,'YYYY-MM') period_month
    from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1`,[sid])).rows[0];
  const bank=(await db.query('select bank_account_id from bank_account where subsidiary_id=$1 order by bank_account_id limit 1',[sid])).rows[0];
  const approved=(await db.query("select status_id from status where upper(code) in('APROBADO','APPROVED','CONTABILIZADO') order by case when upper(code)='APROBADO'then 0 else 1 end limit 1")).rows[0];
  const cancelled=(await db.query("select status_id from status where upper(code) in('ANULADO','CANCELADO','VOID') order by case when upper(code)='ANULADO'then 0 else 1 end limit 1")).rows[0];
  const type=(await db.query('select transaction_type_id from transaction_types order by transaction_type_id limit 1')).rows[0];
  assert.ok(sub&&period&&bank&&approved&&cancelled&&type,'Faltan catálogos para la prueba.');
  const stamp=`SETTLED-${Date.now()}`;
  const rep=(await db.query(`insert into employees(employee_number,first_name,last_name,subsidiary_id,is_active,is_sales_representative)
    values($1,'Reporte','Liquidaciones',$2,true,true)returning employee_id`,[stamp,sid])).rows[0];
  const customer=(await db.query(`insert into customers(company_name,tax_id,primary_subsidiary_id,currency_id,sales_representative_id)
    values($1,$2,$3,$4,$5)returning customer_id`,[`${stamp} Cliente`,stamp,sid,sub.currency_id,rep.employee_id])).rows[0];
  const startIso=period.start_date instanceof Date?period.start_date.toISOString().slice(0,10):String(period.start_date).slice(0,10);
  const start=new Date(`${startIso}T12:00:00Z`);
  const day=offset=>{const d=new Date(start);d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10)};
  const makeTransaction=async(suffix,date,total,statusId=approved.status_id)=>
    (await db.query(`insert into "transaction"(tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,customer_id,total_amount,status_id)
      values($1,$2,$3,$4,$5,1,$6,$7,$8,$9)returning transaction_id`,[`${stamp}-${suffix}`,date,type.transaction_type_id,sid,sub.currency_id,period.fiscal_period_id,customer.customer_id,total,statusId])).rows[0];
  const makeInvoice=async(suffix,total)=>{
    const transaction=await makeTransaction(`TR-${suffix}`,day(0),total);
    return(await db.query(`insert into invoice(invoice_number,transaction_id,customer_id,subsidiary_id,due_date,total_amount,invoice_date,fiscal_period_id,currency_id,exchange_rate,subtotal_amount,tax_total,withholding_total,receivable_amount)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$6,0,0,$6)returning invoice_id,sales_representative_id`,[`${stamp}-${suffix}`,transaction.transaction_id,customer.customer_id,sid,day(25),total,day(0),period.fiscal_period_id,sub.currency_id])).rows[0];
  };
  const makePayment=async(suffix,invoiceId,amount,date,cashAmount=amount)=>{
    const transaction=await makeTransaction(`TR-PAY-${suffix}`,date,amount);
    const payment=(await db.query(`insert into customer_payment(payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,currency_id,exchange_rate,fiscal_period_id,status)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,'APROBADO')returning payment_id`,[`${stamp}-PAY-${suffix}`,transaction.transaction_id,customer.customer_id,bank.bank_account_id,date,amount,sub.currency_id,period.fiscal_period_id])).rows[0];
    await db.query(`insert into customer_payment_application(payment_id,invoice_id,amount,application_date)values($1,$2,$3,$4)`,[payment.payment_id,invoiceId,amount,date]);
    if(cashAmount>0)await db.query(`insert into bank_transaction(tran_date,bank_account_id,transaction_id,amount,tran_type,reference_number)
      values($1,$2,$3,$4,'INGRESO',$5)`,[date,bank.bank_account_id,transaction.transaction_id,cashAmount,`${stamp}-BANK-${suffix}`]);
    return payment;
  };
  const makeCredit=async(suffix,invoiceId,amount,date,statusId=approved.status_id)=>{
    const transaction=await makeTransaction(`TR-CN-${suffix}`,date,amount,statusId);
    return(await db.query(`insert into credit_note(cn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning cn_id`,[`${stamp}-CN-${suffix}`,transaction.transaction_id,customer.customer_id,invoiceId,amount,date,period.fiscal_period_id,sub.currency_id])).rows[0];
  };
  const makeDebit=async(suffix,invoiceId,amount,date)=>{
    const transaction=await makeTransaction(`TR-DN-${suffix}`,date,amount);
    return(await db.query(`insert into debit_note(dn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning dn_id`,[`${stamp}-DN-${suffix}`,transaction.transaction_id,customer.customer_id,invoiceId,amount,date,period.fiscal_period_id,sub.currency_id])).rows[0];
  };

  const paid=await makeInvoice('CASH',100);assert.equal(String(paid.sales_representative_id),String(rep.employee_id));
  const paidPayment=await makePayment('CASH',paid.invoice_id,100,day(3),80);
  const advanceSource=(await db.query('select journal_line_id from journal_line order by journal_line_id limit 1')).rows[0];
  assert.ok(advanceSource,'Se requiere una línea contable para simular un anticipo aplicado.');
  await db.query('insert into customer_advance_application(payment_id,source_journal_line_id,amount)values($1,$2,20)',[paidPayment.payment_id,advanceSource.journal_line_id]);
  const credited=await makeInvoice('CREDIT',200);await makeCredit('CREDIT',credited.invoice_id,200,day(4));
  const mixed=await makeInvoice('MIXED',100);
  await makePayment('MIX-A',mixed.invoice_id,60,day(5),60);
  await makeCredit('MIXED',mixed.invoice_id,40,day(6));
  const mixedDebit=await makeDebit('REOPEN',mixed.invoice_id,20,day(7));
  await makePayment('MIX-B',mixed.invoice_id,20,day(8),20);
  const voided=await makeInvoice('VOIDED',50);await makeCredit('VOIDED',voided.invoice_id,50,day(9),cancelled.status_id);
  await db.query('update customers set sales_representative_id=null where customer_id=$1',[customer.customer_id]);

  await db.query('set local role authenticated');
  const run=async(settlementType='ALL')=>(await db.query('select run_settled_sales_invoice_report($1::jsonb)value',[JSON.stringify({periodMonth:period.period_month,salesRepresentativeIds:[rep.employee_id],settlementType,groupBySettlementType:true,page:1,pageSize:50})])).rows[0].value;
  const report=await run();
  assert.equal(Number(report.total),3);
  assert.equal(Number(report.summary.invoiceCount),3);
  assert.equal(Number(report.summary.paymentCount),1);
  assert.equal(Number(report.summary.creditNoteCount),1);
  assert.equal(Number(report.summary.mixedCount),1);
  assert.equal(Number(report.summary.invoiceAmount),400);
  assert.equal(Number(report.summary.cashAmount),160);
  assert.equal(Number(report.summary.paymentAppliedAmount),180);
  assert.equal(Number(report.summary.creditNoteAmount),240);
  assert.equal(Number(report.summary.debitNoteAmount),20);
  assert.equal(Number(report.summary.advanceAmount),20);
  assert.equal(Number(report.summary.withholdingAmount),0);
  assert.equal(Number(report.summary.otherFundingAmount),0);
  assert.equal(Number(report.summary.settlementBaseAmount),420);
  assert.equal(Number(report.summary.appliedAmount),420);
  assert.equal(Number(report.summary.overappliedAmount),0);
  assert.ok(report.rows.every(row=>String(row.salesRepresentativeId)===String(rep.employee_id)),'No se conservó el vendedor histórico.');
  assert.ok(!report.rows.some(row=>row.invoiceNumber.endsWith('-VOIDED')),'Una nota anulada liquidó indebidamente una factura.');
  const paidRow=report.rows.find(row=>row.invoiceNumber.endsWith('-CASH'));
  const mixedRow=report.rows.find(row=>row.invoiceNumber.endsWith('-MIXED'));
  assert.equal(paidRow.settlementType,'PAYMENT');assert.equal(Number(paidRow.cashAmount),80);assert.equal(Number(paidRow.advanceAmount),20);
  assert.equal(Number(paidRow.paymentAmount),100);assert.equal(Number(paidRow.cashAmount)+Number(paidRow.advanceAmount)+Number(paidRow.withholdingAmount)+Number(paidRow.otherFundingAmount),100);
  assert.equal(mixedRow.settlementType,'MIXED');assert.equal(String(mixedRow.settlementDate).slice(0,10),day(8));
  assert.ok(mixedRow.applications.some(item=>item.type==='DEBIT_NOTE'),'No se mostró la reapertura por nota de débito.');
  await db.query('savepoint debit_guard_test');let debitGuardRejected=false;
  try{await db.query('delete from debit_note where dn_id=$1',[mixedDebit.dn_id])}catch(error){debitGuardRejected=/quedaría sobreaplicada/i.test(String(error.message));await db.query('rollback to savepoint debit_guard_test')}
  assert.ok(debitGuardRejected,'La validación permitió eliminar una nota de débito que sostiene el saldo liquidado.');
  const cashOnly=await run('CASH_PAYMENTS_ONLY');assert.equal(Number(cashOnly.total),2);assert.ok(cashOnly.rows.some(row=>row.settlementType==='MIXED'));
  const creditsOnly=await run('CREDIT_NOTES_ONLY');assert.equal(Number(creditsOnly.total),1);assert.equal(creditsOnly.rows[0].settlementType,'CREDIT_NOTE');
  const options=(await db.query('select settled_sales_invoice_report_options()value')).rows[0].value;
  assert.ok(options.salesRepresentatives.some(item=>String(item.id)===String(rep.employee_id)));
  const guarded=await makeInvoice('GUARD',100);await makeCredit('GUARD',guarded.invoice_id,30,day(10));
  await db.query('savepoint guard_test');let guardRejected=false;
  try{await makePayment('GUARD',guarded.invoice_id,71,day(11),71)}catch(error){guardRejected=/saldo (pendiente|máximo)/i.test(String(error.message));await db.query('rollback to savepoint guard_test')}
  assert.ok(guardRejected,'La validación permitió aplicar más del saldo después de notas de crédito/débito.');
  console.log(JSON.stringify({database:true,snapshotSeller:true,paid:1,creditNote:1,mixed:1,reopenedAndResettled:true,voidedExcluded:true,cashFlowAllocation:true,advanceBreakdown:true,receivableGuard:true,debitNoteGuard:true,filters:true,rollback:true}));
  await db.query('reset role');
  await db.query('rollback');
}catch(error){
  try{await db.query('reset role');await db.query('rollback')}catch{}
  throw error;
}finally{await db.end()}
