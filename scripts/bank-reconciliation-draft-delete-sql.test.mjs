import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setupBankReconciliationDraftDelete,seedBankReconciliationDraft,seedDraftReconciliationMatch,assumeSecurityUser,assumeSqlRole,deniedSql} from './fixtures/setup-bank-reconciliation-draft-delete.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
let db,abaDraft,baselineFunctions,baselineTables,optionsMetadata,migration;
const added=['reconciliation_private.draft_delete_snapshot(bigint,date,bigint)','reconciliation_private.annotate_draft_delete_options(jsonb)','public.preview_bank_reconciliation_draft_delete(bigint,date,bigint)','public.delete_bank_reconciliation_draft(bigint,date,bigint,text)'];
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;
const preview=draft=>q('select preview_bank_reconciliation_draft_delete($1,$2,$3)d',[draft.bank,draft.cutoff,draft.reconciliationId]);
const remove=(draft,fingerprint)=>q('select delete_bank_reconciliation_draft($1,$2,$3,$4)d',[draft.bank,draft.cutoff,draft.reconciliationId,fingerprint]);
const options=()=>q('select bank_reconciliation_options()d');
const inventory=()=>q("select jsonb_agg(jsonb_build_array(oid,oid::regprocedure::text,proowner,proacl::text,proconfig,prosecdef,provolatile,md5(prosrc))order by oid)d from pg_proc where pronamespace in('public'::regnamespace,'reconciliation_private'::regnamespace)and proname not in('draft_delete_snapshot','annotate_draft_delete_options','preview_bank_reconciliation_draft_delete','delete_bank_reconciliation_draft','bank_reconciliation_options')or oid='reconciliation_private.bank_reconciliation_options()'::regprocedure");
const security=()=>q("select jsonb_agg(jsonb_build_array(oid,relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity)order by oid)d from pg_class where relnamespace='public'::regnamespace and relkind in('r','p')");
const financialTables=['bank_account','bank_transaction','bank_statement','bank_statement_line','bank_reconciliation_match','quadratic_bank_reconciliations','quadratic_reconciliation_items','quadratic_reconciliation_matches','journal','journal_line','gl_impact','transaction'];
const auditTables=['audit_log','change_log','deleted_records','event_log','activity_log'];
async function rows(table){assert.match(table,/^[a-z_]+$/);return q('select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),\'[]\')d from public."'+table+'"r');}
async function snapshot(names=financialTables){const result={};for(const name of names)result[name]=await rows(name);return result;}
async function ownerRead(fn){await db.exec('reset role');const result=await fn();await assumeSecurityUser(db);return result;}
async function tx(t){await db.exec('reset role;begin');t.after(async()=>{try{await db.exec('rollback');}finally{await db.exec('reset role');}});await assumeSecurityUser(db);}
async function rejects(run,code){await db.exec('savepoint denied_draft');try{await assert.rejects(run,error=>{assert.equal(error.code,code);return true;});}finally{await db.exec('rollback to denied_draft;release denied_draft');}}
before(async()=>{const fixture=await setupBankReconciliationDraftDelete({apply:false});db=fixture.db;abaDraft=fixture.abaDraft;await db.exec('reset role');baselineFunctions=await inventory();baselineTables=await security();optionsMetadata=(await db.query("select oid,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid='bank_reconciliation_options()'::regprocedure")).rows[0];migration=(await readFile(new URL('../supabase/migrations/20261109151847_allow_empty_classic_reconciliation_draft_delete.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');await db.exec('begin');try{await db.exec(migration);await db.exec('commit');}catch(e){await db.exec('rollback');throw e;}});
after(()=>db?.close());

test('the guarded migration adds exactly four functions, annotates one wrapper and preserves existing engines, attributes and table boundaries',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await inventory(),baselineFunctions);assert.deepEqual(await security(),baselineTables);assert.deepEqual((await db.query("select oid,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid='bank_reconciliation_options()'::regprocedure")).rows[0],optionsMetadata);
 const current=(await db.query('select oid::regprocedure::text signature,prosecdef,provolatile,proconfig,has_function_privilege(\'anon\',oid,\'execute\')anon,has_function_privilege(\'authenticated\',oid,\'execute\')authenticated,has_function_privilege(\'service_role\',oid,\'execute\')service from pg_proc where oid=any($1::regprocedure[])',[added])).rows;assert.equal(current.length,4);
 for(const f of current){const isPublic=!f.signature.startsWith('reconciliation_private.');assert.equal(f.prosecdef,isPublic);assert.equal(f.authenticated,isPublic);assert.equal(f.anon,false);assert.equal(f.service,false);assert.ok(f.proconfig.includes('search_path=pg_catalog, public, pg_temp'));assert.equal(f.provolatile,f.signature.startsWith('delete_bank_')||f.signature.startsWith('reconciliation_private.draft_delete_snapshot(')?'v':'s');}
});

