import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupSessionTokenRenewal,applySessionTokenRenewal,sessionTokenRenewalFunctions,hash,authId,authSession}from'./fixtures/setup-session-token-renewal.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let oldMetadata,oldPolicies,oldData;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const instant=value=>new Date(value).getTime();
const until=()=>q("select(clock_timestamp()+interval'1 hour')d");
const service=()=>db.exec('reset role;set role service_role');
const prepare=(u=1,sid=authSession(u),device=hash('device-'+u))=>q('select security_prepare_session_refresh($1,$2,$3)d',[authId(u),sid,device]);
const renew=(expected,next,expiry,u=1,sid=authSession(u),device=hash('device-'+u))=>q('select security_refresh_session($1,$2,$3,$4,$5,$6)d',[authId(u),sid,device,expected,next,expiry]);
const logout=(expected,u=1,sid=authSession(u),device=hash('device-'+u))=>q('select security_logout_session_binding($1,$2,$3,$4)d',[authId(u),sid,device,expected]);
async function actor(u=1,device=hash('device-'+u),sid=authSession(u)){
 await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[JSON.stringify({sub:authId(u),session_id:sid}),JSON.stringify({'x-erp-device-hash':device})]);await db.exec('set role authenticated');
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function denied(sql,p=[],code='42501'){
 await db.exec('savepoint denied');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denied;release denied');}
}
const binding=()=>q("select to_jsonb(s)d from sessions s where auth_session_id=$1 and user_id=1",[authSession(1)]);
const state=()=>q(`select jsonb_build_object('sessions',(select jsonb_agg(to_jsonb(s)order by session_id)from sessions s),'devices',(select jsonb_agg(to_jsonb(d)order by device_id)from devices d),'history',(select jsonb_agg(to_jsonb(h)order by history_id)from login_history h),'roles',(select jsonb_agg(to_jsonb(r)order by session_id)from user_role_sessions r),'companies',(select jsonb_agg(to_jsonb(c)order by session_id)from user_company_sessions c))d`);
const existingMetadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,prosrc,proowner,proacl::text,proconfig,provolatile,prosecdef,proisstrict,proparallel from pg_proc where pronamespace in('public'::regnamespace,'session_boundary_private'::regnamespace)and oid not in(select to_regprocedure(x)from unnest($1::text[])x where to_regprocedure(x)is not null)order by oid",[sessionTokenRenewalFunctions])).rows;
const policies=async()=>(await db.query("select tablename,policyname,roles,cmd,qual,with_check from pg_policies where tablename in('sessions','devices','login_history')order by tablename,policyname")).rows;
async function unchangedDenied(sql,p=[],code='42501'){
 await db.exec('reset role');const old=await state();await service();await denied(sql,p,code);await db.exec('reset role');assert.deepEqual(await state(),old);
}
const completeSQL='select security_refresh_session($1,$2,$3,$4,$5,$6)';
const prepareSQL='select security_prepare_session_refresh($1,$2,$3)';
const logoutSQL='select security_logout_session_binding($1,$2,$3,$4)';
before(async()=>{await setupSessionTokenRenewal(db);oldMetadata=await existingMetadata();oldPolicies=await policies();oldData=await state();await applySessionTokenRenewal(db);});
after(()=>db.close());

test('migration preserves existing guards, policies and data and exposes only three service-role RPCs',async t=>{
 await tx(t);assert.deepEqual(await existingMetadata(),oldMetadata);assert.deepEqual(await policies(),oldPolicies);assert.deepEqual(await state(),oldData);
 for(const signature of sessionTokenRenewalFunctions){const row=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0];assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,['search_path=pg_catalog, public, pg_temp']);for(const role of['anon','authenticated'])assert.equal(await q("select has_function_privilege($1,$2,'EXECUTE')d",[role,signature]),false);assert.equal(await q("select has_function_privilege('service_role',$1,'EXECUTE')d",[signature]),true);}
 const calls=[[prepareSQL,[authId(1),authSession(1),hash('device-1')]],[completeSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1'),hash('new'),await until()]],[logoutSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1')]]];
 for(const role of['anon','authenticated']){if(role==='authenticated')await actor();else await db.exec('set role anon');for(const[sql,p]of calls)await denied(sql,p);await db.exec('reset role');}
 await service();assert.equal((await prepare()).userId,1);await denied('select session_token from sessions');await denied('update sessions set expires_at=clock_timestamp()');await denied('select device_token from devices');
});

