import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {setupFxZeroNativeRevaluation,applyFxZeroNativeRevaluation,readFxZeroNativeMigration,seedFxZeroNativeCycle,seedFxWeightedZeroNative,fxZeroNativeJournal,linkFxZeroNativeDocument,prepareFxZeroNative,executeFxZeroNative,cancelFxZeroNative,fxZeroNativePayload,assumeSecurityUser,assumeSqlRole,deniedSql,seedStoredFxLedger,seedStoredFxTransfer} from './fixtures/setup-fx-zero-native-revaluation.mjs';
let db,original,migration,beforeFunctions,afterFunctions,beforeData,afterData;
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.data;
const calculate=async(date='2026-10-31')=>{await db.exec('reset role');return q('select fx_revaluation_private.fx_calculate($1,2,159.674)data',[date]);};
const bank=rows=>rows.find(row=>row.sourceKey==='GL:2601'&&row.accountId===2601);
const tables=['journal','journal_line','gl_impact','transaction','number_sequences','fx_revaluation_runs','fx_revaluation_settings','bank_transaction','bank_transfer','invoice','supplier_invoice','customer_payment','customer_payment_application','supplier_payment','supplier_payment_application','audit_log','change_log','event_log','activity_log','deleted_records','sequence_security_private.contexts'];
async function state(){await db.exec('reset role');const result={};for(const name of tables){const relation=name==='transaction'?'public."transaction"':name;result[name]=await q(`select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')::text)data from ${relation} t`);}return result;}
const metadata=async()=>(await db.query("select p.oid,n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')'signature,p.proowner,p.proacl::text,p.proconfig,p.prosecdef,p.provolatile,p.proisstrict,p.proparallel,md5(p.prosrc)md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like'pg_%'and n.nspname<>'information_schema'order by p.oid")).rows;
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);}
async function protectedJournals(run){return q(`select jsonb_agg(jsonb_build_object('header',to_jsonb(j),'lines',(select jsonb_agg(to_jsonb(l)order by journal_line_id)from journal_line l where l.journal_id=j.journal_id),'gl',(select jsonb_agg(to_jsonb(g)order by gl_impact_id)from gl_impact g where g.transaction_id=j.transaction_id))order by j.journal_id)data from journal j where j.journal_id in($1,$2)`,[run.journal_id,run.reversal_journal_id]);}
async function prior(run,accountId=2601){return q(`select jsonb_build_object('rows',count(*),'net',coalesce(sum(l.debit-l.credit),0))data from journal_line l join journal j using(journal_id) where j.fx_revaluation_run_id=$1 and j.journal_date<='2026-10-31'and l.fx_source_key='GL:'||$2::bigint and l.account_id=$2`,[run.run_id,accountId]);}

before(async()=>{
 ({db}=await setupFxZeroNativeRevaluation({apply:false}));await db.exec('reset role');
 original=(await db.query("select pg_get_functiondef('fx_revaluation_private.fx_exposures(date,bigint)'::regprocedure)definition")).rows[0].definition;
 migration=await readFxZeroNativeMigration();beforeFunctions=await metadata();beforeData=await state();await applyFxZeroNativeRevaluation(db);afterFunctions=await metadata();afterData=await state();
});
after(()=>db?.close());

test('one guarded exposure body changes, with existing OIDs/attributes and financial, audit and numbering rows intact',()=>{
 assert.deepEqual(afterData,beforeData);assert.equal(afterFunctions.length,beforeFunctions.length);const changed=[];
 for(let i=0;i<beforeFunctions.length;i++){const{md5:a,...old}=beforeFunctions[i],{md5:b,...next}=afterFunctions[i];assert.deepEqual(next,old);if(a!==b)changed.push({signature:old.signature,before:a,after:b});}
 assert.deepEqual(changed,[{signature:'fx_revaluation_private.fx_exposures(date, bigint)',before:'2d16b1c9db606638e64f3a79e18cf59c',after:'b25c1cbc6f764c581394a011e4f7a359'}]);
});