test('DELETE permission without CREATE or EDIT deletes only an empty header and writes real authoritative deletion audit and system event',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);const prior=await ownerRead(()=>snapshot([...financialTables,...auditTables]));const beforeHeader=await ownerRead(()=>q('select to_jsonb(r)d from bank_reconciliation r where reconciliation_id=$1',[draft.reconciliationId]));const p=await preview(draft);assert.equal(p.canDelete,true);assert.equal(p.matchCount,0);assert.equal(p.status,'ABIERTA');assert.match(p.fingerprint,/^[a-f0-9]{64}$/);
 const headers=await q("select current_setting('request.headers',true)::jsonb d");await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({...headers,'x-audit-actor-email':'forged@example.invalid','x-audit-actor-type':'AI_AGENT','x-audit-execution-context-id':'SYNTHETIC-CORRELATION'})]);assert.equal((await preview(draft)).fingerprint,p.fingerprint);
 const result=await remove(draft,p.fingerprint);assert.deepEqual(result,{success:true,deleted:true,bankAccountId:draft.bank,cutoff:draft.cutoff,reconciliationId:draft.reconciliationId,fiscalPeriodId:draft.periodId});const current=await ownerRead(()=>snapshot([...financialTables,...auditTables]));for(const name of financialTables)assert.deepEqual(current[name],prior[name]);assert.equal(await ownerRead(()=>q('select count(*)d from bank_reconciliation where reconciliation_id=$1',[draft.reconciliationId])),0);
 const deleted=current.deleted_records.filter(row=>!prior.deleted_records.some(old=>old.deleted_id===row.deleted_id));assert.equal(deleted.length,1);assert.equal(deleted[0].original_table_name,'bank_reconciliation');assert.equal(deleted[0].original_record_id,draft.reconciliationId);assert.equal(deleted[0].deleted_by_user_id,1);assert.deepEqual(JSON.parse(deleted[0].record_data_json),beforeHeader);
 const events=current.event_log.filter(row=>!prior.event_log.some(old=>old.event_id===row.event_id));assert.equal(events.length,1);assert.equal(events[0].event_type,'BANK_RECONCILIATION_DRAFT_DELETE');assert.equal(events[0].actor_type,'HUMAN');assert.equal(events[0].created_by_email,'synthetic-1@example.invalid');assert.equal(events[0].details.reconciliationId,draft.reconciliationId);assert.equal(events[0].details.actor.email,'synthetic-1@example.invalid');assert.equal(events[0].details.previewFingerprint,p.fingerprint);
 const audits=current.audit_log.filter(row=>!prior.audit_log.some(old=>old.log_id===row.log_id));assert.deepEqual(audits.map(row=>[row.entity_type,row.action]),[['bank_reconciliation','ELIMINACION']]);
});

test('options preserve the real history projection and expose only trusted per-row delete capabilities',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);const raw=await ownerRead(()=>q('select reconciliation_private.bank_reconciliation_options()d')),result=await options();assert.deepEqual(result.reconciliations.map(({_actions,...r})=>r),raw.reconciliations);assert.deepEqual(result.accounts,raw.accounts);assert.equal(result.reconciliations.find(row=>row.id===draft.reconciliationId)._actions.canDeleteDraft,true);
 await assumeSecurityUser(db,1,2);const editor=await options();assert.ok(editor.reconciliations.every(row=>row._actions.canDeleteDraft===false));await assumeSecurityUser(db,1,3);assert.ok((await options()).reconciliations.every(row=>row._actions.canDeleteDraft===false));
});

