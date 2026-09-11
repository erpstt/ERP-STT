import fs from 'node:fs';
import pg from 'pg';

process.loadEnvFile('.env');
const file = process.argv[2];
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
try {
  await client.query('begin');
  await client.query("set local lock_timeout='15s'; set local statement_timeout='120s'");
  await client.query(fs.readFileSync(file, 'utf8'));
  console.log('VALIDACIÓN SQL CORRECTA; todos los cambios serán revertidos.');
} finally {
  await client.query('rollback').catch(() => {});
  await client.end();
}