test('canonical cancellation retains a zero-net prior key and regenerates a zero-native closing without rewriting posted history',async t=>{
 await tx(t);for(const variant of[{accountId:2601,credit:false,category:'Activo'},{accountId:2703,credit:true,category:'Pasivo'}]){
 await db.exec('reset role;savepoint account_sign');const source=await seedFxZeroNativeCycle(db,variant);await db.exec('reset role');const historical=await protectedJournals(source.posted),oldSnapshot=structuredClone(source.run.snapshot),target=rows=>rows.find(x=>x.sourceKey==='GL:'+variant.accountId&&x.accountId===variant.accountId);
 const current=target(await calculate());assert.equal(current.category,variant.category);assert.equal(current.foreignBalance,0);assert.equal(current.bookValue,1067.4);assert.equal(current.adjustment,-1067.4);
 await db.exec(original);assert.deepEqual(await calculate(),[],'The published old predicate omitted the fully settled foreign principal');await applyFxZeroNativeRevaluation(db);
 const cancelled=await cancelFxZeroNative(db,source.run);assert.equal(cancelled.status,'REVERSADO');assert.deepEqual(cancelled.snapshot,oldSnapshot);assert.equal(cancelled.fingerprint,source.run.fingerprint);await db.exec('reset role');
 const history=await prior(source.run,variant.accountId);assert.ok(history.rows>=2);assert.equal(history.net,0,'A present zero-net history group is different from no FX history');
 const fresh=await prepareFxZeroNative(db),row=target(fresh.snapshot);assert.equal(row.foreignBalance,0);assert.equal(row.bookValue,100);assert.equal(row.revaluedBalance,0);assert.equal(row.adjustment,-100);assert.equal(row.signedAdjustment,variant.credit?100:-100);
 const posted=await executeFxZeroNative(db,fresh);assert.equal(posted.status,'CONTABILIZADO');assert.ok(posted.journal_id&&posted.reversal_journal_id);await db.exec('reset role');
 const balances=(await db.query("select round(sum(debit_amount-credit_amount)filter(where posting_date<='2026-10-31'),2)::text closing,sum(debit_amount-credit_amount)::text after_reverse,sum(debit_fx-credit_fx)::text native from gl_impact where account_id=$1 and accounting_book_id=1",[variant.accountId])).rows[0];
 assert.equal(Number(balances.closing),0);assert.equal(Number(balances.after_reverse),variant.credit?-100:100);assert.equal(Number(balances.native),0);
 const sides=await q('select jsonb_build_object(\'debit\',sum(debit),\'credit\',sum(credit))data from journal_line where journal_id=$1 and account_id=$2',[posted.journal_id,variant.accountId]);assert.deepEqual(sides,variant.credit?{debit:100,credit:0}:{debit:0,credit:100});
 assert.deepEqual(await protectedJournals(source.posted),historical);assert.deepEqual(await q('select snapshot data from fx_revaluation_runs where run_id=$1',[source.run.run_id]),oldSnapshot);
 assert.equal(Number(await q('select coalesce(sum(abs(l.debit_fx)+abs(l.credit_fx)),0)data from journal_line l join journal j using(journal_id)where j.fx_revaluation_run_id is not null')),0);
 await db.exec('rollback to account_sign;release account_sign');}
});

test('weighted positive and negative half-cent boundaries use the emitted six-decimal book value before testing a cent adjustment',async t=>{
 await tx(t);
 for(const negative of[false,true]){
  await db.exec('reset role;savepoint weighted_case');const source=await seedFxWeightedZeroNative(db,{negative}),rows=await calculate(),row=rows.find(x=>x.sourceKey===source.sourceKey);
  const raw=await q('select (1-g.credit_amount/5)::text data from gl_impact g where g.transaction_id=$1 and account_id=2601',[source.settlement.transactionId]);assert.equal(Number(raw),Number(source.rawBook));
  assert.equal(row.foreignBalance,0);assert.equal(row.bookValue,negative?-0.005:0.005);assert.equal(row.revaluedBalance,0);assert.equal(row.adjustment,negative?0.01:-0.01);
  const fresh=await prepareFxZeroNative(db);assert.deepEqual(fresh.snapshot,rows);await db.exec('reset role;rollback to weighted_case;release weighted_case');
 }
});

test('settled GL, AR and AP residuals without an earlier matching FX posting remain excluded',async t=>{
 await tx(t);await fxZeroNativeJournal(db);await fxZeroNativeJournal(db,{credit:true,rate:'149',date:'2026-10-20'});
 const ar=await fxZeroNativeJournal(db),arPayment=await fxZeroNativeJournal(db,{credit:true,rate:'149',date:'2026-10-20'});await linkFxZeroNativeDocument(db,{kind:'AR',invoiceId:91021,paymentId:92021,original:ar,settlement:arPayment});
 const ap=await fxZeroNativeJournal(db,{accountId:2703,credit:true}),apPayment=await fxZeroNativeJournal(db,{accountId:2703,rate:'149',date:'2026-10-20'});await linkFxZeroNativeDocument(db,{kind:'AP',invoiceId:91022,paymentId:92022,original:ap,settlement:apPayment});
 assert.equal(await q('select count(*)::int data from fx_revaluation_runs'),0);assert.deepEqual(await calculate(),[]);const saved=await state();assert.deepEqual(await calculate(),[]);assert.deepEqual(await state(),saved);
});

test('history for another source key, account, subsidiary, currency or future cutoff never activates a settled source',async t=>{
 await tx(t);const source=await seedFxZeroNativeCycle(db,{cancel:true});assert.equal(bank(await calculate()).bookValue,100);
 const mutations=[
  `update journal_line set fx_source_key='GL:999999'where account_id=2601 and journal_id in(select journal_id from journal where fx_revaluation_run_id=${source.run.run_id})`,
  `update journal_line set account_id=2701 where account_id=2601 and journal_id in(select journal_id from journal where fx_revaluation_run_id=${source.run.run_id})`,
  `update fx_revaluation_runs set subsidiary_id=2 where run_id=${source.run.run_id}`,
  `update fx_revaluation_runs set currency_id=1 where run_id=${source.run.run_id}`,
 ];
 // Negative source facts are changed only inside synthetic savepoints. The
 // published managed-journal guards remain active and require their real flag.
 for(const mutation of mutations){await db.exec('reset role;savepoint wrong_history');await db.query("select set_config('nexo.fx_posting','on',true),set_config('nexo.defer_journal_gl_sync','on',true)");await db.exec(mutation);assert.equal(bank(await calculate()),undefined);await db.exec('rollback to wrong_history;release wrong_history');}
 assert.equal(bank(await calculate('2026-10-20')),undefined,'An October-31 history group does not exist at the earlier cutoff');assert.equal(bank(await calculate()).bookValue,100);
});