test('VIEW, DELETE, active identity and company scope are independent gates, and raw/private writes remain denied',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);
 for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select preview_bank_reconciliation_draft_delete(1,null,0)');await deniedSql(db,'select delete_bank_reconciliation_draft(1,null,0,null)');}
 for(const [user,role]of[[1,2],[1,3],[2,4]]){await assumeSecurityUser(db,user,role);await deniedSql(db,'select preview_bank_reconciliation_draft_delete(1,null,0)');}
 // Report VIEW is the required read capability. A generic banking-catalog
 // VIEW flag is not an additional permission invented by this feature.
 await assumeSecurityUser(db,1,6);assert.equal((await preview(draft)).canDelete,true);
 await assumeSecurityUser(db);await deniedSql(db,'select reconciliation_private.draft_delete_snapshot(1,current_date,1)');await deniedSql(db,'select reconciliation_private.annotate_draft_delete_options(\'{}\')');await deniedSql(db,'delete from bank_reconciliation where reconciliation_id=$1',[draft.reconciliationId]);await deniedSql(db,'select preview_bank_reconciliation_draft_delete(3,$1,$2)',[draft.cutoff,draft.reconciliationId]);
 await db.exec('reset role');await db.query('update users set is_active=false where user_id=1');await db.exec('set role authenticated');await deniedSql(db,'select preview_bank_reconciliation_draft_delete(1,$1,$2)',[draft.cutoff,draft.reconciliationId]);
});

test('exact bank, date, header, subsidiary and period identity are required before a preview can authorize deletion',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);await rejects(()=>q('select preview_bank_reconciliation_draft_delete($1,$2,$3)d',[2,draft.cutoff,draft.reconciliationId]),'PBD01');await rejects(()=>q('select preview_bank_reconciliation_draft_delete($1,$2,$3)d',[1,'2026-11-04',draft.reconciliationId]),'PBD01');await rejects(()=>q('select preview_bank_reconciliation_draft_delete($1,$2,$3)d',[1,draft.cutoff,99999]),'PBD01');
 await db.exec('reset role');await db.query('update bank_reconciliation set fiscal_period_id=21 where reconciliation_id=$1',[draft.reconciliationId]);await assumeSecurityUser(db);const invalid=await preview(draft);assert.equal(invalid.canDelete,false);assert.equal(invalid.blockedReason,'INVALID_PERIOD');await rejects(()=>remove(draft,invalid.fingerprint),'PBD01');
});

test('every financial snapshot or closure marker makes a draft ineligible, including explicit zero computed balances',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);for(const [field,value,reason]of[['book_balance',0,'NOT_EMPTY'],['statement_balance',0,'NOT_EMPTY'],['difference',0,'NOT_EMPTY'],['transit_payments',1,'NOT_EMPTY'],['transit_deposits',1,'NOT_EMPTY'],['bank_adjustments',-1,'NOT_EMPTY'],['closed_by',1,'NOT_OPEN'],['closed_at','2026-11-03T12:00:00Z','NOT_OPEN']]){
  await db.exec('savepoint blocked_header;reset role');await db.query('update bank_reconciliation set '+field+'=$1 where reconciliation_id=$2',[value,draft.reconciliationId]);await assumeSecurityUser(db);const p=await preview(draft);assert.equal(p.canDelete,false,field);assert.equal(p.blockedReason,reason,field);await rejects(()=>remove(draft,p.fingerprint),'PBD01');await db.exec('rollback to blocked_header;release blocked_header');await assumeSecurityUser(db);
 }
});

