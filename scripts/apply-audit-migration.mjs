import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const password = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !password) throw new Error('Falta SUPABASE_URL o SUPABASE_DB_PASSWORD.');

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || `db.${projectRef}.supabase.co`,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || 'postgres',
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

try {
  await client.connect();
  const migration = process.argv[2] || '20260826160000_enable_central_auditing.sql';
  if (!/^\d{14}_[a-z0-9_-]+\.sql$/.test(migration)) throw new Error('Nombre de migración inválido.');
  const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');
  const { rows } = await client.query(`
    select count(*)::int trigger_count
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and p.proname='capture_row_audit'
  `);
  console.log(JSON.stringify({ applied: true, triggerCount: rows[0].trigger_count }));
} catch (error) {
  try { await client.query('rollback'); } catch {}
  throw error;
} finally {
  await client.end().catch(() => {});
}
