import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (process.loadEnvFile) process.loadEnvFile('.env');

const apply = process.argv.includes('--apply');
const url = process.env.SUPABASE_URL;
const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!url || !password) throw new Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de continuar.');

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

const migration = await readFile(new URL('../supabase/migrations/20261029200000_auth_bootstrap_context.sql', import.meta.url), 'utf8');
await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='5s'");
  await client.query(migration);
  const verification = await client.query(`
    select p.oid::regprocedure::text signature,
           p.prosecdef security_definer,
           has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
           has_function_privilege('anon',p.oid,'execute') anon_execute
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='auth_bootstrap_context'
  `);
  const row = verification.rows[0];
  if (!row || !row.security_definer || !row.authenticated_execute || row.anon_execute) {
    throw new Error('La función bootstrap no superó la verificación de privilegios.');
  }
  if (apply) await client.query('commit');
  else await client.query('rollback');
  console.log(JSON.stringify({ success: true, mode: apply ? 'applied' : 'check-only', signature: row.signature }));
} catch (cause) {
  await client.query('rollback').catch(() => undefined);
  throw cause;
} finally {
  await client.end();
}
