import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setupClassicBankUnmatch,applyClassicBankUnmatch,seedClassicMatch,classicBankUnmatchMigration,assumeSecurityUser,assumeSqlRole,deniedSql} from './fixtures/setup-classic-bank-unmatch.mjs';
let db,oldFunctions,newFunctions,oldRows,newRows,oldSecurity,newSecurity;
const sql='select public.unmatch_bank_reconciliation($1,$2,$3)result';
const tables=['bank_account','bank_transaction','bank_statement','bank_statement_line','bank_reconciliation','bank_reconciliation_match','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','journal','journal_line','gl_impact','transaction','audit_log','change_log','deleted_records','event_log','activity_log'];
const functions=async probe=>(await probe.query("select p.oid,n.nspname schema,p.proname,md5(p.prosrc)md5,p.proowner,p.proacl::text acl,p.proconfig,p.prosecdef,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','reconciliation_private')order by p.oid")).rows;
const security=async()=> (await db.query("select c.relname,c.relowner,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'order by c.oid")).rows;
async function snapshot(){await db.exec('reset role');const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)d from public."${table}" t`)).rows[0].d;return out;}
before(async()=>{({db}=await setupClassicBankUnmatch({apply:false}));oldFunctions=await functions(db);oldRows=await snapshot();oldSecurity=await security();await applyClassicBankUnmatch(db);newFunctions=await functions(db);newRows=await snapshot();newSecurity=await security();});
after(()=>db?.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);return seedClassicMatch(db);}
async function unmatch(x,changes={}){await assumeSecurityUser(db);return(await db.query(sql,[changes.bank??x.bank,changes.cutoff??x.cutoff,changes.match??x.match])).rows[0].result;}
async function rejectUnchanged(x,code='PBU01',changes={},identity={}){const prior=await snapshot();await assumeSecurityUser(db,identity.user??1,identity.role??1,identity.sid??1);await deniedSql(db,sql,[changes.bank??x.bank,changes.cutoff??x.cutoff,changes.match??x.match],code);assert.deepEqual(await snapshot(),prior);}
async function quad(status='draft',month=10){return(await db.query("insert into quadratic_bank_reconciliations(subsidiary_id,bank_account_id,period_year,period_month,status,created_by)values(1,1,2026,$1,$2,1)returning reconciliation_id",[month,status])).rows[0].reconciliation_id;}
const withoutStatusAndActor=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='reconciliation_status'&&!key.startsWith('updated_')));

test('migration adds one authenticated RPC and only enriches the guarded report body, preserving ACLs, RLS and historical data',async()=>{
 const prior=new Map(oldFunctions.map(f=>[f.oid,f]));
 const modified=newFunctions.filter(f=>prior.has(f.oid)&&f.md5!==prior.get(f.oid).md5);assert.deepEqual(modified.map(f=>f.schema+'.'+f.proname),['public.run_bank_reconciliation_report']);
 for(const f of newFunctions.filter(f=>prior.has(f.oid)))assert.deepEqual({...f,md5:null},{...prior.get(f.oid),md5:null});
 const added=newFunctions.filter(f=>!prior.has(f.oid));assert.equal(added.length,1);assert.equal(added[0].proname,'unmatch_bank_reconciliation');assert.equal(added[0].prosecdef,true);assert.deepEqual(added[0].proconfig,['search_path=pg_catalog, public, pg_temp']);assert.deepEqual(newRows,oldRows);assert.deepEqual(newSecurity,oldSecurity);
 for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.unmatch_bank_reconciliation(bigint,date,bigint)','execute')ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select has_function_privilege('authenticated','public.unmatch_bank_reconciliation(bigint,date,bigint)','execute')ok")).rows[0].ok,true);
 assert.equal((await db.query("select exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl)a where p.oid='public.unmatch_bank_reconciliation(bigint,date,bigint)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')ok")).rows[0].ok,false);
});

test('success releases exactly one classic match and preserves all source values, bank balance, statement and GL',async t=>{
 const x=await tx(t);await db.query('insert into gl_impact(subsidiary_id,account_id,posting_date,debit_amount,credit_amount)values(1,101,\'2026-10-15\',25,0),(1,102,\'2026-10-15\',0,25)');
 const prior=await snapshot();const result=await unmatch(x);assert.deepEqual(result,{success:true,bankAccountId:x.bank,cutoff:x.cutoff,matchId:x.match,reconciliationId:x.reconciliation,bankTransactionId:x.book,statementId:x.statement,statementLineId:x.line});
 const current=await snapshot();assert.equal(current.bank_reconciliation_match.length,0);
 const book=current.bank_transaction.find(y=>y.bank_tran_id===x.book),line=current.bank_statement_line.find(y=>y.statement_line_id===x.line);
 assert.equal(book.reconciliation_status,'PENDIENTE_EN_TRANSITO');assert.equal(line.reconciliation_status,'PENDIENTE');assert.equal(book.value_date,'2026-10-18');
 assert.deepEqual(withoutStatusAndActor(book),withoutStatusAndActor(prior.bank_transaction.find(y=>y.bank_tran_id===x.book)));assert.deepEqual(withoutStatusAndActor(line),withoutStatusAndActor(prior.bank_statement_line.find(y=>y.statement_line_id===x.line)));
 for(const table of ['bank_account','bank_statement','bank_reconciliation','journal','journal_line','gl_impact','transaction'])assert.deepEqual(current[table],prior[table]);
});

test('real central audit records the deleted link, both status changes and an authoritative actor envelope',async t=>{
 const x=await tx(t);const prior=await snapshot();await unmatch(x);const current=await snapshot();
 const events=current.event_log.filter(y=>!prior.event_log.some(z=>z.event_id===y.event_id));assert.equal(events.length,1);const event=events[0];assert.equal(event.event_type,'BANK_RECONCILIATION_UNMATCH');assert.equal(event.actor_type,'HUMAN');assert.equal(event.created_by_email,'synthetic-1@example.invalid');
 const details=event.details;assert.equal(details.userId,1);assert.equal(details.bankAccountId,x.bank);assert.equal(details.match.match_id,x.match);assert.equal(details.reconciliation.reconciliation_id,x.reconciliation);assert.equal(details.statement.statement_id,x.statement);assert.equal(details.actor.email,event.created_by_email);assert.notEqual(details.actor.email,'forged-header@example.invalid');assert.equal(details.before.bankTransaction.reconciliation_status,'CONCILIADO');assert.equal(details.after.bankTransaction.reconciliation_status,'PENDIENTE_EN_TRANSITO');assert.equal(details.after.statementLine.reconciliation_status,'PENDIENTE');
 const deleted=current.deleted_records.filter(y=>!prior.deleted_records.some(z=>z.deleted_id===y.deleted_id));assert.equal(deleted.length,1);assert.equal(deleted[0].original_table_name,'bank_reconciliation_match');assert.equal(JSON.parse(deleted[0].record_data_json).match_id,x.match);assert.equal(deleted[0].deleted_by_user_id,1);
 const audits=current.audit_log.filter(y=>!prior.audit_log.some(z=>z.log_id===y.log_id));assert.equal(audits.length,3);assert.deepEqual(audits.map(y=>[y.entity_type,y.action]).sort(),[['bank_reconciliation_match','ELIMINACION'],['bank_statement_line','MODIFICACION'],['bank_transaction','MODIFICACION']]);assert.ok(audits.every(y=>y.user_id===1));
});

test('repeat or missing match is a conflict without success, partial data changes or new audit rows',async t=>{
 const x=await tx(t);await unmatch(x);await rejectUnchanged(x);await rejectUnchanged(x,'PBU01',{match:99999});
});

test('owning cutoff and bank must match the selected link exactly, including a later open reconciliation',async t=>{
 const x=await tx(t);await rejectUnchanged(x,'PBU01',{cutoff:'2026-11-03'});await rejectUnchanged(x,'PBU01',{bank:2});await rejectUnchanged(x,'42501',{bank:3});
 await db.exec('reset role');await db.query("update bank_reconciliation set reconciliation_date='2026-11-03'where reconciliation_id=$1",[x.reconciliation]);await rejectUnchanged(x);await unmatch(x,{cutoff:'2026-11-03'});
});

test('view-only, blind edit, unassigned role, inactive user and another company are denied before writes',async t=>{
 const x=await tx(t);for(const identity of [{role:3},{role:4},{role:999},{sid:2}])await rejectUnchanged(x,'42501',{},identity);
 await db.exec('reset role;update users set is_active=false where user_id=1');await rejectUnchanged(x,'42501');
});

test('anonymous, service role, missing trusted identity and raw client table writes stay closed',async t=>{
 const x=await tx(t);const prior=await snapshot();
 for(const role of ['anon','service_role','authenticated']){await assumeSqlRole(db,role);await deniedSql(db,sql,[x.bank,x.cutoff,x.match]);}
 await assumeSecurityUser(db);await deniedSql(db,'delete from bank_reconciliation_match where match_id=$1',[x.match]);await deniedSql(db,"update bank_transaction set reconciliation_status='PENDIENTE_EN_TRANSITO'where bank_tran_id=$1",[x.book]);assert.deepEqual(await snapshot(),prior);
});

test('own or later closed classic periods block release without reopening or altering either reconciliation',async t=>{
 const x=await tx(t);await db.query("update bank_reconciliation set status='CERRADA',closed_at=now()where reconciliation_id=$1",[x.reconciliation]);await rejectUnchanged(x,'55000');
});

test('a subsequent closed classic reconciliation protects earlier matches',async t=>{
 const x=await tx(t);await db.exec("insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(11,1,'2026-11-01','2026-11-30',false)");await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-11-30',1,11,'CERRADA')");await rejectUnchanged(x,'55000');
});

test('an earlier closed period covering the source date also blocks a match owned by a later open cutoff',async t=>{
 const x=await tx(t);await db.exec("insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(11,1,'2026-11-01','2026-11-30',false)");await db.query("update bank_reconciliation set reconciliation_date='2026-11-03',fiscal_period_id=11 where reconciliation_id=$1",[x.reconciliation]);await db.query("insert into bank_reconciliation(reconciliation_date,bank_account_id,fiscal_period_id,status)values('2026-10-31',1,10,'CERRADA')");await rejectUnchanged(x,'55000',{cutoff:'2026-11-03'});
});

test('approved or closed quadratic downstream periods protect sources without touching quadratic state',async t=>{
 const x=await tx(t);for(const status of ['approved','closed']){await db.exec('savepoint quad_state');await quad(status,11);await rejectUnchanged(x,'55000');await db.exec('reset role;rollback to quad_state;release quad_state');}
});

test('any quadratic match or item referencing either source blocks release even in a draft',async t=>{
 const x=await tx(t);const q=await quad();
 for(const source of ['book','line','match']){await db.exec('savepoint quad_reference');
  if(source==='match')await db.query("insert into quadratic_reconciliation_matches(reconciliation_id,bank_tran_id,statement_line_id,match_type,matched_by)values($1,$2,$3,'MANUAL',1)",[q,x.book,x.line]);
  else await db.query("insert into quadratic_reconciliation_items(reconciliation_id,bank_tran_id,statement_line_id,item_type,adjustment_side,description,transaction_date,created_by)values($1,$2,$3,'BANK_ERROR','BANK','Synthetic protected source','2026-10-15',1)",[q,source==='book'?x.book:null,source==='line'?x.line:null]);
  await rejectUnchanged(x);await db.exec('reset role;rollback to quad_reference;release quad_reference');
 }
});

test('stale source statuses and incompatible amounts are rejected atomically',async t=>{
 const x=await tx(t);
 for(const [table,key,value]of [['bank_transaction','bank_tran_id',"reconciliation_status='PENDIENTE_EN_TRANSITO'"],['bank_statement_line','statement_line_id',"reconciliation_status='PENDIENTE'"],['bank_transaction','bank_tran_id','amount=24'],['bank_transaction','bank_tran_id',"amount='NaN'::numeric"],['bank_transaction','bank_tran_id',"tran_type='SALDO_INICIAL'"]]){
  await db.exec('savepoint stale');await db.exec('alter table '+table+' disable trigger security_reconciliation_sources');await db.query('update '+table+' set '+value+' where '+key+'=$1',[table==='bank_transaction'?x.book:x.line]);await db.exec('alter table '+table+' enable trigger security_reconciliation_sources');await rejectUnchanged(x);await db.exec('reset role;rollback to stale;release stale');
 }
 await db.exec('savepoint future_statement');await db.query("update bank_statement set statement_date='2026-11-30'where statement_id=$1",[x.statement]);await rejectUnchanged(x);await db.exec('reset role;rollback to future_statement;release future_statement');
});

test('invalid input cannot consume a match or write audit history',async t=>{
 const x=await tx(t);for(const args of [[0,x.cutoff,x.match],[x.bank,null,x.match],[x.bank,'infinity',x.match],[x.bank,x.cutoff,-1]]){const prior=await snapshot();await assumeSecurityUser(db);await deniedSql(db,sql,args,'22023');assert.deepEqual(await snapshot(),prior);}
});

test('an open label with a retained closed timestamp is not treated as an editable reconciliation',async t=>{
 const x=await tx(t);await db.query('update bank_reconciliation set closed_at=now()where reconciliation_id=$1',[x.reconciliation]);await rejectUnchanged(x);
});

test('linked transaction and journal must belong to the active company while null legacy trace remains valid',async t=>{
 const x=await tx(t);const transaction=(await db.query('insert into "transaction"(subsidiary_id)values(2)returning transaction_id')).rows[0].transaction_id;
 await db.query('update bank_transaction set transaction_id=$1 where bank_tran_id=$2',[transaction,x.book]);await rejectUnchanged(x);
 await db.query('update "transaction"set subsidiary_id=1 where transaction_id=$1',[transaction]);await db.query('insert into journal(transaction_id,subsidiary_id)values($1,2)',[transaction]);await rejectUnchanged(x);
 await db.query('update journal set subsidiary_id=1 where transaction_id=$1',[transaction]);await unmatch(x);
});

test('a late audit failure rolls back the deleted match, both statuses and all emitted audit events',async t=>{
 const x=await tx(t);await db.exec("create or replace function public.record_system_event(event_type text,source_component text,description text,result text default 'EXITOSA',details jsonb default null)returns bigint language plpgsql security definer set search_path=public,pg_temp as $$begin raise exception using errcode='P0001',message='Synthetic audit failure';end$$");await rejectUnchanged(x,'P0001');
});

const reportFilters={bankAccountId:1,dateFrom:'2026-10-01',dateTo:'2026-10-31',bankView:'RECONCILED',page:1,pageSize:50};
async function report(role=1){await assumeSecurityUser(db,1,role);return(await db.query('select run_bank_reconciliation_report($1)payload',[reportFilters])).rows[0].payload;}
const stripMetadata=payload=>({...payload,rows:payload.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['match_id','reconciliation_id','reconciliation_cutoff','can_unmatch'].includes(key)))),statementLines:payload.statementLines.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['match_id','reconciliation_id','reconciliation_cutoff','can_unmatch'].includes(key))))});

test('new projection binds mismatched row ordering to exact owning matches and preserves the synthetic read source byte-for-byte without writes',async t=>{
 const first=await tx(t);await db.exec("insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed)values(11,1,'2026-11-01','2026-11-30',false)");
 const secondLine=(await db.query("insert into bank_statement_line(statement_id,bank_date,reference,amount,source_row)values(1,'2026-10-22','SYNTHETIC-SECOND',40,2)returning statement_line_id")).rows[0].statement_line_id;
 const second=await seedClassicMatch(db,{date:'2026-11-03',amount:40,lineId:secondLine,period:11});
 const legacy=(await db.query('select reconciliation_private.run_bank_reconciliation_report($1)payload',[reportFilters])).rows[0].payload;const prior=await snapshot();const actual=await report();assert.deepEqual(stripMetadata(actual),legacy);assert.deepEqual(await snapshot(),prior);
 assert.deepEqual(actual.rows.map(row=>row.id),[second.book,first.book]);assert.deepEqual(actual.statementLines.map(row=>row.statement_line_id),[first.line,second.line]);
 for(const item of [first,second])for(const row of [actual.rows.find(row=>row.id===item.book),actual.statementLines.find(row=>row.statement_line_id===item.line)])assert.deepEqual([row.match_id,row.reconciliation_id,row.reconciliation_cutoff,row.can_unmatch],[item.match,item.reconciliation,item.cutoff,true]);
});

test('projection never offers a write for readers, closed source periods, retained closed timestamps, quadratic references or stale states',async t=>{
 const x=await tx(t);const baseline=await snapshot();const reader=await report(3);assert.equal(reader.rows[0].match_id,x.match);assert.equal(reader.rows[0].can_unmatch,false);assert.equal(reader.statementLines[0].can_unmatch,false);assert.deepEqual(await snapshot(),baseline);
 for(const variant of ['timestamp','quadratic','status','source-closed']){await db.exec('savepoint eligibility');
  if(variant==='timestamp')await db.query('update bank_reconciliation set closed_at=now()where reconciliation_id=$1',[x.reconciliation]);
  if(variant==='quadratic'){const q=await quad();await db.query("insert into quadratic_reconciliation_items(reconciliation_id,bank_tran_id,item_type,adjustment_side,description,transaction_date,created_by)values($1,$2,'BANK_ERROR','BANK','Synthetic reference','2026-10-15',1)",[q,x.book]);}
  if(variant==='status')await db.query("update bank_statement_line set reconciliation_status='PENDIENTE'where statement_line_id=$1",[x.line]);
  if(variant==='source-closed')await db.query("update bank_reconciliation set status='CERRADA'where reconciliation_id=$1",[x.reconciliation]);
  const prior=await snapshot();const actual=await report();assert.equal(actual.rows[0].match_id,x.match);assert.equal(actual.rows[0].can_unmatch,false);assert.equal(actual.statementLines[0].can_unmatch,false);assert.deepEqual(await snapshot(),prior);await db.exec('rollback to eligibility;release eligibility');
 }
 await assumeSecurityUser(db,1,1,2);await deniedSql(db,'select run_bank_reconciliation_report($1)',[reportFilters]);
});

test('dependency drift or a missing audit trigger blocks migration before adding the RPC',async()=>{
 const fixture=await setupClassicBankUnmatch({apply:false}),probe=fixture.db;
 try{const migration=(await readFile(new URL('../supabase/migrations/'+classicBankUnmatchMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  for(const signature of ['reconciliation_private.access(text,text)','reconciliation_private.bank_scope(bigint,date,boolean)','reconciliation_private.protect_sources()','public.capture_row_audit()','public.record_system_event(text,text,text,text,jsonb)','public.resolve_audit_actor()']){await probe.exec('begin');const d=(await probe.query('select pg_get_functiondef($1::regprocedure)d',[signature])).rows[0].d;await probe.exec(d.replace('AS $function$','AS $function$\n-- Synthetic source drift'));await assert.rejects(probe.exec(migration),e=>e.code==='P0001'&&/Unexpected/.test(e.message));await probe.exec('rollback');}
  await probe.exec('begin;alter table bank_reconciliation_match disable trigger central_row_audit');await assert.rejects(probe.exec(migration),e=>e.code==='P0001'&&/Missing current audit/.test(e.message));await probe.exec('rollback');assert.equal((await probe.query("select to_regprocedure('public.unmatch_bank_reconciliation(bigint,date,bigint)')rpc")).rows[0].rpc,null);
 }finally{await probe.close();}
});
