import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');
if (!apply && !verifyOnly) {
  throw new Error('Use --verify para revisar la instalación o --apply para instalar la migración del Auxiliar de Bancos.');
}

if (!process.env.SUPABASE_URL) throw new Error('Falta SUPABASE_URL en el entorno.');
if (!process.env.SUPABASE_DB_PASSWORD && !process.env.PGPASSWORD) {
  throw new Error('Falta SUPABASE_DB_PASSWORD o PGPASSWORD en el entorno.');
}

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
  new URL('../supabase/migrations/20261021100000_opening_bank_auxiliary.sql', import.meta.url),
  'utf8',
);
const zeroBalanceMigration = await readFile(
  new URL('../supabase/migrations/20261021110000_opening_bank_zero_balance.sql', import.meta.url),
  'utf8',
);

const verificationSql = `
  with checks as (
    select * from (values
      ('opening_bank_accounts',to_regclass('public.opening_bank_accounts') is not null),
      ('opening_bank_items',to_regclass('public.opening_bank_items') is not null),
      ('opening_bank_gl_links',to_regclass('public.opening_bank_gl_links') is not null),
      ('bank_transaction.opening_bank_item_id',exists(
        select 1 from information_schema.columns where table_schema='public' and table_name='bank_transaction' and column_name='opening_bank_item_id'
      )),
      ('bank_transaction.is_opening_balance',exists(
        select 1 from information_schema.columns where table_schema='public' and table_name='bank_transaction' and column_name='is_opening_balance'
      )),
      ('opening_bank_stage',to_regprocedure('public.opening_bank_stage(bigint,jsonb)') is not null),
      ('zero cleared bank balance',position('ambos cero' in coalesce(pg_get_functiondef(to_regprocedure('public.opening_bank_stage(bigint,jsonb)')),''))>0),
      ('zero-net account without GL line',position('no existe saldo en el Libro Mayor' in coalesce(pg_get_functiondef(to_regprocedure('public.opening_bank_stage(bigint,jsonb)')),''))=0),
      ('zero balance table constraint',exists(
        select 1 from pg_constraint where conrelid='public.opening_bank_items'::regclass and contype='c'
         and conname='opening_bank_items_amount_sign_check'
      )),
      ('opening_balance_options wrapper',position('bankAccounts' in coalesce(pg_get_functiondef(to_regprocedure('public.opening_balance_options()')),''))>0),
      ('opening_balance_preview wrapper',position('bankReconciliation' in coalesce(pg_get_functiondef(to_regprocedure('public.opening_balance_preview(bigint)')),''))>0),
      ('opening_balance_post wrapper',position('bankItemsCreated' in coalesce(pg_get_functiondef(to_regprocedure('public.opening_balance_post(bigint)')),''))>0),
      ('quadratic opening classification',position('is_opening_balance' in coalesce(pg_get_functiondef(to_regprocedure('public.quadratic_book_values(bigint,integer,integer)')),''))>0),
      ('classic saldo exclusion',position('SALDO_INICIAL' in coalesce(pg_get_functiondef(to_regprocedure('public.run_bank_reconciliation_report(jsonb)')),''))>0),
      ('opening transaction protection',exists(
        select 1 from pg_trigger where tgrelid='public.bank_transaction'::regclass and tgname='protect_opening_bank_transaction_trigger' and not tgisinternal
      )),
      ('classic match protection',exists(
        select 1 from pg_trigger where tgrelid='public.bank_reconciliation_match'::regclass and tgname='prevent_opening_balance_match_trigger' and not tgisinternal
      )),
      ('quadratic match protection',exists(
        select 1 from pg_trigger where tgrelid='public.quadratic_reconciliation_matches'::regclass and tgname='prevent_opening_balance_quadratic_match_trigger' and not tgisinternal
      )),
      ('RLS opening accounts',(select relrowsecurity from pg_class where oid='public.opening_bank_accounts'::regclass)),
      ('authenticated can select',has_table_privilege('authenticated','public.opening_bank_items','SELECT')),
      ('authenticated cannot insert',not has_table_privilege('authenticated','public.opening_bank_items','INSERT')),
      ('authenticated can call public RPC',has_function_privilege('authenticated','public.opening_balance_validate(jsonb)','EXECUTE')),
      ('authenticated cannot call stage',not has_function_privilege('authenticated','public.opening_bank_stage(bigint,jsonb)','EXECUTE')),
      ('anon cannot call public RPC',not has_function_privilege('anon','public.opening_balance_validate(jsonb)','EXECUTE'))
    ) as result(name,ok)
  )
  select name,ok from checks order by name
`;

async function verify() {
  const result = await db.query(verificationSql);
  const failed = result.rows.filter((row) => !row.ok);
  if (failed.length) {
    throw new Error(`Verificación incompleta: ${failed.map((row) => row.name).join(', ')}.`);
  }
  return result.rows.length;
}

await db.connect();
try {
  if (apply) {
    await db.query('begin');
    await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
    const installed = await db.query(`
      select to_regclass('public.opening_bank_accounts') is not null
        and to_regprocedure('public.opening_bank_stage(bigint,jsonb)') is not null as installed
    `);
    if (!installed.rows[0].installed) await db.query(migration);
    await db.query(zeroBalanceMigration);
    const count = await verify();
    await db.query('commit');
    console.log(`Auxiliar de Bancos instalado y verificado (${count} controles).`);
  } else {
    const count = await verify();
    console.log(`Auxiliar de Bancos verificado (${count} controles).`);
  }
} catch (error) {
  if (apply) await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
