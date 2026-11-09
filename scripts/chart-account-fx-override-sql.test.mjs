import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {setupChartAccountFxOverrideFixture,applyChartAccountFxOverride,chartAccountFxOverrideMigration,assumeSecurityUser,assumeSqlRole,deniedSql} from './fixtures/setup-chart-account-fx-override.mjs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

let fixture,db,ids,basePayload,beforeFunctions,beforeAccounts,beforeGroups,beforeHistory,beforeSecurity,beforeTriggers,migration;
const changed=new Set(['inherit_account_fx_flag()','cascade_account_fx_flag()','save_chart_account_catalog(bigint,jsonb,bigint[])']);
const historyTables=['fx_revaluation_runs','fx_revaluation_settings','journal','journal_line','gl_impact','transaction','bank_transaction','bank_account'];
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.d;
const catalog=()=>q('select public.chart_accounts_catalog()d');
const getAccount=async id=>(await catalog()).find(row=>row.account_id===id);
const inventory=()=>q("select jsonb_agg(jsonb_build_object('id',oid,'signature',oid::regprocedure::text,'owner',proowner,'acl',proacl::text,'config',proconfig,'definer',prosecdef,'volatility',provolatile,'md5',md5(prosrc))order by oid)d from pg_proc where pronamespace='public'::regnamespace");
const security=()=>q("select jsonb_agg(jsonb_build_array(oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity)order by oid)d from pg_class where relnamespace='public'::regnamespace and relkind in('r','p')");
const triggers=()=>q("select jsonb_agg(jsonb_build_array(oid,tgrelid,tgfoid,tgenabled,pg_get_triggerdef(oid))order by oid)d from pg_trigger where not tgisinternal and not(tgrelid='chart_accounts'::regclass and tgname='chart_account_inherit_fx')");
async function rows(name){assert.match(name,/^[a-z_]+$/);return q('select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),\'[]\')d from public."'+name+'"r');}
async function snapshot(names=historyTables){const result={};for(const name of names)result[name]=await rows(name);return result;}
async function owner(fn){await db.exec('reset role');const result=await fn();await assumeSecurityUser(db);return result;}
async function tx(t){await db.exec('reset role;begin');t.after(async()=>{try{await db.exec('rollback');}finally{await db.exec('reset role');}});await assumeSecurityUser(db);}
async function rejected(run,code){await db.exec('savepoint rejected_override');try{await assert.rejects(run,error=>{assert.equal(error.code,code);return true;});}finally{await db.exec('rollback to savepoint rejected_override;release savepoint rejected_override');}}
async function save(id=ids.accountId,patch={},subsidiaries=[1]){const payload={...basePayload,...patch};delete payload.subsidiary_ids;return q('select public.save_chart_account_catalog($1,$2,$3)d',[id,payload,subsidiaries]);}
const groupFlag=(group,enabled)=>owner(()=>db.query('update account_group set pending_fx_revaluation=$1 where group_id=$2',[enabled,group]));
const pair=row=>[row.pending_fx_revaluation_override,row.pending_fx_revaluation];