test('a zero or subcent local remainder stays excluded even when the prior history key is present with a zero sum',async t=>{
 await tx(t);
 for(const residual of['0','0.004999','-0.004999']){
  await db.exec('reset role;savepoint subcent_case');const source=await seedFxZeroNativeCycle(db,{residual,cancel:true});const history=await prior(source.run);assert.ok(history.rows>=2);assert.equal(history.net,0);assert.equal(bank(await calculate()),undefined);
  await db.exec('rollback to subcent_case;release subcent_case');
 }
});

test('nonzero foreign sources and the published bank-transfer normalization retain exactly their previous calculations',async t=>{
 await tx(t);await seedStoredFxLedger(db);await seedStoredFxTransfer(db);await seedStoredFxTransfer(db,{source:'120',rate:'152',date:'2026-10-27'});
 const current=await calculate(),row=bank(current);assert.equal(row.foreignBalance,110);assert.equal(row.bookValue,16190);assert.equal(row.revaluedBalance,17564.14);assert.equal(row.adjustment,1374.14);
 await db.exec(original);assert.deepEqual(await calculate(),current);await applyFxZeroNativeRevaluation(db);assert.deepEqual(await calculate(),current);
});

test('an old omitted preview is stale; a late reversal error rolls back the fresh zero-native posting and its retry is idempotent',async t=>{
 await tx(t);await seedFxZeroNativeCycle(db,{cancel:true});await db.exec(original);const old=await prepareFxZeroNative(db);assert.deepEqual(old.snapshot,[]);await db.exec('reset role');await applyFxZeroNativeRevaluation(db);const saved=await state();
 await assumeSecurityUser(db);await deniedSql(db,'select public.fx_execute($1)',[{runId:old.run_id,fingerprint:old.fingerprint}],'P0001');assert.deepEqual(await state(),saved);
 const fresh=await prepareFxZeroNative(db);assert.equal(fresh.run_id,old.run_id);assert.notEqual(fresh.fingerprint,old.fingerprint);assert.equal(bank(fresh.snapshot).adjustment,-100);const pending=await state();
 await db.exec("create function fixture_fail_zero_native_reversal()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin if exists(select 1 from journal j where j.transaction_id=new.transaction_id and j.fx_revaluation_run_id is not null and j.journal_date='2026-11-01')then raise exception 'Synthetic zero-native late reversal failure';end if;return new;end$$;create trigger fixture_fail_zero_native_reversal before insert on gl_impact for each row execute function fixture_fail_zero_native_reversal()");
 await assumeSecurityUser(db);await deniedSql(db,'select public.fx_execute($1)',[{runId:fresh.run_id,fingerprint:fresh.fingerprint}],'P0001');assert.deepEqual(await state(),pending);
 await db.exec('drop trigger fixture_fail_zero_native_reversal on gl_impact;drop function fixture_fail_zero_native_reversal()');const first=await executeFxZeroNative(db,fresh),posted=await state(),again=await executeFxZeroNative(db,fresh);assert.equal(again.journal_id,first.journal_id);assert.equal(again.reversal_journal_id,first.reversal_journal_id);assert.deepEqual(await state(),posted);
});

test('canonical identity, permissions, private ACL and exact source guard remain mandatory for the newly retained source',async t=>{
 await tx(t);const source=await seedFxZeroNativeCycle(db,{cancel:true}),saved=await state();
 await assumeSecurityUser(db,1,3,1);await deniedSql(db,'select public.fx_prepare($1)',[fxZeroNativePayload()],'42501');
 await assumeSecurityUser(db,1,1,2);await deniedSql(db,'select public.fx_cancel($1)',[{runId:source.run.run_id,reason:'Synthetic foreign scope'}],'42501');
 await assumeSqlRole(db,'anon');await deniedSql(db,'select public.fx_prepare($1)',[fxZeroNativePayload()],'42501');
 await assumeSecurityUser(db);await deniedSql(db,"select fx_revaluation_private.fx_exposures('2026-10-31',2)",[],'42501');assert.deepEqual(await state(),saved);
 await db.exec('savepoint source_guard');await assert.rejects(db.exec(migration),/Unexpected FX exposure calculation/);await db.exec('rollback to source_guard;release source_guard');
});

// PGlite uses one serialized connection. Atomic rollback and stale proof are
// exercised with the actual engines; this suite makes no MVCC concurrency claim.
