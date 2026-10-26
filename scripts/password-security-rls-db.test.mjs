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
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261026100000_secure_password_sessions_rls.sql', import.meta.url),
  'utf8',
);
const nonce = crypto.randomUUID();
const ownerEmail = `rls-owner-${nonce}@example.test`;
const otherEmail = `rls-other-${nonce}@example.test`;
const ownerAuthId = crypto.randomUUID();
const otherAuthId = crypto.randomUUID();

async function assume(email, sessionId, subject = crypto.randomUUID()) {
  await db.query('reset role');
  await db.query(
    `select set_config('request.jwt.claims',$1,true)`,
    [JSON.stringify({ email, sub: subject, session_id: sessionId })],
  );
  await db.query('set local role authenticated');
}

async function expectDenied(statement, params = []) {
  await db.query('savepoint expected_denial');
  try {
    await db.query(statement, params);
    assert.fail('La operación insegura fue permitida.');
  } catch (error) {
    assert.match(String(error.code), /^(42501|P0001)$/);
  } finally {
    await db.query('rollback to savepoint expected_denial');
    await db.query('release savepoint expected_denial');
  }
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");
  // Permite ejecutar esta prueba tanto antes como después de la migración que
  // vincula estrictamente cada usuario ERP con su identidad de Supabase Auth.
  await db.query('alter table public.users add column if not exists auth_user_id uuid');
  await db.query(migration);

  const policyRows = (await db.query(`
    select tablename,policyname,cmd
    from pg_policies
    where schemaname='public'
      and tablename=any(array['sessions','password_history'])
    order by tablename,policyname
  `)).rows;
  assert.deepEqual(policyRows.map((row) => row.policyname), [
    'password_history_insert_owner',
    'password_history_select_owner',
    'sessions_delete_owner_or_admin',
    'sessions_insert_owner',
    'sessions_select_owner_or_admin',
    'sessions_update_owner',
  ]);
  const privileges = (await db.query(`select
    not has_table_privilege('anon','public.sessions','select') anon_sessions_denied,
    not has_table_privilege('anon','public.password_history','select') anon_history_denied,
    not has_table_privilege('authenticated','public.password_history','update') history_update_denied,
    not has_table_privilege('authenticated','public.password_history','delete') history_delete_denied
  `)).rows[0];
  assert.ok(Object.values(privileges).every(Boolean));

  const administrator = (await db.query(`
    select account.user_id,account.email,auth_account.id::text auth_id,role.role_id
    from public.users account
    join auth.users auth_account on lower(auth_account.email)=lower(account.email)
    join public.user_roles assignment on assignment.user_id=account.user_id
    join public.roles role on role.role_id=assignment.role_id
      and lower(role.role_name) in('administrador','administrator','admin')
    where account.is_active
    order by account.user_id
    limit 1
  `)).rows[0];
  assert.ok(administrator, 'La base debe tener un usuario Supabase con rol Administrador.');

  const users = (await db.query(`
    insert into public.users(email,password_hash,auth_user_id,first_name,last_name,is_active)
    values
      ($1,'auth:managed-by-supabase',$3,'RLS','Owner',true),
      ($2,'auth:managed-by-supabase',$4,'RLS','Other',true)
    returning user_id,email
  `, [ownerEmail, otherEmail, ownerAuthId, otherAuthId])).rows;
  const idByEmail = Object.fromEntries(users.map((row) => [row.email, row.user_id]));
  const ownerId = idByEmail[ownerEmail];
  const otherId = idByEmail[otherEmail];
  const adminId = administrator.user_id;

  await db.query(`
    insert into public.sessions(user_id,session_token,expires_at)
    values($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour'),($5,$6,now()+interval '1 hour')
  `, [ownerId, `owner-${nonce}`, otherId, `other-${nonce}`, adminId, `admin-${nonce}`]);
  await db.query(`
    insert into public.password_history(user_id,password_hash)
    values($1,$2),($3,$4),($5,$6)
  `, [ownerId, `scrypt$owner$${nonce}`, otherId, `scrypt$other$${nonce}`, adminId, `scrypt$admin$${nonce}`]);
  await db.query(`
    insert into public.user_role_sessions(session_id,user_id,role_id)
    values($1,$2,$3)
  `, [`admin-session-${nonce}`, adminId, administrator.role_id]);

  await assume(ownerEmail, `owner-session-${nonce}`, ownerAuthId);
  assert.deepEqual((await db.query('select user_id from public.sessions order by user_id')).rows, [{ user_id: ownerId }]);
  assert.deepEqual((await db.query('select user_id from public.password_history order by user_id')).rows, [{ user_id: ownerId }]);
  await expectDenied(
    'insert into public.password_history(user_id,password_hash) values($1,$2)',
    [otherId, `scrypt$forbidden$${nonce}`],
  );
  await expectDenied('update public.password_history set created_at=now() where user_id=$1', [ownerId]);
  const ownerCrossDelete = await db.query('delete from public.sessions where user_id=$1 returning session_id', [otherId]);
  assert.equal(ownerCrossDelete.rowCount, 0);

  await assume(administrator.email, `admin-session-${nonce}`, administrator.auth_id);
  const ownerSessionInsert = await db.query(
    `insert into public.sessions(user_id,session_token,expires_at)
     values($1,$2,now()+interval '1 hour') returning session_id`,
    [adminId, `admin-created-${nonce}`],
  );
  assert.equal(ownerSessionInsert.rowCount, 1);
  const ownerHistoryInsert = await db.query(
    'insert into public.password_history(user_id,password_hash) values($1,$2) returning history_id',
    [adminId, `scrypt$admin-created$${nonce}`],
  );
  assert.equal(ownerHistoryInsert.rowCount, 1);
  assert.equal((await db.query(
    'select count(*)::int count from public.sessions where session_token=any($1::text[])',
    [[`owner-${nonce}`, `other-${nonce}`, `admin-${nonce}`, `admin-created-${nonce}`]],
  )).rows[0].count, 4);
  assert.deepEqual((await db.query(
    'select distinct user_id from public.password_history where password_hash=any($1::text[])',
    [[`scrypt$owner$${nonce}`, `scrypt$other$${nonce}`, `scrypt$admin$${nonce}`]],
  )).rows, [{ user_id: adminId }]);
  await expectDenied(
    'insert into public.sessions(user_id,session_token,expires_at) values($1,$2,now()+interval \'1 hour\')',
    [otherId, `admin-forbidden-${nonce}`],
  );
  const deleted = await db.query('delete from public.sessions where user_id=$1 returning session_id', [otherId]);
  assert.equal(deleted.rowCount, 1);

  console.log(JSON.stringify({
    policies: policyRows.length,
    anonymousAccessDenied: true,
    ownerIsolation: true,
    ownerFlowsPreserved: true,
    administratorSessionRevocation: true,
    crossUserPasswordHashesHidden: true,
    passwordHistoryImmutable: true,
    rollback: true,
  }));
} finally {
  await db.query('reset role').catch(() => {});
  await db.query('rollback').catch(() => {});
  await db.end();
}
