import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupFiscalStructureSecurity} from './fixtures/setup-fiscal-structure-security.mjs';

const db=new PGlite();
const migration='20261110015114_clarify_fiscal_period_closure_and_delete_capabilities.sql';
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const metadata=()=>q("select jsonb_agg(jsonb_build_object('oid',p.oid,'signature',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')','md5',md5(prosrc),'owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'volatility',provolatile)order by p.oid)d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg_%'and n.nspname<>'information_schema'");
async function financial(){const value={};for(const table of ['fiscal_years','fiscal_periods','fiscal_calendars','permissions','role_permissions','role_access_matrix','journal','journal_line','gl_impact','supplier_invoice'])value[table]=await q(`select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]')::text)d from public.${table} t`);return value;}
async function assume(role=1,sid=1){await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,role_id=$1",[role]);await db.query("insert into user_company_sessions values('fixture',1,$1)on conflict(session_id)do update set user_id=1,subsidiary_id=$1",[sid]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);await db.exec('set role authenticated');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));await assume();}
async function deny(sql,p=[],code='42501'){await db.exec('savepoint denied');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denied;release denied');}}
const options=()=>q("select organization_master_options('accounting-periods')d");
const list=()=>q("select organization_master_list('accounting-periods')d");
const save=(id,p)=>q("select save_organization_master('accounting-periods',$1,$2)d",[p,id]);
async function closureGrant(role=1){await db.exec('reset role');await db.query("insert into role_permissions select $1,permission_id from permissions where code='CONF_PERIODOS_FISCALES_CERRAR'on conflict do nothing",[role]);await assume(role);}
async function periods(){const y=await q("select save_organization_master('fiscal-years',$1,null)d",[{year_name:'Synthetic fiscal controls',start_date:'2029-01-01',end_date:'2029-12-31',is_closed:false}]);await q("select save_organization_master('accounting-periods',$1,null)d",[{fiscal_year_id:y.fiscal_year_id,subsidiary_ids:[1]}]);return{year:y,rows:(await list()).filter(p=>p.fiscal_year_id===y.fiscal_year_id)};}
let beforeFunctions,afterFunctions,beforeData,afterData;
before(async()=>{
 await setupFiscalStructureSecurity(db);
 // Reuse the published central-administration actor/access gates, without
 // mocked eligibility or installing unrelated access-administration writers.
 const access=(await readFile(new URL('../supabase/migrations/20261101184932_secure_access_administration.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 await db.exec('create schema access_admin_private;revoke all on schema access_admin_private from public,anon,authenticated,service_role;grant usage on schema access_admin_private to authenticated');
 for(const name of ['actor','central','access','allowed']){const start=access.indexOf('create function access_admin_private.'+name+'('),end=access.indexOf('$$;',start);assert(start>=0&&end>start);await db.exec(access.slice(start,end+3));await db.exec(`revoke all on function access_admin_private.${name}(${name==='access'||name==='allowed'?'text,text':''})from public,anon,authenticated,service_role`);}
 await db.exec("update roles set is_system_role=true,role_name='Administrador' where role_id=1");
 // The historical fixture seeds this technical grant. Remove it only here to
 // reproduce an administrator with catalog EDIT but no closure permission.
 await db.exec("delete from role_permissions where role_id=1 and permission_id in(select permission_id from permissions where code='CONF_PERIODOS_FISCALES_CERRAR')");
 // Published production bodies use LF. Keep exact source guards across a CRLF
 // Windows clone without altering the shared fixture or any authorization code.
 const definition=(await db.query("select pg_get_functiondef('fiscal_structure_private.options(text)'::regprocedure)definition")).rows[0].definition;
 await db.exec(definition.replace(/\r\n/g,'\n'));
 // The published live save body retains historical UTF-8/Latin-1 encoded
 // message literals. Reproduce that exact body without changing its policy.
 const saveDefinition=(await db.query("select pg_get_functiondef('fiscal_structure_private.save(text,jsonb,bigint)'::regprocedure)definition")).rows[0].definition;
 await db.exec(Buffer.from(saveDefinition.replace(/\r\n/g,'\n'),'utf8').toString('latin1'));
 assert.equal(await q("select md5(prosrc)d from pg_proc where oid='fiscal_structure_private.save(text,jsonb,bigint)'::regprocedure"),'f9072a216c949e1b2c03369d28a757c2');
 assert.equal(await q("select md5(prosrc)d from pg_proc where oid='fiscal_structure_private.options(text)'::regprocedure"),'4b5e040076fd4f73f1509cef81b34289');
 beforeFunctions=await metadata();beforeData=await financial();
 await db.exec('begin');await db.exec((await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8')).replace(/\r\n/g,'\n'));await db.exec('commit');
 afterFunctions=await metadata();afterData=await financial();
});
after(()=>db.close());

test('installation changes only two guarded capability bodies, preserving OIDs, attributes, grants and stored state',()=>{
 assert.deepEqual(afterData,beforeData);assert.equal(afterFunctions.length,beforeFunctions.length);const changed=[];
 for(let i=0;i<beforeFunctions.length;i++){const{md5:a,...old}=beforeFunctions[i],{md5:b,...current}=afterFunctions[i];assert.deepEqual(current,old);if(a!==b)changed.push(old.signature);}
 assert.deepEqual(changed.sort(),['fiscal_structure_private.dto(k text, id bigint)','fiscal_structure_private.options(k text)']);
});
test('administrator without the exact technical grant receives a clear reason and still cannot change closure state',async t=>{
 await tx(t);const{rows}=await periods(),p=rows[0],o=await options();assert.equal(o.canManageClosure,false);assert.equal(o.canConfigureClosurePermission,true);assert.equal(o.closureBlockedReason,'MISSING_CLOSURE_PERMISSION');assert.deepEqual(o.requiredClosurePermission,{code:'CONF_PERIODOS_FISCALES_CERRAR',label:'Cerrar y reabrir períodos fiscales'});
 await deny("select save_organization_master('accounting-periods',$1,$2)",[{_revision:p._revision,ap_closed:true},p.fiscal_period_id]);assert.equal((await list()).find(x=>x.fiscal_period_id===p.fiscal_period_id).ap_closed,false);
 await closureGrant();assert.equal((await options()).canManageClosure,true);assert.equal((await options()).closureBlockedReason,null);const closedAP=await save(p.fiscal_period_id,{_revision:p._revision,ap_closed:true});assert.equal(closedAP.ap_closed,true);assert.equal(closedAP.ar_closed,false);assert.equal(closedAP.gl_closed,false);assert.equal(closedAP.is_closed,false);
});
test('technical closure permission never supplies catalog EDIT, DELETE or foreign-subsidiary access',async t=>{
 await tx(t);const{rows}=await periods(),p=rows[0];await closureGrant(3);const row=(await list()).find(x=>x.fiscal_period_id===p.fiscal_period_id);assert.equal((await options()).canManageClosure,true);assert.equal((await options()).canConfigureClosurePermission,false);assert.equal(row._actions.canEdit,false);assert.equal(row._actions.canDelete,false);assert.equal(row._actions.deleteBlockedReason,'NOT_AUTHORIZED');await deny("select save_organization_master('accounting-periods',$1,$2)",[{_revision:p._revision,ap_closed:true},p.fiscal_period_id]);
 await assume(1,2);assert(!(await list()).some(x=>x.fiscal_period_id===p.fiscal_period_id));await deny("select save_organization_master('accounting-periods',$1,$2)",[{_revision:p._revision,period_name:'Foreign'},p.fiscal_period_id]);
});
test('delete reasons distinguish an unused open period, real references and a closed unused period without deleting data',async t=>{
 await tx(t);const{rows}=await periods(),[open,used,closed]=rows;assert.equal(open._actions.canDelete,true);assert.equal(open._actions.deleteBlockedReason,null);
 await db.exec('reset role');await db.query('insert into fixture_period_usage values($1)',[used.fiscal_period_id]);await assume();let r=(await list()).find(x=>x.fiscal_period_id===used.fiscal_period_id);assert.equal(r._actions.canDelete,false);assert.equal(r._actions.deleteBlockedReason,'REFERENCED');
 await closureGrant();r=await save(closed.fiscal_period_id,{_revision:closed._revision,ap_closed:true,ar_closed:true,gl_closed:true,is_closed:true});assert.equal(r._actions.canDelete,false);assert.equal(r._actions.deleteBlockedReason,'CLOSED');await deny("select delete_organization_master('accounting-periods',$1,$2)",[r.fiscal_period_id,r._revision],'55000');assert.equal((await list()).filter(x=>x.fiscal_year_id===closed.fiscal_year_id).length,12);
});
test('manual checklist semantics and AP/AR/GL/year closure sequencing remain unchanged',async t=>{
 await tx(t);const{year,rows}=await periods();await closureGrant();let p=await save(rows[0].fiscal_period_id,{_revision:rows[0]._revision,checklist_completed:true});assert.equal(p.checklist_completed,true);assert.equal(p.ap_closed,false);assert.equal(p.gl_closed,false);await deny("select save_organization_master('accounting-periods',$1,$2)",[{_revision:p._revision,gl_closed:true},p.fiscal_period_id],'22023');
 p=await save(p.fiscal_period_id,{_revision:p._revision,checklist_completed:false,ap_closed:true,ar_closed:true,gl_closed:true,is_closed:true});assert.equal(p.checklist_completed,true);
 const y=(await q("select organization_master_list('fiscal-years')d")).find(x=>x.fiscal_year_id===year.fiscal_year_id);await deny("select save_organization_master('fiscal-years',$1,$2)",[{_revision:y._revision,is_closed:true},y.fiscal_year_id],'55000');
});
