import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const {isolatedUserAccessDatabase,assumeSqlRole,beginIsolatedCase,deniedSql,authId,hash}=await import('./fixtures/isolated-user-access-db-test.mjs');
const db=await isolatedUserAccessDatabase({invitations:true});
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const deny=(sql,params=[],code='42501')=>deniedSql(db,sql,params,code);
const state=hash('synthetic-invitation-state'),email=hash('synthetic-invitation-email');
const consume=(stateHash=state,emailHash=email,identity=authId(200))=>value('select consume_user_invitation_grant($1,$2,$3) value',[stateHash,emailHash,identity]);
const insert=()=>rows("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",[email,state,authId(200)]);

test('real invitation schema retains Auth linkage, canonical identity constraints, forced RLS and service-only grants',async t=>{
 await beginIsolatedCase(db,t);
 const columns=(await rows("select column_name from information_schema.columns where table_schema='public' and table_name='users' and column_name in('auth_user_id','invitation_sent_at','invitation_accepted_at') order by column_name")).map(row=>row.column_name);
 assert.deepEqual(columns,['auth_user_id','invitation_accepted_at','invitation_sent_at']);
 assert.equal(await value("select convalidated value from pg_constraint where conrelid='users'::regclass and conname='users_email_canonical_check'"),true);
 const rls=(await rows("select relrowsecurity,relforcerowsecurity from pg_class where oid='user_invitation_grants'::regclass"))[0];assert.deepEqual(rls,{relrowsecurity:true,relforcerowsecurity:true});
 const privilege=(await rows("select has_table_privilege('service_role','user_invitation_grants','select,insert,update,delete') service_table,has_sequence_privilege('service_role','user_invitation_grants_invitation_id_seq','usage,select') service_sequence,has_function_privilege('service_role','consume_user_invitation_grant(text,text,uuid)','execute') service_consume"))[0];
 assert.ok(Object.values(privilege).every(Boolean));
 for(const role of['anon','authenticated']){
  await assumeSqlRole(db,role);
  for(const sql of['select invitation_id from user_invitation_grants','delete from user_invitation_grants','update user_invitation_grants set consumed_at=now()',"select nextval('user_invitation_grants_invitation_id_seq')"])await deny(sql);
  await deny("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[email,state,authId(200)]);
  await deny('select consume_user_invitation_grant($1,$2,$3)',[state,email,authId(200)]);
 }
});

test('wrong state, email or Auth UUID cannot consume a grant; the valid triple consumes exactly once',async t=>{
 await beginIsolatedCase(db,t);await assumeSqlRole(db,'service_role');await insert();
 assert.equal(await consume(hash('different-state')),false);
 assert.equal(await consume(state,hash('different-email')),false);
 assert.equal(await consume(state,email,authId(201)),false);
 assert.equal(await value('select count(*)::int value from user_invitation_grants where consumed_at is not null'),0);
 assert.equal(await consume(),true);assert.equal(await consume(),false);
 assert.equal(await value('select count(*)::int value from user_invitation_grants where consumed_at is not null'),1);
});

test('expired and malformed consumption inputs preserve an open unrelated invitation',async t=>{
 await beginIsolatedCase(db,t);await assumeSqlRole(db,'service_role');await insert();
 const expired=hash('expired-synthetic-invitation');
 await rows("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,created_at,expires_at) values($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[email,expired,authId(200)]);
 assert.equal(await consume(expired),false);
 for(const input of[['not-a-digest',email,authId(200)],[state,'not-a-digest',authId(200)],[state,email,null],[null,email,authId(200)],[state,null,authId(200)]]){
  assert.equal(await consume(...input),false);
 }
 assert.equal(await value('select count(*)::int value from user_invitation_grants where consumed_at is not null'),0);
 assert.equal(await consume(),true);
});

test('table constraints reject malformed hashes and impossible expiry atomically',async t=>{
 await beginIsolatedCase(db,t);await assumeSqlRole(db,'service_role');
 for(const [emailHash,stateHash]of[['bad',state],[email,'bad'],[email,'A'.repeat(64)],[email,'0'.repeat(63)]]){
  await deny("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",[emailHash,stateHash,authId(200)],'23514');
 }
 await deny("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,created_at,expires_at) values($1,$2,$3,clock_timestamp(),clock_timestamp()-interval '1 hour')",[email,state,authId(200)],'23514');
 assert.equal(await value('select count(*)::int value from user_invitation_grants'),0);
 await insert();await deny("insert into user_invitation_grants(email_hash,state_hash,auth_user_id,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",[email,state,authId(200)],'23505');
 assert.equal(await value('select count(*)::int value from user_invitation_grants'),1);
});

test('service SQL privilege and service JWT role are both required for invitation consumption',async t=>{
 await beginIsolatedCase(db,t);await assumeSqlRole(db,'service_role');await insert();
 await assumeSqlRole(db,'service_role',{role:'authenticated'});await deny('select consume_user_invitation_grant($1,$2,$3)',[state,email,authId(200)]);
 for(const role of['anon','authenticated']){
  await assumeSqlRole(db,role,{role:'service_role'});await deny('select consume_user_invitation_grant($1,$2,$3)',[state,email,authId(200)]);
 }
 await assumeSqlRole(db,'service_role');assert.equal(await consume(),true);
});

test('service invitation completion may update only the accepted timestamp, never profile or Auth identity',async t=>{
 await beginIsolatedCase(db,t);await assumeSqlRole(db,'service_role');
 assert.equal((await rows('update users set invitation_accepted_at=now() where user_id=1 returning user_id')).length,1);
 await deny("update users set first_name='Service takeover' where user_id=1");
 await deny('update users set auth_user_id=$1 where user_id=1',[authId(200)]);
 await deny("update users set password_hash='SYNTHETIC-BLOCKED' where user_id=1");
 await deny("insert into users(email,first_name,last_name) values('service-new@example.invalid','Denied','Synthetic')");
 await deny('delete from users where user_id=1');
 await db.exec('reset role');assert.ok(await value('select invitation_accepted_at value from users where user_id=1'));
 assert.equal(await value('select auth_user_id value from users where user_id=1'),authId(1));
});