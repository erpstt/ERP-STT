import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {isolatedPasswordNotificationDatabase} from './fixtures/isolated-password-notification-test.mjs';

assertIsolatedTestArgs();

// In-memory PostgreSQL only. This entry point never loads .env or creates a
// database, Auth, HTTP or SMTP client, regardless of its parent's environment.
const db=await isolatedPasswordNotificationDatabase();
test.after(()=>db.close());
const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
const value=async(sql,params=[])=>(await rows(sql,params))[0]?.value;
const prepare=id=>value('select public.security_prepare_user_password_recovery($1) value',[id]);
const audit=(target=2,sid=1,result='ENVIADO',actor=4)=>value(
 'select public.security_audit_user_password_notification($1,$2,$3,$4) value',[actor,target,sid,result]);

async function reset(t){
 await db.exec('begin');
 t.after(()=>db.exec('rollback'));
}
async function actor(user=4,role=5,sid=1){
 await db.exec('reset role');
 await db.query("insert into user_role_sessions values('password-synthetic',$1,$2) on conflict(session_id) do update set user_id=excluded.user_id,role_id=excluded.role_id",[user,role]);
 await db.query("insert into user_company_sessions values('password-synthetic',$1,$2) on conflict(session_id) do update set user_id=excluded.user_id,subsidiary_id=excluded.subsidiary_id",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({
  sub:'00000000-0000-0000-0000-'+String(user).padStart(12,'0'),
  session_id:'password-synthetic',role:'authenticated'
 })]);
 await db.exec('set role authenticated');
}
async function service(){
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 await db.exec('set role service_role');
}
async function denied(work,code='42501'){
 await db.exec('savepoint expected_denial');
 try{await assert.rejects(work,error=>error?.code===code);}
 finally{await db.exec('rollback to expected_denial;release expected_denial');}
}

test('central administrator prepares subsidiary/global recovery without disclosing Auth identity or granting membership',async t=>{
 await reset(t);await actor();
 const scoped=await prepare(2);
 assert.deepEqual(scoped,{
  actor_user_id:4,subsidiary_id:1,authorization_scope:'SUBSIDIARY',user_id:2,
  email:'synthetic-2@example.invalid',first_name:'Synthetic',last_name:'User'
 });
 const global=await prepare(100);
 assert.equal(global.authorization_scope,'GLOBAL_ADMIN');
 assert.equal(global.user_id,100);assert.equal(global.actor_user_id,4);assert.equal(global.subsidiary_id,1);
 assert.equal(global.email,'global-password@example.invalid');
 assert.ok(!('auth_user_id' in scoped)&&!('auth_user_id' in global));
 await db.exec('reset role');
 assert.equal(await value('select count(*)::int value from user_subsidiaries where user_id=100'),0);
 assert.equal(await value('select count(*)::int value from user_roles where user_id=100'),0);
 const paths=await rows("select path_accessed from activity_log where activity_type='SOLICITUD_RECUPERACION_USUARIO' order by path_accessed");
 assert.deepEqual(paths.map(row=>row.path_accessed).sort(),[
  'security/users/100/password-recovery?subsidiary=1&scope=global_admin',
  'security/users/2/password-recovery?subsidiary=1&scope=subsidiary'
 ].sort());
});

test('delegated edit permission stays within the active subsidiary and cannot recover an administrator',async t=>{
 await reset(t);await actor(1,1);
 const scoped=await prepare(2);assert.equal(scoped.authorization_scope,'SUBSIDIARY');assert.equal(scoped.actor_user_id,1);
 for(const target of[100,101,4])await denied(()=>prepare(target));
 await actor(1,1,2);assert.equal((await prepare(101)).authorization_scope,'SUBSIDIARY');
 await denied(()=>prepare(3));
 await db.exec('reset role');
 assert.equal(await value("select count(*)::int value from activity_log where activity_type='SOLICITUD_RECUPERACION_USUARIO'"),2);
});

test('view-only, unassigned role, missing company context and inactive actors/targets are denied',async t=>{
 await reset(t);await actor(1,3);await denied(()=>prepare(2));
 await actor(1,5);await denied(()=>prepare(2));
 await actor(1,1,999);await denied(()=>prepare(2));
 await actor();await denied(()=>prepare(102),'22023');await denied(()=>prepare(9999),'22023');
 await db.exec('reset role');await db.exec('update users set is_active=false where user_id=4');
 await actor();await denied(()=>prepare(2));
 await db.exec('reset role');
 assert.equal(await value("select count(*)::int value from activity_log where activity_type='SOLICITUD_RECUPERACION_USUARIO'"),0);
});

test('delivery uses the recovery template and obeys editing permission',async t=>{
 await reset(t);await actor();
 const delivery=await value("select user_password_recovery_email_settings('delivery','{}'::jsonb) value");
 assert.equal(delivery.template.tipo_notificacion,'USUARIO_RECUPERACION');
 assert.match(delivery.template.asunto_template,/Recupera tu acceso/);
 assert.doesNotMatch(delivery.template.cuerpo_template,/Se creó una cuenta/);
 assert.equal(delivery.subsidiary.id,1);
 assert.ok(delivery.variables.includes('enlace_recuperacion'));
 await actor(1,1);
 assert.equal((await value("select user_password_recovery_email_settings('delivery','{}'::jsonb) value")).template.id_subsidiaria,1);
 await denied(()=>value("select user_password_recovery_email_settings('save',$1) value",[{subject:'Denied',body:'Denied',active:true}]));
 await actor(1,3);await denied(()=>value("select user_password_recovery_email_settings('delivery','{}'::jsonb) value"));
});