test('preparing an expired technical lease is read-only and does not authorize ordinary requests',async t=>{
 await tx(t);await db.query("update sessions set expires_at=clock_timestamp()-interval'1 hour'where user_id=1");const old=await state();await service();const p=await prepare();assert.equal(p.sessionTokenHash,hash('jwt-1'));assert.ok(Date.parse(p.expiresAt)<Date.now());assert.equal(p.authNotAfter,null);await db.exec('reset role');assert.deepEqual(await state(),old);await actor();assert.equal(await q('select app_user_id()d'),null);assert.equal((await q('select assert_request_access($1,$2)d',[hash('jwt-1'),hash('device-1')])).allowed,false);
});

test('fresh provider proof renews an expired lease in place and preserves role, company, device and history',async t=>{
 await tx(t);await db.exec("update sessions set expires_at=clock_timestamp()-interval'1 hour'where user_id=1");const old=await state(),original=await binding();await service();const p=await prepare(),next=hash('fresh-provider-jwt'),result=await renew(p.sessionTokenHash,next,await until());assert.equal(result.userId,1);await db.exec('reset role');const current=await binding(),after=await state();const strip=s=>{const{session_token,expires_at,...rest}=s;return rest};assert.deepEqual(strip(current),strip(original));assert.equal(current.session_token,next);assert.ok(Date.parse(current.expires_at)>Date.now());assert.deepEqual(after.devices,old.devices);assert.deepEqual(after.history,old.history);assert.deepEqual(after.roles,old.roles);assert.deepEqual(after.companies,old.companies);assert.deepEqual(after.sessions.filter(s=>s.user_id!==1),old.sessions.filter(s=>s.user_id!==1));
 await actor();assert.equal(await q('select app_user_id()d'),1);assert.equal(await q('select app_active_role_id()d'),2);assert.equal(await q('select active_subsidiary_id()d'),2);assert.equal((await q('select assert_request_access($1,$2)d',[next,hash('device-1')])).allowed,true);assert.equal((await q('select assert_request_access($1,$2)d',[hash('jwt-1'),hash('device-1')])).allowed,false);
});

test('malformed identity, device, hashes and non-finite or elapsed expiry are rejected atomically',async t=>{
 await tx(t);const expiry=await until();const base=[authId(1),authSession(1),hash('device-1'),hash('jwt-1'),hash('next'),expiry];
 for(const[index,value]of[[0,null],[1,null],[2,null],[2,'bad'],[2,'A'.repeat(64)],[3,null],[3,'bad'],[4,null],[4,'bad'],[5,null],[5,'infinity'],[5,'-infinity'],[5,'2000-01-01T00:00:00Z']]){const p=[...base];p[index]=value;await unchangedDenied(completeSQL,p);}
 for(const p of[[null,authSession(1),hash('device-1')],[authId(1),null,hash('device-1')],[authId(1),authSession(1),'bad']])await unchangedDenied(prepareSQL,p);
 await unchangedDenied(logoutSQL,[authId(1),authSession(1),hash('device-1'),'bad']);
});

test('wrong user, Auth session or device cannot prepare, renew or revoke another binding',async t=>{
 await tx(t);const expiry=await until();for(const[user,sid,device]of[[authId(2),authSession(1),hash('device-1')],[authId(1),authSession(2),hash('device-1')],[authId(1),authSession(1),hash('device-2')],[authId(99),authSession(99),hash('missing-device')]]){
  await unchangedDenied(prepareSQL,[user,sid,device]);await unchangedDenied(completeSQL,[user,sid,device,hash('jwt-1'),hash('next'),expiry]);await unchangedDenied(logoutSQL,[user,sid,device,hash('jwt-1')]);
 }
});

