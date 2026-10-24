import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const migration = await readFile(new URL(
  '../supabase/migrations/20261023183000_assert_request_access_rpc.sql',
  import.meta.url
), 'utf8');

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'");
  await db.query(migration);
  const check = (await db.query(`select
    to_regprocedure('public.assert_request_access(text,text)') is not null rpc_exists,
    prosecdef is true security_definer,
    has_function_privilege('authenticated','public.assert_request_access(text,text)','execute') authenticated_can_execute,
    not has_function_privilege('anon','public.assert_request_access(text,text)','execute') anon_cannot_execute
    from pg_proc where oid='public.assert_request_access(text,text)'::regprocedure
  `)).rows[0];
  if (!check || Object.values(check).some(value => value !== true)) {
    throw new Error('La RPC consolidada de acceso no superó sus verificaciones.');
  }
  await db.query('commit');
  console.log(JSON.stringify({ applied: true, ...check }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