test('service auditing binds results to a prepared request, retaining its authorized scope',async t=>{
 await reset(t);await actor();await prepare(2);await prepare(100);
 await denied(()=>audit());
 await service();assert.equal(await audit(),true);assert.equal(await audit(100,1,'ENVIADO_CON_ADVERTENCIA'),true);
 await denied(()=>audit(101),'22023'); // Existing synthetic target, but no prepared request.
 await denied(()=>audit(2,2),'22023');
 await denied(()=>audit(2,1,'INVALID'),'22023');
 await db.exec('reset role');
 const events=await rows("select user_id,activity_type,path_accessed from activity_log where activity_type like 'ENVIO_RECUPERACION_USUARIO_%' order by activity_type");
 assert.deepEqual(events,[
  {user_id:4,activity_type:'ENVIO_RECUPERACION_USUARIO_ENVIADO',path_accessed:'security/users/2/password-recovery?subsidiary=1&scope=subsidiary'},
  {user_id:4,activity_type:'ENVIO_RECUPERACION_USUARIO_ENVIADO_CON_ADVERTENCIA',path_accessed:'security/users/100/password-recovery?subsidiary=1&scope=global_admin'}
 ]);
 assert.ok(events.every(row=>!/(?:token|password=|https?:)/i.test(row.path_accessed)));
});

test('rate limits and expired authorization prevent additional recovery work',async t=>{
 await reset(t);await actor();
 for(let count=0;count<3;count++)await prepare(2);
 await denied(()=>prepare(2),'22023');
 await db.exec('reset role');
 await db.exec("update activity_log set timestamp=clock_timestamp()-interval '2 hours'");
 await service();await denied(()=>audit(),'22023');
 await db.exec('reset role');
 await db.exec("insert into activity_log(user_id,activity_type,path_accessed) select 4,'SOLICITUD_RECUPERACION_USUARIO','synthetic-limit/'||n from generate_series(1,10)n");
 await actor();await denied(()=>prepare(100),'22023');
});

test('consuming a recovery grant invalidates every open link for that email and rejects replay/expiry/mismatch',async t=>{
 await reset(t);
 const email='a'.repeat(64),otherEmail='d'.repeat(64),first='b'.repeat(64),second='c'.repeat(64),expired='e'.repeat(64),otherState='f'.repeat(64);
 await db.query("insert into password_recovery_grants(email_hash,state_hash,expires_at) values($1,$2,clock_timestamp()+interval '30 minutes'),($1,$3,clock_timestamp()+interval '30 minutes'),($4,$5,clock_timestamp()+interval '30 minutes')",[email,first,second,otherEmail,otherState]);
 await db.query("insert into password_recovery_grants(email_hash,state_hash,created_at,expires_at) values($1,$2,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[otherEmail,expired]);
 await actor();await denied(()=>value('select consume_password_recovery_grant($1,$2) value',[first,email]));
 await service();
 const consume=(state,mail)=>value('select consume_password_recovery_grant($1,$2) value',[state,mail]);
 assert.equal(await consume('invalid',email),false);assert.equal(await consume(first,otherEmail),false);assert.equal(await consume(expired,otherEmail),false);
 assert.equal(await consume(first,email),true);assert.equal(await consume(first,email),false);assert.equal(await consume(second,email),false);
 assert.equal(await value('select count(*)::int value from password_recovery_grants where email_hash=$1 and consumed_at is not null',[email]),2);
 assert.equal(await value('select count(*)::int value from password_recovery_grants where email_hash=$1 and consumed_at is null',[otherEmail]),2);
});

test('RPC grants and recovery-state storage deny public clients and reserve consumption/audit for service_role',async t=>{
 await reset(t);
 const privileges=await rows(`select role_name,
  has_function_privilege(role_name,'public.security_prepare_user_password_recovery(bigint)','EXECUTE') prepare,
  has_function_privilege(role_name,'public.user_password_recovery_email_settings(text,jsonb)','EXECUTE') template,
  has_function_privilege(role_name,'public.security_audit_user_password_notification(bigint,bigint,bigint,text)','EXECUTE') audit,
  has_function_privilege(role_name,'public.consume_password_recovery_grant(text,text)','EXECUTE') consume
  from(values('anon'),('authenticated'),('service_role')) roles(role_name) order by role_name`);
 assert.deepEqual(privileges,[
  {role_name:'anon',prepare:false,template:false,audit:false,consume:false},
  {role_name:'authenticated',prepare:true,template:true,audit:false,consume:false},
  {role_name:'service_role',prepare:false,template:false,audit:true,consume:true}
 ]);
 for(const role of['anon','authenticated']){
  await db.exec('reset role');await db.exec('set role '+role);
  await denied(()=>rows('select * from password_recovery_grants'));
  await denied(()=>rows("insert into password_recovery_grants(email_hash,state_hash,expires_at) values(repeat('a',64),repeat('b',64),clock_timestamp()+interval '1 hour')"));
 }
});
