import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedPasswordSecurityDatabase,assumeSecurityUser,authId,authSession,hash} from './fixtures/isolated-security-user-db-test.mjs';

assertIsolatedTestArgs();
const db=await isolatedPasswordSecurityDatabase();
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const catalog=()=>value("select security_connection_catalog('sessions') value");
async function reset(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));}
async function denied(work,code='42501'){
 await db.exec('savepoint denied');
 try{await assert.rejects(work,error=>error?.code===code);}
 finally{await db.exec('rollback to denied;release denied');}
}

// Current session semantics: clients use checked RPCs and never insert/delete
// raw session rows. Password-history owner policies remain actual SQL rules.
test('password history is owner-scoped, append-only and confidential even from a central administrator',async t=>{
 await reset(t);await assumeSecurityUser(db);
 assert.deepEqual(await rows('select user_id,password_hash from password_history'),[{user_id:1,password_hash:'SYNTHETIC-HISTORY-1'}]);
 await rows("insert into password_history(user_id,password_hash) values(1,'SYNTHETIC-NEW-HISTORY')");
 await denied(()=>rows("insert into password_history(user_id,password_hash) values(2,'SYNTHETIC-CROSS-USER')"));
 await denied(()=>rows('update password_history set created_at=now() where user_id=1'));
 await denied(()=>rows('delete from password_history where user_id=1'));
 await assumeSecurityUser(db,4,5);
 assert.deepEqual(await rows('select user_id,password_hash from password_history'),[{user_id:4,password_hash:'SYNTHETIC-HISTORY-4'}]);
 await rows("insert into password_history(user_id,password_hash) values(4,'SYNTHETIC-ADMIN-HISTORY')");
 await denied(()=>rows("insert into password_history(user_id,password_hash) values(2,'SYNTHETIC-ADMIN-CROSS-USER')"));
});

test('current session catalogs expose only authorized rows and sanitized fields while direct writes and token reads fail',async t=>{
 await reset(t);await assumeSecurityUser(db);
 const own=await catalog();assert.equal(own.length,1);assert.equal(own[0].user_id,1);
 const allowed=['_actions','_revision','created_at','expires_at','ip_address','session_id','user_id'];
 assert.deepEqual(Object.keys(own[0]).sort(),allowed.sort());
 for(const user of[1,2]){
  await denied(()=>rows('delete from sessions where user_id=$1',[user]));
  await denied(()=>rows('update sessions set expires_at=now() where user_id=$1',[user]));
  await denied(()=>rows("insert into sessions(user_id,session_token,expires_at) values($1,'SYNTHETIC-SESSION',now()+interval '1 hour')",[user]));
 }
 for(const column of['session_token','auth_session_id','device_id'])await denied(()=>rows('select '+column+' from sessions'));
 await assumeSecurityUser(db,4,5);const central=await catalog();assert.equal(central.length,4);
 assert.ok(!JSON.stringify(central).includes('jwt-'));
 assert.deepEqual((await rows('select distinct user_id from password_history')).map(row=>row.user_id),[4]);
});

test('session revocation uses ownership, revision and central role checks and invalidates the revoked identity',async t=>{
 await reset(t);await assumeSecurityUser(db,4,5);
 const target=(await catalog()).find(row=>row.user_id===2);
 await assumeSecurityUser(db);await denied(()=>value("select security_revoke_connection('sessions',$1,$2) value",[target.session_id,target._revision]));
 await assumeSecurityUser(db,4,5);
 await denied(()=>value("select security_revoke_connection('sessions',$1,'STALE') value",[target.session_id]),'55000');
 assert.equal(await value("select security_revoke_connection('sessions',$1,$2) value",[target.session_id,target._revision]),true);
 await assumeSecurityUser(db,2,4);
 assert.equal(await value('select app_user_id() value'),null);
 await denied(()=>catalog());assert.deepEqual(await rows('select user_id from password_history'),[]);
});

test('history and session access require the bound Auth UUID, registered session and matching device',async t=>{
 await reset(t);
 for(const [device,session]of[[2,authSession(1)],[1,authSession(2)],[1,'22222222-0000-4000-8000-000000000001']]){
  await assumeSecurityUser(db,1,1,1,device,session);
  assert.equal(await value('select app_user_id() value'),null);
  assert.deepEqual(await rows('select user_id from password_history'),[]);await denied(()=>catalog());
 }
 await assumeSecurityUser(db);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:authId(2),email:'synthetic-1@example.invalid',session_id:authSession(1),role:'authenticated'})]);
 assert.equal(await value('select app_user_id() value'),null);assert.deepEqual(await rows('select user_id from password_history'),[]);
 await assumeSecurityUser(db);await db.query("select set_config('request.headers','{}',false)");
 assert.equal(await value('select app_user_id() value'),null);await denied(()=>catalog());
});

test('expired Auth/ERP sessions and inactive users cannot retain history or connection access',async t=>{
 await reset(t);await assumeSecurityUser(db);
 await db.exec("reset role;update sessions set expires_at=now()-interval '1 second' where user_id=1;set role authenticated");
 assert.equal(await value('select app_user_id() value'),null);assert.deepEqual(await rows('select user_id from password_history'),[]);
 await assumeSecurityUser(db,2,4);
 await db.exec('reset role');await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[authSession(2)]);await db.exec('set role authenticated');
 assert.equal(await value('select app_user_id() value'),null);await denied(()=>catalog());
 await assumeSecurityUser(db,3,1);await db.exec('reset role;update users set is_active=false where user_id=3;set role authenticated');
 assert.equal(await value('select app_user_id() value'),null);assert.deepEqual(await rows('select user_id from password_history'),[]);
});

test('anonymous clients and authenticated callers cannot bypass service registration or history/session grants',async t=>{
 await reset(t);await assumeSecurityUser(db);
 await denied(()=>rows("select security_register_login($1,$2,$3,$4,'Synthetic',now()+interval '1 hour',null)",[authId(1),authSession(1),hash('unused-jwt'),hash('unused-device')]));
 await denied(()=>rows('select security_revoke_user_sessions(2)'));
 await db.exec('reset role;set role anon');
 for(const table of['sessions','password_history'])await denied(()=>rows('select * from '+table));
 await denied(()=>catalog());
 await db.exec('reset role');
 const grants=await rows("select privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_name='password_history' order by privilege_type");
 assert.deepEqual(grants.map(row=>row.privilege_type),['INSERT','SELECT']);
 const policies=await rows("select policyname from pg_policies where tablename='sessions'");
 assert.deepEqual(policies,[{policyname:'connection_read'}]);
});
