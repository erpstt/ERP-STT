import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000
});
const migration = await readFile(
  new URL('../supabase/migrations/20261026102000_password_recovery_grants.sql', import.meta.url),
  'utf8'
);
const stateHash = 'a'.repeat(64);
const emailHash = 'b'.repeat(64);

await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='5s'; set local statement_timeout='60s'");
  await client.query(migration);
  const privileges = (await client.query(`
    select
      has_table_privilege('anon','public.password_recovery_grants','select') anon_select,
      has_table_privilege('authenticated','public.password_recovery_grants','select') authenticated_select,
      has_table_privilege('service_role','public.password_recovery_grants','select,insert,update,delete') service_access
  `)).rows[0];
  assert.equal(privileges.anon_select, false);
  assert.equal(privileges.authenticated_select, false);
  assert.equal(privileges.service_access, true);

  await client.query(
    `insert into public.password_recovery_grants(state_hash,email_hash,expires_at)
     values($1,$2,now()+interval '30 minutes')`,
    [stateHash, emailHash]
  );
  await client.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: 'service_role' })]);
  await client.query('set local role service_role');
  assert.equal((await client.query(
    'select count(*)::int count from public.password_recovery_grants where state_hash=$1',
    [stateHash]
  )).rows[0].count, 1);
  assert.equal((await client.query(
    'select public.consume_password_recovery_grant($1,$2) consumed',
    [stateHash, emailHash]
  )).rows[0].consumed, true);
  assert.equal((await client.query(
    'select public.consume_password_recovery_grant($1,$2) consumed',
    [stateHash, emailHash]
  )).rows[0].consumed, false);
  await client.query('reset role');

  console.log(JSON.stringify({
    migration: true,
    anonymousAccessDenied: true,
    authenticatedAccessDenied: true,
    serviceOnly: true,
    serviceDirectAccess: true,
    oneTimeConsumption: true,
    rollback: true
  }));
} finally {
  await client.query('reset role').catch(() => {});
  await client.query('rollback').catch(() => {});
  await client.end();
}

