import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const {isolatedUserAccessDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession}=await import('./fixtures/isolated-user-access-db-test.mjs');
const db=await isolatedUserAccessDatabase();
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const list=()=>value("select security_access_master_list('user-subsidiaries') value");
const save=(id,payload)=>value("select security_save_access_master('user-subsidiaries',$1,$2) value",[payload,id]);
const deny=(sql,params=[],code='42501')=>deniedSql(db,sql,params,code);
const ids=row=>row.subsidiary_ids.map(Number).sort((a,b)=>a-b);

test('central catalog includes users with no assignments and returns every company option with revision-aware actions',async t=>{
 await beginIsolatedCase(db,t);await db.query("insert into auth.users(id,email) values($1,'unassigned-synthetic@example.invalid')",[authId(200)]);
 await assumeSecurityUser(db,4,5);
 const created=await value("select security_create_user('unassigned-synthetic@example.invalid',$1,'Synthetic','Unassigned',null,true) value",[authId(200)]);
 const catalog=await list(),unassigned=catalog.find(row=>row.user_id===created.user_id);assert.ok(unassigned);assert.deepEqual(unassigned.subsidiary_ids,[]);assert.equal(unassigned.subsidiary_count,0);assert.ok(unassigned._revision);
 const own=catalog.find(row=>row.user_id===4);assert.deepEqual(own._actions,{canEdit:false,canDelete:false});
 assert.ok(catalog.every(row=>!('password_hash'in row)&&!('auth_user_id'in row)));
 const options=await value('select security_user_subsidiary_options() value');
 assert.deepEqual(options.map(row=>row.subsidiary_id).sort((a,b)=>a-b),[1,2,3,4]);
 const configuration=await value("select security_access_master_options('user-subsidiaries') value");
 assert.equal(configuration.canEdit,true);assert.deepEqual(configuration.references['organization/subsidiaries'],options);
});

test('checked save deduplicates selected companies and invalidates stale revisions',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const before=(await list()).find(row=>row.user_id===3);
 const changed=await save(3,{user_id:3,subsidiary_ids:[2,1,2],_revision:before._revision});
 assert.deepEqual(ids(changed),[1,2]);assert.equal(changed.subsidiary_count,2);assert.notEqual(changed._revision,before._revision);
 await deny("select security_save_access_master('user-subsidiaries',$1,3)",[{subsidiary_ids:[1],_revision:before._revision}],'55000');
 await deny("select security_save_access_master('user-subsidiaries',$1,3)",[{subsidiary_ids:[1]}],'55000');
 assert.deepEqual(ids((await list()).find(row=>row.user_id===3)),[1,2]);
 await db.exec('reset role');assert.equal(await value('select count(*)::int value from user_subsidiaries where user_id=3'),2);
});

test('removing a company clears every stale company context and prevents reuse of the removed selection',async t=>{
 await beginIsolatedCase(db,t);
 await db.query("insert into user_company_sessions values('synthetic-second-context',2,2)");
 await assumeSecurityUser(db,2,4,2);assert.equal(await value('select active_subsidiary_id() value'),2);
 await assumeSecurityUser(db,4,5);const target=(await list()).find(row=>row.user_id===2);
 assert.deepEqual(ids(await save(2,{subsidiary_ids:[1],_revision:target._revision})),[1]);
 await db.exec('reset role');
 assert.equal(await value('select count(*)::int value from user_company_sessions where user_id=2 and subsidiary_id=2'),0);
 await assumeSecurityUser(db,2,4,2);assert.equal(await value('select active_subsidiary_id() value'),null);
 await deny("select security_access_master_list('user-subsidiaries')");
 assert.equal(await value('select app_user_id() value'),2);
});

