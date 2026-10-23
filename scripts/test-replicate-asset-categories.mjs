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
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const migration = await readFile(
  new URL('../supabase/migrations/20261022140000_replicate_asset_categories_all_subsidiaries.sql', import.meta.url),
  'utf8',
);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");

  const source = (await db.query(`
    select subsidiary_id,name
      from subsidiaries
     where upper(trim(name))='EMPRESA DE PRUEBAS' and is_active
  `)).rows[0];
  assert.ok(source, 'Debe existir la subsidiaria activa EMPRESA DE PRUEBAS.');

  const sourceCategories = (await db.query(`
    select category_code,category_name,description,useful_life_months,depreciation_method,
      residual_value_percentage,asset_account_id,depreciation_account_id,
      depreciation_expense_account_id,is_active
      from asset_category
     where subsidiary_id=$1
     order by category_code
  `, [source.subsidiary_id])).rows;
  assert.ok(sourceCategories.length > 0, 'La subsidiaria origen debe tener categorías canónicas.');

  const activeSubsidiaries = Number((await db.query(
    'select count(*) count from subsidiaries where is_active',
  )).rows[0].count);

  // The migration performs the copy. Running it again must not create duplicates.
  await db.query(migration);
  const expectedTotal = activeSubsidiaries * sourceCategories.length;
  const replicatedTotal = Number((await db.query(`
    select count(*) count
      from asset_category category
      join subsidiaries subsidiary using(subsidiary_id)
     where subsidiary.is_active
       and exists (
         select 1 from asset_category canonical
          where canonical.subsidiary_id=$1
            and upper(canonical.category_code)=upper(category.category_code)
            and lower(canonical.category_name)=lower(category.category_name)
       )
  `, [source.subsidiary_id])).rows[0].count);
  assert.equal(replicatedTotal, expectedTotal);

  const beforeSecondRun = Number((await db.query('select count(*) count from asset_category')).rows[0].count);
  await db.query(migration);
  const afterSecondRun = Number((await db.query('select count(*) count from asset_category')).rows[0].count);
  assert.equal(afterSecondRun, beforeSecondRun, 'La segunda ejecución no debe duplicar categorías.');

  const preview = (await db.query(
    'select replicate_asset_categories_to_active_subsidiaries($1,false) result',
    [source.subsidiary_id],
  )).rows[0].result;
  assert.equal(preview.planned, 0);
  assert.equal(preview.conflictCount, 0);
  assert.equal(preview.accountIssueCount, 0);
  assert.equal(preview.unchanged, (activeSubsidiaries - 1) * sourceCategories.length);

  const mismatches = (await db.query(`
    select target.name subsidiary,canonical.category_code
      from asset_category canonical
      cross join subsidiaries target
      left join asset_category copy
        on copy.subsidiary_id=target.subsidiary_id
       and upper(copy.category_code)=upper(canonical.category_code)
       and lower(copy.category_name)=lower(canonical.category_name)
       and copy.description is not distinct from canonical.description
       and copy.useful_life_months is not distinct from canonical.useful_life_months
       and copy.depreciation_method is not distinct from canonical.depreciation_method
       and copy.residual_value_percentage is not distinct from canonical.residual_value_percentage
       and copy.asset_account_id is not distinct from canonical.asset_account_id
       and copy.depreciation_account_id is not distinct from canonical.depreciation_account_id
       and copy.depreciation_expense_account_id is not distinct from canonical.depreciation_expense_account_id
       and copy.is_active is not distinct from canonical.is_active
     where canonical.subsidiary_id=$1 and target.is_active and copy.category_id is null
  `, [source.subsidiary_id])).rows;
  assert.deepEqual(mismatches, []);

  const target = (await db.query(`
    select subsidiary_id,name from subsidiaries
     where is_active and subsidiary_id<>$1 order by subsidiary_id limit 1
  `, [source.subsidiary_id])).rows[0];
  const canonical = sourceCategories[0];

  // Removing one copied row and rerunning creates exactly that missing row.
  await db.query('savepoint missing_category');
  await db.query(
    'delete from asset_category where subsidiary_id=$1 and upper(category_code)=upper($2)',
    [target.subsidiary_id, canonical.category_code],
  );
  const repaired = (await db.query(
    'select replicate_asset_categories_to_active_subsidiaries($1,true) result',
    [source.subsidiary_id],
  )).rows[0].result;
  assert.equal(repaired.created, 1);
  assert.equal(repaired.conflictCount, 0);
  await db.query('rollback to savepoint missing_category');
  await db.query('release savepoint missing_category');

  // A local definition with the canonical code/name but different content is
  // reported and never overwritten.
  await db.query('savepoint category_conflict');
  const conflicting = (await db.query(`
    update asset_category
       set description=coalesce(description,'')||' · AJUSTE LOCAL DE PRUEBA'
     where subsidiary_id=$1 and upper(category_code)=upper($2)
     returning category_id,description
  `, [target.subsidiary_id, canonical.category_code])).rows[0];
  const conflictPreview = (await db.query(
    'select replicate_asset_categories_to_active_subsidiaries($1,false) result',
    [source.subsidiary_id],
  )).rows[0].result;
  assert.equal(conflictPreview.conflictCount, 1);
  assert.deepEqual(conflictPreview.conflicts[0].differentFields, ['descripcion']);

  await db.query('savepoint expected_conflict');
  await assert.rejects(
    db.query('select replicate_asset_categories_to_active_subsidiaries($1,true)', [source.subsidiary_id]),
    /No se copiaron las categorías de activos porque existen conflictos/,
  );
  await db.query('rollback to savepoint expected_conflict');
  await db.query('release savepoint expected_conflict');
  const preserved = (await db.query(
    'select description from asset_category where category_id=$1',
    [conflicting.category_id],
  )).rows[0];
  assert.equal(preserved.description, conflicting.description);
  await db.query('rollback to savepoint category_conflict');
  await db.query('release savepoint category_conflict');

  // Disabled account scope is also reported before any category is inserted.
  await db.query('savepoint account_issue');
  await db.query(`
    update account_subsidiaries set is_active=false
     where subsidiary_id=$1 and account_id=$2
  `, [target.subsidiary_id, canonical.asset_account_id]);
  const accountPreview = (await db.query(
    'select replicate_asset_categories_to_active_subsidiaries($1,false) result',
    [source.subsidiary_id],
  )).rows[0].result;
  assert.ok(accountPreview.accountIssueCount >= 1);
  assert.ok(accountPreview.accountIssues.some(issue =>
    String(issue.subsidiaryId) === String(target.subsidiary_id)
      && issue.categoryCode === canonical.category_code
      && issue.accountRole === 'ACTIVO'
      && issue.reason === 'CUENTA_INACTIVA_EN_SUBSIDIARIA'));
  await db.query('rollback to savepoint account_issue');
  await db.query('release savepoint account_issue');

  console.log(JSON.stringify({
    source: source.name,
    canonicalCategories: sourceCategories.map(category => category.category_code),
    activeSubsidiaries,
    replicatedDefinitions: expectedTotal,
    idempotent: true,
    conflictsReportedWithoutOverwrite: true,
    accountAvailabilityValidated: true,
    rollback: true,
  }, null, 2));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
