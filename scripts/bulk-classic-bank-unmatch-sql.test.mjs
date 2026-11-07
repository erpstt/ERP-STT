import assert from'node:assert/strict';
import {test,before,after}from'node:test';
import {performance}from'node:perf_hooks';
import {readFile}from'node:fs/promises';
import {setupBulkClassicBankUnmatch,applyBulkClassicBankUnmatch,seedBulkClassicMatches,bulkClassicBankUnmatchMigration,assumeSecurityUser,assumeSqlRole,deniedSql}from'./fixtures/setup-bulk-classic-bank-unmatch.mjs';
let db,priorFunctions,currentFunctions,priorRows,currentRows,priorAcl,currentAcl;
const previewSql='select preview_bank_reconciliation_unmatch_all($1,$2)result',writeSql='select unmatch_all_bank_reconciliation($1,$2,$3,$4,$5)result';
const tables=['bank_account','bank_transaction','bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','journal','journal_line','gl_impact','transaction','audit_log','change_log','deleted_records','event_log','activity_log'];
async function hashes(){await db.exec('reset role');const out={};for(const table of tables)out[table]=(await db.query(`select count(*)::int count,md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)hash from public."${table}" t`)).rows[0];return out;}
const functions=async probe=>(await probe.query("select p.oid,n.nspname schema,p.proname,md5(p.prosrc)md5,p.proowner,p.proacl::text acl,p.proconfig,p.prosecdef,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','reconciliation_private')order by p.oid")).rows;
const acl=async()=>(await db.query("select c.oid,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'order by c.oid")).rows;
before(async()=>{({db}=await setupBulkClassicBankUnmatch({apply:false}));priorFunctions=await functions(db);priorRows=await hashes();priorAcl=await acl();await applyBulkClassicBankUnmatch(db);currentFunctions=await functions(db);currentRows=await hashes();currentAcl=await acl();});
after(()=>db?.close());
async function tx(t,options={}){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);return seedBulkClassicMatches(db,options);}
async function preview(x,identity={}){await assumeSecurityUser(db,identity.user??1,identity.role??1,identity.sid??1);return(await db.query(previewSql,[x.bank,x.cutoff])).rows[0].result;}
const args=(x,p,change={})=>[change.bank??x.bank,change.cutoff??x.cutoff,change.statement??x.statement,change.fingerprint??p.fingerprint,change.count??p.matchCount];
async function write(x,p,change={}){await assumeSecurityUser(db);return(await db.query(writeSql,args(x,p,change))).rows[0].result;}
async function rejectUnchanged(x,p,code='PBU01',change={},identity={}){const prior=await hashes();await assumeSecurityUser(db,identity.user??1,identity.role??1,identity.sid??1);await deniedSql(db,writeSql,args(x,p,change),code);assert.deepEqual(await hashes(),prior);}
async function quad(status='draft'){return(await db.query("insert into quadratic_bank_reconciliations(subsidiary_id,bank_account_id,period_year,period_month,status,created_by)values(1,1,2026,11,$1,1)returning reconciliation_id",[status])).rows[0].reconciliation_id;}

test('migration changes only capability wrapper, adds two authenticated RPCs and one owner-only helper, with no historical or ACL writes',async()=>{
 const old=new Map(priorFunctions.map(f=>[f.oid,f]));const changed=currentFunctions.filter(f=>old.has(f.oid)&&f.md5!==old.get(f.oid).md5);assert.deepEqual(changed.map(f=>f.schema+'.'+f.proname),['public.run_bank_reconciliation_report']);for(const f of currentFunctions.filter(f=>old.has(f.oid)))assert.deepEqual({...f,md5:null},{...old.get(f.oid),md5:null});
 const added=currentFunctions.filter(f=>!old.has(f.oid));assert.equal(added.length,3);for(const f of added){assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog, public, pg_temp']);}assert.deepEqual(currentRows,priorRows);assert.deepEqual(currentAcl,priorAcl);
 for(const role of ['anon','service_role','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'reconciliation_private.unmatch_all_snapshot(bigint,date,bigint)','execute')ok",[role])).rows[0].ok,false);
 for(const signature of ['public.preview_bank_reconciliation_unmatch_all(bigint,date)','public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)']){for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2,'execute')ok",[role,signature])).rows[0].ok,false);assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute')ok",[signature])).rows[0].ok,true);}
});

