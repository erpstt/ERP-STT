import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedUserAuditDatabase,assumeSecurityUser} from './fixtures/isolated-security-user-db-test.mjs';

assertIsolatedTestArgs();
const db=await isolatedUserAuditDatabase();
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const audit=(id=100,table='users')=>value('select record_actor_audit($1,$2) value',[table,String(id)]);
const safeFields=['created_by_name','created_by_email','actor_type','actor_source','execution_context_id','updated_by_name','updated_by_email','updated_actor_type','updated_actor_source','updated_execution_context_id'].sort();
async function reset(t){await db.exec('reset role;begin');t.after(()=>db.exec('reset role;rollback'));}
async function denied(work,code='42501'){await db.exec('savepoint denied');try{await assert.rejects(work,error=>error?.code===code);}finally{await db.exec('rollback to denied;release denied');}}
function sanitized(record){assert.ok(record);assert.deepEqual(Object.keys(record).sort(),safeFields);assert.ok(!JSON.stringify(record).includes('forged-header'));}

test('actual actor triggers and SECURITY INVOKER audit RPC preserve sanitized human attribution for central administrators',async t=>{
 await reset(t);await assumeSecurityUser(db,4,5);
 const metadata=await audit();sanitized(metadata);
 assert.equal(metadata.created_by_email,'synthetic-4@example.invalid');
 assert.equal(metadata.created_by_name,'Synthetic User');assert.equal(metadata.actor_type,'HUMAN');
 assert.equal(metadata.actor_source,'Synthetic isolated database');
 assert.equal(metadata.execution_context_id,'synthetic-security-4');
 assert.equal(metadata.updated_by_email,null);
 const listed=await value("select security_access_master_list('users') value");
 const target=listed.find(row=>row.user_id===100);assert.ok(target);
 await value("select security_save_access_master('users',$1,100) value",[{first_name:'Updated synthetic',_revision:target._revision}]);
 const updated=await audit();sanitized(updated);assert.equal(updated.created_by_email,metadata.created_by_email);
 assert.equal(updated.updated_by_email,'synthetic-4@example.invalid');assert.equal(updated.updated_actor_type,'HUMAN');
 await db.exec('reset role');
 assert.equal(await value("select count(*)::int value from audit_log where entity_type='users' and entity_id=100 and user_id=4 and action='MODIFICACION'"),1);
});

test('owners read their metadata while unrelated users cannot observe another profile audit',async t=>{
 await reset(t);await assumeSecurityUser(db,100,1);sanitized(await audit());
 await assumeSecurityUser(db,3,1);assert.equal(await audit(),null);
 await assumeSecurityUser(db,101,1,2);sanitized(await audit(101));assert.equal(await audit(),null);
});

test('delegated viewers stay in their active subsidiary and stale/forged privileged context grants no cross-user audit',async t=>{
 await reset(t);await assumeSecurityUser(db,1,3);sanitized(await audit());assert.equal(await audit(101),null);
 await assumeSecurityUser(db,1,3,2);sanitized(await audit(101));assert.equal(await audit(),null);
 await assumeSecurityUser(db,1,5);assert.equal(await audit(),null);
 await assumeSecurityUser(db,1,3,999);assert.equal(await audit(),null);
 await assumeSecurityUser(db,4,5,1,1);assert.equal(await audit(),null); // Wrong device for administrator identity.
});

test('column ACLs protect passwords/Auth and internal actor IDs for owner and administrator, including direct SELECT',async t=>{
 await reset(t);
 for(const [user,role]of[[100,1],[4,5]]){
  await assumeSecurityUser(db,user,role);sanitized(await audit());
  for(const column of['password_hash','auth_user_id','created_by_id','updated_by_id'])await denied(()=>rows('select '+column+' from users'));
  for(const column of safeFields)assert.equal(await value("select has_column_privilege('authenticated','users',$1,'SELECT') value",[column]),true);
 }
 assert.equal(await value("select p.prosecdef value from pg_proc p where p.oid='record_actor_audit(text,text)'::regprocedure"),false);
});

test('anonymous, absent identity, invalid targets and raw audit reads cannot bypass the metadata contract',async t=>{
 await reset(t);await db.exec('set role anon');await denied(()=>audit());
 await db.exec('reset role');await db.query("select set_config('request.jwt.claims','{}',false),set_config('request.headers','{}',false)");await db.exec('set role authenticated');
 assert.equal(await audit(),null);
 await assumeSecurityUser(db,4,5);assert.equal(await audit(99999),null);
 await denied(()=>audit(100,'users;select'),'P0001');
 await denied(()=>audit('', 'users'),'P0001');
 for(const table of['audit_log','change_log','event_log','activity_log','deleted_records'])await denied(()=>rows('select * from '+table));
});
