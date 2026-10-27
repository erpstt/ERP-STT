import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: {rejectUnauthorized: false},
  connectionTimeoutMillis: 15_000
});

const migrations = await Promise.all([
  '20261026110000_secure_user_auth_invitations.sql',
  '20261026112000_harden_user_catalog_rls.sql',
  '20261027170000_bulk_user_subsidiary_assignments.sql'
].map(file => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')));

async function assume(email, subject, sessionId) {
  await db.query('reset role');
  await db.query(
    `select set_config('request.jwt.claims',$1,true),set_config('request.headers','{}',true)`,
    [JSON.stringify({role: 'authenticated', email, sub: subject, session_id: sessionId})]
  );
  await db.query('set local role authenticated');
}

async function expectDenied(statement, params = []) {
  await db.query('savepoint expected_denial');
  try {
    await db.query(statement, params);
    assert.fail('La operación insegura fue permitida.');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, '42501');
  } finally {
    await db.query('rollback to savepoint expected_denial');
    await db.query('release savepoint expected_denial');
  }
}

async function expectErrorCode(statement, params, expectedCode) {
  await db.query('savepoint expected_database_error');
  try {
    await db.query(statement, params);
    assert.fail('La operación inválida fue permitida.');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, expectedCode);
  } finally {
    await db.query('rollback to savepoint expected_database_error');
    await db.query('release savepoint expected_database_error');
  }
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  for (const migration of migrations) await db.query(migration);

  const nonce = crypto.randomUUID();
  const actor = (await db.query(`
    select account.user_id,account.email,identity.id::text auth_id
    from public.users account
    join auth.users identity on lower(identity.email)=lower(account.email)
    where account.is_active
      and account.auth_user_id=identity.id
    order by account.user_id
    limit 1
  `)).rows[0];
  assert.ok(actor, 'Se requiere un usuario ERP activo enlazado con Supabase Auth.');
  const targetEmail = `users-target-${nonce}@example.test`;
  const targetIdentity = crypto.randomUUID();
  const target = (await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'auth:'||$2,$2::uuid,'Objetivo','Prueba',true)
    returning user_id,email
  `, [targetEmail, targetIdentity])).rows[0];

  const roles = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Prueba lectura usuarios',false),($2,'Prueba edición usuarios',false),($3,'Prueba creación segura de usuarios',false)
    returning role_id,role_name
  `, [`TEST-USERS-VIEW-${nonce}`, `TEST-USERS-EDIT-${nonce}`, `TEST-USERS-CREATE-${nonce}`])).rows;
  const roleId = Object.fromEntries(roles.map(role => [role.role_name, role.role_id]));
  const viewerRole = roleId[`TEST-USERS-VIEW-${nonce}`];
  const editorRole = roleId[`TEST-USERS-EDIT-${nonce}`];
  const creatorRole = roleId[`TEST-USERS-CREATE-${nonce}`];
  const systemRole=(await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Rol de sistema protegido',true)
    returning role_id
  `,[`TEST-SYSTEM-${nonce}`])).rows[0].role_id;
  await db.query(
    `insert into public.user_roles(user_id,role_id) values($1,$2),($1,$3),($1,$4)`,
    [actor.user_id, viewerRole, editorRole, creatorRole]
  );
  await db.query(`
    insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
    values($1,'security:users',true,false,false,false),
          ($2,'security:users',true,false,true,false),
          ($3,'security:users',true,true,false,false)
  `, [viewerRole, editorRole, creatorRole]);
  await db.query(`
    insert into public.role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
    values($1,'security:roles',true,true,true,true),
          ($1,'security:user-roles',true,true,true,true),
          ($1,'security:user-subsidiaries',true,true,true,true)
  `,[creatorRole]);
  await db.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$2,$3),($4,$2,$5),($6,$2,$7)
  `, [
    `view-session-${nonce}`, actor.user_id, viewerRole,
    `edit-session-${nonce}`, editorRole,
    `create-session-${nonce}`, creatorRole
  ]);
  const provisionAuthId=crypto.randomUUID(),provisionEmail=`users-rpc-${nonce}@example.test`;
  await db.query(
    `insert into auth.users(id,email,raw_app_meta_data) values($1,$2,'{}'::jsonb)`,
    [provisionAuthId,provisionEmail]
  );
  const subsidiary=(await db.query(`
    select subsidiary_id
    from public.subsidiaries
    order by subsidiary_id
    limit 1
  `)).rows[0];
  assert.ok(subsidiary, 'Se requiere al menos una subsidiaria para probar el alcance empresarial.');

  const privileges = (await db.query(`select
    not has_table_privilege('anon','public.users','select') anon_denied,
    not has_table_privilege('authenticated','public.users','insert') direct_insert_denied,
    not has_table_privilege('authenticated','public.users','delete') direct_delete_denied,
    has_column_privilege('authenticated','public.users','email','select') safe_select_allowed,
    has_column_privilege('authenticated','public.users','first_name','update') safe_update_allowed,
    not has_column_privilege('authenticated','public.users','password_hash','select') password_hidden,
    not has_column_privilege('authenticated','public.users','password_hash','update') password_immutable,
    not has_column_privilege('authenticated','public.users','auth_user_id','select') auth_identity_hidden,
    not has_column_privilege('authenticated','public.users','auth_user_id','update') auth_identity_immutable,
    not has_table_privilege('authenticated','public.user_subsidiaries','insert') subsidiary_direct_insert_denied,
    not has_table_privilege('authenticated','public.user_subsidiaries','update') subsidiary_direct_update_denied,
    not has_table_privilege('authenticated','public.user_subsidiaries','delete') subsidiary_direct_delete_denied
  `)).rows[0];
  assert.ok(Object.values(privileges).every(Boolean));
  assert.equal((await db.query(`
    select convalidated
    from pg_constraint
    where conrelid='public.users'::regclass
      and conname='users_email_canonical_check'
  `)).rows[0]?.convalidated, true);

  await assume(actor.email, actor.auth_id, `self-session-${nonce}`);
  assert.deepEqual(
    (await db.query('select email from public.users order by user_id')).rows,
    [{email: actor.email}]
  );
  await expectDenied('select password_hash from public.users');
  await expectDenied('select auth_user_id from public.users');
  await expectDenied(`insert into public.users(email,password_hash,first_name,last_name) values($1,'x','X','X')`, [`blocked-${nonce}@example.test`]);
  await expectDenied('delete from public.users where user_id=$1', [target.user_id]);
  assert.equal((await db.query(
    `update public.users set first_name='Bloqueado' where user_id=$1 returning user_id`,
    [target.user_id]
  )).rowCount, 0);

  await assume(actor.email, actor.auth_id, `view-session-${nonce}`);
  assert.equal((await db.query(
    'select user_id from public.users where email=any($1::text[])',
    [[actor.email, targetEmail]]
  )).rowCount, 2);
  assert.equal((await db.query(
    `update public.users set first_name='Bloqueado' where user_id=$1 returning user_id`,
    [target.user_id]
  )).rowCount, 0);
  await expectDenied(
    'select public.security_create_user($1,$2,$3,$4,$5,$6)',
    [provisionEmail,provisionAuthId,'RPC','Denegado',null,true]
  );

  await assume(actor.email, actor.auth_id, `edit-session-${nonce}`);
  assert.equal((await db.query(
    `update public.users set first_name='Actualizado' where user_id=$1 returning user_id,first_name`,
    [target.user_id]
  )).rows[0].first_name, 'Actualizado');
  await expectDenied('update public.users set email=$1 where user_id=$2', [
    `forbidden-${nonce}@example.test`, target.user_id
  ]);
  await expectDenied('update public.users set auth_user_id=$1 where user_id=$2', [
    crypto.randomUUID(), target.user_id
  ]);

  await assume(actor.email, actor.auth_id, `create-session-${nonce}`);
  const provisioned=(await db.query(
    'select public.security_create_user($1,$2,$3,$4,$5,$6) value',
    [provisionEmail,provisionAuthId,'RPC','Autorizado',null,true]
  )).rows[0].value;
  assert.equal(provisioned.email,provisionEmail);
  assert.equal(provisioned.first_name,'RPC');
  assert.equal('password_hash' in provisioned,false);
  assert.equal('auth_user_id' in provisioned,false);
  assert.equal((await db.query(
    'select public.security_mark_user_invitation_sent($1) value',
    [provisioned.user_id]
  )).rows[0].value,true);

  // Un gestor delegado puede administrar terceros, pero no elevar sus propios
  // privilegios, asignar roles de sistema ni ampliar su propio alcance.
  const delegatedRole=(await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Rol ordinario creado por gestor delegado',false)
    returning role_id
  `,[`TEST-DELEGATED-${nonce}`])).rows[0];
  assert.ok(delegatedRole?.role_id);
  await expectDenied(
    'update public.roles set role_name=$1 where role_id=$2 returning role_id',
    [' ADMIN ',viewerRole]
  );
  assert.equal((await db.query(
    `update public.roles set description='Bloqueado' where role_id=$1 returning role_id`,
    [systemRole]
  )).rowCount,0);
  await expectDenied(
    'insert into public.user_roles(user_id,role_id) values($1,$2)',
    [actor.user_id,delegatedRole.role_id]
  );
  await expectDenied(
    'insert into public.user_roles(user_id,role_id) values($1,$2)',
    [target.user_id,systemRole]
  );
  assert.equal((await db.query(
    'insert into public.user_roles(user_id,role_id) values($1,$2) returning id',
    [target.user_id,delegatedRole.role_id]
  )).rowCount,1);

  await db.query('reset role');
  await db.query(
    'delete from public.user_subsidiaries where user_id=$1 and subsidiary_id=$2',
    [actor.user_id,subsidiary.subsidiary_id]
  );
  await assume(actor.email,actor.auth_id,`create-session-${nonce}`);
  await expectDenied(
    'insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2)',
    [actor.user_id,subsidiary.subsidiary_id]
  );
  await expectDenied(
    'insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2)',
    [target.user_id,subsidiary.subsidiary_id]
  );
  const delegatedAssignment=(await db.query(
    'select public.security_sync_user_subsidiaries($1,$2::bigint[]) value',
    [target.user_id,[subsidiary.subsidiary_id]]
  )).rows[0].value;
  assert.deepEqual(delegatedAssignment.subsidiary_ids.map(Number),[Number(subsidiary.subsidiary_id)]);

  // Las selecciones antiguas dejan de conceder acceso al retirar la asignacion.
  await db.query('reset role');
  await db.query(
    'insert into public.user_subsidiaries(user_id,subsidiary_id) values($1,$2)',
    [actor.user_id,subsidiary.subsidiary_id]
  );
  await db.query(`
    insert into public.user_company_sessions(session_id,user_id,subsidiary_id)
    values($1,$2,$3)
  `,[`company-session-${nonce}`,actor.user_id,subsidiary.subsidiary_id]);
  await assume(actor.email,actor.auth_id,`company-session-${nonce}`);
  assert.equal(
    Number((await db.query('select public.active_subsidiary_id() value')).rows[0].value),
    Number(subsidiary.subsidiary_id)
  );
  await db.query('reset role');
  await db.query(
    'delete from public.user_subsidiaries where user_id=$1 and subsidiary_id=$2',
    [actor.user_id,subsidiary.subsidiary_id]
  );
  await assume(actor.email,actor.auth_id,`company-session-${nonce}`);
  assert.equal((await db.query('select public.active_subsidiary_id() value')).rows[0].value,null);

  await db.query('reset role');
  await db.query(
    'delete from public.user_roles where user_id=$1 and role_id=$2',
    [actor.user_id,creatorRole]
  );
  await assume(actor.email,actor.auth_id,`create-session-${nonce}`);
  assert.equal((await db.query('select public.app_active_role_id() value')).rows[0].value,null);
  assert.equal((await db.query('select public.app_is_admin() value')).rows[0].value,false);

  await db.query('reset role');
  const provisionedInternal=(await db.query(
    'select auth_user_id,password_hash,invitation_sent_at from public.users where user_id=$1',
    [provisioned.user_id]
  )).rows[0];
  assert.equal(provisionedInternal.auth_user_id,provisionAuthId);
  assert.equal(provisionedInternal.password_hash,`auth:${provisionAuthId}`);
  assert.ok(provisionedInternal.invitation_sent_at);
  assert.equal((await db.query(`
    select user_id from public.audit_log
    where entity_type='users'and entity_id=$1
    order by log_id desc limit 1
  `,[provisioned.user_id])).rows[0]?.user_id,actor.user_id);

  await db.query('reset role');
  await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({role: 'service_role'})]);
  await db.query('set local role service_role');
  const serviceEmail = `users-service-${nonce}@example.test`;
  assert.equal((await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,$2,$3,'Servicio','Confianza',true)
    returning user_id
  `, [serviceEmail, `auth:${crypto.randomUUID()}`, crypto.randomUUID()])).rowCount, 1);
  await expectErrorCode(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,$2,$3,'Correo','No canónico',true)
  `, [` Upper-${nonce}@example.test `, `auth:${crypto.randomUUID()}`, crypto.randomUUID()], '23514');

  console.log(JSON.stringify({
    columnSecretsHidden: true,
    directCreateDeleteDenied: true,
    selfReadPreserved: true,
    matrixViewPreserved: true,
    matrixEditPreserved: true,
    actorAuthorizedProvisioning: true,
    databasePermissionRechecked: true,
    humanAuditPreserved: true,
    roleEscalationBlocked: true,
    subsidiaryEscalationBlocked: true,
    delegatedAdministrationPreserved: true,
    staleSelectionsInvalidated: true,
    serviceProvisioningPreserved: true,
    canonicalEmailEnforced: true,
    rollback: true
  }));
} finally {
  await db.query('reset role').catch(() => {});
  await db.query('rollback').catch(() => {});
  await db.end();
}
