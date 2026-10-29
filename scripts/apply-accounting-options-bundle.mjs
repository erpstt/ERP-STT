import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (process.loadEnvFile) process.loadEnvFile('.env');

const apply = process.argv.includes('--apply');
const url = process.env.SUPABASE_URL;
const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!url || !password) {
  throw new Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de continuar.');
}

const reference = new URL(url).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${reference}`,
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261029210000_accounting_report_options_bundle.sql', import.meta.url),
  'utf8',
);

await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='5s'");
  await client.query(migration);

  const verification = await client.query(`
    select
      p.oid::regprocedure::text signature,
      pg_get_function_result(p.oid) result_type,
      p.prosecdef security_definer,
      p.provolatile = 's' is_stable,
      coalesce(array_to_string(p.proconfig, ','), '') settings,
      has_function_privilege('authenticated', p.oid, 'execute') authenticated_execute,
      has_function_privilege('anon', p.oid, 'execute') anon_execute,
      exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      ) public_execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'accounting_report_options_bundle'
      and p.pronargs = 0
  `);
  const row = verification.rows[0];
  const secureSearchPath = /(?:^|,)search_path=public,\s*pg_temp(?:,|$)/i.test(row?.settings || '');
  if (
    verification.rowCount !== 1
    || !row.security_definer
    || !row.is_stable
    || row.result_type !== 'jsonb'
    || !secureSearchPath
    || !row.authenticated_execute
    || row.anon_execute
    || row.public_execute
  ) {
    throw new Error('La función consolidada no superó la verificación de contrato y privilegios.');
  }

  if (apply) await client.query('commit');
  else await client.query('rollback');
  console.log(JSON.stringify({
    success: true,
    mode: apply ? 'applied' : 'check-only',
    signature: row.signature,
    resultType: row.result_type,
    authenticatedExecute: row.authenticated_execute,
    anonymousExecute: row.anon_execute,
    publicExecute: row.public_execute,
  }));
} catch (cause) {
  await client.query('rollback').catch(() => undefined);
  throw cause;
} finally {
  await client.end();
}
