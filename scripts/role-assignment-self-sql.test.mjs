import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupAccessAdminSecurity} from './fixtures/setup-access-admin-security.mjs';
import {installSelfRoleAssignment} from './fixtures/role-assignment-self-migration.mjs';

const db=new PGlite();let baseline;
const q=async(sql,parameters=[])=>(await db.query(sql,parameters)).rows;
const one=async(sql,parameters=[])=>(await q(sql,parameters))[0]?.data;
const save=(payload,id=null)=>one("select security_save_access_master('user-roles',$1,$2) data",[payload,id]);
const list=()=>one("select security_access_master_list('user-roles') data");
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function actor(user=4,role=5){
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'self-role-synthetic'})]);
 await db.query("insert into user_role_sessions values('self-role-synthetic',$1,$2)on conflict(session_id)do update set user_id=excluded.user_id,role_id=excluded.role_id",[user,role]);
 await db.query("insert into user_company_sessions values('self-role-synthetic',$1,1)on conflict(session_id)do update set user_id=excluded.user_id,subsidiary_id=excluded.subsidiary_id",[user]);
 await db.exec('set role authenticated');
}
async function deny(sql,parameters=[],code='42501'){
 await db.exec('savepoint denied');
 try{await assert.rejects(()=>db.query(sql,parameters),error=>error.code===code);}
 finally{await db.exec('rollback to denied;release savepoint denied');}
}
async function customRole(){return (await one("select security_save_access_master('roles',$1,null) data",[{role_name:'Synthetic operational role'}])).role_id;}
const snapshots=()=>q(`select 'policies' kind,md5(coalesce(string_agg(row(schemaname,tablename,policyname,roles,cmd,qual,with_check)::text,'' order by schemaname,tablename,policyname),'')) value from pg_policies
 union all select 'routine_acl',md5(coalesce(string_agg(row(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig)::text,'' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','access_admin_private')
 union all select 'table_acl',md5(coalesce(string_agg(row(c.oid,c.relowner,c.relacl,c.relrowsecurity)::text,'' order by c.oid),'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
 union all select 'assignments',md5(coalesce(string_agg(to_jsonb(r)::text,'' order by r.id),'')) from user_roles r
 order by kind`);

before(async()=>{
 await setupAccessAdminSecurity(db);
 baseline=await snapshots();
 await installSelfRoleAssignment(db);
});
after(()=>db.close());

test('active central administrator may add their own operational role while preserving the active administrator context',async t=>{
 await tx(t);await actor();const role=await customRole(),result=await save({user_id:4,role_id:role});
 assert.equal(result.user_id,4);assert.equal(result.role_id,role);assert.deepEqual(result._actions,{canEdit:false,canDelete:false});
 await db.exec("reset role;insert into roles(role_id,role_name,is_system_role)values(1000,'Contador de Subsidiaria',true)");await actor();
 const systemOperational=await save({user_id:4,role_id:1000});assert.equal(systemOperational.role_id,1000);assert.equal(systemOperational.user_id,4);
 assert.equal((await q('select app_active_role_id() id'))[0].id,5);
 assert.equal((await q('select role_id from user_roles where user_id=4 and role_id=5')).length,1);
 assert.deepEqual((await q('select subsidiary_id from user_subsidiaries where user_id=4 order by subsidiary_id')).map(x=>x.subsidiary_id),[1,2]);
});

test('the same central administrator can continue assigning a role to another active user',async t=>{
 await tx(t);await actor();const role=await customRole(),result=await save({user_id:2,role_id:role});
 assert.equal(result.user_id,2);assert.equal(result.role_id,role);assert.equal(result._actions.canEdit,true);
});

test('an assigned administrator role cannot authorize self-assignment while an operational role is active',async t=>{
 await tx(t);await db.exec("insert into user_roles(user_id,role_id)values(4,1);insert into role_access_matrix values(1,'security:user-roles',true,true,true,true,null,now())");
 await actor(4,1);await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:2}]);
 await actor(1,1);await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:1,role_id:4}]);
});

test('all normalized administrator aliases remain forbidden for self-assignment regardless of the system-role flag',async t=>{
 await tx(t);let id=1000;
 for(const name of ['Administrador','Administrator','Admin','  aDmIn  ','  AdMiNiStRaDoR  ']){
  await db.exec('reset role');await db.query('insert into roles(role_id,role_name,is_system_role)values($1,$2,false)',[id,name]);await actor();
  await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:id}]);id++;
 }
});

test('newly added own links and the existing own administrator link cannot be edited or deleted',async t=>{
 await tx(t);await actor();const own=await save({user_id:4,role_id:await customRole()}),admin=(await list()).find(x=>x.user_id===4&&x.role_id===5);
 for(const link of [own,admin]){
  await deny("select security_save_access_master('user-roles',$1,$2)",[{user_id:2,role_id:link.role_id,_revision:link._revision},link.id]);
  await deny('select security_delete_access_master($1,$2)',[link.id,link._revision]);
 }
});

test('an existing assignment belonging to someone else cannot be transferred to the actor',async t=>{
 await tx(t);await actor();const link=await save({user_id:2,role_id:await customRole()});
 await deny("select security_save_access_master('user-roles',$1,$2)",[{user_id:4,role_id:link.role_id,_revision:link._revision},link.id]);
});

test('duplicate own assignments fail atomically and preserve a single link and the active session',async t=>{
 await tx(t);await actor();const role=await customRole();await save({user_id:4,role_id:role});
 await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:role}],'23505');
 assert.equal((await q('select role_id from user_roles where user_id=4 and role_id=$1',[role])).length,1);
 assert.equal((await q('select app_active_role_id() id'))[0].id,5);
});

test('self subsidiary changes, the last administrator, direct writes and private functions remain protected',async t=>{
 await tx(t);await actor();
 const subsidiaries=await one("select security_access_master_list('user-subsidiaries') data"),own=subsidiaries.find(x=>x.user_id===4);
 await deny("select security_save_access_master('user-subsidiaries',$1,4)",[{user_id:4,subsidiary_ids:[1],_revision:own._revision}]);
 await deny('delete from user_roles');await deny("select access_admin_private.security_sync_user_subsidiaries(4,array[1])");
 const other=await one("select security_save_access_master('roles',$1,null) data",[{role_name:'Synthetic replacement role'}]);
 await deny("select security_save_access_master('user-roles',$1,$2)",[{user_id:2,role_id:other.role_id,_revision:(await list()).find(x=>x.user_id===4&&x.role_id===5)._revision},(await list()).find(x=>x.user_id===4&&x.role_id===5).id]);
});

test('missing identities, inactive actors and anonymous or service roles cannot create assignments',async t=>{
 await tx(t);
 for(const role of ['anon','authenticated','service_role']){
  await db.exec('reset role');await db.query("select set_config('request.jwt.claims','{}',false)");await db.exec('set role '+role);
  await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:1}]);
 }
 await db.exec('reset role;update users set is_active=false where user_id=4');await actor();
 await deny("select security_save_access_master('user-roles',$1,null)",[{user_id:4,role_id:1}]);
});

test('migration preserves every existing function security attribute, table ACL, policy and assignment',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await snapshots(),baseline);
});
