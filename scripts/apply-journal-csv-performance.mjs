import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const password = process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD;
if (!process.env.SUPABASE_URL || !password) {
  throw Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de aplicar la migración.');
}

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='10s'; set local statement_timeout='120s'");
  await db.query(await readFile(new URL(
    '../supabase/migrations/20261026194500_optimize_journal_csv_lookups.sql',
    import.meta.url
  ), 'utf8'));

  const importer = (await db.query(
    "select pg_get_functiondef('public.import_journal_csv(jsonb,boolean,bigint)'::regprocedure) definition"
  )).rows[0]?.definition || '';
  const lookup = (await db.query(
    "select pg_get_functiondef('public.journal_csv_lookup(text,text)'::regprocedure) definition"
  )).rows[0]?.definition || '';
  const syncTrigger = (await db.query(
    "select pg_get_functiondef('public.sync_journal_gl_impacts_trigger()'::regprocedure) definition"
  )).rows[0]?.definition || '';
  const indexes = Number((await db.query(`select count(*) total
    from pg_indexes
    where schemaname='public'
      and indexname like 'journal_csv_%_name_idx'`)).rows[0].total);

  assert.ok(importer.includes('journal_csv_lookup_cache_enabled'));
  assert.ok(importer.includes('nexo.defer_journal_gl_sync'));
  assert.ok(importer.includes('sync_journal_gl_impacts'));
  assert.ok(lookup.includes("when 'Cliente'"));
  assert.ok(lookup.includes("when 'compania_relacionada'"));
  assert.ok(syncTrigger.includes('nexo.defer_journal_gl_sync'));
  assert.ok(indexes>=8);

  await db.query('commit');
  console.log(JSON.stringify({
    applied:true,
    requestScopedLookupCache:true,
    singleGlRefreshPerJournal:true,
    lookupIndexes:indexes
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
