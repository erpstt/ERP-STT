import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupRateSecurity} from './fixtures/setup-rate-security.mjs';
import {authId,authSession,hash} from './fixtures/setup-session-boundary-security.mjs';
import {installRateCatalogReadOptimization} from './fixtures/rate-catalog-read-migration.mjs';

const db=new PGlite();let oldDefinition;
const q=async(sql,parameters=[])=>(await db.query(sql,parameters)).rows;
const catalog=async kind=>(await q('select exchange_rate_catalog($1) data',[kind]))[0].data;
async function actor(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[
  JSON.stringify({sub:authId(user),session_id:authSession(user)}),JSON.stringify({'x-erp-device-hash':hash('device-'+user)})]);
 await db.query('insert into user_role_sessions values($1,$2,$3)on conflict(session_id)do update set user_id=excluded.user_id,role_id=excluded.role_id',[authSession(user),user,role]);
 await db.query('insert into user_company_sessions values($1,$2,$3)on conflict(session_id)do update set user_id=excluded.user_id,subsidiary_id=excluded.subsidiary_id',[authSession(user),user,sid]);
 await db.exec('set role authenticated');
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));}
async function deny(sql,parameters=[]){
 await db.exec('savepoint denied');
 try{await assert.rejects(db.query(sql,parameters),error=>error.code==='42501');}
 finally{await db.exec('rollback to denied;release denied');}
}
async function oldRows(kind){await db.exec('reset role;'+oldDefinition);await db.exec('set role authenticated');return catalog(kind);}
async function optimizedRows(kind){await db.exec('reset role');await installRateCatalogReadOptimization(db);await db.exec('set role authenticated');return catalog(kind);}
async function sameRows(kind){const expected=await oldRows(kind),actual=await optimizedRows(kind);assert.deepEqual(actual,expected);return actual;}
const securitySnapshot=()=>q(`select 'policies' kind,md5(coalesce(string_agg(row(schemaname,tablename,policyname,roles,cmd,qual,with_check)::text,'' order by schemaname,tablename,policyname),'')) value from pg_policies
 union all select 'routine_acl',md5(coalesce(string_agg(row(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig)::text,'' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','rate_security_private')
 union all select 'table_acl',md5(coalesce(string_agg(row(c.oid,c.relowner,c.relacl,c.relrowsecurity)::text,'' order by c.oid),'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','rate_security_private')
 union all select 'daily_rows',md5(coalesce(string_agg(to_jsonb(r)::text,'' order by exchange_rate_id),'')) from exchange_rates r
 union all select 'consolidated_rows',md5(coalesce(string_agg(to_jsonb(r)::text,'' order by rate_id),'')) from consolidated_exchange_rates r
 order by kind`);
before(async()=>{
 await setupRateSecurity(db);
 oldDefinition=(await q("select pg_get_functiondef('public.exchange_rate_catalog(text)'::regprocedure) definition"))[0].definition;
});
after(()=>db.close());

test('optimized catalog preserves every field, revision, ordering and action for writers, readers, partial members and administrators',async t=>{
 await tx(t);
 for(const [user,role] of [[1,1],[1,3],[3,1],[4,5]]){
  await actor(user,role);
  for(const kind of ['exchange-rates','consolidated-exchange-rates'])await sameRows(kind);
 }
});

test('secondary currencies and both pair directions retain exactly the original visibility and global-write scope',async t=>{
 await tx(t);
 await db.exec(`insert into subsidiary_currencies values(1,3,false);
  alter table exchange_rates disable trigger user;
  insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)values(2,1,'2026-10-10',0.002),(3,2,'2026-10-11',0.125);
  alter table exchange_rates enable trigger user;`);
 await actor(3,1);const rows=await sameRows('exchange-rates');assert.ok(rows.some(row=>row.from_currency_id===3&&row.to_currency_id===2));
 assert.ok(rows.every(row=>row._actions.canEdit===false&&row._actions.canDelete===false));
 await actor(4,5);await sameRows('exchange-rates');
});

test('closed GL periods, closed years and locked consolidation preserve the exact protected actions',async t=>{
 await tx(t);
 for(const update of [
  'update fiscal_periods set gl_closed=true where fiscal_period_id=1',
  'update fiscal_years set is_closed=true where fiscal_year_id=1',
  'alter table consolidated_exchange_rates disable trigger user;update consolidated_exchange_rates set is_locked=true where source_subsidiary_id=2;alter table consolidated_exchange_rates enable trigger user'
 ]){
  await db.exec('reset role;savepoint protection');await db.exec(update);await actor();
  await sameRows('exchange-rates');await sameRows('consolidated-exchange-rates');
  await db.exec('reset role;rollback to protection;release protection');
 }
});

test('independent grants and special consolidation permissions retain the exact action flags',async t=>{
 await tx(t);
 for(const update of [
  "update role_access_matrix set can_delete=false where role_id=1 and resource_key='configuration:exchange-rates'",
  "update role_access_matrix set can_edit=false where role_id=1 and resource_key='configuration:exchange-rates'",
  "delete from role_permissions where permission_id in(select permission_id from permissions where code='consolidation:rates:manage')"
 ]){
  await db.exec('reset role;savepoint grants');await db.exec(update);await actor();
  await sameRows('exchange-rates');await sameRows('consolidated-exchange-rates');
  await db.exec('reset role;rollback to grants;release grants');
 }
});