test('closed history remains immutable while an empty later-period draft can be deleted without touching an earlier closed record',async t=>{
 await tx(t);const closed=await seedBankReconciliationDraft(db,{cutoff:'2026-10-31',period:10,status:'CERRADA',bookBalance:125,statementBalance:125,difference:0,closedAt:'2026-10-31T12:00:00Z',closedBy:1});const before=await ownerRead(()=>q('select to_jsonb(r)d from bank_reconciliation r where reconciliation_id=$1',[closed.reconciliationId]));const p=await preview(closed);assert.equal(p.canDelete,false);assert.equal(p.blockedReason,'NOT_OPEN');await rejects(()=>remove(closed,p.fingerprint),'55000');
 const draft=await seedBankReconciliationDraft(db);const fresh=await preview(draft);assert.equal(fresh.canDelete,true);await remove(draft,fresh.fingerprint);assert.deepEqual(await ownerRead(()=>q('select to_jsonb(r)d from bank_reconciliation r where reconciliation_id=$1',[closed.reconciliationId])),before);
});

test('closed/inactive fiscal periods and downstream classic or quadratic closures block deletion',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);for(const field of['is_closed','is_inactive']){await db.exec('savepoint period_state;reset role');await db.query('update fiscal_periods set '+field+'=true where fiscal_period_id=11');await assumeSecurityUser(db);const p=await preview(draft);assert.equal(p.canDelete,false);assert.equal(p.blockedReason,'PERIOD_PROTECTED');await rejects(()=>remove(draft,p.fingerprint),'PBD01');await db.exec('rollback to period_state;release period_state');await assumeSecurityUser(db);}
 await db.exec("savepoint later_classic;reset role;insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,is_closed,is_inactive,period_name)values(12,1,'2026-12-01','2026-12-31',false,false,'Synthetic later period')");await seedBankReconciliationDraft(db,{cutoff:'2026-12-31',period:12,status:'CERRADA',closedAt:'2026-12-31T12:00:00Z',closedBy:1});let p=await preview(draft);assert.equal(p.blockedReason,'PROTECTED_WINDOW');await rejects(()=>remove(draft,p.fingerprint),'55000');await db.exec('rollback to later_classic;release later_classic');await assumeSecurityUser(db);
 await db.exec("reset role;insert into quadratic_bank_reconciliations(subsidiary_id,bank_account_id,period_year,period_month,status,created_by)values(1,1,2026,11,'approved',1)");await assumeSecurityUser(db);p=await preview(draft);assert.equal(p.canDelete,false);assert.equal(p.blockedReason,'PROTECTED_WINDOW');await rejects(()=>remove(draft,p.fingerprint),'55000');
});

test('a match arriving after preview blocks the whole confirmation and preserves both financial sources',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db),p=await preview(draft);
 // One outer SQL statement must see the changed financial marker before the
 // volatile read snapshot / defensive DELETE predicate can authorize removal.
 await db.exec('reset role');await rejects(()=>q('with changed as(update bank_reconciliation set bank_adjustments=1 where reconciliation_id=$1 returning reconciliation_id)select delete_bank_reconciliation_draft($2,$3,$1,$4)d from changed',[draft.reconciliationId,draft.bank,draft.cutoff,p.fingerprint]),'PBD01');await assumeSecurityUser(db);
 await seedDraftReconciliationMatch(db,draft);const before=await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation']));const blocked=await preview(draft);assert.equal(blocked.canDelete,false);assert.equal(blocked.blockedReason,'HAS_MATCHES');await rejects(()=>remove(draft,p.fingerprint),'PBD01');assert.deepEqual(await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation'])),before);
 // PGlite is a single-connection functional stale-set oracle, not a real
 // concurrent row-lock benchmark. Production uses the bank row/FK key locks.
});

