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
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261020130000_asset_category_export_header.sql', import.meta.url),
  'utf8'
);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  await db.query(migration);
  const verification = (await db.query(`
    with target as (
      select p.oid,p.prosecdef,p.provolatile,p.proacl,p.proowner,pg_get_functiondef(p.oid) definition
      from pg_proc p
      where p.oid=to_regprocedure('public.asset_category_report(jsonb)')
    )
    select
      exists(select 1 from target) as report_rpc,
      coalesce((select prosecdef from target),false) as security_definer,
      coalesce((select provolatile='s' from target),false) as stable_function,
      coalesce((select position('active_subsidiary_id' in definition)>0 from target),false) as active_subsidiary_scope,
      coalesce((select position('''subsidiary''' in definition)>0 from target),false) as subsidiary_header,
      coalesce((select position('opening_reversed_at is null' in definition)>0 from target),false) as excludes_reversed_opening,
      has_function_privilege('authenticated','public.asset_category_report(jsonb)','EXECUTE') as authenticated_execute,
      not has_function_privilege('anon','public.asset_category_report(jsonb)','EXECUTE') as anonymous_denied,
      not exists(
        select 1 from target
        cross join lateral aclexplode(coalesce(target.proacl,acldefault('f',target.proowner))) privilege
        where privilege.grantee=0 and privilege.privilege_type='EXECUTE'
      ) as public_denied
  `)).rows[0];
  if (Object.values(verification).some(value => value !== true)) {
    throw new Error(`El reporte de categorías no superó la validación: ${JSON.stringify(verification)}`);
  }
  await db.query('commit');
  console.log(JSON.stringify({ applied: true, ...verification }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