test('migration changes no grants, policies, protected table data or security attributes',async t=>{
 await tx(t);const before=await securitySnapshot();await installRateCatalogReadOptimization(db);assert.deepEqual(await securitySnapshot(),before);
 const attrs=(await q("select prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon_exec,has_function_privilege('service_role',oid,'execute') service_exec from pg_proc where oid='public.exchange_rate_catalog(text)'::regprocedure"))[0];
 assert.equal(attrs.prosecdef,true);assert.equal(attrs.anon_exec,false);assert.equal(attrs.service_exec,false);assert.deepEqual(attrs.proconfig,['search_path=pg_catalog, public, pg_temp']);
 await actor();await deny('delete from exchange_rates');await deny("select rate_security_private.enter('daily')");
});

test('fresh reads still reject revoked membership, inactive accounts, missing identity and ungranted roles',async t=>{
 await tx(t);await installRateCatalogReadOptimization(db);await db.exec('savepoint revoked');await actor();
 await db.exec('reset role;delete from user_subsidiaries where user_id=1 and subsidiary_id=1');await db.exec('set role authenticated');await deny("select exchange_rate_catalog('exchange-rates')");
 await db.exec('reset role;rollback to revoked;release revoked');await actor(2,4);await deny("select exchange_rate_catalog('exchange-rates')");
 await db.exec('reset role;update users set is_active=false where user_id=1');await actor();await deny("select exchange_rate_catalog('consolidated-exchange-rates')");
 for(const role of ['anon','authenticated','service_role']){await db.exec('reset role');await db.query("select set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)");await db.exec('set role '+role);await deny("select exchange_rate_catalog('exchange-rates')");}
});

test('catalog validations stay bounded when scaling from 20 to 483 rates with 588 periods',async t=>{
 await tx(t);
 await db.exec(`alter table exchange_rates disable trigger user;
  insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)select 1,2,date '2020-01-01'+g,500+g from generate_series(0,16)g;
  alter table exchange_rates enable trigger user;
  alter table fiscal_periods disable trigger user;
  insert into fiscal_periods(fiscal_period_id,subsidiary_id,start_date,end_date,fiscal_year_id,is_closed,gl_closed,is_inactive,period_name)
   select 1000+g,2,date '2026-10-01',date '2026-10-31',1,false,false,false,'Synthetic scale period '||g from generate_series(1,585)g;
  alter table fiscal_periods enable trigger user;
  create sequence public.synthetic_rate_actor_calls;
  create or replace function rate_security_private.actor()returns bigint language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $$begin perform nextval('public.synthetic_rate_actor_calls');return access_admin_private.actor();end$$;`);
 await actor();await db.exec('reset role;alter sequence public.synthetic_rate_actor_calls restart with 1;set role authenticated');
 const oldStarted=performance.now(),expected=await oldRows('exchange-rates'),oldMs=performance.now()-oldStarted;
 await db.exec('reset role');const oldCalls=Number((await q('select last_value from synthetic_rate_actor_calls'))[0].last_value);
 await db.exec('alter sequence public.synthetic_rate_actor_calls restart with 1;set role authenticated');
 const newStarted=performance.now(),actual=await optimizedRows('exchange-rates'),newMs=performance.now()-newStarted;
 await db.exec('reset role');const newCalls=Number((await q('select last_value from synthetic_rate_actor_calls'))[0].last_value);
 assert.equal(actual.length,20);assert.deepEqual(actual,expected);assert.ok(oldCalls>actual.length);assert.ok(newCalls<=4,JSON.stringify({oldCalls,newCalls}));
 await db.exec(`alter table exchange_rates disable trigger user;
  insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)select 1,2,date '2020-01-01'+g,500+g from generate_series(17,479)g;
  alter table exchange_rates enable trigger user;alter sequence public.synthetic_rate_actor_calls restart with 1;set role authenticated;`);
 const scaleStarted=performance.now(),scaled=await catalog('exchange-rates'),scaleMs=performance.now()-scaleStarted;
 await db.exec('reset role');const scaleCalls=Number((await q('select last_value from synthetic_rate_actor_calls'))[0].last_value);
 const expectedIds=new Set(expected.map(row=>row.exchange_rate_id));
 assert.equal(scaled.length,483);assert.deepEqual(scaled.filter(row=>expectedIds.has(row.exchange_rate_id)),expected);assert.ok(scaleCalls<=4,JSON.stringify({scaleCalls}));
 console.log(JSON.stringify({syntheticCatalogBenchmark:{comparisonRows:actual.length,scaledRows:scaled.length,oldActorCalls:oldCalls,newActorCalls:newCalls,scaledActorCalls:scaleCalls,oldMs:Math.round(oldMs),newMs:Math.round(newMs),scaledMs:Math.round(scaleMs)}}));
});
