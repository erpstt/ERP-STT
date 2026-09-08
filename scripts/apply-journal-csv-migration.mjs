import pg from 'pg';
import { readFile } from 'node:fs/promises';
process.loadEnvFile?.('.env');
const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!process.env.SUPABASE_URL || !password) throw Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de aplicar la migración.');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({ host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com', port: Number(process.env.SUPABASE_DB_PORT || 6543), database:'postgres', user: process.env.SUPABASE_DB_USER || `postgres.${ref}`, password, ssl:{rejectUnauthorized:false}, connectionTimeoutMillis:15000 });
await client.connect();
try {
  await client.query('begin');
  await client.query(await readFile(new URL('../supabase/migrations/20260908120000_import_journal_csv.sql',import.meta.url),'utf8'));
  await client.query(await readFile(new URL('../supabase/migrations/20260908130000_journal_csv_dimensions.sql',import.meta.url),'utf8'));
  await client.query('commit');
  console.log('Migración de importación CSV aplicada correctamente.');
} catch (error) { await client.query('rollback'); throw error; }
finally { await client.end(); }
