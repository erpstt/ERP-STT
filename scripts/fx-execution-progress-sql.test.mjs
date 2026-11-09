import assert from'node:assert/strict';
import{test,before,after}from'node:test';
import{setupFxExecutionProgress,seedFxExecutionBatch,applyFxExecutionBatch,assumeSecurityUser,assumeSqlRole,deniedSql,fxExecutionPayload}from'./fixtures/setup-fx-execution-progress.mjs';
let db,baseline,beforeFunctions,afterFunctions,migrationBefore,migrationAfter;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const prepare=async(p={})=>q('select public.fx_prepare($1)d',[{...fxExecutionPayload(),...p}]);
const execute=r=>q('select public.fx_execute($1)d',[{runId:r.run_id,fingerprint:r.fingerprint}]);
const metrics=()=>q("select jsonb_object_agg(name,value)d from fixture_fx_metrics");
const metadata=()=>q("select jsonb_agg(jsonb_build_object('oid',p.oid,'name',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')','source',md5(p.prosrc),'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile)order by p.oid)d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg_%'and n.nspname<>'information_schema'");
const tables=['journal','journal_line','gl_impact','transaction','number_sequences','fx_revaluation_runs','fx_revaluation_settings','audit_log','change_log','event_log','activity_log','deleted_records','sequence_security_private.contexts'];
async function financialSnapshot(){await db.exec('reset role');const out={};for(const name of tables){const quoted=name==='transaction'?'public."transaction"':name;out[name]=await q(`select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')::text)d from ${quoted} t`);}return out;}
async function savedFinancials(id){return q(`select jsonb_agg(jsonb_build_object('date',j.journal_date,'currency',j.currency_id,'rate',j.exchange_rate,'type',j.journal_type,'status',j.status,'debit',j.total_debit,'credit',j.total_credit,
 'lines',(select jsonb_agg(jsonb_build_array(l.account_id,l.debit,l.credit,l.debit_fx,l.credit_fx,l.fx_source_key,l.customer_id,l.supplier_id,l.related_company_id)order by l.account_id,l.fx_source_key,l.debit,l.credit)from journal_line l where l.journal_id=j.journal_id),
 'ledger',(select jsonb_agg(jsonb_build_array(g.account_id,g.accounting_book_id,g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx)order by g.account_id,g.debit_amount,g.credit_amount)from gl_impact g where g.transaction_id=j.transaction_id))order by j.journal_date)d from journal j where j.fx_revaluation_run_id=$1`,[id]);}
async function tx(t){await db.exec('reset role;begin;update fixture_fx_metrics set value=0');t.after(()=>db.exec('reset role;rollback'));await assumeSecurityUser(db);}
before(async()=>{
 ({db}=await setupFxExecutionProgress());await seedFxExecutionBatch(db);await db.exec('reset role');
 beforeFunctions=await metadata();migrationBefore=await financialSnapshot();
 await db.exec('begin');await assumeSecurityUser(db);const r=await prepare();assert.equal(r.snapshot.length,67);assert.equal(new Set(r.snapshot.map(x=>x.accountId)).size,7);assert.ok(r.snapshot.every(x=>Number(x.signedAdjustment)!==0));
 const started=performance.now(),posted=await execute(r),elapsedMs=performance.now()-started;await db.exec('reset role');baseline={metrics:await metrics(),financials:await savedFinancials(posted.run_id),elapsedMs};await db.exec('rollback');
 assert.deepEqual(await financialSnapshot(),migrationBefore,'Legacy observation is rolled back, including numbering and audit rows');
 await applyFxExecutionBatch(db);afterFunctions=await metadata();migrationAfter=await financialSnapshot();
},{timeout:180000});
after(()=>db?.close());

