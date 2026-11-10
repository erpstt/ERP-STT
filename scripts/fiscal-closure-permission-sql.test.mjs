import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {setupFiscalClosurePermission,applyFiscalClosurePermission,applyFiscalClosurePermissionHardening,fiscalPermissionState,assumeSecurityUser,assumeSqlRole,deniedSql,authId} from './fixtures/setup-fiscal-closure-permission.mjs';
let db,install;before(async()=>{install=await setupFiscalClosurePermission();db=install.db;});after(()=>db?.close());
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assumeSecurityUser(db);}
const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.data;
const options=()=>q('select public.fiscal_closure_permission_options()data');
const set=(enabled,revision)=>q('select public.set_fiscal_closure_permission($1,$2)data',[enabled,revision]);
async function state(){await db.exec('reset role');return fiscalPermissionState(db);}
const withoutTarget=s=>({...s,grants:s.grants.filter(x=>!s.permissions.some(p=>p.code==='CONF_PERIODOS_FISCALES_CERRAR'&&p.permission_id===x.permission_id&&x.role_id===1)),audit:[]});

test('installation preserves all existing data and authority; only four narrowly granted functions are added',async t=>{
 await tx(t);assert.deepEqual(install.after,install.before);assert.equal((await options()).enabled,false);
 const rows=(await db.query("select n.nspname schema,p.proname name,p.prosecdef definer,p.provolatile volatility,p.proconfig config,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')authenticated,has_function_privilege('service_role',p.oid,'execute')service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fiscal_closure_permission_private'or n.nspname='public'and p.proname in('fiscal_closure_permission_options','set_fiscal_closure_permission')")).rows;
 assert.equal(rows.length,4);for(const row of rows){assert.equal(row.anon,false);assert.equal(row.service,false);assert.ok(row.config.some(x=>x.startsWith('search_path=')));assert.equal(row.authenticated,true);assert.equal(row.definer,row.schema==='fiscal_closure_permission_private');}
});
test('explicit enable and disable affect only the active-role closure link, with real trusted actor audit',async t=>{
 await tx(t);const initial=await state();await assumeSecurityUser(db);const a=await options();assert.equal(a.canConfigure,true);assert.equal(a.enabled,false);const b=await set(true,a.revision);assert.equal(b.enabled,true);assert.notEqual(b.revision,a.revision);
 const enabled=await state();assert.deepEqual(withoutTarget(enabled),withoutTarget(initial));assert.equal(enabled.permissions.find(x=>x.code==='CONF_PERIODOS_FISCALES_CERRAR').is_operational,false);const event=enabled.audit.at(-1);assert.equal(event.entity_type,'role_permissions');assert.equal(event.user_id,1);assert.equal(event.actor_type,'HUMAN');assert.notEqual(event.created_by_email,'forged-header@example.invalid');
 await assumeSecurityUser(db);const c=await set(false,b.revision);assert.equal(c.enabled,false);const disabled=await state();assert.deepEqual(withoutTarget(disabled),withoutTarget(initial));assert.equal(disabled.grants.some(x=>x.role_id===1&&x.permission_id===enabled.permissions.find(p=>p.code==='CONF_PERIODOS_FISCALES_CERRAR').permission_id),false);
});
test('same-value confirmations create no extra link, audit or revision change',async t=>{
 await tx(t);let o=await options();const initial=await state();await assumeSecurityUser(db);assert.deepEqual(await set(false,o.revision),o);assert.deepEqual(await state(),initial);await assumeSecurityUser(db);o=await set(true,o.revision);const enabled=await state();await assumeSecurityUser(db);assert.deepEqual(await set(true,o.revision),o);assert.deepEqual(await state(),enabled);
});
test('stale revision and a revision copied from another active role are rejected without changing grants',async t=>{
 await tx(t);const o=await options();await set(true,o.revision);await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[false,o.revision],'55000');
 await db.exec("reset role;insert into roles(role_id,role_name,is_system_role)values(6,'Administrator',true);insert into user_roles(user_id,role_id)values(1,6)");await assumeSecurityUser(db,1,6);await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision],'55000');assert.equal((await options()).enabled,false);
});
test('noncentral and wrong-scope callers receive only false capability and cannot configure',async t=>{
 await tx(t);const o=await options();for(const [u,r,sid]of [[1,2,1],[1,1,999]]){await assumeSecurityUser(db,u,r,sid);assert.deepEqual(await options(),{canConfigure:false});await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision]);}
 await db.exec('reset role;update users set is_active=false where user_id=1');await assumeSecurityUser(db);assert.deepEqual(await options(),{canConfigure:false});await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision]);
});
test('forged sessions and raw writes stay denied; direct private delegation keeps the same central-authority check',async t=>{
 await tx(t);const o=await options();await assumeSqlRole(db,'authenticated',{sub:authId(1),session_id:'unregistered',role_id:1});assert.deepEqual(await options(),{canConfigure:false});await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision]);
 for(const role of ['anon','service_role']){await assumeSqlRole(db,role);await deniedSql(db,'select public.fiscal_closure_permission_options()');await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision]);}
 await assumeSecurityUser(db,1,2);assert.deepEqual(await q('select fiscal_closure_permission_private.options()data'),{canConfigure:false});await deniedSql(db,'select fiscal_closure_permission_private.set_permission($1,$2)',[true,o.revision]);
 await assumeSecurityUser(db);assert.deepEqual(await q('select fiscal_closure_permission_private.options()data'),await options());const direct=await q('select fiscal_closure_permission_private.set_permission($1,$2)data',[true,o.revision]);assert.equal(direct.enabled,true);assert.equal((await options()).enabled,true);await deniedSql(db,"insert into role_permissions(role_id,permission_id)select 1,permission_id from permissions where code='CONF_PERIODOS_FISCALES_CERRAR'");
});
test('invalid confirmation, missing revision and injected target-role signatures cannot change data',async t=>{
 await tx(t);const o=await options();for(const [enabled,revision]of [[null,o.revision],[true,null],[true,'stale']])await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[enabled,revision],'22023');await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2,$3)',[true,o.revision,3],'42883');assert.equal((await options()).enabled,false);
});
test('late real-audit failure rolls back the permission change atomically',async t=>{
 await tx(t);const o=await options(),initial=await state();await db.exec("create function fixture_permission_audit_failure()returns trigger language plpgsql as $$begin raise exception 'Synthetic audit failure';end$$;create trigger fixture_permission_audit_failure before insert on audit_log for each row execute function fixture_permission_audit_failure()");await assumeSecurityUser(db);await deniedSql(db,'select public.set_fiscal_closure_permission($1,$2)',[true,o.revision],'P0001');assert.deepEqual(await state(),initial);await db.exec('drop trigger fixture_permission_audit_failure on audit_log');await assumeSecurityUser(db);assert.equal((await set(true,o.revision)).enabled,true);
});
test('fresh installation registers only the missing legacy code and never grants it',async()=>{
 const fixture=await setupFiscalClosurePermission({apply:false,permission:false});try{const {db:other}=fixture;await other.exec('reset role');await applyFiscalClosurePermission(other);const result=await fiscalPermissionState(other);assert.equal(result.permissions.length,fixture.before.permissions.length+1);assert.equal(result.permissions.find(x=>x.code==='CONF_PERIODOS_FISCALES_CERRAR').is_operational,false);assert.deepEqual(result.grants,fixture.before.grants);assert.deepEqual(result.matrix,fixture.before.matrix);assert.deepEqual(result.periods,fixture.before.periods);}finally{await fixture.db.close();}
});
test('private authority is not exposed by the official lint boundary, with no table privilege or body changes',async()=>{
 const fixture=await setupFiscalClosurePermission({hardened:false});const other=fixture.db;
 const metadata=()=>other.query("select p.oid,p.oid::regprocedure::text signature,md5(prosrc)body,p.prosecdef definer,p.provolatile volatility,p.proconfig config,p.proowner owner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fiscal_closure_permission_private'or n.nspname='public'and p.proname in('fiscal_closure_permission_options','set_fiscal_closure_permission')order by p.oid");
 // Same exposure/EXECUTE/SECURITY DEFINER predicate as the official Splinter
 // 0029 linter. A private schema must never be added to pgrst.db_schemas.
 const lint=()=>other.query("select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and has_function_privilege('authenticated',p.oid,'EXECUTE')and n.nspname=any(array(select trim(unnest(string_to_array(coalesce(current_setting('pgrst.db_schemas',true),'public'),',')))))and p.proname in('fiscal_closure_permission_options','set_fiscal_closure_permission','options','set_permission')");
 try{
  await other.exec('reset role');const original=(await metadata()).rows,initial=await fiscalPermissionState(other),privileges=(await other.query("select relname,relacl from pg_class where relnamespace='public'::regnamespace order by oid")).rows;assert.equal((await lint()).rows.length,2);
  await other.exec("begin;select set_config('pgrst.db_schemas','public,fiscal_closure_permission_private',true)");await assert.rejects(applyFiscalClosurePermissionHardening(other),e=>e.code==='P0001'&&e.message.includes('must not be exposed'));await other.exec('rollback');
  await applyFiscalClosurePermissionHardening(other);assert.equal((await lint()).rows.length,0);const changed=(await metadata()).rows;assert.equal(changed.length,4);for(let i=0;i<original.length;i++){const {definer:old,...a}=original[i],{definer:now,...b}=changed[i];assert.deepEqual(a,b);assert.equal(now,!old);}
  assert.deepEqual(await fiscalPermissionState(other),initial);assert.deepEqual((await other.query("select relname,relacl from pg_class where relnamespace='public'::regnamespace order by oid")).rows,privileges);
  assert.equal((await other.query("select has_schema_privilege('authenticated','fiscal_closure_permission_private','USAGE')u,has_schema_privilege('authenticated','fiscal_closure_permission_private','CREATE')c")).rows[0].u,true);assert.equal((await other.query("select has_schema_privilege('authenticated','fiscal_closure_permission_private','CREATE')c")).rows[0].c,false);
 }finally{await other.close();}
});
