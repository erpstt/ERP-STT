import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile}from'node:fs/promises';
import {setupFxBankTransferNormalization,seedStoredFxLedger,seedStoredFxTransfer,seedStoredFxTransferReversal,seedFxExecutionExposure,fxExecutionPayload,assumeSecurityUser,deniedSql,fxBankTransferMigration}from'./fixtures/setup-fx-bank-transfer-normalization.mjs';
import {seedSupplierAdvanceOpening}from'./fixtures/setup-supplier-advances-report.mjs';
let db,original,migration;
const json=async(sql,args=[])=>(await db.query(sql,args)).rows[0].data;
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);}
async function calculate(date='2026-10-31'){await db.exec('reset role');return json('select fx_revaluation_private.fx_calculate($1,2,159.674)data',[date]);}
async function prepare(){await assumeSecurityUser(db);return json('select public.fx_prepare($1)data',[fxExecutionPayload()]);}
async function execute(run){await assumeSecurityUser(db);return json('select public.fx_execute($1)data',[{runId:run.run_id,fingerprint:run.fingerprint}]);}
async function install(){await db.exec('reset role');await db.exec(migration);}
async function seedCase(){const initial=await seedStoredFxLedger(db),first=await seedStoredFxTransfer(db),second=await seedStoredFxTransfer(db,{source:'120',rate:'152',date:'2026-10-27'});return{initial,first,second};}
async function state(){await db.exec('reset role');return json(`select jsonb_object_agg(name,value)data from(
 select 'journals'name,coalesce(jsonb_agg(to_jsonb(t)order by journal_id),'[]')value from journal t
 union all select 'lines',coalesce(jsonb_agg(to_jsonb(t)order by journal_line_id),'[]')from journal_line t
 union all select 'gl',coalesce(jsonb_agg(to_jsonb(t)order by gl_impact_id),'[]')from gl_impact t
 union all select 'transactions',coalesce(jsonb_agg(to_jsonb(t)order by transaction_id),'[]')from "transaction"t
 union all select 'runs',coalesce(jsonb_agg(to_jsonb(t)order by run_id),'[]')from fx_revaluation_runs t
 union all select 'sequences',coalesce(jsonb_agg(to_jsonb(t)order by sequence_id),'[]')from number_sequences t
 union all select 'audit',coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')from audit_log t
 union all select 'bank',coalesce(jsonb_agg(to_jsonb(t)order by bank_tran_id),'[]')from bank_transaction t
 union all select 'transfers',coalesce(jsonb_agg(to_jsonb(t)order by transfer_id),'[]')from bank_transfer t)q`);}
