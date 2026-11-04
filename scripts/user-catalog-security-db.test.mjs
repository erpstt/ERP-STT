import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const {isolatedUserAccessDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql,authId,authSession}=await import('./fixtures/isolated-user-access-db-test.mjs');
const db=await isolatedUserAccessDatabase({audit:true});
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const list=()=>value("select security_access_master_list('users') value");
const save=(id,payload)=>value("select security_save_access_master('users',$1,$2) value",[payload,id]);
const deny=(sql,params=[],code='42501')=>deniedSql(db,sql,params,code);
const create=(email,identity,first='Synthetic',last='New user',timezone=null)=>value('select security_create_user($1,$2,$3,$4,$5,true) value',[email,identity,first,last,timezone]);

test('own profile uses verified Auth UUID while secrets and all direct profile mutations stay inaccessible',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db);
 assert.deepEqual(await rows('select user_id,email from users order by user_id'),[{user_id:1,email:'synthetic-1@example.invalid'}]);
 assert.equal(await value('select app_user_id() value'),1);
 for(const column of['password_hash','auth_user_id'])await deny('select '+column+' from users');
 for(const sql of["update users set first_name='Blocked' where user_id=1",'delete from users where user_id=1',"insert into users(email,first_name,last_name) values('blocked@example.invalid','Blocked','Synthetic')"])await deny(sql);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:authId(1),email:'synthetic-4@example.invalid',session_id:authSession(1),role:'authenticated'})]);
 assert.equal(await value('select app_user_id() value'),1);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({email:'synthetic-1@example.invalid',session_id:authSession(1),role:'authenticated'})]);
 assert.equal(await value('select app_user_id() value'),null);assert.deepEqual(await rows('select user_id from users'),[]);
 await deny("select security_access_master_list('users')");
});

test('explicit viewer is scoped to the active company and cannot edit, provision or mark invitations',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,1,3);
 const catalog=await list();assert.ok(catalog.some(row=>row.user_id===100));assert.ok(!catalog.some(row=>row.user_id===101));
 assert.ok(catalog.every(row=>row._revision&&!('password_hash'in row)&&!('auth_user_id'in row)));
 const target=catalog.find(row=>row.user_id===100);assert.equal(target._actions.canEdit,false);
 await deny("select security_save_access_master('users',$1,100)",[{first_name:'Denied',_revision:target._revision}]);
 await deny("select security_create_user('new@example.invalid',$1,'New','Synthetic',null,true)",[authId(200)]);
 await deny('select security_mark_user_invitation_sent(100)');
 await deny("update users set first_name='Denied' where user_id=100");
});

test('delegated editor changes only a scoped profile through revision-checked RPC and preserves real human audit attribution',async t=>{
 await beginIsolatedCase(db,t);
 await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(1,'security:users',true,false,true,false)");
 const identityBefore=(await rows('select auth_user_id,password_hash from users where user_id=100'))[0];
 const otherCompanyRevision=await value("select access_admin_private.revision('users',101) value");
 await assumeSecurityUser(db,1,1);const initial=(await list()).find(row=>row.user_id===100);
 const changed=await save(100,{first_name:'Updated synthetic',_revision:initial._revision});
 assert.equal(changed.first_name,'Updated synthetic');assert.notEqual(changed._revision,initial._revision);
 await deny("select security_save_access_master('users',$1,100)",[{last_name:'Stale',_revision:initial._revision}],'55000');
 await deny("select security_save_access_master('users',$1,100)",[{email:'changed@example.invalid',_revision:changed._revision}]);
 await deny("select security_save_access_master('users',$1,100)",[{auth_user_id:authId(200),_revision:changed._revision}],'55000');
 const admin=(await list()).find(row=>row.user_id===4);
 await deny("select security_save_access_master('users',$1,4)",[{first_name:'Blocked administrator',_revision:admin._revision}]);
 await deny("select security_save_access_master('users',$1,101)",[{first_name:'Other company',_revision:otherCompanyRevision}]);
 const attribution=await value("select record_actor_audit('users','100') value");
 assert.equal(attribution.updated_by_email,'synthetic-1@example.invalid');assert.equal(attribution.updated_actor_type,'HUMAN');
 assert.equal(attribution.created_by_email,'synthetic-4@example.invalid');
 await db.exec('reset role');
 assert.deepEqual((await rows('select auth_user_id,password_hash from users where user_id=100'))[0],identityBefore);
 assert.equal(await value("select count(*)::int value from audit_log where entity_type='users' and entity_id=100 and action='MODIFICACION' and user_id=1"),1);
});