before(async()=>{
 fixture=await setupChartAccountFxOverrideFixture({apply:false});({db,ids,basePayload}=fixture);await db.exec('reset role');beforeFunctions=await inventory();beforeAccounts=await rows('chart_accounts');beforeGroups=await rows('account_group');beforeHistory=await snapshot();beforeSecurity=await security();beforeTriggers=await triggers();migration=(await readFile(new URL('../supabase/migrations/'+chartAccountFxOverrideMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');await applyChartAccountFxOverride(db);
});
after(()=>db?.close());

test('installation changes exactly three guarded function bodies and one trigger event list; old effective flags, attributes, assignments and financial history remain untouched',async t=>{
 await tx(t);await db.exec('reset role');const afterFunctions=await inventory();assert.equal(afterFunctions.length,beforeFunctions.length);const byId=new Map(afterFunctions.map(fn=>[fn.id,fn]));
 for(const old of beforeFunctions){const current=byId.get(old.id);assert.ok(current);if(changed.has(old.signature)){const{md5:oldHash,...oldAttrs}=old,{md5:newHash,...newAttrs}=current;assert.notEqual(newHash,oldHash);assert.deepEqual(newAttrs,oldAttrs);}else assert.deepEqual(current,old);}
 const accounts=await rows('chart_accounts');assert.ok(accounts.every(row=>row.pending_fx_revaluation_override===null));assert.deepEqual(accounts.map(({pending_fx_revaluation_override,...row})=>row),beforeAccounts);assert.deepEqual(await rows('account_group'),beforeGroups);assert.deepEqual(await snapshot(),beforeHistory);assert.deepEqual(await security(),beforeSecurity);assert.deepEqual(await triggers(),beforeTriggers);
 const column=(await db.query("select attnotnull,atttypid::regtype::text type from pg_attribute where attrelid='chart_accounts'::regclass and attname='pending_fx_revaluation_override'and not attisdropped")).rows[0];assert.equal(column.type,'boolean');assert.equal(column.attnotnull,false);assert.ok((await q("select pg_get_triggerdef(oid)d from pg_trigger where tgrelid='chart_accounts'::regclass and tgname='chart_account_inherit_fx'")).includes('pending_fx_revaluation_override'));
});

test('new accounts inherit their direct group by default and ignore stale derived flag echoes while keeping real numbering and selected subsidiary links',async t=>{
 await tx(t);const on=await save(null,{account_name:'Synthetic new inherited on',pending_fx_revaluation:false});assert.deepEqual(pair(on),[null,true]);assert.match(on.account_number,/^125\d+$/);assert.deepEqual(on.subsidiary_ids,[1]);
 const off=await save(null,{account_name:'Synthetic new inherited off',account_group_id:ids.groupOffId,pending_fx_revaluation:true});assert.deepEqual(pair(off),[null,false]);assert.match(off.account_number,/^126\d+$/);assert.deepEqual(pair(await getAccount(off.account_id)),[null,false]);
 const explicit=await save(null,{account_name:'Synthetic new explicit off',pending_fx_revaluation_override:false});assert.deepEqual(pair(explicit),[false,false]);assert.deepEqual(pair(await getAccount(explicit.account_id)),[false,false]);
});

test('an explicit off choice survives reload, unrelated saves, stale legacy echoes and both directions of the group cascade without updating the exception row',async t=>{
 await tx(t);let saved=await save(ids.accountId,{pending_fx_revaluation_override:false});assert.deepEqual(pair(saved),[false,false]);assert.deepEqual(pair(await getAccount(ids.accountId)),[false,false]);saved=await save(ids.accountId,{account_name:'Synthetic renamed exception',pending_fx_revaluation:true});assert.deepEqual(pair(saved),[false,false]);
 const before=await owner(()=>q('select ctid::text d from chart_accounts where account_id=$1',[ids.accountId]));await groupFlag(ids.groupOnId,false);assert.deepEqual(pair(await getAccount(ids.accountId)),[false,false]);await groupFlag(ids.groupOnId,true);assert.deepEqual(pair(await getAccount(ids.accountId)),[false,false]);assert.equal(await owner(()=>q('select ctid::text d from chart_accounts where account_id=$1',[ids.accountId])),before);
});

test('an explicit on choice is supported under an unmarked group and remains on after unrelated saves and group edits',async t=>{
 await tx(t);let saved=await save(ids.offAccountId,{account_group_id:ids.groupOffId,pending_fx_revaluation_override:true});assert.deepEqual(pair(saved),[true,true]);saved=await save(ids.offAccountId,{account_group_id:ids.groupOffId,account_name:'Synthetic manual on renamed',pending_fx_revaluation:false});assert.deepEqual(pair(saved),[true,true]);await groupFlag(ids.groupOffId,true);await groupFlag(ids.groupOffId,false);assert.deepEqual(pair(await getAccount(ids.offAccountId)),[true,true]);
});

test('explicit null resets to inheritance while an omitted key preserves the saved mode',async t=>{
 await tx(t);await save(ids.accountId,{pending_fx_revaluation_override:false});let saved=await save(ids.accountId,{pending_fx_revaluation_override:null,pending_fx_revaluation:false});assert.deepEqual(pair(saved),[null,true]);await groupFlag(ids.groupOnId,false);assert.deepEqual(pair(await getAccount(ids.accountId)),[null,false]);saved=await save(ids.accountId,{account_name:'Synthetic still inherited',pending_fx_revaluation:true});assert.deepEqual(pair(saved),[null,false]);await groupFlag(ids.groupOnId,true);assert.deepEqual(pair(await getAccount(ids.accountId)),[null,true]);
});

test('changing group applies the new default only to inherited rows and keeps an explicit choice until reset',async t=>{
 await tx(t);let saved=await save(ids.accountId,{account_group_id:ids.groupOffId});assert.deepEqual(pair(saved),[null,false]);saved=await save(ids.accountId,{account_group_id:ids.groupOnId,pending_fx_revaluation_override:false});assert.deepEqual(pair(saved),[false,false]);saved=await save(ids.accountId,{account_group_id:ids.groupOffId});assert.deepEqual(pair(saved),[false,false]);saved=await save(ids.accountId,{account_group_id:ids.groupOffId,pending_fx_revaluation_override:true});assert.deepEqual(pair(saved),[true,true]);
});

test('nonmonetary categories always clear the exception and effective flag; returning to an eligible category inherits again',async t=>{
 await tx(t);await save(ids.accountId,{pending_fx_revaluation_override:true});let saved=await save(ids.accountId,{category:'Gasto',financial_statement:'Estado de Resultados',pending_fx_revaluation_override:true,pending_fx_revaluation:true});assert.deepEqual(pair(saved),[null,false]);saved=await save(ids.accountId,{category:'Activo',financial_statement:'Balance General'});assert.deepEqual(pair(saved),[null,true]);
 saved=await save(ids.nonMonetaryAccountId,{account_group_id:ids.nonMonetaryGroupId,category:'Ingreso',nature:'Acreedora',financial_statement:'Estado de Resultados',pending_fx_revaluation_override:true});assert.deepEqual(pair(saved),[null,false]);
});

test('malformed override values are rejected atomically instead of coercing strings, arrays or objects into a choice',async t=>{
 await tx(t);await save(ids.accountId,{pending_fx_revaluation_override:false});const before=await owner(()=>snapshot(['chart_accounts','account_subsidiaries',...historyTables]));for(const value of['false','true','',0,1,[],{},['false']])await rejected(()=>save(ids.accountId,{account_name:'Must not persist',pending_fx_revaluation_override:value}),'22023');assert.deepEqual(await owner(()=>snapshot(['chart_accounts','account_subsidiaries',...historyTables])),before);
});

test('the existing global administrator oracle, A06 identity and raw-table RLS remain authoritative for the new column',async t=>{
 await tx(t);for(const role of['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select public.save_chart_account_catalog($1,$2,$3)',[ids.accountId,{...basePayload,pending_fx_revaluation_override:false},[1]]);}
 await assumeSecurityUser(db,1,3);await deniedSql(db,'select public.save_chart_account_catalog($1,$2,$3)',[ids.accountId,{...basePayload,pending_fx_revaluation_override:false},[1]]);const raw=await db.query('update chart_accounts set pending_fx_revaluation_override=false where account_id=$1 returning account_id',[ids.accountId]);assert.equal(raw.rows.length,0,'The actual existing admin-only policy filters non-admin writes');
 await assumeSecurityUser(db);assert.deepEqual(pair(await getAccount(ids.accountId)),[null,true]);await db.exec('reset role;update users set is_active=false where user_id=1;set role authenticated');await deniedSql(db,'select public.save_chart_account_catalog($1,$2,$3)',[ids.accountId,{...basePayload,pending_fx_revaluation_override:false},[1]]);
});

test('global subsidiary selection keeps its existing authority and invalid scope failures do not alter the account or its exception',async t=>{
 await tx(t);let saved=await save(ids.accountId,{pending_fx_revaluation_override:false},[1,2]);assert.deepEqual(saved.subsidiary_ids,[1,2]);assert.deepEqual(pair(saved),[false,false]);const before=await owner(()=>snapshot(['chart_accounts','account_subsidiaries']));await rejected(()=>save(ids.accountId,{pending_fx_revaluation_override:true},[999999]),'23503');assert.deepEqual(await owner(()=>snapshot(['chart_accounts','account_subsidiaries'])),before);
});

test('changing master eligibility never recalculates a stored FX run, its journal, ledger or other financial sources',async t=>{
 await tx(t);const history=await owner(()=>snapshot());await save(ids.accountId,{pending_fx_revaluation_override:false});await groupFlag(ids.groupOnId,false);await groupFlag(ids.groupOnId,true);await save(ids.accountId,{pending_fx_revaluation_override:null});await save(ids.offAccountId,{account_group_id:ids.groupOffId,pending_fx_revaluation_override:true});assert.deepEqual(await owner(()=>snapshot()),history);assert.equal(history.fx_revaluation_runs[0].status,'CONTABILIZADO');assert.equal(history.fx_revaluation_runs[0].snapshot[0].signedAdjustment,100);
});

test('a late subsidiary-link failure rolls back a new account and its real audit rows rather than leaving an orphan',async t=>{
 await tx(t);const tables=['chart_accounts','account_subsidiaries','audit_log','change_log','event_log','activity_log','deleted_records'],before=await owner(()=>snapshot(tables));await db.exec("reset role;create function fail_synthetic_chart_link()returns trigger language plpgsql as $$begin if new.account_id>=4000 then raise exception 'Synthetic late account link failure';end if;return new;end$$;create trigger fail_synthetic_chart_link before insert on account_subsidiaries for each row execute function fail_synthetic_chart_link()");await assumeSecurityUser(db);await rejected(()=>save(null,{account_name:'Must not survive linked failure',pending_fx_revaluation_override:false}),'P0001');assert.deepEqual(await owner(()=>snapshot(tables)),before);
});