test('invalid bulk input is atomic across memberships and contexts; mismatched target IDs are rejected',async t=>{
 await beginIsolatedCase(db,t);
 await db.query("insert into user_company_sessions values('synthetic-atomic-context',2,2)");
 const beforeMemberships=await rows('select user_id,subsidiary_id,id from user_subsidiaries order by user_id,subsidiary_id'),beforeContexts=await rows('select * from user_company_sessions order by session_id');
 await assumeSecurityUser(db,4,5);const target=(await list()).find(row=>row.user_id===2);
 // assumeSecurityUser legitimately adds the actor's context; compare the full
 // membership graph and only the target's contexts after each failed request.
 for(const selection of[[1,999999],[],null,['1'],[null],[0],[-1],[1.5]]){
  await deny("select security_save_access_master('user-subsidiaries',$1,2)",[{subsidiary_ids:selection,_revision:target._revision}],'22023');
 }
 await deny("select security_save_access_master('user-subsidiaries',$1,2)",[{user_id:3,subsidiary_ids:[1],_revision:target._revision}]);
 assert.equal((await list()).find(row=>row.user_id===2)._revision,target._revision);
 await db.exec('reset role');
 assert.deepEqual(await rows('select user_id,subsidiary_id,id from user_subsidiaries order by user_id,subsidiary_id'),beforeMemberships);
 assert.deepEqual(await rows('select * from user_company_sessions where user_id=2 order by session_id'),beforeContexts.filter(row=>row.user_id===2));
});

test('own company assignments cannot be edited, including attempts to remove the active company or retain only another one',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const own=(await list()).find(row=>row.user_id===4);
 for(const selection of[[2],[1],[1,2],[]])await deny("select security_save_access_master('user-subsidiaries',$1,4)",[{user_id:4,subsidiary_ids:selection,_revision:own._revision}]);
 assert.deepEqual(ids((await list()).find(row=>row.user_id===4)),[1,2]);
 await db.exec('reset role;delete from user_subsidiaries where user_id=4 and subsidiary_id=1');await assumeSecurityUser(db,4,5,1);
 assert.equal(await value('select active_subsidiary_id() value'),null);await deny("select security_access_master_options('user-subsidiaries')");
});

test('delegated and legacy grants cannot administer bulk assignments; historical public and private sync shortcuts stay closed',async t=>{
 await beginIsolatedCase(db,t);
 await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(1,'security:user-subsidiaries',true,true,true,true),(1,'legacy:all',true,true,true,true)");
 await assumeSecurityUser(db,4,5);const target=(await list()).find(row=>row.user_id===2);
 await deny('select security_sync_user_subsidiaries(2,array[1])');
 await deny('select access_admin_private.security_sync_user_subsidiaries(2,array[1])');
 await assumeSecurityUser(db,1,1);
 for(const sql of["select security_access_master_list('user-subsidiaries')",'select security_user_subsidiary_assignments()','select security_user_subsidiary_options()'])await deny(sql);
 await deny("select security_save_access_master('user-subsidiaries',$1,2)",[{subsidiary_ids:[1],_revision:target._revision}]);
 await deny('select security_sync_user_subsidiaries(2,array[1])');
});

test('anonymous, authenticated and service callers cannot write assignment tables directly; browser sequence writes are denied',async t=>{
 await beginIsolatedCase(db,t);
 for(const role of['anon','authenticated','service_role']){
  if(role==='authenticated')await assumeSecurityUser(db,4,5);else await assumeSqlRole(db,role,{sub:authId(4),session_id:authSession(4)});
  for(const sql of['insert into user_subsidiaries(user_id,subsidiary_id) values(3,2)','update user_subsidiaries set subsidiary_id=2 where user_id=3','delete from user_subsidiaries where user_id=3','truncate user_subsidiaries'])await deny(sql);
  if(role!=='service_role')for(const sql of["select nextval('user_subsidiaries_id_seq')","select setval('user_subsidiaries_id_seq',999)"])await deny(sql);
  if(role!=='authenticated')await deny("select security_save_access_master('user-subsidiaries',$1,2)",[{subsidiary_ids:[1],_revision:'SYNTHETIC'}]);
 }
 await assumeSecurityUser(db,1,1);assert.deepEqual((await rows('select subsidiary_id from user_subsidiaries order by subsidiary_id')).map(row=>row.subsidiary_id),[1,2]);
});