test('central provisioning validates canonical Auth identity and returns a sanitized profile without assigning roles or companies',async t=>{
 await beginIsolatedCase(db,t);
 const email='synthetic-provisioned@example.invalid';await db.query('insert into auth.users(id,email) values($1,$2)',[authId(200),email]);
 await assumeSecurityUser(db,4,5);
 assert.deepEqual((await list()).map(row=>row.user_id).sort((a,b)=>a-b),[1,2,3,4,100,101]);
 await deny('select security_create_user($1,$2,$3,$4,null,true)',[' '+email.toUpperCase()+' ',authId(200),'Synthetic','New'],'22023');
 await deny('select security_create_user($1,$2,$3,$4,null,true)',['mismatch@example.invalid',authId(200),'Synthetic','New'],'22023');
 await deny('select security_create_user($1,$2,$3,$4,999,true)',[email,authId(200),'Synthetic','New'],'22023');
 const created=await create(email,authId(200),' Synthetic ',' New user ',1);
 assert.deepEqual(Object.keys(created).sort(),['user_id','email','first_name','last_name','timezone_id','is_active','invitation_sent_at','invitation_accepted_at'].sort());
 assert.equal(created.email,email);assert.equal(created.first_name,'Synthetic');assert.equal(created.last_name,'New user');
 assert.equal(created.invitation_sent_at,null);assert.equal(created.invitation_accepted_at,null);
 assert.equal(await value('select security_mark_user_invitation_sent($1) value',[created.user_id]),true);
 await deny('select security_create_user($1,$2,$3,$4,null,true)',[email,authId(200),'Duplicate','Synthetic'],'23505');
 const attribution=await value("select record_actor_audit('users',$1) value",[String(created.user_id)]);
 assert.equal(attribution.actor_type,'HUMAN');assert.equal(attribution.created_by_email,'synthetic-4@example.invalid');
 await db.exec('reset role');
 const internal=(await rows('select auth_user_id,password_hash,invitation_sent_at from users where user_id=$1',[created.user_id]))[0];
 assert.equal(internal.auth_user_id,authId(200));assert.equal(internal.password_hash,'auth:'+authId(200));assert.ok(internal.invitation_sent_at);
 assert.equal(await value('select count(*)::int value from user_roles where user_id=$1',[created.user_id]),0);
 assert.equal(await value('select count(*)::int value from user_subsidiaries where user_id=$1',[created.user_id]),0);
 await deny("insert into users(email,password_hash,first_name,last_name) values(' Upper@example.invalid ','SYNTHETIC','Invalid','Canonical')",[],'23514');
});

test('legacy and explicit delegated grants cannot create users, roles, role assignments or company assignments',async t=>{
 await beginIsolatedCase(db,t);
 await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(1,'security:users',true,true,true,true),(1,'security:roles',true,true,true,true),(1,'security:user-roles',true,true,true,true),(1,'security:user-subsidiaries',true,true,true,true),(1,'legacy:all',true,true,true,true)");
 await assumeSecurityUser(db,1,1);
 await deny("select security_create_user('delegated@example.invalid',$1,'Denied','Synthetic',null,true)",[authId(200)]);
 for(const catalog of['roles','user-roles','user-subsidiaries'])await deny('select security_save_access_master($1,$2,null)',[catalog,{}]);
 await deny("select security_assert_role_access('security:users','create')");
 await deny('select security_sync_user_subsidiaries(3,array[1,2])');
 await deny('select access_admin_private.security_create_user($1,$2,$3,$4,null,true)',['private@example.invalid',authId(200),'Private','Denied']);
});

test('system roles and own links stay protected while the current central-only operational self-assignment remains allowed',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const custom=await value("select security_save_access_master('roles',$1,null) value",[{role_name:'Synthetic operational role'}]);
 const own=await value("select security_save_access_master('user-roles',$1,null) value",[{user_id:4,role_id:custom.role_id}]);
 assert.deepEqual(own._actions,{canEdit:false,canDelete:false});
 await deny("select security_save_access_master('user-roles',$1,$2)",[{user_id:3,role_id:custom.role_id,_revision:own._revision},own.id]);
 await deny('select security_delete_access_master($1,$2)',[own.id,own._revision]);
 await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:5}]);
 await deny("select security_save_access_master('roles',$1,null)",[{role_name:' Admin '}],'22023');
 await deny("select security_save_access_master('roles',$1,null)",[{role_name:'Injected system',is_system_role:true}],'22023');
 const roles=await value("select security_access_master_list('roles') value"),system=roles.find(row=>row.role_id===5);
 await deny("select security_save_access_master('roles',$1,5)",[{description:'Blocked system mutation',_revision:system._revision}]);
 const self=(await list()).find(row=>row.user_id===4);await deny("select security_save_access_master('users',$1,4)",[{is_active:false,_revision:self._revision}]);
});

test('revoked role/company context, wrong device and inactive identity cannot reach privileged catalog operations',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,1,3);
 await db.exec('reset role;delete from user_roles where user_id=1 and role_id=3');await assumeSecurityUser(db,1,3);
 assert.equal(await value('select app_active_role_id() value'),null);await deny("select security_access_master_list('users')");
 await db.exec('reset role;delete from user_subsidiaries where user_id=4 and subsidiary_id=1');await assumeSecurityUser(db,4,5,1);
 assert.equal(await value('select active_subsidiary_id() value'),null);await deny("select security_access_master_list('users')");
 await assumeSecurityUser(db,4,5,2,1);assert.equal(await value('select app_user_id() value'),null);await deny("select security_access_master_list('users')");
 await db.exec('reset role;update users set is_active=false where user_id=4');await assumeSecurityUser(db,4,5,2);
 assert.equal(await value('select app_user_id() value'),null);await deny("select security_access_master_list('users')");
});

test('service and anonymous callers cannot provision directly or invoke human administrative RPCs',async t=>{
 await beginIsolatedCase(db,t);
 for(const role of['anon','service_role']){
  await assumeSqlRole(db,role,{sub:authId(4),session_id:authSession(4)});
  await deny("insert into users(email,password_hash,auth_user_id,first_name,last_name) values('blocked-service@example.invalid','SYNTHETIC',$1,'Blocked','Synthetic')",[authId(200)]);
  await deny("select security_create_user('blocked-service@example.invalid',$1,'Blocked','Synthetic',null,true)",[authId(200)]);
  await deny("select security_access_master_list('users')");
 }
});