test('one guarded runtime body changes; existing OIDs/attributes and all financial/history rows stay intact',()=>{
 assert.deepEqual(migrationAfter,migrationBefore);assert.equal(afterFunctions.length,beforeFunctions.length);const changed=[];
 for(let i=0;i<beforeFunctions.length;i++){const a=beforeFunctions[i],b=afterFunctions[i];assert.equal(a.oid,b.oid);const{source:sa,...aa}=a,{source:sb,...bb}=b;assert.deepEqual(bb,aa);if(sa!==sb)changed.push(a.name);}
 assert.equal(changed.length,1);assert.match(changed[0],/^sequence_security_private\.runtime_fx_post\(/);
});
test('67 nonzero sources on seven accounts retain exact legacy GL/JL output, with one observed rebuild per closing/reversal journal',async t=>{
 await tx(t);const r=await prepare(),started=performance.now(),out=await execute(r),elapsedMs=performance.now()-started;await db.exec('reset role');
 assert.equal(out.status,'CONTABILIZADO');assert.ok(out.journal_id&&out.reversal_journal_id&&out.journal_id!==out.reversal_journal_id);assert.equal(r.snapshot.length,67);
 const observed=await metrics();assert.equal(observed.syncCalls,2);assert.ok(baseline.metrics.syncCalls>observed.syncCalls);assert.equal(observed.glInsertRows,268);assert.ok(baseline.metrics.glInsertRows>observed.glInsertRows);
 assert.deepEqual(await savedFinancials(out.run_id),baseline.financials);
 const rows=(await db.query('select j.journal_date::text date,j.created_by,j.created_by_id,j.total_debit,j.total_credit,count(l.journal_line_id)::int lines,sum(abs(l.debit_fx)+abs(l.credit_fx))::float8 native from journal j join journal_line l using(journal_id)where j.fx_revaluation_run_id=$1 group by j.journal_id order by j.journal_date',[out.run_id])).rows;
 assert.deepEqual(rows.map(x=>x.date),['2026-10-31','2026-11-01']);assert.deepEqual(rows.map(x=>x.lines),[134,134]);for(const row of rows){assert.equal(row.created_by,1);assert.ok(row.created_by_id);assert.equal(row.total_debit,row.total_credit);assert.equal(row.native,0);}
 assert.equal(await q('select count(*)::int d from sequence_security_private.contexts'),0);
 t.diagnostic(JSON.stringify({syntheticSources:67,legacy:baseline.metrics,batched:observed,legacyMs:Math.round(baseline.elapsedMs),batchedMs:Math.round(elapsedMs),scope:'PGlite observation, not a production latency estimate'}));
});
test('a lost-response retry returns the same pair without new numbering, GL, audit or synchronization',async t=>{
 await tx(t);const r=await prepare(),first=await execute(r);const saved=await financialSnapshot(),count=await metrics();await assumeSecurityUser(db);const again=await execute(r);assert.equal(again.journal_id,first.journal_id);assert.equal(again.reversal_journal_id,first.reversal_journal_id);assert.deepEqual(await financialSnapshot(),saved);assert.deepEqual(await metrics(),count);
});
test('caller flags off/on/unset are restored and final synchronization still occurs when outer deferral is on',async t=>{
 await tx(t);for(const prior of['on','off','']){await db.exec('reset role;savepoint flag_case');await assumeSecurityUser(db);await db.query("select set_config('nexo.defer_journal_gl_sync',$1,true),set_config('nexo.fx_posting',$1,true)",[prior]);const r=await prepare();await execute(r);assert.equal(await q("select current_setting('nexo.defer_journal_gl_sync',true)d"),prior);assert.equal(await q("select current_setting('nexo.fx_posting',true)d"),prior);await db.exec('reset role');assert.equal((await metrics()).syncCalls,2);await db.exec('rollback to flag_case;release flag_case');}
});
async function injectFailure(code,{audit=false}={}){
 await db.exec('reset role');const on=audit?'audit_log':'gl_impact';
 const condition=audit?"new.entity_type='gl_impact'and exists(select 1 from journal j where j.fx_revaluation_run_id is not null and j.journal_date='2026-11-01')":"exists(select 1 from journal j where j.transaction_id=new.transaction_id and j.fx_revaluation_run_id is not null and j.journal_date='2026-11-01')";
 await db.exec(`create function fixture_fail_final_fx()returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin if ${condition}then raise exception using errcode='${code}',message='Synthetic late FX failure';end if;return new;end$$;create trigger fixture_fail_final_fx before insert on ${on} for each row execute function fixture_fail_final_fx()`);
}
for(const[title,code,audit]of[['late reversal GL failure','P0001',false],['query cancellation during final GL synchronization','57014',false],['late real audit insertion failure','P0001',true]])test(title+' rolls back both journals, numbering and audit history atomically',async t=>{
 await tx(t);const r=await prepare(),saved=await financialSnapshot();await injectFailure(code,{audit});await assumeSecurityUser(db);await db.query("select set_config('nexo.defer_journal_gl_sync','off',true),set_config('nexo.fx_posting','off',true)");await deniedSql(db,'select public.fx_execute($1)',[{runId:r.run_id,fingerprint:r.fingerprint}],code);assert.equal(await q("select current_setting('nexo.defer_journal_gl_sync',true)d"),'off');assert.equal(await q("select current_setting('nexo.fx_posting',true)d"),'off');assert.deepEqual(await financialSnapshot(),saved);
 await db.exec('drop trigger fixture_fail_final_fx on '+(audit?'audit_log':'gl_impact')+';drop function fixture_fail_final_fx()');await assumeSecurityUser(db);const retry=await execute(r);assert.ok(retry.journal_id&&retry.reversal_journal_id);await db.exec('reset role');assert.equal(await q('select count(*)::int d from journal where fx_revaluation_run_id=$1',[r.run_id]),2);
});
test('changed source eligibility, preview proof and official rate fail before any posting',async t=>{
 await tx(t);const r=await prepare();await deniedSql(db,'select public.fx_execute($1)',[{runId:r.run_id,fingerprint:'FORGED'}],'55000');
 for(const change of["update chart_accounts set pending_fx_revaluation=false where account_id=2601","update exchange_rates set spot_rate=160 where exchange_rate_id=9001"]){await db.exec('reset role;savepoint changed');await db.exec(change);const saved=await financialSnapshot();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_execute($1)',[{runId:r.run_id,fingerprint:r.fingerprint}],'P0001');assert.deepEqual(await financialSnapshot(),saved);await db.exec('rollback to changed;release changed');}
});
test('closing/reversal periods and active account scope remain mandatory without partial journals',async t=>{
 await tx(t);const r=await prepare();for(const change of["update fiscal_periods set gl_closed=true where fiscal_period_id=10","update fiscal_periods set gl_closed=true where fiscal_period_id=13","update account_subsidiaries set is_active=false where account_id=2601 and subsidiary_id=1"]){await db.exec('reset role;savepoint closed');await db.exec(change);const saved=await financialSnapshot();await assumeSecurityUser(db);await deniedSql(db,'select public.fx_execute($1)',[{runId:r.run_id,fingerprint:r.fingerprint}],'55000');assert.deepEqual(await financialSnapshot(),saved);await db.exec('rollback to closed;release closed');}
});
test('A06 view-only, foreign subsidiary, no identity and direct private execution cannot post',async t=>{
 await tx(t);const r=await prepare(),p=[{runId:r.run_id,fingerprint:r.fingerprint}];await assumeSecurityUser(db,1,3,1);await deniedSql(db,'select public.fx_execute($1)',p);await assumeSecurityUser(db,1,1,2);await deniedSql(db,'select public.fx_execute($1)',p);await assumeSqlRole(db,'anon');await deniedSql(db,'select public.fx_execute($1)',p);await assumeSecurityUser(db);await deniedSql(db,'select sequence_security_private.runtime_fx_post($1,$2,1,$3)',[r.run_id,'2026-10-31','forged']);
});
test('without auto-reversal only the closing is posted once, with local-only balanced GL',async t=>{
 await tx(t);const r=await prepare({autoReverse:false}),out=await execute(r);assert.ok(out.journal_id);assert.equal(out.reversal_journal_id,null);await db.exec('reset role');assert.equal((await metrics()).syncCalls,1);const values=await savedFinancials(out.run_id);assert.equal(values.length,1);assert.equal(values[0].debit,values[0].credit);assert.ok(values[0].ledger.every(x=>x[4]===0&&x[5]===0));
});
// PGlite serializes one connection. Stale-proof and retry cases exercise the
// real locking paths, without claiming independent-session MVCC contention.
