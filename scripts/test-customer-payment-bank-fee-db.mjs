import assert from 'node:assert/strict';
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

const close=(left,right,tolerance=.00001)=>Math.abs(Number(left)-Number(right))<=tolerance;
await db.connect();
try{
  await db.query('begin');
  const session=(await db.query(`select users.email,users.auth_user_id,session.session_id,session.subsidiary_id
    from user_company_sessions session join users using(user_id)
    where session.subsidiary_id is not null order by session.selected_at desc limit 1`)).rows[0];
  assert.ok(session,'Se requiere una sesión activa para probar cobros.');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:session.auth_user_id,email:session.email,session_id:session.session_id})]);

  const options=(await db.query('select public.customer_payment_options() value')).rows[0].value;
  const invoices=(options.invoices||[]).filter(invoice=>Number(invoice.balance)>.02)
    .sort((left,right)=>Number(String(right.currencyId)===String(options.subsidiary.currencyId))-Number(String(left.currencyId)===String(options.subsidiary.currencyId)));
  let selected;
  for(const invoice of invoices){
    const hasPaymentWithholding=(await db.query(`select exists(select 1 from sales_invoice_withholding
      where invoice_id=$1 and application_moment='Al aplicar el pago') value`,[invoice.id])).rows[0].value;
    if(!hasPaymentWithholding){selected=invoice;break;}
  }
  assert.ok(selected,'Se requiere una factura pendiente sin retención al cobro.');
  const account=(options.accounts||[]).find(item=>String(item.currencyId)===String(selected.currencyId));
  const today=new Date().toLocaleDateString('en-CA'),period=(options.periods||[]).find(item=>periodContains(item,today))
    ||[...(options.periods||[])].sort((left,right)=>String(right.end).localeCompare(String(left.end)))[0],paymentDate=periodContains(period,today)?today:period.end;
  assert.ok(account&&period,'Se requiere cuenta bancaria y período abierto en la moneda de la factura.');
  assert.ok((await db.query('select public.bank_fee_expense_account($1) id',[session.subsidiary_id])).rows[0].id,'Falta configurar la cuenta de comisiones bancarias.');

  const gross=Math.min(Number(selected.balance),100),fee=gross>30?29.61:.01;
  const before=Number((await db.query('select balance from bank_account where bank_account_id=$1',[account.id])).rows[0].balance);
  if(String(account.currencyId)!==String(options.subsidiary.currencyId))await db.query(`insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)
    values($1,$2,$3,1.25)on conflict(from_currency_id,to_currency_id,effective_date)do nothing`,[account.currencyId,options.subsidiary.currencyId,paymentDate]);
  const payload={customer_id:selected.customerId,account_id:account.id,date:paymentDate,period_id:period.id,location_id:options.location?.id||'',rate:1,reference:'PRUEBA-COMISION-COBRO',memo:'Prueba reversible de comisión integrada',applications:[{invoice_id:selected.id,amount:gross}],advances:[],bank_fee_amount:fee};
  const saved=(await db.query('select public.save_customer_payment_with_advances($1::jsonb,null) value',[JSON.stringify(payload)])).rows[0].value;
  const net=Number(saved.cashTotal);
  assert.ok(close(saved.grossTotal??saved.total,gross),'El total aplicado no coincide.');
  assert.ok(close(saved.bankFeeTotal,fee),'La comisión devuelta no coincide.');
  assert.ok(close(net,gross-fee),'El ingreso bancario neto no coincide.');

  const stored=(await db.query(`select fee.amount fee_amount,fee.expense_account_id,
      bank_transaction.amount bank_amount,bank_account.balance,journal.total_debit,journal.total_credit,
      payment.journal_id,payment.bank_account_id
    from customer_payment payment join customer_payment_bank_fee fee using(payment_id)
    join bank_transaction on bank_transaction.transaction_id=payment.transaction_id
    join bank_account on bank_account.bank_account_id=payment.bank_account_id
    join journal on journal.journal_id=payment.journal_id
    where payment.payment_id=$1`,[saved.id])).rows[0];
  assert.ok(stored,'No se persistió el detalle de la comisión.');
  assert.ok(close(stored.fee_amount,fee));
  assert.ok(close(stored.bank_amount,net),'La conciliación bancaria debe recibir solamente el neto.');
  assert.ok(close(stored.balance,before+net),'El saldo bancario debe aumentar solamente por el neto.');
  assert.ok(close(stored.total_debit,stored.total_credit),'El encabezado del asiento no está cuadrado.');

  const lines=(await db.query(`select line.account_id,line.debit,line.credit
    from journal_line line where line.journal_id=$1`,[stored.journal_id])).rows;
  const bankLedger=(await db.query('select account_id from bank_account where bank_account_id=$1',[stored.bank_account_id])).rows[0].account_id;
  const bankLine=lines.find(line=>String(line.account_id)===String(bankLedger));
  const feeLine=lines.find(line=>String(line.account_id)===String(stored.expense_account_id));
  assert.ok(bankLine&&close(bankLine.debit,net),'Falta el débito bancario neto.');
  assert.ok(feeLine&&close(feeLine.debit,fee),'Falta el débito de comisión bancaria.');
  assert.ok(close(lines.reduce((sum,line)=>sum+Number(line.debit),0),gross));
  assert.ok(close(lines.reduce((sum,line)=>sum+Number(line.credit),0),gross));

  const editedFee=fee>1?10.25:Number((fee/2).toFixed(6));
  const editedPayload={...payload,reference:'PRUEBA-COMISION-COBRO-EDITADA',bank_fee_amount:editedFee};
  const edited=(await db.query('select public.save_customer_payment_with_advances($1::jsonb,$2) value',[JSON.stringify(editedPayload),saved.id])).rows[0].value;
  assert.ok(close(edited.bankFeeTotal,editedFee));
  assert.ok(close(edited.cashTotal,gross-editedFee));
  const editedState=(await db.query(`select fee.amount fee_amount,bank_transaction.amount bank_amount,bank_account.balance,
      (select count(*) from journal_line line where line.journal_id=payment.journal_id and line.account_id=fee.expense_account_id) fee_lines
    from customer_payment payment join customer_payment_bank_fee fee using(payment_id)
    join bank_transaction on bank_transaction.transaction_id=payment.transaction_id
    join bank_account on bank_account.bank_account_id=payment.bank_account_id
    where payment.payment_id=$1`,[saved.id])).rows[0];
  assert.ok(close(editedState.fee_amount,editedFee));
  assert.ok(close(editedState.bank_amount,gross-editedFee),'Editar debe reemplazar el neto bancario anterior.');
  assert.ok(close(editedState.balance,before+gross-editedFee),'Editar no debe acumular la comisión anterior.');
  assert.equal(Number(editedState.fee_lines),1,'Editar duplicó la línea contable de comisión.');

  await db.query('select public.delete_customer_payment($1)',[saved.id]);
  const after=Number((await db.query('select balance from bank_account where bank_account_id=$1',[account.id])).rows[0].balance);
  assert.ok(close(after,before),'Eliminar el cobro no revirtió exactamente el ingreso bancario neto.');
  assert.equal((await db.query('select count(*)::int count from customer_payment_bank_fee where payment_id=$1',[saved.id])).rows[0].count,0);

  const withoutFeePayload={...payload,reference:'PRUEBA-COBRO-SIN-COMISION',bank_fee_amount:0};
  const withoutFee=(await db.query('select public.save_customer_payment_with_advances($1::jsonb,null) value',[JSON.stringify(withoutFeePayload)])).rows[0].value;
  assert.ok(close(withoutFee.bankFeeTotal,0));
  assert.ok(close(withoutFee.cashTotal,gross),'El flujo sin comisión cambió su ingreso bancario.');
  assert.equal((await db.query('select count(*)::int count from customer_payment_bank_fee where payment_id=$1',[withoutFee.id])).rows[0].count,0);
  await db.query('select public.delete_customer_payment($1)',[withoutFee.id]);
  assert.ok(close((await db.query('select balance from bank_account where bank_account_id=$1',[account.id])).rows[0].balance,before));

  console.log(JSON.stringify({passed:true,gross,bankFee:fee,bankNet:net,journalBalanced:true,bankReconciliationNet:true,editReplacement:true,deleteReversal:true,noFeeRegression:true,rollback:true}));
  await db.query('rollback');
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}

function periodContains(period,date){return String(date)>=String(period.start)&&String(date)<=String(period.end);}