test('preview counts all eleven statement matches across October and November owning cutoffs without writes',async t=>{
 const x=await tx(t);const prior=await hashes(),p=await preview(x);assert.equal(p.scope,'BANK_STATEMENT');assert.equal(p.statementId,1);assert.equal(p.statementDate,x.cutoff);assert.equal(p.matchCount,11);assert.equal(p.canUnmatch,true);assert.equal(p.blockedReason,null);assert.match(p.fingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(p.groups.map(g=>[g.cutoff,g.matchCount,g.currencyCode,g.netAmount]),[['2026-10-31',10,'USD','250.055000'],['2026-11-03',1,'USD','25.011000']]);assert.deepEqual(await hashes(),prior);
});

test('two previews and intervening authenticated reads or technical lease activity preserve the same fingerprint and permit confirmation',async t=>{
 const x=await tx(t),p=await preview(x);await db.query("select security_assert_role_access('banking:bank-reconciliations','edit')");await db.query('select run_bank_reconciliation_report($1)',[{bankAccountId:1,dateFrom:'2026-10-01',dateTo:x.cutoff}]);await db.exec("reset role;update devices set last_used=clock_timestamp();update sessions set expires_at=expires_at+interval'1 minute'");const p2=await preview(x);assert.equal(p2.fingerprint,p.fingerprint);const result=await write(x,p);assert.equal(result.unmatchedCount,11);
});

test('one SQL call releases the whole statement, records batch plus individual audit, and preserves all amounts, dates, bank/GL and headers',async t=>{
 const x=await tx(t),p=await preview(x);const prior=await hashes();await db.exec('reset role');const values=(await db.query('select jsonb_agg(to_jsonb(b)-\'reconciliation_status\'-array[\'updated_by_id\',\'updated_by_email\',\'updated_by_name\',\'updated_actor_type\',\'updated_actor_source\',\'updated_execution_context_id\']order by bank_tran_id)rows from bank_transaction b')).rows[0].rows;
 const result=await write(x,p);assert.deepEqual(result,{success:true,scope:'BANK_STATEMENT',bankAccountId:x.bank,cutoff:x.cutoff,statementId:x.statement,fingerprint:p.fingerprint,unmatchedCount:11,matchIds:x.matches.map(m=>m.match_id)});const actual=await hashes();for(const table of ['bank_account','bank_statement','bank_reconciliation','journal','journal_line','gl_impact','transaction'])assert.deepEqual(actual[table],prior[table]);assert.equal(actual.bank_reconciliation_match.count,0);
 const afterValues=(await db.query('select jsonb_agg(to_jsonb(b)-\'reconciliation_status\'-array[\'updated_by_id\',\'updated_by_email\',\'updated_by_name\',\'updated_actor_type\',\'updated_actor_source\',\'updated_execution_context_id\']order by bank_tran_id)rows from bank_transaction b')).rows[0].rows;assert.deepEqual(afterValues,values);assert.equal((await db.query("select count(*)::int n from bank_transaction where reconciliation_status='PENDIENTE_EN_TRANSITO'")).rows[0].n,11);
 const events=(await db.query("select event_type,details,created_by_email from event_log where event_type in('BANK_RECONCILIATION_UNMATCH','BANK_RECONCILIATION_UNMATCH_ALL')order by event_id")).rows;assert.equal(events.filter(e=>e.event_type==='BANK_RECONCILIATION_UNMATCH').length,11);const batch=events.find(e=>e.event_type==='BANK_RECONCILIATION_UNMATCH_ALL');assert.equal(batch.details.statementId,x.statement);assert.equal(batch.details.userId,1);assert.equal(batch.created_by_email,'synthetic-1@example.invalid');assert.deepEqual(batch.details.matchIds,result.matchIds);
});

test('matches from another statement remain linked even when they share an owning reconciliation',async t=>{
 const x=await tx(t,{count:2,secondaryCount:0});const other=(await db.query("insert into bank_statement(statement_date,bank_account_id,opening_balance,closing_balance)values('2026-09-30',1,0,7)returning statement_id")).rows[0].statement_id;const line=(await db.query("insert into bank_statement_line(statement_id,bank_date,amount,source_row,reconciliation_status)values($1,'2026-09-29',7,1,'CONCILIADO')returning statement_line_id",[other])).rows[0].statement_line_id;const book=(await db.query("insert into bank_transaction(bank_account_id,tran_date,amount,tran_type,reconciliation_status)values(1,'2026-09-29',7,'SYNTHETIC','CONCILIADO')returning bank_tran_id")).rows[0].bank_tran_id;const match=(await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)returning match_id",[x.first,book,line])).rows[0].match_id;const p=await preview(x);assert.equal(p.matchCount,2);await write(x,p);await db.exec('reset role');assert.deepEqual((await db.query('select match_id from bank_reconciliation_match')).rows,[{match_id:match}]);assert.equal((await db.query('select reconciliation_status s from bank_transaction where bank_tran_id=$1',[book])).rows[0].s,'CONCILIADO');
});

test('empty or nonexact selected date never falls back to a latest statement or a reconciliation header',async t=>{
 const x=await tx(t,{count:0,secondaryCount:0}),p=await preview(x);assert.equal(p.canUnmatch,false);assert.equal(p.matchCount,0);assert.deepEqual(p.groups,[]);await rejectUnchanged(x,p,'PBU01',{count:1});const missing=await preview({...x,cutoff:'2026-11-03'});assert.equal(missing.statementId,null);assert.equal(missing.canUnmatch,false);assert.equal(missing.matchCount,0);
});

test('fingerprint/count/statement/bank/cutoff tampering and a repeated committed request fail without further writes',async t=>{
 const x=await tx(t),p=await preview(x);for(const change of [{fingerprint:'0'.repeat(64)},{count:10},{statement:999},{bank:2},{cutoff:'2026-11-03'},{fingerprint:'INVALID'},{count:0}])await rejectUnchanged(x,p,'PBU01',change);await write(x,p);await rejectUnchanged(x,p);
});

test('removing, replacing with a new match ID or changing a source after preview invalidates the exact set',async t=>{
 const x=await tx(t),p=await preview(x);const first=x.matches[0];
 for(const variant of ['remove','rematch','source']){await db.exec('reset role;savepoint stale');
  if(variant==='source')await db.query("update bank_transaction set value_date='2026-10-18'where bank_tran_id=$1",[first.bank_tran_id]);
  else{await db.query('delete from bank_reconciliation_match where match_id=$1',[first.match_id]);if(variant==='rematch')await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)",[first.reconciliation_id,first.bank_tran_id,first.statement_line_id]);}
  await rejectUnchanged(x,p);await db.exec('reset role;rollback to stale;release stale');
 }
});

test('a new target match after preview is not silently excluded from the batch',async t=>{
 const x=await tx(t,{count:2,secondaryCount:0}),p=await preview(x);await db.exec('reset role');const line=(await db.query("insert into bank_statement_line(statement_id,bank_date,amount,source_row,reconciliation_status)values(1,'2026-10-15',9,999,'CONCILIADO')returning statement_line_id")).rows[0].statement_line_id;const book=(await db.query("insert into bank_transaction(bank_account_id,tran_date,amount,tran_type,reconciliation_status)values(1,'2026-10-15',9,'SYNTHETIC','CONCILIADO')returning bank_tran_id")).rows[0].bank_tran_id;await db.query("insert into bank_reconciliation_match(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)",[x.first,book,line]);await rejectUnchanged(x,p);assert.equal((await preview(x)).matchCount,3);
});

test('changing active user or assigned role invalidates a previously prepared fingerprint',async t=>{
 const x=await tx(t),p=await preview(x);await rejectUnchanged(x,p,'PBU01',{}, {role:2});await db.exec('reset role;insert into user_roles(user_id,role_id)values(2,1)on conflict do nothing;insert into user_subsidiaries(user_id,subsidiary_id)values(2,1)on conflict do nothing');await rejectUnchanged(x,p,'PBU01',{}, {user:2,role:1});
});

test('readers, blind editors, unassigned roles, another company and missing identity cannot preview or execute',async t=>{
 const x=await tx(t),p=await preview(x);for(const identity of [{role:3},{role:4},{role:999},{sid:2}]){await assumeSecurityUser(db,1,identity.role??1,identity.sid??1);await deniedSql(db,previewSql,[x.bank,x.cutoff]);await rejectUnchanged(x,p,'42501',{},identity);}
 for(const role of ['anon','service_role','authenticated']){await assumeSqlRole(db,role);await deniedSql(db,previewSql,[x.bank,x.cutoff]);await deniedSql(db,writeSql,args(x,p));}
});

test('one closed owner or downstream quadratic closure blocks the complete statement rather than skipping matches',async t=>{
 const x=await tx(t),p=await preview(x);await db.exec('reset role;savepoint protected_owner');await db.query("update bank_reconciliation set status='CERRADA'where reconciliation_id=$1",[x.second]);const blocked=await preview(x);assert.equal(blocked.matchCount,11);assert.equal(blocked.canUnmatch,false);await rejectUnchanged(x,p,'55000');await db.exec('reset role;rollback to protected_owner;release protected_owner');
 const q=await quad('approved');assert.ok(q);assert.equal((await preview(x)).canUnmatch,false);await rejectUnchanged(x,p,'55000');
});

test('one stale status or quadratic source reference blocks every member and remains visible in the full count',async t=>{
 const x=await tx(t),p=await preview(x),last=x.matches.at(-1);for(const variant of ['status','quadratic']){await db.exec('reset role;savepoint protected_source');
  if(variant==='status')await db.query("update bank_statement_line set reconciliation_status='PENDIENTE'where statement_line_id=$1",[last.statement_line_id]);
  else{const q=await quad();await db.query("insert into quadratic_reconciliation_items(reconciliation_id,bank_tran_id,item_type,adjustment_side,description,transaction_date,created_by)values($1,$2,'BANK_ERROR','BANK','Synthetic protected last member','2026-10-15',1)",[q,last.bank_tran_id]);}
  const blocked=await preview(x);assert.equal(blocked.matchCount,11);assert.equal(blocked.canUnmatch,false);await rejectUnchanged(x,p);await db.exec('reset role;rollback to protected_source;release protected_source');
 }
});

test('a late individual audit failure rolls back all earlier successful unmatches and their audit records',async t=>{
 const x=await tx(t),p=await preview(x),last=x.matches.at(-1);await db.exec('reset role');const definition=(await db.query("select pg_get_functiondef('public.record_system_event(text,text,text,text,jsonb)'::regprocedure)d")).rows[0].d;await db.exec(definition.replace('begin',`begin if event_type='BANK_RECONCILIATION_UNMATCH'and(details->'match'->>'match_id')::bigint=${last.match_id} then raise exception using errcode='P0001',message='Synthetic last-member audit failure';end if;`));await rejectUnchanged(x,p,'P0001');
});

test('failure of the final batch audit also rolls back every individual unmatch and audit event',async t=>{
 const x=await tx(t),p=await preview(x);await db.exec('reset role');const definition=(await db.query("select pg_get_functiondef('public.record_system_event(text,text,text,text,jsonb)'::regprocedure)d")).rows[0].d;await db.exec(definition.replace('begin',"begin if event_type='BANK_RECONCILIATION_UNMATCH_ALL'then raise exception using errcode='P0001',message='Synthetic final batch audit failure';end if;"));await rejectUnchanged(x,p,'P0001');
});

test('capability is scoped to exact statement date and edit permission, independently of count and source eligibility',async t=>{
 const x=await tx(t,{count:0,secondaryCount:0});const filters={bankAccountId:1,dateFrom:'2026-10-01',dateTo:x.cutoff};await assumeSecurityUser(db);assert.equal((await db.query('select run_bank_reconciliation_report($1)p',[filters])).rows[0].p.canUnmatchAll,true);await assumeSecurityUser(db,1,3);assert.equal((await db.query('select run_bank_reconciliation_report($1)p',[filters])).rows[0].p.canUnmatchAll,false);await assumeSecurityUser(db);assert.equal((await db.query('select run_bank_reconciliation_report($1)p',[{...filters,dateTo:'2026-11-03'}])).rows[0].p.canUnmatchAll,false);
});

test('foreign-bank owning headers fail authorization without exposing foreign owner groups or changing any row',async t=>{
 const x=await tx(t),p=await preview(x);await db.exec("reset role;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(20,2,'2026-10-01','2026-10-31',false)");const foreign=(await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-10-31',3,20,'ABIERTA')returning reconciliation_id")).rows[0].reconciliation_id;await db.exec('alter table bank_reconciliation_match disable trigger security_reconciliation_sources');await db.query('update bank_reconciliation_match set reconciliation_id=$1 where match_id=$2',[foreign,x.matches[0].match_id]);await db.exec('alter table bank_reconciliation_match enable trigger security_reconciliation_sources');const prior=await hashes();await assumeSecurityUser(db);await deniedSql(db,previewSql,[x.bank,x.cutoff]);assert.deepEqual(await hashes(),prior);await rejectUnchanged(x,p,'42501');
});

test('the ordinary guarded statement import becomes available after all target matches are released and preserves book/GL balances',async t=>{
 const x=await tx(t,{count:3,secondaryCount:1}),p=await preview(x);await db.exec('reset role');const rows=(await db.query("select jsonb_agg(jsonb_build_object('date',bank_date,'amount',amount,'reference',reference)order by statement_line_id)rows from bank_statement_line where statement_id=1")).rows[0].rows;const closing=(await db.query('select round(opening_balance+(select sum(amount)from bank_statement_line where statement_id=1),2)closing from bank_statement where statement_id=1')).rows[0].closing;const importArgs=[1,x.cutoff,100,closing,'synthetic-reviewed-statement.csv',rows];await assumeSecurityUser(db);await deniedSql(db,'select import_bank_statement($1,$2,$3,$4,$5,$6)',importArgs,'55000');await write(x,p);const prior=await hashes();await assumeSecurityUser(db);assert.equal((await db.query('select import_bank_statement($1,$2,$3,$4,$5,$6)id',importArgs)).rows[0].id,1);const actual=await hashes();for(const table of ['bank_account','bank_transaction','journal','journal_line','gl_impact','transaction'])assert.deepEqual(actual[table],prior[table]);assert.equal(actual.bank_reconciliation_match.count,0);assert.equal(actual.bank_statement_line.count,rows.length+1);
});

for(const count of [100,300])test(`synthetic ${count}-match batch preserves financial controls and reports bounded preview/write duration`,async t=>{
 const x=await tx(t,{count,secondaryCount:1});const prior=await hashes();const start=performance.now(),p=await preview(x),previewMs=performance.now()-start;const writeStart=performance.now(),result=await write(x,p),writeMs=performance.now()-writeStart;const after=await hashes();assert.equal(result.unmatchedCount,count);for(const table of ['bank_account','bank_statement','bank_reconciliation','journal','journal_line','gl_impact','transaction'])assert.deepEqual(after[table],prior[table]);assert.equal(after.bank_reconciliation_match.count,0);t.diagnostic(JSON.stringify({count,previewMs:Math.round(previewMs),writeMs:Math.round(writeMs),financialValuesPreserved:true}));
});

test('source dependency or wrapper drift aborts migration without creating partially available bulk RPCs',async()=>{
 const{db:probe}=await setupBulkClassicBankUnmatch({apply:false});try{const sql=(await readFile(new URL('../supabase/migrations/'+bulkClassicBankUnmatchMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');for(const signature of ['public.unmatch_bank_reconciliation(bigint,date,bigint)','public.run_bank_reconciliation_report(jsonb)']){await probe.exec('begin');const d=(await probe.query('select pg_get_functiondef($1::regprocedure)d',[signature])).rows[0].d;await probe.exec(d.replace('AS $function$','AS $function$\n-- Synthetic drift\n'));await assert.rejects(probe.exec(sql),e=>e.code==='P0001'&&/Unexpected/.test(e.message));await probe.exec('rollback');assert.equal((await probe.query("select to_regprocedure('public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)')p")).rows[0].p,null);}
  for(const change of ['alter table bank_transaction disable trigger central_row_audit','drop trigger security_reconciliation_sources on bank_statement_line']){await probe.exec('begin;'+change);await assert.rejects(probe.exec(sql),e=>e.code==='P0001'&&/Missing current bulk-unmatch/.test(e.message));await probe.exec('rollback');assert.equal((await probe.query("select to_regprocedure('public.unmatch_all_bank_reconciliation(bigint,date,bigint,text,integer)')p")).rows[0].p,null);}
 }finally{await probe.close();}
});