const metadata=async()=>(await db.query("select p.oid,n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')'signature,p.proowner,p.proacl::text,p.proconfig,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,md5(p.prosrc)md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like'pg_%'and n.nspname<>'information_schema'order by p.oid")).rows;
before(async()=>{({db}=await setupFxBankTransferNormalization({apply:false}));await db.exec('reset role');original=(await db.query("select pg_get_functiondef('fx_revaluation_private.fx_exposures(date,bigint)'::regprocedure)definition")).rows[0].definition;migration=(await readFile(new URL('../supabase/migrations/'+fxBankTransferMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');});
after(()=>db.close());

test('installation changes only the guarded exposure body and preserves OIDs, ACLs, all other functions and stored financial history',async()=>{
 const before=await metadata(),saved=await state();await install();const after=await metadata();assert.equal(after.length,before.length);const changes=[];
 for(let i=0;i<before.length;i++){const a=before[i],b=after[i];assert.equal(a.oid,b.oid);const{md5:oldHash,...oldAttrs}=a,{md5:newHash,...newAttrs}=b;assert.deepEqual(newAttrs,oldAttrs);if(oldHash!==newHash)changes.push({signature:a.signature,before:oldHash,after:newHash});}
 assert.equal(changes.length,1);assert.equal(changes[0].signature,'fx_revaluation_private.fx_exposures(date, bigint)');assert.equal(changes[0].before,'7b74399c1e4d31d4bc2efa3748eb09df');assert.deepEqual(await state(),saved);
});

test('two synthetic local-header USD outflows are normalized before currency selection and preserve exact GL local values',async t=>{
 await tx(t);await seedCase();const rows=await calculate(),row=rows.find(r=>r.accountId===2601);
 assert.equal(row.foreignBalance,110);assert.equal(row.bookValue,16190);assert.equal(row.revaluedBalance,17564.14);assert.equal(row.adjustment,1374.14);
 const before=await state(),run=await prepare();assert.deepEqual(run.snapshot,rows);const out=await execute(run);assert.equal(out.status,'CONTABILIZADO');
 await db.exec('reset role');const actual=(await db.query("select sum(debit_amount-credit_amount)::text local,sum(debit_fx-credit_fx)filter(where original_currency_id=2)::text stored_native from gl_impact where account_id=2601 and accounting_book_id=1 and posting_date<='2026-10-31'")).rows[0];assert.equal(Number(actual.local),17564.14);
 const after=await state();for(const old of before.gl)assert.deepEqual(after.gl.find(g=>g.gl_impact_id===old.gl_impact_id),old,'Existing local and native GL amounts never change');
});

test('incoming transfers and source fees use the bank native principal plus fee without revaluing stored GL local amounts',async t=>{
 await tx(t);await seedStoredFxLedger(db,{native:100,local:15000});await seedStoredFxTransfer(db,{source:'10',rate:'151',fee:'2.5'});await seedStoredFxTransfer(db,{source:'20',rate:'152',incoming:true});
 const row=(await calculate()).find(r=>r.accountId===2601);assert.equal(row.foreignBalance,107.5);assert.equal(row.bookValue,16152.5);assert.equal(row.revaluedBalance,17164.96);assert.equal(row.adjustment,1012.46);
});

test('a stored transfer reversal flips the native sides only from its posting date and preserves the original historical source',async t=>{
 await tx(t);await seedStoredFxLedger(db,{native:100,local:15000});const source=await seedStoredFxTransfer(db,{source:'10',rate:'151'});await seedStoredFxTransferReversal(db,source);
 const before=(await calculate('2026-10-31')).find(r=>r.accountId===2601),after=(await calculate('2026-11-01')).find(r=>r.accountId===2601);assert.equal(before.foreignBalance,90);assert.equal(before.bookValue,13490);assert.equal(after.foreignBalance,100);assert.equal(after.bookValue,15000);
});

test('ambiguous GL/BT traces, invalid local components and missing transfer headers block preparation with no financial writes',async t=>{
 await tx(t);await seedStoredFxLedger(db,{native:100,local:15000});const source=await seedStoredFxTransfer(db,{source:'10',rate:'151'});
 const mutations=[
  `insert into bank_transaction(bank_account_id,transaction_id,amount,tran_date,tran_type)select bank_account_id,transaction_id,amount,tran_date,tran_type from bank_transaction where transaction_id=${source.transactionId} and bank_account_id=9101`,
  `insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)select transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date from gl_impact where gl_impact_id=${source.glId}`,
  `update gl_impact set credit_amount=credit_amount+1 where gl_impact_id=${source.glId}`,
  `delete from bank_transfer where transfer_id=${source.transferId}`,
 ];
 for(const mutation of mutations){await db.exec('reset role;savepoint source_case');await db.exec(mutation);const saved=await state();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_prepare($1)',[fxExecutionPayload()],'55000');assert.deepEqual(await state(),saved);await db.exec('rollback to source_case;release source_case');}
});

test('foreign-subsidiary or changed-currency ambiguous legs cannot disappear behind a local header',async t=>{
 await tx(t);await seedStoredFxLedger(db,{native:100,local:15000});const source=await seedStoredFxTransfer(db,{source:'10',rate:'151'});
 await db.exec("reset role;insert into currencies(currency_id,currency_code)values(3,'EUR')on conflict(currency_id)do nothing;insert into bank_account(bank_account_id,account_number,subsidiary_id,currency_id,account_id)values(9103,'SYN-USD-SECOND',1,2,2601)");
 await db.exec('update bank_account set currency_id=3,subsidiary_id=2 where bank_account_id=9101');const saved=await state();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_prepare($1)',[fxExecutionPayload()],'55000');assert.deepEqual(await state(),saved);
});

test('valid different-currency legs remain outside USD and primary-book filtering does not multiply a transfer',async t=>{
 await tx(t);await seedStoredFxLedger(db,{native:100,local:15000});const source=await seedStoredFxTransfer(db,{source:'10',rate:'151'});
 await db.exec(`reset role;insert into gl_impact(transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,debit_amount,credit_amount,debit_fx,credit_fx,posting_date)select transaction_id,account_id,subsidiary_id,fiscal_period_id,10,debit_amount,credit_amount,debit_fx,credit_fx,posting_date from gl_impact where gl_impact_id=${source.glId}`);
 assert.equal((await calculate()).find(r=>r.accountId===2601).foreignBalance,90);
 await db.exec("insert into currencies(currency_id,currency_code)values(3,'EUR')on conflict(currency_id)do nothing;update bank_account set currency_id=3 where bank_account_id=9101");const row=(await calculate()).find(r=>r.accountId===2601);assert.equal(row.foreignBalance,100);assert.equal(row.bookValue,15000);
});

test('non-transfer source calculations, document allocations, NULL transaction omission and payroll subcent rounding remain canonical',async t=>{
 await tx(t);const ar=await seedFxExecutionExposure(db,{amount:123.45,rate:150});
 await db.exec(`reset role;insert into customers(customer_id,company_name)values(99001,'Synthetic FX receivable customer');
  insert into invoice(invoice_id,invoice_number,customer_id,transaction_id,currency_id,subsidiary_id,invoice_date)select 99001,'SYN-FX-AR',99001,transaction_id,2,1,'2026-10-01'from journal where journal_id=${ar};
  insert into account_group(group_id,group_code,group_name,category,nature)values(99001,'119','Synthetic related-company group','Activo','Deudora');
  insert into chart_accounts(account_id,account_number,account_name,account_group_id,category,nature,accepts_entries,pending_fx_revaluation,is_inactive)values(2801,'119991','Synthetic intercompany exposure',99001,'Activo','Deudora',true,true,false);
  insert into account_subsidiaries values(2801,1,true);update chart_accounts set pending_fx_revaluation=true where account_id=601;
 `);
 await seedFxExecutionExposure(db,{accountId:2801,amount:9,rate:150});
 await seedSupplierAdvanceOpening(db,{glTransactionNull:false,items:[{supplierId:10,amount:11,rate:140,currencyId:2}]});
 await assumeSecurityUser(db);const ap=await json('select public.save_supplier_invoice($1,null)data',[{invoice_number:'SYN-FX-AP',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-01',fiscal_period_id:10,currency_id:2,exchange_rate:150,memo:'Synthetic payable FX source',lines:[{account_id:203,quantity:1,unit_price:13,tax_rate:0,department_id:21}]}]);
 await db.exec('reset role');await db.query('update chart_accounts set pending_fx_revaluation=true where account_id=(select payable_account_id from supplier_invoice where invoice_id=$1)',[ap.invoiceId]);
 // Add literal GL-only historical snapshots after the real writers; these are
 // stored-state read oracles, not editable manual journals to be resynchronized.
 await seedStoredFxLedger(db,{accountId:2703,native:'0.07',local:'1200.1234'});
 await db.exec("reset role;insert into gl_impact(account_id,subsidiary_id,posting_date,debit_amount,credit_amount,accounting_book_id,debit_fx,credit_fx,original_currency_id)values(2601,1,'2026-10-01',999,0,1,999,0,2)");
 const current=await calculate();assert.ok(current.some(r=>r.sourceType==='CxC'));assert.ok(current.some(r=>r.sourceType==='CxP'));assert.ok(current.some(r=>r.sourceKey.startsWith('ICGL:')));assert.ok(current.some(r=>r.accountId===601&&r.foreignBalance===11));await db.exec(original);const legacy=await calculate();assert.deepEqual(current,legacy);await install();assert.deepEqual(await calculate(),legacy);
 const payroll=current.find(r=>r.sourceKey==='GL:2703');assert.ok(payroll,JSON.stringify(current.map(r=>({key:r.sourceKey,account:r.accountId,native:r.foreignBalance}))));assert.equal(payroll.foreignBalance,-0.07);assert.equal(payroll.bookValue,-1200.1234);assert.equal(payroll.revaluedBalance,-11.18);assert.equal(payroll.adjustment,1188.94);
});

test('pending legacy previews require a fresh snapshot and cannot post their formerly incomplete exposure',async t=>{
 await tx(t);await db.exec('reset role');await db.exec(original);await seedCase();const old=await prepare();assert.equal(old.snapshot.find(r=>r.accountId===2601).foreignBalance,300);await install();const saved=await state();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_execute($1)',[{runId:old.run_id,fingerprint:old.fingerprint}],'P0001');assert.deepEqual(await state(),saved);
 const fresh=await prepare();assert.equal(fresh.run_id,old.run_id);assert.equal(fresh.snapshot.find(r=>r.accountId===2601).foreignBalance,110);assert.notEqual(fresh.fingerprint,old.fingerprint);assert.equal((await execute(fresh)).status,'CONTABILIZADO');
});

test('posted history stays untouched on install; canonical cancellation and correction preserve original snapshots and future reversals',async t=>{
 await tx(t);await db.exec('reset role');await db.exec(original);await seedCase();const old=await prepare(),posted=await execute(old);const saved=await state();await install();assert.deepEqual(await state(),saved);
 const retry=await execute(old);assert.equal(retry.journal_id,posted.journal_id);assert.deepEqual(await state(),saved);
 const incremental=(await calculate()).find(r=>r.accountId===2601);assert.equal(incremental.foreignBalance,110);assert.equal(incremental.bookValue,19092.2);assert.equal(incremental.adjustment,-1528.06);
 await db.exec("reset role;insert into role_permissions(role_id,permission_id)select 1,permission_id from permissions where code='accounting:journal:reverse'on conflict do nothing");
 await db.exec(`create function fixture_fail_cancel_reverse()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin if exists(select 1 from journal j where j.transaction_id=new.transaction_id and j.memo like 'Anulacion de reversion programada:%')then raise exception 'Synthetic late cancellation failure';end if;return new;end$$;create trigger fixture_fail_cancel_reverse before insert on gl_impact for each row execute function fixture_fail_cancel_reverse()`);
 const beforeCancel=await state();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_cancel($1)',[{runId:old.run_id,reason:'Synthetic source normalization regression'}],'P0001');assert.deepEqual(await state(),beforeCancel);await db.exec('drop trigger fixture_fail_cancel_reverse on gl_impact;drop function fixture_fail_cancel_reverse()');
 await assumeSecurityUser(db);const cancelled=await json('select public.fx_cancel($1)data',[{runId:old.run_id,reason:'Synthetic source normalization regression'}]);assert.equal(cancelled.status,'REVERSADO');assert.deepEqual(cancelled.snapshot,old.snapshot);assert.equal(cancelled.fingerprint,old.fingerprint);
 const corrected=await prepare();assert.equal(corrected.snapshot.find(r=>r.accountId===2601).adjustment,1374.14);await execute(corrected);await db.exec('reset role');
 const bridge=(await db.query("select sum(debit_amount-credit_amount)filter(where posting_date<='2026-10-31')::numeric local_oct,sum(debit_amount-credit_amount)::numeric local_after_reverse from gl_impact where account_id=2601 and accounting_book_id=1")).rows[0];assert.equal(Number(bridge.local_oct),17564.14);assert.equal(Number(bridge.local_after_reverse),16190);
});

test('reporting permissions and private ACL remain enforced, and dependency drift aborts the patch',async t=>{
 await tx(t);await assumeSecurityUser(db,1,3);await deniedSql(db,'select public.fx_prepare($1)',[fxExecutionPayload()],'42501');await assumeSecurityUser(db);await deniedSql(db,"select fx_revaluation_private.fx_exposures('2026-10-31',2)",[],'42501');
 await db.exec('reset role;savepoint source_drift');const attrs=await metadata();await assert.rejects(db.exec(migration),/Unexpected FX exposure calculation/);await db.exec('rollback to source_drift;release source_drift');assert.deepEqual(await metadata(),attrs);
});
