import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const {isolatedRoleTemplateDatabase,assumeSecurityUser,assumeSqlRole,beginIsolatedCase,deniedSql}=await import('./fixtures/isolated-role-template-security.mjs');
const db=await isolatedRoleTemplateDatabase();
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const matrix=(role=1)=>value('select security_role_access_matrix_data($1) value',[role]);
const save=(entries,permissions,revision,role=1)=>value('select security_save_access_matrix($1,$2,$3,$4) value',[role,entries,permissions,revision]);
const deny=(sql,params=[],code='42501')=>deniedSql(db,sql,params,code);
const entries=[
 {resourceKey:'accounting:chart-accounts',canView:true,canCreate:true,canEdit:false,canDelete:false},
 {resourceKey:'reports:accounting-reports',canView:true,canCreate:false,canEdit:false,canDelete:false}
];

test('central administrator receives current revision and 31 synthetic operational actions without internal permissions',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);
 const data=await matrix();assert.equal(data.selectedRoleId,1);assert.ok(data.roles.some(role=>role.roleId===1));assert.ok(data.roles.some(role=>role.roleId===5));assert.ok(data._revision);
 assert.equal(data.specialPermissions.length,31);
 assert.ok(data.specialPermissions.every(permission=>permission.code.startsWith('SYNTHETIC_OPERATION_')));
 assert.ok(!data.specialPermissions.some(permission=>permission.code==='SYNTHETIC_INTERNAL'));
});

test('revision-checked matrix save persists selected grants and one operational action without touching another role',async t=>{
 await beginIsolatedCase(db,t);
 const otherBefore=await rows('select resource_key,can_view,can_create,can_edit,can_delete from role_access_matrix where role_id=2 order by resource_key');
 await assumeSecurityUser(db,4,5);const before=await matrix(),special=before.specialPermissions[0].permissionId;
 const saved=await save(entries,[special],before._revision);assert.equal(saved.success,true);assert.equal(saved.saved,2);assert.equal(saved.specialSaved,1);assert.notEqual(saved._revision,before._revision);
 const after=await matrix();assert.deepEqual(after.grants,entries);assert.equal(after._revision,saved._revision);
 assert.deepEqual(after.specialPermissions.filter(permission=>permission.enabled).map(permission=>permission.permissionId),[special]);
 await db.exec('reset role');assert.deepEqual(await rows('select resource_key,can_view,can_create,can_edit,can_delete from role_access_matrix where role_id=2 order by resource_key'),otherBefore);
});

test('the assigned role allows only its explicit actions after the current matrix is saved',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);await save(entries,[],(await matrix())._revision);
 await assumeSecurityUser(db,1,1);
 await rows("select security_assert_role_access('accounting:chart-accounts','view')");
 await rows("select security_assert_role_access('accounting:chart-accounts','create')");
 await rows("select security_assert_role_access('reports:accounting-reports','view')");
 for(const [resource,action]of[['accounting:chart-accounts','edit'],['accounting:chart-accounts','delete'],['reports:accounting-reports','create'],['banking:bank-accounts','view']]){
  assert.equal(await value('select security_resource_allowed($1,$2) value',[resource,action]),false);
  await deny('select security_assert_role_access($1,$2)',[resource,action]);
 }
});

test('stale revisions, duplicate resources and technical or duplicate permission IDs reject atomically',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);const initial=await matrix(),special=initial.specialPermissions[0].permissionId;
 const updated=await save(entries,[special],initial._revision),stable=await matrix();
 await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,entries,[],initial._revision],'55000');
 await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,entries,[],null],'55000');
 const internal=await value("select permission_id value from permissions where code='SYNTHETIC_INTERNAL'");
 for(const [grants,permissions]of[[[entries[0],entries[0]],[]],[entries,[internal]],[entries,[special,special]],[entries,[999999]],[entries,null]]){
  await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,grants,permissions,updated._revision],'22023');
 }
 assert.deepEqual(await matrix(),stable);
});

test('A06 forbids legacy rows and legacy form submissions while old unrevisioned and private save shortcuts remain closed',async t=>{
 await beginIsolatedCase(db,t);
 await deny("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(1,'legacy:all',true,true,true,true)",[],'23514');
 await assumeSecurityUser(db,4,5);const current=await matrix();
 await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,[{resourceKey:'legacy:all',canView:true}],[],current._revision],'22023');
 await deny('select security_save_role_access_matrix($1,$2,$3)',[1,entries,[]]);
 await deny('select access_admin_private.security_save_role_access_matrix($1,$2,$3)',[1,entries,[]]);
 for(const sql of["delete from role_access_matrix where role_id=1","update role_access_matrix set can_edit=true where role_id=1","insert into role_permissions(role_id,permission_id) values(1,1)"])await deny(sql);
 await db.exec('reset role');
 assert.equal(await value("select count(*)::int value from pg_proc where proname in('security_assert_role_access','security_resource_allowed') and prosrc like '%legacy:all%'"),0);
});

test('delegated explicit matrix permissions cannot grant administration and anonymous/service callers cannot invoke the matrix',async t=>{
 await beginIsolatedCase(db,t);
 await db.exec("insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete) values(1,'security:role-access-matrix',true,true,true,true)");
 await assumeSecurityUser(db,1,1);
 await deny('select security_role_access_matrix_data(1)');
 await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,entries,[],'SYNTHETIC-REVISION']);
 for(const role of['anon','service_role']){
  await assumeSqlRole(db,role);
  await deny('select security_role_access_matrix_data(1)');
  await deny('select security_save_access_matrix($1,$2,$3,$4)',[1,entries,[],'SYNTHETIC-REVISION']);
 }
});

test('revoked sessions and removed company context cannot use otherwise valid explicit or administrator grants',async t=>{
 await beginIsolatedCase(db,t);await assumeSecurityUser(db,4,5);await save(entries,[],(await matrix())._revision);
 await db.exec('reset role;update sessions set revoked_at=now() where user_id=1');
 await assumeSecurityUser(db,1,1);assert.equal(await value("select security_resource_allowed('accounting:chart-accounts','view') value"),false);await deny("select security_assert_role_access('accounting:chart-accounts','view')");
 await assumeSecurityUser(db,4,5);await db.exec('reset role;delete from user_company_sessions where user_id=4;set role authenticated');await deny('select security_role_access_matrix_data(1)');
});