test('revoked ERP/device, inactive user, missing Auth and expired Auth lifetime never regain a lease',async t=>{
 await tx(t);const expiry=await until();const variants=[['update sessions set revoked_at=clock_timestamp()where user_id=1',[]],['update devices set revoked_at=clock_timestamp()where user_id=1',[]],['update users set is_active=false where user_id=1',[]],['delete from auth.sessions where id=$1',[authSession(1)]],["update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=$1",[authSession(1)]],['delete from sessions where user_id=1',[]],['update devices set user_id=2 where user_id=1',[]]];
 for(const[sql,p]of variants){await db.exec('reset role;savepoint boundary');await db.query(sql,p);await unchangedDenied(prepareSQL,[authId(1),authSession(1),hash('device-1')]);await unchangedDenied(completeSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1'),hash('next'),expiry]);await unchangedDenied(logoutSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1')]);await db.exec('rollback to boundary;release boundary');}
});

test('lease expiration is bounded by JWT expiration, fifteen minutes and Auth not_after',async t=>{
 await tx(t);const short=await q("select(clock_timestamp()+interval'2 minutes')d");await service();let p=await prepare(),r=await renew(p.sessionTokenHash,hash('short'),short);assert.equal(instant(r.expiresAt),instant(short));await db.exec('reset role');const started=instant(await q('select clock_timestamp()d'));await service();p=await prepare();r=await renew(p.sessionTokenHash,hash('long'),await until());assert.ok(instant(r.expiresAt)>=started+14*60_000);assert.ok(instant(r.expiresAt)<=Date.now()+15*60_000+1000);
 await db.exec('reset role');const limit=await q("select(clock_timestamp()+interval'90 seconds')d");await db.query('update auth.sessions set not_after=$1 where id=$2',[limit,authSession(1)]);await service();p=await prepare();assert.equal(instant(p.authNotAfter),instant(limit));r=await renew(p.sessionTokenHash,hash('auth-bounded'),await until());assert.equal(instant(r.expiresAt),instant(limit));
});

test('stale concurrent CAS and replay fail with PT409 without downgrading the winning token',async t=>{
 await tx(t);await service();const a=await prepare(),b=await prepare(),expiry=await until();await renew(a.sessionTokenHash,hash('winner'),expiry);await db.exec('reset role');const won=await state();await service();await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),b.sessionTokenHash,hash('stale-result'),expiry],'PT409');await db.exec('reset role');assert.deepEqual(await state(),won);await service();const fresh=await prepare();assert.equal(fresh.sessionTokenHash,hash('winner'));await renew(fresh.sessionTokenHash,hash('newer-provider-result'),expiry);await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),a.sessionTokenHash,hash('winner'),expiry],'PT409');assert.equal((await prepare()).sessionTokenHash,hash('newer-provider-result'));
});

test('lost refresh responses recover from authoritative prepare instead of a stale browser JWT hint',async t=>{
 await tx(t);const staleHint=hash('jwt-1');await service();let p=await prepare();await renew(p.sessionTokenHash,hash('response-lost'),await until());await db.exec('reset role');await db.query("update sessions set expires_at=clock_timestamp()-interval'1 second'where user_id=1");await service();p=await prepare();assert.notEqual(p.sessionTokenHash,staleHint);assert.equal(p.sessionTokenHash,hash('response-lost'));const result=await renew(p.sessionTokenHash,hash('new-provider-proof-after-recovery'),await until());assert.equal(result.userId,1);await actor();assert.equal((await q('select assert_request_access($1,$2)d',[hash('new-provider-proof-after-recovery'),hash('device-1')])).allowed,true);
});

test('re-preparing an already current provider token is safe without duplicate login or device records',async t=>{
 await tx(t);const expiry=await q("select(clock_timestamp()+interval'1 minute')d");await service();let p=await prepare();await renew(p.sessionTokenHash,hash('provider-reuse-token'),expiry);await db.exec('reset role');const old=await state();await service();p=await prepare();await renew(p.sessionTokenHash,hash('provider-reuse-token'),expiry);await db.exec('reset role');assert.deepEqual(await state(),old);
});

