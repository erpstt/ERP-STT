import pg from 'pg';

const client = new pg.Client({
  host: 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.kqepssgjfbdctchpiwuu',
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }
});

try {
  await client.connect();
  await client.query(`
    alter table public.subsidiaries
      add column if not exists logo_url text,
      add column if not exists address text
  `);
  console.log('MIGRATION_OK');
} finally {
  await client.end().catch(() => undefined);
}
