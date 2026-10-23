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
  new URL('../supabase/migrations/20261022130000_opening_balance_financial_income_dimension_exception.sql', import.meta.url),
  'utf8',
);

async function expectValidationError(category, departmentId, costCenterId, expected) {
  await db.query('savepoint expected_dimension_error');
  let failure;
  try {
    await db.query(
      'select public.opening_balance_assert_result_dimensions($1,$2,$3,$4,55)',
      [category.accountId, category.name, departmentId, costCenterId],
    );
  } catch (error) {
    failure = error;
  }
  await db.query('rollback to savepoint expected_dimension_error');
  await db.query('release savepoint expected_dimension_error');
  assert.match(failure?.message || '', expected);
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s';set local statement_timeout='120s'");
  await db.query(migration);
  await db.query(migration); // Reapplying must keep the upgraded validator deterministic.

  const classifiedAccounts = (await db.query(`
    select
      (select jsonb_build_object('accountId',account.account_id,'name',account.category,'groupCode',account_group.group_code,'groupName',account_group.group_name)
       from chart_accounts account join account_group on account_group.group_id=account.account_group_id where account.account_number='421001'limit 1)financial,
      (select jsonb_build_object('accountId',account.account_id,'name',account.category)
       from chart_accounts account where account.account_number='413001'limit 1)operating,
      (select jsonb_build_object('accountId',account.account_id,'name',account.category)
       from chart_accounts account where account.account_number='422001'limit 1)"otherIncome",
      (select jsonb_build_object('accountId',account.account_id,'name',account.category)
       from chart_accounts account where lower(account.category)in('costo','costos')order by account.account_id limit 1)cost,
      (select jsonb_build_object('accountId',account.account_id,'name',account.category)
       from chart_accounts account where lower(account.category)in('gasto','gastos')order by account.account_id limit 1)expense
  `)).rows[0];
  assert.ok(classifiedAccounts.financial && classifiedAccounts.operating && classifiedAccounts.otherIncome && classifiedAccounts.cost && classifiedAccounts.expense);
  assert.equal(classifiedAccounts.financial.groupCode, '421');
  assert.match(classifiedAccounts.financial.groupName, /Ingresos? Financieros?/i);

  // 421001 is financial income and must pass without a cost center.
  assert.equal((await db.query(
    'select public.opening_balance_is_financial_income($1) value',
    [classifiedAccounts.financial.accountId],
  )).rows[0].value, true);
  await db.query(
    'select public.opening_balance_assert_result_dimensions($1,$2,null,null,55)',
    [classifiedAccounts.financial.accountId, classifiedAccounts.financial.name],
  );
  const financialAccounts = (await db.query(`
    select account.account_id,account.account_number,account.category
    from chart_accounts account
    where public.opening_balance_is_financial_income(account.account_id)
    order by account.account_number
  `)).rows;
  assert.deepEqual(financialAccounts.map(account => account.account_number), ['421001', '421002', '421003']);
  for (const account of financialAccounts) {
    await db.query(
      'select public.opening_balance_assert_result_dimensions($1,$2,null,null,55)',
      [account.account_id, account.category],
    );
  }

  // Operating income and costs require a cost center; department is optional.
  await expectValidationError(classifiedAccounts.operating, null, null, /Libro Mayor fila 55: el centro de costos es obligatorio para cuentas de ingreso operativo o costo/);
  await expectValidationError(classifiedAccounts.otherIncome, null, null, /Libro Mayor fila 55: el centro de costos es obligatorio para cuentas de ingreso operativo o costo/);
  await db.query('select public.opening_balance_assert_result_dimensions($1,$2,null,100,55)', [classifiedAccounts.operating.accountId, classifiedAccounts.operating.name]);
  await expectValidationError(classifiedAccounts.cost, null, null, /Libro Mayor fila 55: el centro de costos es obligatorio para cuentas de ingreso operativo o costo/);
  await db.query('select public.opening_balance_assert_result_dimensions($1,$2,null,101,56)', [classifiedAccounts.cost.accountId, classifiedAccounts.cost.name]);

  // Expenses require a department; a cost center remains optional.
  await expectValidationError(classifiedAccounts.expense, null, null, /Libro Mayor fila 55: el departamento es obligatorio para cuentas de gasto/);
  await db.query('select public.opening_balance_assert_result_dimensions($1,$2,202,null,57)', [classifiedAccounts.expense.accountId, classifiedAccounts.expense.name]);

  const definition = (await db.query(`
    select pg_get_functiondef('public.opening_balance_validate_before_opening_pending(jsonb)'::regprocedure) definition
  `)).rows[0].definition;
  assert.match(definition, /opening_balance_assert_result_dimensions\(line\.account_id,line\.category,line\.department_id,line\.cost_center_id,line\.row_number\)/);
  assert.doesNotMatch(definition, /centro de costos es obligatorio para cuentas de resultados/);

  const pendingDefinition = (await db.query(`
    select pg_get_functiondef('public.opening_pending_invoice_stage_before_period_type(bigint,jsonb)'::regprocedure) definition
  `)).rows[0].definition;
  assert.match(pendingDefinition, /centro de costos es obligatorio para la cuenta 413001/);
  assert.equal((pendingDefinition.match(/if role_value='COUNTERPART'and cost_key is null then/g) || []).length, 1);
  assert.match(pendingDefinition, /centro de costos pertenece a otro cliente/);
  assert.match(pendingDefinition, /centro de costos no corresponde al departamento/);
  assert.match(pendingDefinition, /clase no corresponde al centro de costos/);

  const fixture = (await db.query(`
    select session.session_id,app_user.user_id,app_user.email,auth_user.id auth_id,
      subsidiary.subsidiary_id,subsidiary.currency_id,subsidiary.country_id,currency.currency_code,
      customer.customer_id,customer.tax_id,transition.account_id transition_account
    from user_company_sessions session
    join users app_user using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
    join user_subsidiaries access on access.user_id=app_user.user_id and access.subsidiary_id=session.subsidiary_id
    join subsidiaries subsidiary on subsidiary.subsidiary_id=session.subsidiary_id and subsidiary.is_active
    join currencies currency on currency.currency_id=subsidiary.currency_id
    join chart_accounts transition on transition.account_number='319999'and transition.accepts_entries and not transition.is_inactive
    join account_subsidiaries transition_scope on transition_scope.account_id=transition.account_id
      and transition_scope.subsidiary_id=subsidiary.subsidiary_id and transition_scope.is_active
    join lateral(
      select entity.customer_id,entity.tax_id from customers entity
      where entity.tax_id is not null and(
        entity.primary_subsidiary_id=subsidiary.subsidiary_id
        or exists(select 1 from entity_subsidiaries scope where scope.customer_id=entity.customer_id and scope.subsidiary_id=subsidiary.subsidiary_id)
      )order by entity.customer_id limit 1
    )customer on true
    where app_user.is_active
      and not exists(
        select 1 from(values('113003'),('113004'),('413001'),('413002'))required(account_number)
        where not exists(
          select 1 from chart_accounts account join account_subsidiaries scope using(account_id)
          where account.account_number=required.account_number and account.accepts_entries and not account.is_inactive
            and scope.subsidiary_id=subsidiary.subsidiary_id and scope.is_active
        )
      )
    order by session.selected_at desc limit 1
  `)).rows[0];
  assert.ok(fixture, 'Se requiere una sesión con las cuatro cuentas de pendientes y un cliente habilitado.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: fixture.auth_id,
    email: fixture.email,
    session_id: fixture.session_id,
    role: 'authenticated',
  })]);
  assert.equal(String((await db.query('select active_subsidiary_id() id')).rows[0].id), String(fixture.subsidiary_id));

  await db.query(
    "update opening_balance_runs set status='REVERSED',reversed_at=coalesce(reversed_at,now())where subsidiary_id=$1 and status<>'REVERSED'",
    [fixture.subsidiary_id],
  );
  const openingDate = new Date().toISOString().slice(0, 10);
  const run = (await db.query(`
    insert into opening_balance_runs(subsidiary_id,opening_date,load_type,transition_account_id,created_by)
    values($1,$2,'MID_YEAR',$3,$4)returning id
  `, [fixture.subsidiary_id, openingDate, fixture.transition_account, fixture.user_id])).rows[0];
  const center = (await db.query(`
    insert into cost_centers(code,name,subsidiary_id,is_inactive,cost_center_type)
    values('AUTO',$1,$2,false,'INTERNO')returning cost_center_id,code
  `, [`Centro prueba apertura ${Date.now()}`, fixture.subsidiary_id])).rows[0];
  const reference = `TEST-PENDING-NO-CENTER-${Date.now()}`;
  const pending = [{
    reference,
    originDate: openingDate,
    entityTaxId: fixture.tax_id,
    currency: fixture.currency_code,
    exchangeRate: 1,
    serviceMonth: openingDate.slice(0, 7),
    serviceCountry: `ID:${fixture.country_id}`,
    periodType: 'ACTUAL',
    lines: [
      { sourceRow: 2, account: '113003', debit: 100, credit: 0, debitFx: 100, creditFx: 0, isControlLine: true },
      { sourceRow: 3, account: '413001', debit: 0, credit: 100, debitFx: 0, creditFx: 100, isControlLine: false },
    ],
  }];
  await db.query('savepoint pending_center_required');
  await assert.rejects(
    db.query('select public.opening_pending_invoice_stage($1,$2::jsonb)', [run.id, JSON.stringify(pending)]),
    /centro de costos es obligatorio para la cuenta 413001/,
  );
  await db.query('rollback to savepoint pending_center_required');
  await db.query('release savepoint pending_center_required');

  pending[0].lines[1].costCenter = `ID:${center.cost_center_id}`;
  const staged = (await db.query(
    'select public.opening_pending_invoice_stage($1,$2::jsonb) count',
    [run.id, JSON.stringify(pending)],
  )).rows[0];
  assert.equal(Number(staged.count), 1);
  const counterpart = (await db.query(`
    select line.cost_center_id,line.class_id
    from opening_pending_invoice_items item
    join opening_pending_invoice_lines line on line.item_id=item.id and line.line_role='COUNTERPART'
    where item.run_id=$1 and item.reference=$2
  `, [run.id, reference])).rows[0];
  assert.ok(counterpart);
  assert.equal(String(counterpart.cost_center_id), String(center.cost_center_id));
  assert.equal(counterpart.class_id, null);

  console.log('Reglas verificadas: grupo 421 exento; otros ingresos/costos por centro; gastos por departamento; 413001 conserva centro.');
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
