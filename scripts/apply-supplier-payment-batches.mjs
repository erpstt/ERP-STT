import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const migration = await readFile(new URL('../supabase/migrations/20261003120000_supplier_payment_batches.sql', import.meta.url), 'utf8');
await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='10s';set local statement_timeout='180s'");
  await db.query(migration);
  await db.query('commit');
  console.log(JSON.stringify({ applied: true, module: 'supplier-payment-batches' }));
} catch (error) {
  await db.query('rollback').catch(() => undefined);
  throw error;
} finally {
  await db.end();
}

