import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15_000
});
const migrations=await Promise.all([
  '20261027153000_user_edit_password_notification.sql',
  '20261029100000_admin_global_user_password_recovery.sql'
].map(file=>readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8')));

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");
  for(const migration of migrations)await db.query(migration);
  let savepointCounter=0;
  const expectSqlError=async(work,code)=>{
    const savepoint=`expected_error_${++savepointCounter}`;
    await db.query(`savepoint ${savepoint}`);
    try{await work();assert.fail(`Se esperaba el error SQL ${code}.`);}
    catch(error){await db.query(`rollback to savepoint ${savepoint}`);assert.equal(error?.code,code);}
    finally{await db.query(`release savepoint ${savepoint}`);}
  };

  const admin=(await db.query(`
    select account.user_id,account.auth_user_id,account.email,role.role_id,scope.subsidiary_id
    from public.users account
    join public.user_roles membership using(user_id)
    join public.roles role using(role_id)
    join public.user_subsidiaries scope using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where account.is_active and account.auth_user_id is not null and subsidiary.is_active
      and lower(role.role_name)in('administrador','administrator','admin')
    order by account.user_id,scope.subsidiary_id limit 1`)).rows[0];
  assert.ok(admin,'Se requiere un administrador activo con subsidiaria.');

  const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const target=(await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'test-only',gen_random_uuid(),'Usuario','Recuperación',true)
    returning user_id,email`,[`recovery-target-${suffix}@example.test`])).rows[0];
  await db.query('insert into public.user_subsidiaries(user_id,subsidiary_id)values($1,$2)',[target.user_id,admin.subsidiary_id]);
  const sessionId=`recovery-db-${suffix}`;
  await db.query('insert into public.user_company_sessions(session_id,user_id,subsidiary_id)values($1,$2,$3)',[sessionId,admin.user_id,admin.subsidiary_id]);
  await db.query('insert into public.user_role_sessions(session_id,user_id,role_id)values($1,$2,$3)',[sessionId,admin.user_id,admin.role_id]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin.auth_user_id,email:admin.email,session_id:sessionId,role:'authenticated'})]);

  let prepared=(await db.query('select public.security_prepare_user_password_recovery($1) value',[target.user_id])).rows[0].value;
  assert.equal(String(prepared.user_id),String(target.user_id));
  assert.equal(String(prepared.actor_user_id),String(admin.user_id));
  assert.equal(String(prepared.subsidiary_id),String(admin.subsidiary_id));
  assert.equal(prepared.email,target.email);
  assert.equal(Object.hasOwn(prepared,'auth_user_id'),false);
  assert.equal(prepared.authorization_scope,'SUBSIDIARY');

  const delivery=(await db.query("select public.user_password_recovery_email_settings('delivery','{}'::jsonb) value")).rows[0].value;
  assert.equal(delivery.template.tipo_notificacion,'USUARIO_RECUPERACION');
  assert.match(delivery.template.asunto_template,/Recupera tu acceso/);
  assert.doesNotMatch(delivery.template.cuerpo_template,/Se creó una cuenta/);

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
  await db.query(
    'select public.security_audit_user_password_notification($1,$2,$3,$4)',
    [admin.user_id,target.user_id,admin.subsidiary_id,'ENVIADO']
  );
  assert.equal((await db.query(`select count(*)::int count from public.activity_log
    where user_id=$1 and activity_type='ENVIO_RECUPERACION_USUARIO_ENVIADO'
      and path_accessed like $2`,[admin.user_id,`security/users/${target.user_id}/password-recovery%`])).rows[0].count,1);

  // El Administrador activo puede recuperar a un usuario activo que no
  // pertenece a la subsidiaria seleccionada. El alcance queda en auditoria.
  const globalTarget=(await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'test-only',gen_random_uuid(),'Usuario','Global',true)
    returning user_id,email`,[`recovery-global-${suffix}@example.test`])).rows[0];
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin.auth_user_id,email:admin.email,session_id:sessionId,role:'authenticated'})]);
  prepared=(await db.query('select public.security_prepare_user_password_recovery($1) value',[globalTarget.user_id])).rows[0].value;
  assert.equal(String(prepared.user_id),String(globalTarget.user_id));
  assert.equal(prepared.authorization_scope,'GLOBAL_ADMIN');
  assert.equal(String(prepared.subsidiary_id),String(admin.subsidiary_id));

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
  await db.query(
    'select public.security_audit_user_password_notification($1,$2,$3,$4)',
    [admin.user_id,globalTarget.user_id,admin.subsidiary_id,'ENVIADO']
  );
  const globalAudit=(await db.query(`select path_accessed from public.activity_log
    where user_id=$1 and activity_type='ENVIO_RECUPERACION_USUARIO_ENVIADO'
      and path_accessed like $2 order by "timestamp" desc limit 1`,
    [admin.user_id,`security/users/${globalTarget.user_id}/password-recovery%`])).rows[0];
  assert.match(globalAudit.path_accessed,/scope=global_admin$/);

  // El RPC de auditoria no acepta combinaciones actor/objetivo que no fueron
  // previamente autorizadas por la RPC actor-scoped.
  await expectSqlError(
    ()=>db.query('select public.security_audit_user_password_notification($1,$2,$3,$4)',[admin.user_id,globalTarget.user_id+1000000,admin.subsidiary_id,'ENVIADO']),
    '22023'
  );

  const emailHash='a'.repeat(64),firstState='b'.repeat(64),secondState='c'.repeat(64);
  await db.query(`insert into public.password_recovery_grants(email_hash,state_hash,expires_at)
    values($1,$2,clock_timestamp()+interval '30 minutes'),($1,$3,clock_timestamp()+interval '30 minutes')`,
    [emailHash,firstState,secondState]);
  assert.equal((await db.query('select public.consume_password_recovery_grant($1,$2) consumed',[firstState,emailHash])).rows[0].consumed,true);
  assert.equal((await db.query(`select count(*)::int count from public.password_recovery_grants
    where email_hash=$1 and consumed_at is not null`,[emailHash])).rows[0].count,2);
  assert.equal((await db.query('select public.consume_password_recovery_grant($1,$2) consumed',[secondState,emailHash])).rows[0].consumed,false);

  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin.auth_user_id,email:admin.email,session_id:sessionId,role:'authenticated'})]);
  await expectSqlError(
    ()=>db.query('select public.security_audit_user_password_notification($1,$2,$3,$4)',[admin.user_id,target.user_id,admin.subsidiary_id,'ENVIADO']),
    '42501'
  );

  await db.query('update public.users set is_active=false where user_id=$1',[globalTarget.user_id]);
  await expectSqlError(()=>db.query('select public.security_prepare_user_password_recovery($1)',[globalTarget.user_id]),'22023');
  await db.query('update public.users set is_active=true where user_id=$1',[globalTarget.user_id]);

  // Un rol delegado con security:users.edit puede trabajar dentro de la
  // subsidiaria, pero no hereda el alcance global del Administrador.
  const delegatedRole=(await db.query(`insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba edicion de usuarios por subsidiaria',false)returning role_id`,[`RECOVERY_SCOPED_EDIT_${suffix}`])).rows[0];
  await db.query('insert into public.user_roles(user_id,role_id)values($1,$2)',[admin.user_id,delegatedRole.role_id]);
  await db.query(`insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
    values($1,'security:users',true,false,true,false)`,[delegatedRole.role_id]);
  await db.query('update public.user_role_sessions set role_id=$1 where session_id=$2',[delegatedRole.role_id,sessionId]);
  prepared=(await db.query('select public.security_prepare_user_password_recovery($1) value',[target.user_id])).rows[0].value;
  assert.equal(prepared.authorization_scope,'SUBSIDIARY');
  await expectSqlError(()=>db.query('select public.security_prepare_user_password_recovery($1)',[globalTarget.user_id]),'22023');

  const restrictedRole=(await db.query(`insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba sin permiso de edición',false)returning role_id`,[`RECOVERY_NO_EDIT_${suffix}`])).rows[0];
  await db.query('insert into public.user_roles(user_id,role_id)values($1,$2)',[admin.user_id,restrictedRole.role_id]);
  await db.query('update public.user_role_sessions set role_id=$1 where session_id=$2',[restrictedRole.role_id,sessionId]);
  await expectSqlError(()=>db.query('select public.security_prepare_user_password_recovery($1)',[target.user_id]),'42501');

  const privileges=(await db.query(`select
    has_function_privilege('anon','public.security_prepare_user_password_recovery(bigint)','execute') anon_prepare,
    has_function_privilege('anon','public.user_password_recovery_email_settings(text,jsonb)','execute') anon_template,
    has_function_privilege('authenticated','public.security_prepare_user_password_recovery(bigint)','execute') authenticated_prepare,
    has_function_privilege('authenticated','public.security_audit_user_password_notification(bigint,bigint,bigint,text)','execute') authenticated_audit,
    has_function_privilege('service_role','public.security_audit_user_password_notification(bigint,bigint,bigint,text)','execute') service_audit,
    has_function_privilege('authenticated','public.consume_password_recovery_grant(text,text)','execute') authenticated_consume,
    has_function_privilege('service_role','public.consume_password_recovery_grant(text,text)','execute') service_consume`)).rows[0];
  assert.deepEqual(privileges,{
    anon_prepare:false,anon_template:false,authenticated_prepare:true,
    authenticated_audit:false,service_audit:true,
    authenticated_consume:false,service_consume:true
  });

  console.log(JSON.stringify({
    migration:true,rollback:true,editPermission:true,subsidiaryScope:true,globalAdministratorScope:true,
    inactiveRejected:true,authIdNotExposed:true,recoveryTemplate:true,audit:true,
    globalScopeAudited:true,auditRequiresPreparedRequest:true,
    allConcurrentLinksConsumed:true,serviceOnlyAudit:true
  }));
}finally{
  await db.query('rollback').catch(()=>undefined);
  await db.end();
}
