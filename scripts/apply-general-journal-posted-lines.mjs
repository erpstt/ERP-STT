import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261002110000_fix_general_journal_posted_lines.sql', import.meta.url),
  'utf8',
);

await db.connect();
try {
  await db.query('begin');
  await db.query(migration);
  await db.query('commit');
  console.log('Libro Diario activado con líneas contabilizadas del Mayor.');
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  await db.end();
}
