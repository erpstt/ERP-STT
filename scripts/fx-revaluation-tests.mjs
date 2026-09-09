import assert from 'node:assert/strict';
export async function testRevaluation(db){
  const ctx=(await db.query('select u.email,ucs.session_id from user_company_sessions ucs join users u using(user_id) order by selected_at desc limit 1')).rows[0];assert.ok(ctx);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(ctx)]);
  const sid=(await db.query('select active_subsidiary_id() sid')).rows[0].sid;
  const local=(await db.query('select currency_id from subsidiaries where subsidiary_id=$1',[sid])).rows[0].currency_id;
  const foreign=(await db.query('select currency_id from subsidiary_currencies where subsidiary_id=$1 and currency_id<>$2 order by currency_id limit 1',[sid,local])).rows[0]?.currency_id;
  assert.ok(foreign,'La subsidiaria de prueba requiere una moneda extranjera autorizada');
  const period=(await db.query("select *,to_char(start_date,'YYYY-MM-DD') start,to_char(end_date,'YYYY-MM-DD') finish from fiscal_periods where subsidiary_id=$1 order by start_date limit 1",[sid])).rows[0];assert.ok(period);
  const end=period.finish,next=new Date(`${end}T12:00:00Z`);next.setUTCDate(next.getUTCDate()+1);const nextDate=next.toISOString().slice(0,10);
  await db.query('update fiscal_periods set is_closed=false,gl_closed=false,is_inactive=false where fiscal_period_id=$1',[period.fiscal_period_id]);
  let nextPeriod=(await db.query('select fiscal_period_id from fiscal_periods where subsidiary_id=$1 and start_date=$2',[sid,nextDate])).rows[0];
  if(!nextPeriod)nextPeriod=(await db.query("insert into fiscal_periods(period_name,start_date,end_date,fiscal_year_id,subsidiary_id,is_closed,gl_closed,is_inactive) values('FX TEST NEXT',$1,($1::date+interval '1 month'-interval '1 day')::date,$2,$3,false,false,false) returning fiscal_period_id",[nextDate,period.fiscal_year_id,sid])).rows[0];
  await db.query('update fiscal_periods set is_closed=false,gl_closed=false,is_inactive=false where fiscal_period_id=$1',[nextPeriod.fiscal_period_id]);
  const book=(await db.query('select accounting_book_id from accounting_books where subsidiary_id=$1 and is_primary and is_active limit 1',[sid])).rows[0];assert.ok(book);
  await db.query('update chart_accounts set pending_fx_revaluation=false where account_id in(select account_id from account_subsidiaries where subsidiary_id=$1)',[sid]);
  const stamp=`FXTEST-${Date.now()}`;
  const createAccount=async(category,name,eligible)=>{
    const a=(await db.query(`insert into chart_accounts(account_group_id,account_number,account_name,level,nature,financial_statement,category,accepts_entries,pending_fx_revaluation,is_inactive)
      select account_group_id,$1,$1,4,nature,financial_statement,category,true,$2,false from chart_accounts where category=$3 order by account_id limit 1 returning account_id`,[`${stamp}-${name}`,eligible,category])).rows[0];assert.ok(a,category);
    await db.query('insert into account_subsidiaries(account_id,subsidiary_id,is_active) values($1,$2,true)',[a.account_id,sid]);return a.account_id;
  };
  const bank=await createAccount('Activo','BANK',true),ar=await createAccount('Activo','AR',true),ap=await createAccount('Pasivo','AP',true),loan=await createAccount('Pasivo','LOAN',true),inventory=await createAccount('Activo','INVENTORY',false),gain=await createAccount('Ingreso','GAIN',false),loss=await createAccount('Gasto','LOSS',false);
  const rpc=async(name,payload)=> (await db.query(`select ${name}($1::jsonb) value`,[JSON.stringify(payload)])).rows[0].value;
  let serial=0;
  const journal=async(date,rate,lines,currency=foreign)=>{
    const total=lines.reduce((sum,l)=>sum+Number(l.debit||0),0);
    const j=(await db.query("insert into journal(journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,status) values($1,$2,$3,$4,$5,$6,'FX TEST','Asiento de Diario General',$7,$7,'CONTABILIZADO') returning journal_id,transaction_id",[`${stamp}-${++serial}`,date,sid,currency,period.fiscal_period_id,rate,total])).rows[0];
    for(const l of lines)await db.query('insert into journal_line(journal_id,account_id,debit,credit,debit_fx,credit_fx) values($1,$2,$3,$4,$3,$4)',[j.journal_id,l.id,l.debit||0,l.credit||0]);return j;
  };
  await journal(period.start,500,[{id:bank,debit:100},{id:gain,credit:100}]);
  await journal(period.start,500,[{id:loss,debit:200},{id:loan,credit:200}]);
  await journal(period.start,500,[{id:inventory,debit:50},{id:gain,credit:50}]);
  await journal(period.start,1,[{id:bank,debit:1000},{id:gain,credit:1000}],local);
  const customer=(await db.query('insert into customers(company_name,tax_id,primary_subsidiary_id,currency_id) values($1,$1,$2,$3) returning customer_id',[stamp,sid,foreign])).rows[0];
  const supplier=(await db.query('insert into suppliers(company_name,tax_id,primary_subsidiary_id,currency_id) values($1,$1,$2,$3) returning supplier_id',[stamp,sid,foreign])).rows[0];
  const arj=await journal(period.start,500,[{id:ar,debit:100},{id:gain,credit:100}]);
  const ari=(await db.query('insert into invoice(invoice_number,transaction_id,customer_id,subsidiary_id,total_amount,due_date,invoice_date,currency_id,exchange_rate,journal_id,fiscal_period_id) values($1,$2,$3,$4,100,$5,$5,$6,500,$7,$8) returning invoice_id',[stamp,arj.transaction_id,customer.customer_id,sid,period.start,foreign,arj.journal_id,period.fiscal_period_id])).rows[0];
  const apj=await journal(period.start,500,[{id:loss,debit:200},{id:ap,credit:200}]);
  const api=(await db.query('insert into supplier_invoice(invoice_number,transaction_id,supplier_id,subsidiary_id,total_amount,due_date,invoice_date,currency_id,exchange_rate,journal_id,fiscal_period_id) values($1,$2,$3,$4,200,$5,$5,$6,500,$7,$8) returning invoice_id',[stamp,apj.transaction_id,supplier.supplier_id,sid,period.start,foreign,apj.journal_id,period.fiscal_period_id])).rows[0];
  const paymentBank=(await db.query('select bank_account_id from bank_account where subsidiary_id=$1 limit 1',[sid])).rows[0];assert.ok(paymentBank);
  const cpj=await journal(period.start,520,[{id:bank,debit:40},{id:ar,credit:40}]);
  const cp=(await db.query('insert into customer_payment(payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,journal_id,currency_id,exchange_rate) values($1,$2,$3,$4,$5,40,$6,$7,520) returning payment_id',[`${stamp}-CP`,cpj.transaction_id,customer.customer_id,paymentBank.bank_account_id,period.start,cpj.journal_id,foreign])).rows[0];
  await db.query('insert into customer_payment_application(payment_id,invoice_id,amount,application_date) values($1,$2,40,$3)',[cp.payment_id,ari.invoice_id,period.start]);
  const spj=await journal(period.start,510,[{id:ap,debit:50},{id:bank,credit:50}]);
  const sp=(await db.query('insert into supplier_payment(payment_number,transaction_id,supplier_id,bank_account_id,payment_date,amount_paid,journal_id,currency_id,exchange_rate) values($1,$2,$3,$4,$5,50,$6,$7,510) returning payment_id',[`${stamp}-SP`,spj.transaction_id,supplier.supplier_id,paymentBank.bank_account_id,period.start,spj.journal_id,foreign])).rows[0];
  await db.query('insert into supplier_payment_application(payment_id,invoice_id,amount,application_date) values($1,$2,50,$3)',[sp.payment_id,api.invoice_id,period.start]);
  const notej=await journal(period.start,505,[{id:gain,debit:10},{id:ar,credit:10}]);
  await db.query('insert into credit_note(cn_number,transaction_id,customer_id,invoice_id,amount,note_date,currency_id,exchange_rate,journal_id) values($1,$2,$3,$4,10,$5,$6,505,$7)',[stamp,notej.transaction_id,customer.customer_id,ari.invoice_id,period.start,foreign,notej.journal_id]);
  // Future settlements must not reduce the closing balance.
  const futurej=await journal(nextDate,515,[{id:bank,debit:10},{id:ar,credit:10}]);
  const future=(await db.query('insert into customer_payment(payment_number,transaction_id,customer_id,bank_account_id,payment_date,amount_received,journal_id,currency_id,exchange_rate) values($1,$2,$3,$4,$5,10,$6,$7,515) returning payment_id',[`${stamp}-FUTURE`,futurej.transaction_id,customer.customer_id,paymentBank.bank_account_id,nextDate,futurej.journal_id,foreign])).rows[0];
  await db.query('insert into customer_payment_application(payment_id,invoice_id,amount,application_date) values($1,$2,10,$3)',[future.payment_id,ari.invoice_id,nextDate]);
  await db.query('set local role authenticated');
  await rpc('fx_save_settings',{gain_account_id:gain,loss_account_id:loss,gain_taxable:false,loss_deductible:false,tax_note:'Test only'});
  const opts=(await db.query('select fx_options() value')).rows[0].value;assert.equal(String(opts.subsidiary.id),String(sid));assert.ok(opts.currencies.length);
  const params={date:end,currencyId:foreign,rate:510,rateReason:'TEST MANUAL',autoReverse:true};
  let preview=await rpc('fx_prepare',params);
  const arRow=preview.snapshot.find(x=>x.sourceKey===`AR:${ari.invoice_id}`);assert.equal(Number(arRow.foreignBalance),50);assert.equal(Number(arRow.bookValue),24150);assert.equal(Number(arRow.adjustment),1350);
  const apRow=preview.snapshot.find(x=>x.sourceKey===`AP:${api.invoice_id}`);assert.equal(Number(apRow.foreignBalance),150);assert.equal(Number(apRow.bookValue),74500);assert.equal(Number(apRow.signedAdjustment),-2000);
  assert.ok(preview.snapshot.every(x=>String(x.accountId)!==String(inventory)));
  assert.equal(Number(preview.snapshot.find(x=>String(x.accountId)===String(loan)).signedAdjustment),-2000);
  const reject=async(name,payload,pattern)=>{await db.query('savepoint reject_case');await assert.rejects(rpc(name,payload),pattern);await db.query('rollback to savepoint reject_case');};
  await reject('fx_prepare',{...params,rateReason:''},/motivo/);
  await reject('fx_execute',{runId:preview.run_id,fingerprint:'stale'},/vista previa/);
  // A source posting after preview invalidates it.
  await db.query('reset role');await journal(period.start,500,[{id:bank,debit:1},{id:gain,credit:1}]);await db.query('set local role authenticated');
  await reject('fx_execute',{runId:preview.run_id,fingerprint:preview.fingerprint},/saldos cambiaron/);
  preview=await rpc('fx_prepare',params);
  const posted=await rpc('fx_execute',{runId:preview.run_id,fingerprint:preview.fingerprint});assert.equal(posted.status,'CONTABILIZADO');assert.ok(posted.journal_id&&posted.reversal_journal_id);
  assert.equal((await rpc('fx_execute',{runId:posted.run_id,fingerprint:preview.fingerprint})).journal_id,posted.journal_id);
  await reject('fx_prepare',params,/ya fueron revaluados/);
  const report=await rpc('fx_report',{runId:posted.run_id});assert.equal(report.runs.length,1);assert.ok(report.runs[0].accounts.length>=4);
  await db.query('savepoint edit_protected');await assert.rejects(db.query("update journal set memo='MANUAL' where journal_id=$1",[posted.journal_id]),/Revaluaci/);await db.query('rollback to savepoint edit_protected');
  await db.query('reset role');
  const amounts=(await db.query('select j.journal_id,sum(g.debit_amount) debit,sum(g.credit_amount) credit,sum(g.debit_fx) fx_debit,sum(g.credit_fx) fx_credit,min(tt.abbreviation) kind from journal j join gl_impact g using(transaction_id) join "transaction" t using(transaction_id) join transaction_types tt using(transaction_type_id) where j.fx_revaluation_run_id=$1 group by j.journal_id',[posted.run_id])).rows;
  assert.equal(amounts.length,2);for(const a of amounts){assert.equal(Number(a.debit),Number(a.credit));assert.equal(Number(a.fx_debit),0);assert.equal(Number(a.fx_credit),0);assert.equal(a.kind,'DIF_CAM');}
  const net=(await db.query('select g.account_id,sum(g.debit_amount-g.credit_amount) net from gl_impact g join journal j using(transaction_id) where j.fx_revaluation_run_id=$1 group by g.account_id',[posted.run_id])).rows;assert.ok(net.every(x=>Number(x.net)===0));
  // Resynchronizing a generated journal must still leave FC at zero.
  await db.query('select sync_journal_gl_impacts($1)',[posted.journal_id]);
  assert.equal(Number((await db.query('select sum(g.debit_fx+g.credit_fx) n from gl_impact g join journal j using(transaction_id) where j.fx_revaluation_run_id=$1',[posted.run_id])).rows[0].n),0);
  await db.query('set local role authenticated');
  await rpc('fx_cancel',{runId:posted.run_id,reason:'Rollback test cancellation'});
  const again=await rpc('fx_prepare',params);assert.notEqual(again.run_id,posted.run_id);
  assert.deepEqual(again.snapshot,preview.snapshot);
  await db.query('reset role');
  // Closed reversal period must roll back the entire execution.
  await db.query('update fiscal_periods set ap_closed=true,ar_closed=true,gl_closed=true where fiscal_period_id=$1',[nextPeriod.fiscal_period_id]);await db.query('set local role authenticated');
  await reject('fx_execute',{runId:again.run_id,fingerprint:again.fingerprint},/periodo/);
  await db.query('reset role');
  assert.equal(Number((await db.query('select count(*) n from journal where fx_revaluation_run_id=$1',[again.run_id])).rows[0].n),0);
  await db.query('set local role authenticated');
  const lower=await rpc('fx_prepare',{...params,rate:480,autoReverse:false});
  assert.ok(lower.snapshot.find(x=>String(x.accountId)===String(loan)).signedAdjustment>0);
  assert.ok(lower.snapshot.find(x=>x.sourceKey===`AR:${ari.invoice_id}`).signedAdjustment<0);
  const single=await rpc('fx_execute',{runId:lower.run_id,fingerprint:lower.fingerprint});assert.ok(single.journal_id);assert.equal(single.reversal_journal_id,null);
  await rpc('fx_cancel',{runId:single.run_id,reason:'Single journal cancellation test'});
  console.log('PASS: AR/AP partial settlements and notes at cutoff, future payment exclusion, assets/liabilities, local/nonmonetary exclusion, stale preview, duplicates, balanced DIF_CAM, zero FC, mirrored reversal, cancellation and atomic rollback.');
}