test('xmin rejects an ABA header change even with identical restored visible data; success cannot be replayed',async t=>{
 await tx(t);const p=await preview(abaDraft),before=await ownerRead(()=>q('select jsonb_build_object(\'row\',to_jsonb(r),\'xmin\',xmin::text)d from bank_reconciliation r where reconciliation_id=$1',[abaDraft.reconciliationId]));await db.exec('reset role');await db.query('update bank_reconciliation set book_balance=1 where reconciliation_id=$1',[abaDraft.reconciliationId]);await db.query('update bank_reconciliation set book_balance=null where reconciliation_id=$1',[abaDraft.reconciliationId]);await assumeSecurityUser(db);const after=await ownerRead(()=>q('select jsonb_build_object(\'row\',to_jsonb(r),\'xmin\',xmin::text)d from bank_reconciliation r where reconciliation_id=$1',[abaDraft.reconciliationId]));assert.deepEqual(after.row,before.row);assert.notEqual(after.xmin,before.xmin);const fresh=await preview(abaDraft);assert.notEqual(fresh.fingerprint,p.fingerprint);await rejects(()=>remove(abaDraft,p.fingerprint),'PBD01');await remove(abaDraft,fresh.fingerprint);await rejects(()=>remove(abaDraft,fresh.fingerprint),'PBD01');
});

test('copied preview fingerprints cannot cross an independently authorized active role context',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db),p=await preview(draft);await assumeSecurityUser(db,1,7);const alternate=await preview(draft);assert.equal(alternate.canDelete,true);assert.notEqual(alternate.fingerprint,p.fingerprint);const before=await ownerRead(()=>snapshot([...financialTables,'bank_reconciliation']));await assumeSecurityUser(db,1,7);await rejects(()=>remove(draft,p.fingerprint),'PBD01');assert.deepEqual(await ownerRead(()=>snapshot([...financialTables,'bank_reconciliation'])),before);
});

test('new foreign-key dependencies and disabled audit protection fail closed instead of allowing hidden cascades',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db);await db.exec('savepoint extra_reference;reset role;create table synthetic_draft_reference(id bigint primary key,reconciliation_id bigint references bank_reconciliation on delete cascade)');await assumeSecurityUser(db);let p=await preview(draft);assert.equal(p.canDelete,false);assert.equal(p.blockedReason,'UNSUPPORTED_REFERENCES');await rejects(()=>remove(draft,p.fingerprint),'PBD01');await db.exec('rollback to extra_reference;release extra_reference;reset role;alter table bank_reconciliation disable trigger central_row_audit');await assumeSecurityUser(db);p=await preview(draft);assert.equal(p.canDelete,false);assert.equal(p.blockedReason,'AUDIT_PROTECTION_UNAVAILABLE');await rejects(()=>remove(draft,p.fingerprint),'PBD01');
});

test('a late system-event failure rolls back the deleted header and all earlier row-audit writes atomically',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db),p=await preview(draft);await db.exec("reset role;create function pg_temp.synthetic_draft_event_failure()returns trigger language plpgsql as $$begin if new.event_type='BANK_RECONCILIATION_DRAFT_DELETE'then raise exception 'Synthetic late draft event failure';end if;return new;end$$;create trigger synthetic_draft_event_failure before insert on event_log for each row execute function pg_temp.synthetic_draft_event_failure()");await assumeSecurityUser(db);const before=await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation']));await rejects(()=>remove(draft,p.fingerprint),'P0001');assert.deepEqual(await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation'])),before);
});

test('invalid proofs fail before deletion and the writer uses the published bank-header-period lock order',async t=>{
 await tx(t);const draft=await seedBankReconciliationDraft(db),p=await preview(draft),before=await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation']));for(const proof of[null,'',p.fingerprint.toUpperCase(),'a'.repeat(63)])await rejects(()=>remove(draft,proof),'22023');await rejects(()=>remove(draft,'a'.repeat(64)),'PBD01');assert.deepEqual(await ownerRead(()=>snapshot([...financialTables,...auditTables,'bank_reconciliation'])),before);
 const body=await ownerRead(()=>q("select prosrc d from pg_proc where oid='delete_bank_reconciliation_draft(bigint,date,bigint,text)'::regprocedure"));assert.ok(body.indexOf('bank_scope(p_bank_account_id,p_cutoff,true)')<body.indexOf('for update'));assert.ok(body.indexOf('for update')<body.indexOf('for share'));assert.ok(body.indexOf('for share')<body.indexOf('draft_delete_snapshot('));assert.equal(/pg_advisory/.test(body),false);
});
