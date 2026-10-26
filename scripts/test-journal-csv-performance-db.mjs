import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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
  connectionTimeoutMillis: 15000
});

const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const timed = async operation => {
  const started = performance.now();
  const value = await operation();
  return { value, milliseconds: Math.round((performance.now() - started) * 100) / 100 };
};

await db.connect();
try {
  await db.query('begin');
  const connectionTimeout = (await one('show statement_timeout')).statement_timeout;
  const roleSettings = (await db.query(`select role.rolname,
      coalesce(role.rolconfig,'{}'::text[]) rolconfig
    from pg_roles role
    where role.rolname in('authenticator','authenticated')
    order by role.rolname`)).rows;
  const databaseRoleSettings = (await db.query(`select
      coalesce(database.datname,'*') database,
      coalesce(role.rolname,'*') role,
      setting.setconfig
    from pg_db_role_setting setting
    left join pg_database database on database.oid=setting.setdatabase
    left join pg_roles role on role.oid=setting.setrole
    where role.rolname in('authenticator','authenticated')
       or setting.setrole=0
    order by database,role`)).rows;
  await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");

  const context = await one(`select
      account.email,
      account.auth_user_id::text sub,
      session.session_id,
      session.subsidiary_id
    from public.user_company_sessions session
    join public.users account using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where account.is_active
      and account.auth_user_id is not null
      and subsidiary.name ilike '%HOLDINGS%'
      and exists(
        select 1 from public.user_subsidiaries membership
        where membership.user_id=session.user_id
          and membership.subsidiary_id=session.subsidiary_id
      )
    order by session.selected_at desc
    limit 1`);
  assert.ok(context, 'Se requiere una sesión activa para STT Holdings.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);

  const setup = await one(`select
      currency.currency_code,
      period.fiscal_period_id,
      to_char(period.start_date,'YYYY-MM-DD') journal_date
    from public.subsidiaries subsidiary
    join public.currencies currency using(currency_id)
    cross join lateral(
      select fiscal_period_id,start_date
      from public.fiscal_periods
      where subsidiary_id=subsidiary.subsidiary_id
        and not coalesce(is_inactive,false)
        and not coalesce(is_closed,false)
        and not coalesce(gl_closed,false)
      order by start_date desc
      limit 1
    ) period
    where subsidiary.subsidiary_id=$1`, [context.subsidiary_id]);
  assert.ok(setup, 'Se requiere un período contable abierto.');

  const accounts = (await db.query(`select account.account_number
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1
      and scope.is_active
      and not coalesce(account.is_inactive,false)
      and coalesce(account.accepts_entries,true)
      and account.category in('Gasto','Pasivo')
    order by account.account_id
    limit 11`, [context.subsidiary_id])).rows;
  assert.equal(accounts.length, 11, 'Se requieren once cuentas imputables.');

  const dimensions = (await db.query(`with eligible as(
      select center.cost_center_id,center.name center,
        owner.customer_id,owner.company_name customer,
        department.department_id,department.name department,
        class.class_id,class.name class
      from public.cost_centers center
      join public.customers owner using(customer_id)
      join public.entity_subsidiaries owner_scope
        on owner_scope.customer_id=owner.customer_id
       and owner_scope.subsidiary_id=center.subsidiary_id
      join public.departments department on department.department_id=owner.department_id
      join public.department_subsidiaries department_scope
        on department_scope.department_id=department.department_id
       and department_scope.subsidiary_id=center.subsidiary_id
      join public.classes class on class.class_id=center.class_id
      join public.class_subsidiaries class_scope
        on class_scope.class_id=class.class_id
       and class_scope.subsidiary_id=center.subsidiary_id
      where center.subsidiary_id=$1
        and not center.is_inactive
        and not department.is_inactive
        and not class.is_inactive
        and (select count(*) from public.cost_centers duplicate
             where duplicate.subsidiary_id=center.subsidiary_id
               and not duplicate.is_inactive
               and lower(duplicate.name)=lower(center.name))=1
        and (select count(*) from public.departments duplicate
             join public.department_subsidiaries duplicate_scope using(department_id)
             where duplicate_scope.subsidiary_id=center.subsidiary_id
               and not duplicate.is_inactive
               and lower(duplicate.name)=lower(department.name))=1
        and (select count(*) from public.classes duplicate
             join public.class_subsidiaries duplicate_scope using(class_id)
             where duplicate_scope.subsidiary_id=center.subsidiary_id
               and not duplicate.is_inactive
               and lower(duplicate.name)=lower(class.name))=1
        and (select count(*) from public.customers duplicate
             join public.entity_subsidiaries duplicate_scope using(customer_id)
             where duplicate_scope.subsidiary_id=center.subsidiary_id
               and lower(duplicate.company_name)=lower(owner.company_name))=1
    ), chosen_class as(
      select class_id
      from eligible
      group by class_id
      having count(*)>=7
      order by count(*) desc,class_id
      limit 1
    ), chosen_departments as(
      select department_id
      from eligible
      where class_id=(select class_id from chosen_class)
      group by department_id
      order by count(*) desc,department_id
      limit 3
    ), ranked as(
      select eligible.*,
        row_number() over(partition by department_id order by cost_center_id) rank_in_department
      from eligible
      where class_id=(select class_id from chosen_class)
        and department_id in(select department_id from chosen_departments)
    )
    select center,customer,department,class
    from ranked
    order by rank_in_department,department_id,cost_center_id
    limit 7`, [context.subsidiary_id])).rows;
  assert.equal(dimensions.length, 7, 'Se requieren siete centros de costos válidos para el benchmark.');
  assert.equal(new Set(dimensions.map(item => item.department)).size,3);
  assert.equal(new Set(dimensions.map(item => item.class)).size, 1);

  const stamp = Date.now();
  const rows = [];
  for (let journal = 0; journal < 7; journal++) {
    const dimension = dimensions[journal];
    const lineCount = journal < 4 ? 12 : 11;
    const debitLines = lineCount===12 ? 6 : 5;
    const debitValue = lineCount===12 ? 10 : 12;
    const creditValue = 10;
    for (let line = 0; line < lineCount; line++) {
      const debit = line < debitLines ? debitValue.toFixed(2) : '0.00';
      const credit = line < debitLines ? '0.00' : creditValue.toFixed(2);
      rows.push({
        asiento_referencia: `PERF-NOM-${stamp}-${journal + 1}`,
        tipo_asiento: 'ASI_NOM',
        fecha: setup.journal_date,
        moneda: setup.currency_code,
        tipo_cambio: '1.000000',
        nota_asiento: 'Benchmark reversible de importación de nómina',
        numero_cuenta: accounts[line % accounts.length].account_number,
        debito: debit,
        credito: credit,
        nota_linea: `Línea ${line + 1}`,
        mes_servicio: '1999-01',
        pais_servicio: 'Jamaica',
        entidad: 'Cliente',
        nombre: dimension.customer,
        departamento: dimension.department,
        centro_costos: dimension.center,
        clase: dimension.class,
        acreedor_financiero: '',
        compania_relacionada: ''
      });
    }
  }
  assert.equal(rows.length, 81);
  assert.equal(new Set(dimensions.map(item => item.customer)).size,3);

  const call = async preview => (await one(
    'select public.import_journal_csv($1::jsonb,$2,$3) result',
    [JSON.stringify(rows), preview, context.subsidiary_id]
  )).result;

  await db.query('set local role authenticated');
  const before = await timed(() => call(true));
  assert.equal(before.value.valid, true, JSON.stringify(before.value.errors));
  await db.query('reset role');

  const migration = await readFile(new URL(
    '../supabase/migrations/20261026194500_optimize_journal_csv_lookups.sql',
    import.meta.url
  ), 'utf8');
  await db.query(migration);

  await db.query('set local role authenticated');
  await db.query("set local statement_timeout='8s'");
  const preview = await timed(() => call(true));
  assert.equal(preview.value.valid, true, JSON.stringify(preview.value.errors));
  assert.ok(preview.milliseconds < 3000, `La vista previa tardó ${preview.milliseconds} ms.`);

  const invalidAmountRows = rows.map((row,index) => index===0
    ? { ...row, credito:'10.00' }
    : row);
  const invalidAmount = (await one(
    'select public.import_journal_csv($1::jsonb,true,$2) result',
    [JSON.stringify(invalidAmountRows),context.subsidiary_id]
  )).result;
  assert.equal(invalidAmount.valid,false);
  assert.ok(invalidAmount.errors.some(error => /solo débito o crédito/i.test(String(error.message))));

  const invalidDimensionRows = rows.map((row,index) => index===0
    ? { ...row, centro_costos:'CENTRO-INEXISTENTE-DE-PRUEBA' }
    : row);
  const invalidDimension = (await one(
    'select public.import_journal_csv($1::jsonb,true,$2) result',
    [JSON.stringify(invalidDimensionRows),context.subsidiary_id]
  )).result;
  assert.equal(invalidDimension.valid,false);
  assert.ok(invalidDimension.errors.some(error => /centro_costos|centro de costos/i.test(String(error.message))));

  const imported = await timed(() => call(false));
  assert.equal(imported.value.valid, true, JSON.stringify(imported.value.errors));
  assert.equal(imported.value.created, 7);
  assert.ok(imported.milliseconds < 3000, `La importación tardó ${imported.milliseconds} ms.`);

  const journalIds = imported.value.entries.map(entry => Number(entry.journalId));
  const projection = (await db.query(`select journal.journal_id,
      distinct_line.line_count,
      distinct_impact.impact_count,
      coalesce(distinct_line.debit_local,0)::numeric debit_lines,
      coalesce(distinct_line.credit_local,0)::numeric credit_lines,
      coalesce(distinct_impact.debit_amount,0)::numeric debit_impacts,
      coalesce(distinct_impact.credit_amount,0)::numeric credit_impacts
    from public.journal journal
    cross join lateral(
      select count(*) line_count,
        sum(line.debit*journal.exchange_rate) debit_local,
        sum(line.credit*journal.exchange_rate) credit_local
      from public.journal_line line
      where line.journal_id=journal.journal_id
        and (line.debit>0 or line.credit>0)
    ) distinct_line
    cross join lateral(
      select count(*) impact_count,
        sum(impact.debit_amount) debit_amount,
        sum(impact.credit_amount) credit_amount
      from public.gl_impact impact
      where impact.transaction_id=journal.transaction_id
    ) distinct_impact
    where journal.journal_id=any($1::bigint[])
    order by journal.journal_id`, [journalIds])).rows;
  assert.equal(projection.length, 7);
  for (const row of projection) {
    assert.ok(Number(row.debit_lines)>0);
    assert.equal(Number(row.impact_count), Number(row.line_count));
    assert.equal(Number(row.debit_impacts), Number(row.debit_lines));
    assert.equal(Number(row.credit_impacts), Number(row.credit_lines));
  }

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    rows: rows.length,
    journals: 7,
    accounts: accounts.length,
    departments: new Set(dimensions.map(item => item.department)).size,
    customers: new Set(dimensions.map(item => item.customer)).size,
    centers: dimensions.length,
    classes: new Set(dimensions.map(item => item.class)).size,
    lookupCallsWithoutCacheApproximately: rows.length * 7,
    beforePreviewMs: before.milliseconds,
    optimizedPreviewMs: preview.milliseconds,
    optimizedImportMs: imported.milliseconds,
    underThreeSeconds: true,
    connectionTimeout,
    roleSettings,
    databaseRoleSettings,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
