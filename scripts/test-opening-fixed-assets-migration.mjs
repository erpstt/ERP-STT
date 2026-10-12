import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261012150000_opening_fixed_asset_auxiliary.sql', import.meta.url),
  'utf8',
);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  await db.query(migration);

  const expectedFunctions = [
    'opening_balance_assert_access',
    'validate_opening_asset_link',
    'validate_opening_depreciation_link',
    'protect_opening_fixed_asset_values',
    'protect_opening_asset_depreciation',
    'opening_fixed_asset_stage',
    'opening_fixed_asset_reconciliation',
    'opening_fixed_asset_create',
    'opening_balance_validate',
    'opening_balance_preview',
    'opening_balance_post',
    'opening_balance_reverse',
    'protect_opening_journal_mutation',
    'fixed_asset_period_depreciation',
  ];
  const functions = (await db.query(`
    select distinct proname
    from pg_proc
    where pronamespace='public'::regnamespace and proname=any($1::text[])
  `, [expectedFunctions])).rows.map((row) => row.proname);
  assert.deepEqual(functions.sort(), expectedFunctions.sort());

  const columns = (await db.query(`
    select table_name,column_name
    from information_schema.columns
    where table_schema='public' and(
      (table_name='asset' and column_name in('opening_run_id','is_opening_balance'))or
      (table_name='asset_depreciation' and column_name in('opening_run_id','is_opening_balance','depreciated_months'))
    )
  `)).rows;
  assert.equal(columns.length, 5, 'Faltan columnas de trazabilidad o meses históricos.');

  const stagingSnapshotColumns = (await db.query(`
    select column_name
    from information_schema.columns
    where table_schema='public' and table_name='opening_fixed_asset_lines'
      and column_name=any($1::text[])
  `, [[
    'category_asset_account_id',
    'category_depreciation_account_id',
    'category_expense_account_id',
    'category_useful_life_months',
    'category_depreciation_method',
    'category_residual_value_percentage',
  ]])).rows.map((row) => row.column_name);
  assert.deepEqual(stagingSnapshotColumns.sort(), [
    'category_asset_account_id',
    'category_depreciation_account_id',
    'category_expense_account_id',
    'category_useful_life_months',
    'category_depreciation_method',
    'category_residual_value_percentage',
  ].sort(), 'La etapa debe congelar la configuración contable y de depreciación de la categoría.');

  const openingConsistencyConstraints = (await db.query(`
    select conname,pg_get_constraintdef(oid) definition
    from pg_constraint
    where conname in('asset_opening_balance_consistency','asset_depreciation_opening_consistency')
      and conrelid in('asset'::regclass,'asset_depreciation'::regclass)
  `)).rows;
  assert.equal(openingConsistencyConstraints.length, 2);
  for (const constraint of openingConsistencyConstraints) {
    assert.match(constraint.definition, /is_opening_balance\s*=\s*\(opening_run_id IS NOT NULL\)/i);
  }

  const openingTriggers = (await db.query(`
    select t.tgname,c.relname table_name,pg_get_triggerdef(t.oid) definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where not t.tgisinternal and t.tgname in(
      'validate_opening_asset_link_trigger',
      'validate_opening_depreciation_link_trigger',
      'a_protect_opening_journal_record',
      'a_protect_opening_journal_lines',
      'a_protect_opening_gl_impacts',
      'a_protect_opening_transactions'
    )
  `)).rows;
  assert.equal(openingTriggers.length, 6);
  assert.equal(openingTriggers.find((row) => row.tgname === 'validate_opening_asset_link_trigger')?.table_name, 'asset');
  assert.equal(openingTriggers.find((row) => row.tgname === 'validate_opening_depreciation_link_trigger')?.table_name, 'asset_depreciation');
  assert.equal(openingTriggers.find((row) => row.tgname === 'a_protect_opening_journal_record')?.table_name, 'journal');
  assert.equal(openingTriggers.find((row) => row.tgname === 'a_protect_opening_journal_lines')?.table_name, 'journal_line');
  assert.equal(openingTriggers.find((row) => row.tgname === 'a_protect_opening_gl_impacts')?.table_name, 'gl_impact');
  const transactionProtection = openingTriggers.find((row) => row.tgname === 'a_protect_opening_transactions');
  assert.equal(transactionProtection?.table_name, 'transaction');
  assert.match(transactionProtection?.definition || '', /BEFORE (?:UPDATE OR DELETE|DELETE OR UPDATE)/i);

  const openingSubledgerProtection = (await db.query(`
    select t.tgname,c.relname table_name,pg_get_functiondef(t.tgfoid) function_definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where not t.tgisinternal and c.relname in('asset','asset_depreciation')
      and pg_get_functiondef(t.tgfoid) ilike '%app.opening_balance_internal%'
  `)).rows;
  assert.deepEqual(
    [...new Set(openingSubledgerProtection.map((row) => row.table_name))].sort(),
    ['asset', 'asset_depreciation'],
    'Las fichas y su depreciación histórica deben estar protegidas contra edición o eliminación externa.',
  );
  assert.ok(openingSubledgerProtection.every((row) => /apertura|saldo inicial/i.test(row.function_definition)));

  const depreciationIndexes = (await db.query(`
    select c.relname index_name,i.indisunique,
      pg_get_indexdef(i.indexrelid) definition,
      pg_get_expr(i.indpred,i.indrelid) predicate
    from pg_index i join pg_class c on c.oid=i.indexrelid
    where i.indrelid='asset_depreciation'::regclass
      and c.relname in('asset_depreciation_regular_period_idx','asset_depreciation_opening_asset_idx')
  `)).rows;
  assert.equal(depreciationIndexes.length, 2);
  const regularIndex = depreciationIndexes.find((row) => row.index_name === 'asset_depreciation_regular_period_idx');
  const openingIndex = depreciationIndexes.find((row) => row.index_name === 'asset_depreciation_opening_asset_idx');
  assert.equal(regularIndex.indisunique, true);
  assert.match(regularIndex.definition, /\(asset_id, fiscal_period_id\)/i);
  assert.match(regularIndex.predicate, /NOT is_opening_balance/i);
  assert.equal(openingIndex.indisunique, true);
  assert.match(openingIndex.definition, /\(asset_id, opening_run_id\)/i);
  assert.match(openingIndex.predicate, /is_opening_balance/i);
  assert.match(openingIndex.predicate, /opening_run_id IS NOT NULL/i);

  const legacyDepreciationConstraint = Number((await db.query(`
    select count(*) n
    from pg_constraint
    where conrelid='asset_depreciation'::regclass and contype='u'
      and pg_get_constraintdef(oid)like'UNIQUE (asset_id, fiscal_period_id)%'
  `)).rows[0].n);
  assert.equal(
    legacyDepreciationConstraint,
    0,
    'La restricción histórica impediría registrar depreciación normal en el mismo período de la apertura.',
  );

  const openingRunIndex = (await db.query(`
    select i.indisunique,pg_get_expr(i.indpred,i.indrelid) predicate
    from pg_index i join pg_class c on c.oid=i.indexrelid
    where i.indrelid='opening_balance_runs'::regclass and c.relname='one_active_opening_per_subsidiary'
  `)).rows[0];
  assert.equal(openingRunIndex?.indisunique, true);
  assert.match(openingRunIndex.predicate, /status.*REVERSED/i);

  const definitions = Object.fromEntries((await db.query(`
    select p.proname,pg_get_functiondef(p.oid) definition
    from pg_proc p
    where p.pronamespace='public'::regnamespace
      and p.proname=any($1::text[])
  `, [[
    'opening_fixed_asset_reconciliation',
    'opening_balance_validate',
    'opening_balance_preview',
    'opening_balance_post',
    'opening_balance_reverse',
    'opening_fixed_asset_create',
    'protect_opening_journal_mutation',
    'fixed_asset_period_depreciation',
    'fixed_asset_depreciation_preview',
    'run_fixed_asset_depreciation',
  ]])).rows.map((row) => [row.proname, row.definition]));

  assert.match(definitions.opening_fixed_asset_reconciliation, /'existing'/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /'staged'/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /x\.existing\s*\+\s*x\.staged/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /purchase_cost\s*\*\s*a\.exchange_rate/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /depreciation_amount\s*\*\s*a\.exchange_rate/i);
  assert.match(
    definitions.opening_fixed_asset_reconciliation,
    /status\s*=\s*'POSTED'/i,
    'Un lote contabilizado debe distinguirse para leer su asiento vigente.',
  );
  assert.match(
    definitions.opening_fixed_asset_reconciliation,
    /\b(?:journal_line|gl_impact)\b/i,
    'La conciliación de un lote POSTED debe usar el asiento o GL vigente.',
  );
  assert.match(definitions.opening_fixed_asset_reconciliation, /accounting_books/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /is_primary/i);
  assert.match(definitions.opening_fixed_asset_reconciliation, /is_active/i);
  assert.match(definitions.opening_balance_validate, /opening_balance_assert_access\('create'/i);
  assert.match(definitions.opening_balance_validate, /expectedSubsidiaryId/i);
  assert.match(definitions.opening_balance_validate, /empresa activa cambi[oó]|recargue la pantalla/i);
  assert.match(definitions.opening_balance_preview, /opening_balance_assert_access\('view'/i);
  assert.match(definitions.opening_balance_post, /opening_balance_assert_access\('create'/i);
  assert.match(definitions.opening_balance_post, /run_row\.status\s*<>\s*'VALIDATED'/i);
  assert.match(definitions.opening_balance_post, /journal_number_value\s*:=\s*journal_number_value\s*\|\|\s*'-'\s*\|\|\s*run_row\.id/i);
  assert.match(definitions.opening_balance_reverse, /run_row\.opening_date\s+between\s+start_date\s+and\s+end_date/i);
  assert.match(definitions.opening_balance_reverse, /select\s+reversal_number,run_row\.opening_date/i);
  assert.match(definitions.opening_balance_reverse, /contable original.*cerrado/i);
  assert.match(definitions.opening_balance_reverse, /historical_exchange_rate\s*,\s*original_currency_id\s*,\s*opening_balance_line_id/i);
  assert.match(definitions.opening_balance_post, /insert\s+into\s+gl_impact/i);
  assert.match(definitions.opening_balance_post, /l\.debit_fx\s*,\s*l\.credit_fx/i);
  assert.match(definitions.opening_fixed_asset_create, /category_asset_account_id/i);
  assert.match(definitions.opening_fixed_asset_create, /category_depreciation_account_id/i);
  assert.match(definitions.opening_fixed_asset_create, /category_expense_account_id/i);
  assert.match(definitions.opening_fixed_asset_create, /category_useful_life_months/i);
  assert.match(definitions.opening_fixed_asset_create, /category_depreciation_method/i);
  assert.match(definitions.opening_fixed_asset_create, /category_residual_value_percentage/i);
  assert.match(definitions.opening_fixed_asset_create, /asset_number\s*=\s*created_number/i);
  assert.match(definitions.protect_opening_journal_mutation, /opening_balance_internal/i);
  assert.match(definitions.protect_opening_journal_mutation, /Los asientos de apertura solo pueden modificarse o reversarse/i);
  assert.match(definitions.fixed_asset_period_depreciation, /Suma de los D[ií]gitos de los A[nñ]os/i);
  assert.match(definitions.fixed_asset_period_depreciation, /remaining\s*\/\s*greatest\(p_life_months\s*-\s*coalesce\(p_consumed_months/i);
  assert.match(definitions.fixed_asset_depreciation_preview, /not\s+x\.is_opening_balance/i);
  assert.match(definitions.fixed_asset_depreciation_preview, /p_date\s*>/i);
  assert.match(definitions.fixed_asset_depreciation_preview, /fixed_asset_period_depreciation/i);
  assert.match(definitions.run_fixed_asset_depreciation, /and\s+not\s+is_opening_balance/i);
  assert.match(definitions.run_fixed_asset_depreciation, /fixed_asset_period_depreciation/i);

  const privileges = (await db.query(`
    select
      has_function_privilege('authenticated','opening_balance_preview(bigint)','execute') authenticated_preview,
      has_function_privilege('authenticated','opening_balance_post(bigint)','execute') authenticated_post,
      has_function_privilege('anon','opening_balance_post(bigint)','execute') anon_post,
      has_function_privilege('authenticated','opening_fixed_asset_create(bigint,bigint)','execute') internal_create,
      has_function_privilege('authenticated','fixed_asset_period_depreciation(numeric,numeric,integer,text,integer,numeric)','execute') internal_depreciation,
      has_function_privilege('authenticated','protect_opening_journal_mutation()','execute') internal_protection,
      has_function_privilege('authenticated','protect_opening_fixed_asset_values()','execute') internal_asset_protection,
      has_function_privilege('authenticated','protect_opening_asset_depreciation()','execute') internal_history_protection
  `)).rows[0];
  assert.equal(privileges.authenticated_preview, true);
  assert.equal(privileges.authenticated_post, true);
  assert.equal(privileges.anon_post, false);
  assert.equal(privileges.internal_create, false);
  assert.equal(privileges.internal_depreciation, false);
  assert.equal(privileges.internal_protection, false);
  assert.equal(privileges.internal_asset_protection, false);
  assert.equal(privileges.internal_history_protection, false);

  console.log(
    'OK: migración compila; snapshots, invariantes, protección de apertura, conciliación local, depreciación y permisos quedan estructuralmente cubiertos; rollback aplicado.',
  );
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
