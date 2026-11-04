import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedPasswordNotificationDatabase} from './fixtures/isolated-password-notification-test.mjs';

assertIsolatedTestArgs();
const db=await isolatedPasswordNotificationDatabase();
test.after(()=>db.close());
const value=async(sql,params=[])=>(await db.query(sql,params)).rows[0]?.value;
const email='a'.repeat(64),state='b'.repeat(64),second='c'.repeat(64),otherEmail='d'.repeat(64),otherState='e'.repeat(64);
const consume=(hash=state,mail=email)=>value('select consume_password_recovery_grant($1,$2) value',[hash,mail]);
async function reset(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));}
async function service(){await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);await db.exec('set role service_role');}
async function denied(work,code='42501'){await db.exec('savepoint denied');try{await assert.rejects(work,error=>error?.code===code);}finally{await db.exec('rollback to denied;release denied');}}

test('recovery grants and their sequence/consume RPC remain inaccessible to public clients',async t=>{
 await reset(t);
 assert.equal(await value("select has_table_privilege('service_role','password_recovery_grants','SELECT,INSERT,UPDATE,DELETE') value"),true);
 assert.equal(await value("select has_function_privilege('service_role','consume_password_recovery_grant(text,text)','EXECUTE') value"),true);
 for(const role of['anon','authenticated']){
  await db.exec('reset role;set role '+role);
  await denied(()=>db.query('select * from password_recovery_grants'));
  await denied(()=>db.query("insert into password_recovery_grants(email_hash,state_hash,expires_at) values($1,$2,now()+interval '1 hour')",[email,state]));
  await denied(()=>db.query("select nextval('password_recovery_grants_recovery_id_seq')"));
  await denied(()=>consume());
 }
});

test('current recovery consumption invalidates all sibling links for the email and preserves other emails',async t=>{
 await reset(t);await service();
 await db.query("insert into password_recovery_grants(email_hash,state_hash,expires_at) values($1,$2,now()+interval '30 minutes'),($1,$3,now()+interval '30 minutes'),($4,$5,now()+interval '30 minutes')",[email,state,second,otherEmail,otherState]);
 assert.equal(await value('select count(*)::int value from password_recovery_grants'),3);
 assert.equal(await consume(),true);assert.equal(await consume(),false);assert.equal(await consume(second),false);
 assert.equal(await value('select count(*)::int value from password_recovery_grants where email_hash=$1 and consumed_at is not null',[email]),2);
 assert.equal(await value('select count(*)::int value from password_recovery_grants where email_hash=$1 and consumed_at is null',[otherEmail]),1);
 assert.equal(await consume(otherState,otherEmail),true);
});

test('wrong digests, malformed values and expired links never consume a valid recovery grant',async t=>{
 await reset(t);await service();
 await db.query("insert into password_recovery_grants(email_hash,state_hash,expires_at) values($1,$2,now()+interval '1 hour')",[email,state]);
 await db.query("insert into password_recovery_grants(email_hash,state_hash,created_at,expires_at) values($1,$2,now()-interval '2 hours',now()-interval '1 hour')",[otherEmail,otherState]);
 for(const [candidate,mail]of[[second,email],[state,otherEmail],['invalid',email],[state,'invalid'],[otherState,otherEmail]])assert.equal(await consume(candidate,mail),false);
 assert.equal(await value('select count(*)::int value from password_recovery_grants where consumed_at is not null'),0);
 assert.equal(await consume(),true);
});

test('service SQL privilege alone does not replace the explicit service JWT role check',async t=>{
 await reset(t);await service();
 await db.query("insert into password_recovery_grants(email_hash,state_hash,expires_at) values($1,$2,now()+interval '1 hour')",[email,state]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated'})]);
 await denied(()=>consume());
 assert.equal(await value('select count(*)::int value from password_recovery_grants where consumed_at is not null'),0);
 await service();assert.equal(await consume(),true);
});
