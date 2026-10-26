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
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000
});

const migrations = await Promise.all([
  '20260913110000_record_actor_audit_view.sql',
  '20261026112000_harden_user_catalog_rls.sql',
  '20261026114000_fix_user_record_audit_grants.sql'
].map(file => readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')));

async function assume(identity, sessionId) {
  await db.query('reset role');
  await db.query(
    `select set_config('request.jwt.claims',$1,true),set_config('request.headers','{}',true)`,
    [JSON.stringify({
      role: 'authenticated',
      email: identity.email,
      sub: identity.authId,
      session_id: sessionId
    })]
  );
  await db.query('set local role authenticated');
}

async function expectDenied(statement) {
  await db.query('savepoint expected_denial');
  try {
    await db.query(statement);
    assert.fail('La columna sensible fue visible para authenticated.');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error.code, '42501');
  } finally {
    await db.query('rollback to savepoint expected_denial');
    await db.query('release savepoint expected_denial');
  }
}

async function createIdentity(label, nonce) {
  const authId = crypto.randomUUID();
  const email = `audit-${label.toLowerCase()}-${nonce}@example.test`;
  await db.query(
    `insert into auth.users(id,email,raw_app_meta_data) values($1,$2,'{}'::jsonb)`,
    [authId, email]
  );
  const account = (await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values($1,'auth:'||$2,$2::uuid,$3,'Auditoría',true)
    returning user_id
  `, [email, authId, label])).rows[0];
  return { authId, email, userId: account.user_id };
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  for (const migration of migrations) await db.query(migration);

  const nonce = crypto.randomUUID();
  const administratorRole = (await db.query(`
    select role_id
    from public.roles
    where lower(btrim(role_name)) in('administrador','administrator','admin')
    order by case lower(btrim(role_name)) when 'administrador' then 0 else 1 end,role_id
    limit 1
  `)).rows[0];
  assert.ok(administratorRole, 'Se requiere el rol Administrador para esta prueba.');

  const ordinaryRole = (await db.query(`
    insert into public.roles(role_name,description,is_system_role)
    values($1,'Rol sin acceso global al catálogo de usuarios',false)
    returning role_id
  `, [`TEST-AUDIT-OWNER-${nonce}`])).rows[0];

  const administrator = await createIdentity('Administrador', nonce);
  const owner = await createIdentity('Propietario', nonce);
  const outsider = await createIdentity('Tercero', nonce);

  await db.query(`
    insert into public.user_roles(user_id,role_id)
    values($1,$2),($3,$4),($5,$4)
  `, [
    administrator.userId, administratorRole.role_id,
    owner.userId, ordinaryRole.role_id,
    outsider.userId
  ]);

  const adminSession = `audit-admin-${nonce}`;
  const ownerSession = `audit-owner-${nonce}`;
  const outsiderSession = `audit-outsider-${nonce}`;
  await db.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$2,$3),($4,$5,$6),($7,$8,$6)
  `, [
    adminSession, administrator.userId, administratorRole.role_id,
    ownerSession, owner.userId, ordinaryRole.role_id,
    outsiderSession, outsider.userId
  ]);

  const requiredColumns = [
    'created_by_name',
    'created_by_email',
    'actor_type',
    'actor_source',
    'execution_context_id',
    'updated_by_name',
    'updated_by_email',
    'updated_actor_type',
    'updated_actor_source',
    'updated_execution_context_id'
  ];
  const columnPrivileges = (await db.query(`
    select column_name,
           has_column_privilege('authenticated','public.users',column_name,'select') allowed
    from unnest($1::text[]) column_name
    order by column_name
  `, [requiredColumns])).rows;
  assert.equal(columnPrivileges.length, requiredColumns.length);
  assert.ok(columnPrivileges.every(column => column.allowed));

  const sensitivePrivileges = (await db.query(`select
    not has_column_privilege('authenticated','public.users','password_hash','select') password_hidden,
    not has_column_privilege('authenticated','public.users','auth_user_id','select') auth_identity_hidden,
    not has_column_privilege('authenticated','public.users','created_by_id','select') creator_id_hidden,
    not has_column_privilege('authenticated','public.users','updated_by_id','select') updater_id_hidden
  `)).rows[0];
  assert.ok(Object.values(sensitivePrivileges).every(Boolean));

  await assume(administrator, adminSession);
  const adminView = (await db.query(
    `select public.record_actor_audit('users',$1) data`,
    [String(owner.userId)]
  )).rows[0].data;
  assert.ok(adminView, 'El Administrador debe poder consultar la autoría de otro usuario.');
  assert.deepEqual(Object.keys(adminView).sort(), requiredColumns.sort());
  assert.equal('password_hash' in adminView, false);
  assert.equal('auth_user_id' in adminView, false);
  assert.equal('created_by_id' in adminView, false);

  await assume(owner, ownerSession);
  const ownerView = (await db.query(
    `select public.record_actor_audit('users',$1) data`,
    [String(owner.userId)]
  )).rows[0].data;
  assert.ok(ownerView, 'El usuario debe poder consultar la autoría de su propio perfil.');
  await expectDenied('select password_hash from public.users');
  await expectDenied('select auth_user_id from public.users');
  await expectDenied('select created_by_id from public.users');

  await assume(outsider, outsiderSession);
  const hiddenView = (await db.query(
    `select public.record_actor_audit('users',$1) data`,
    [String(owner.userId)]
  )).rows[0].data;
  assert.equal(hiddenView, null, 'Un usuario sin security:users:view no debe ver la autoría ajena.');

  await db.query('rollback');
  console.log(JSON.stringify({
    auditColumnsGranted: true,
    administratorCanReadUserAudit: true,
    ownerCanReadOwnAudit: true,
    unrelatedUserDenied: true,
    sensitiveColumnsHidden: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
