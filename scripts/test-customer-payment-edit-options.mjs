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
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260930164000_customer_payment_edit_options.sql',import.meta.url),'utf8'));

  const context=(await db.query(`select u.email,au.id auth_id,ucs.session_id,ucs.subsidiary_id
    from user_company_sessions ucs
    join users u using(user_id)
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
    (select bank_account_id from bank_account where subsidiary_id=$1 order by bank_account_id limit 1)bank_account_id,
    (select fiscal_period_id from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1)fiscal_period_id,
    (select start_date from fiscal_periods where subsidiary_id=$1 order by start_date desc limit 1)test_date,
    (select status_id from status where upper(code)='APROBADO'order by status_id limit 1)approved_status_id,
    (select status_id from status where upper(code)in('ANULADO','CANCELADO')order by status_id limit 1)cancelled_status_id,
    (select transaction_type_id from transaction_types order by transaction_type_id limit 1)transaction_type_id`,[sid])).rows[0];
  for(const [name,value]of Object.entries(catalogs))assert.ok(value,`Falta el catálogo ${name}.`);

  const stamp=`EDIT-COBRO-${Date.now()}`;
  const employee=(await db.query(`insert into employees(employee_number,first_name,last_name,subsidiary_id,is_active,is_sales_representative)
    values($1,'Prueba','Edición cobro',$2,true,true)returning employee_id`,[stamp,sid])).rows[0];
  const customer=(await db.query(`insert into customers(company_name,tax_id,primary_subsidiary_id,currency_id,sales_representative_id)
    values($1,$2,$3,$4,$5)returning customer_id`,[stamp,stamp,sid,catalogs.currency_id,employee.employee_id])).rows[0];
  const date=catalogs.test_date instanceof Date?catalogs.test_date.toISOString().slice(0,10):String(catalogs.test_date).slice(0,10);

  const makeTransaction=async(suffix,total,statusId=catalogs.approved_status_id)=>(await db.query(`insert into "transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,exchange_rate,fiscal_period_id,customer_id,total_amount,status_id)
    values($1,$2,$3,$4,$5,1,$6,$7,$8,$9)returning transaction_id`,[
      `${stamp}-TR-${suffix}`,date,catalogs.transaction_type_id,sid,catalogs.currency_id,
      catalogs.fiscal_period_id,customer.customer_id,total,statusId
    ])).rows[0];
  const makeInvoice=async(suffix,total)=>{
    const transaction=await makeTransaction(`INV-${suffix}`,total);
    return(await db.query(`insert into invoice(
        invoice_number,transaction_id,customer_id,subsidiary_id,due_date,total_amount,invoice_date,
        fiscal_period_id,currency_id,exchange_rate,subtotal_amount,tax_total,withholding_total,receivable_amount)
      values($1,$2,$3,$4,$5,$6,$5,$7,$8,1,$6,0,0,$6)returning invoice_id`,[
        `${stamp}-INV-${suffix}`,transaction.transaction_id,customer.customer_id,sid,date,total,
        catalogs.fiscal_period_id,catalogs.currency_id
      ])).rows[0];
  };
  const makePayment=async(suffix,total,status='APROBADO',transactionStatus=catalogs.approved_status_id)=>{
    const transaction=await makeTransaction(`PAY-${suffix}`,total,transactionStatus);
    return(await db.query(`insert into customer_payment(
        payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,
        currency_id,exchange_rate,fiscal_period_id,status)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9)returning payment_id`,[
        `${stamp}-PAY-${suffix}`,transaction.transaction_id,customer.customer_id,catalogs.bank_account_id,
        date,total,catalogs.currency_id,catalogs.fiscal_period_id,status
      ])).rows[0];
  };
  const makeNote=async(kind,suffix,invoiceId,amount,statusId)=>{
    const transaction=await makeTransaction(`${kind}-${suffix}`,amount,statusId);
    if(kind==='DN')return(await db.query(`insert into debit_note(
        dn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning dn_id`,[
        `${stamp}-DN-${suffix}`,transaction.transaction_id,customer.customer_id,invoiceId,amount,date,
        catalogs.fiscal_period_id,catalogs.currency_id
      ])).rows[0];
    return(await db.query(`insert into credit_note(
        cn_number,transaction_id,customer_id,invoice_id,amount,note_date,fiscal_period_id,currency_id,exchange_rate)
      values($1,$2,$3,$4,$5,$6,$7,$8,1)returning cn_id`,[
        `${stamp}-CN-${suffix}`,transaction.transaction_id,customer.customer_id,invoiceId,amount,date,
        catalogs.fiscal_period_id,catalogs.currency_id
      ])).rows[0];
  };

  const settled=await makeInvoice('SETTLED',100);
  const adjusted=await makeInvoice('ADJUSTED',200);
  await makeNote('DN','ACTIVE',adjusted.invoice_id,20,catalogs.approved_status_id);
  await makeNote('CN','ACTIVE',adjusted.invoice_id,30,catalogs.approved_status_id);
  await makeNote('CN','CANCELLED',adjusted.invoice_id,99,catalogs.cancelled_status_id);

  const editedPayment=await makePayment('EDITED',140);
  await db.query(`insert into customer_payment_application(payment_id,invoice_id,amount,application_date)
    values($1,$2,100,$4),($1,$3,40,$4)`,[editedPayment.payment_id,settled.invoice_id,adjusted.invoice_id,date]);
  const otherPayment=await makePayment('OTHER',50);
  await db.query(`insert into customer_payment_application(payment_id,invoice_id,amount,application_date)
    values($1,$2,50,$3)`,[otherPayment.payment_id,adjusted.invoice_id,date]);
  const cancelledPayment=await makePayment('CANCELLED',80,'ANULADO',catalogs.cancelled_status_id);
  await db.query(`insert into customer_payment_application(payment_id,invoice_id,amount,application_date)
    values($1,$2,80,$3)`,[cancelledPayment.payment_id,adjusted.invoice_id,date]);

  await db.query('set local role authenticated');
  const createOptions=(await db.query('select customer_payment_options() value')).rows[0].value;
  assert.ok(!createOptions.invoices.some(row=>String(row.id)===String(settled.invoice_id)),
    'La consulta de creación no debe reabrir una factura saldada.');

  const editOptions=(await db.query('select customer_payment_edit_options($1) value',[editedPayment.payment_id])).rows[0].value;
  const settledRow=editOptions.invoices.find(row=>String(row.id)===String(settled.invoice_id));
  const adjustedRow=editOptions.invoices.find(row=>String(row.id)===String(adjusted.invoice_id));
  assert.ok(settledRow,'La edición omitió una factura saldada por el cobro actual.');
  assert.equal(Number(settledRow.balance),0);
  assert.equal(Number(settledRow.currentApplied),100);
  assert.equal(Number(settledRow.editableBalance),100);
  assert.ok(adjustedRow,'La edición omitió una factura parcialmente aplicada.');
  assert.equal(Number(adjustedRow.debitNotes),20);
  assert.equal(Number(adjustedRow.creditNotes),30,'Una nota anulada afectó el saldo editable.');
  assert.equal(Number(adjustedRow.paid),90,'Un cobro anulado afectó el saldo editable.');
  assert.equal(Number(adjustedRow.currentApplied),40);
  assert.equal(Number(adjustedRow.balance),100);
  assert.equal(Number(adjustedRow.editableBalance),140,
    'El máximo editable debe excluir una sola vez el cobro actual.');

  const otherOptions=(await db.query('select customer_payment_edit_options($1) value',[otherPayment.payment_id])).rows[0].value;
  assert.ok(!otherOptions.invoices.some(row=>String(row.id)===String(settled.invoice_id)),
    'Editar otro cobro reabrió una factura ajena ya saldada.');

  await db.query('savepoint cancelled_payment');
  let cancelledRejected=false;
  try{await db.query('select customer_payment_edit_options($1)',[cancelledPayment.payment_id])}
  catch(error){cancelledRejected=/anulado o cancelado/i.test(String(error.message));await db.query('rollback to savepoint cancelled_payment')}
  assert.ok(cancelledRejected,'La RPC permitió editar un cobro anulado o cancelado.');

  await db.query('savepoint invalid_payment');
  let invalidRejected=false;
  try{await db.query('select customer_payment_edit_options($1)',[Number.MAX_SAFE_INTEGER])}
  catch(error){invalidRejected=/Cobro no encontrado/i.test(String(error.message));await db.query('rollback to savepoint invalid_payment')}
  assert.ok(invalidRejected,'La RPC de edición aceptó un cobro fuera del alcance activo.');

  const overloads=(await db.query(`select count(*)::int total from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'and p.proname='customer_payment_options'and p.pronargs>0`)).rows[0].total;
  assert.equal(overloads,0,'Se creó un overload ambiguo de customer_payment_options().');

  console.log(JSON.stringify({
    database:true,settledInvoiceIncluded:true,currentAmounts:true,editableBalance:true,
    notesAndCancelledStates:true,cancelledPaymentRejected:true,scopeGuard:true,noAmbiguousOverload:true,rollback:true
  }));
  await db.query('reset role');
  await db.query('rollback');
}catch(error){
  try{await db.query('reset role');await db.query('rollback')}catch{}
  throw error;
}finally{
  await db.end();
}