async function secondBinding(){
 await db.exec('reset role');const sid='22222222-0000-4000-8000-000000000001',device=hash('second-device');await db.query('insert into auth.sessions(id,user_id)values($1,$2)',[sid,authId(1)]);await service();await db.query("select security_register_login($1,$2,$3,$4,'Synthetic other browser',clock_timestamp()+interval'1 hour',null)",[authId(1),sid,hash('second-jwt'),device]);await db.exec('reset role');await db.query('insert into user_role_sessions values($1,1,1)',[sid]);await db.query('insert into user_company_sessions values($1,1,1)',[sid]);return{sid,device};
}
test('renewal and expired-lease logout affect only the same binding and its role/company selections',async t=>{
 await tx(t);const other=await secondBinding();await db.exec("update sessions set expires_at=clock_timestamp()-interval'1 hour'where auth_session_id='11111111-0000-4000-8000-000000000001'");const old=await state();await service();const p=await prepare();assert.equal(await logout(p.sessionTokenHash),true);await db.exec('reset role');const after=await state(),target=after.sessions.find(s=>s.auth_session_id===authSession(1));assert.ok(target.revoked_at);assert.equal(target.session_token,hash('jwt-1'));assert.deepEqual(after.sessions.filter(s=>s.auth_session_id!==authSession(1)),old.sessions.filter(s=>s.auth_session_id!==authSession(1)));assert.deepEqual(after.devices,old.devices);assert.deepEqual(after.history,old.history);assert.deepEqual(after.roles,old.roles.filter(r=>r.session_id!==authSession(1)));assert.deepEqual(after.companies,old.companies.filter(c=>c.session_id!==authSession(1)));await actor(1,other.device,other.sid);assert.equal(await q('select app_user_id()d'),1);await actor();assert.equal(await q('select app_user_id()d'),null);await service();await denied(prepareSQL,[authId(1),authSession(1),hash('device-1')]);await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),p.sessionTokenHash,hash('revive'),await until()]);
});

test('logout conflicts after renewal do not falsely close the session, and successful logout wins over later refresh',async t=>{
 await tx(t);await service();const old=await prepare();await renew(old.sessionTokenHash,hash('renew-before-logout'),await until());await db.exec('reset role');const before=await state();await service();await denied(logoutSQL,[authId(1),authSession(1),hash('device-1'),old.sessionTokenHash],'PT409');await db.exec('reset role');assert.deepEqual(await state(),before);await service();const fresh=await prepare();assert.equal(await logout(fresh.sessionTokenHash),true);await db.exec('reset role');const revoked=await state();await service();await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),fresh.sessionTokenHash,hash('late-refresh'),await until()]);await db.exec('reset role');assert.deepEqual(await state(),revoked);
});

test('existing administrator and password-recovery revocation continue to block the new RPCs',async t=>{
 await tx(t);await actor(4);const sessions=await q("select security_connection_catalog('sessions')d"),own=sessions.find(s=>s.user_id===1);assert.equal(await q("select security_revoke_connection('sessions',$1,$2)d",[own.session_id,own._revision]),true);await service();await denied(prepareSQL,[authId(1),authSession(1),hash('device-1')]);await db.query('select security_revoke_user_sessions(2)');await denied(completeSQL,[authId(2),authSession(2),hash('device-2'),hash('jwt-2'),hash('recovery-revive'),await until()]);
});

test('renewal cannot restore revoked role or company membership or choose another context',async t=>{
 await tx(t);await db.exec('delete from user_roles where user_id=1 and role_id=2;delete from user_subsidiaries where user_id=1 and subsidiary_id=2');const old=await state();await service();const p=await prepare();await renew(p.sessionTokenHash,hash('same-user-no-restored-grants'),await until());await db.exec('reset role');const after=await state();assert.deepEqual(after.roles,old.roles);assert.deepEqual(after.companies,old.companies);await actor();assert.equal(await q('select app_user_id()d'),1);assert.equal(await q('select app_active_role_id()d'),null);assert.equal(await q('select active_subsidiary_id()d'),null);
});

test('ambiguous bindings and hash collisions fail closed without exposing or modifying another session',async t=>{
 await tx(t);const expiry=await until();await service();await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1'),hash('jwt-2'),expiry],'PT409');await db.exec('reset role');assert.equal((await binding()).session_token,hash('jwt-1'));await db.query("insert into sessions(user_id,auth_session_id,device_id,session_token,expires_at)select user_id,auth_session_id,device_id,$1,expires_at from sessions where user_id=1",[hash('duplicate-binding')]);const old=await state();await service();await denied(prepareSQL,[authId(1),authSession(1),hash('device-1')]);await denied(completeSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1'),hash('next'),expiry]);await denied(logoutSQL,[authId(1),authSession(1),hash('device-1'),hash('jwt-1')]);await db.exec('reset role');assert.deepEqual(await state(),old);
});
