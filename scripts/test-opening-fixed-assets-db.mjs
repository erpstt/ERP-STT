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

const SCALE = 1_000_000n;
const one = async (text, params = []) => (await db.query(text, params)).rows[0];

function toUnits(value) {
  const raw = String(value ?? 0).trim();
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const units = BigInt(integer || '0') * SCALE + BigInt((fraction + '000000').slice(0, 6));
  return negative ? -units : units;
}

function fromUnits(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integer = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(6, '0');
  return `${negative ? '-' : ''}${integer}.${fraction}`;
}

function addAmount(map, accountId, accountNumber, amount) {
  const key = String(accountId);
  const current = map.get(key) || { accountId: Number(accountId), accountNumber, amount: 0n };
  current.amount += toUnits(amount);
  map.set(key, current);
}

function buildLedgerRows(existingRows, setup, stagedCost, stagedAccumulated) {
  const costs = new Map();
  const depreciation = new Map();
  for (const row of existingRows) {
    addAmount(
      row.kind === 'COST' ? costs : depreciation,
      row.account_id,
      row.account_number,
      row.amount,
    );
  }
  addAmount(costs, setup.asset_account_id, setup.asset_account, stagedCost);
  addAmount(
    depreciation,
    setup.depreciation_account_id,
    setup.depreciation_account,
    stagedAccumulated,
  );

  const rows = [];
  let debitTotal = 0n;
  let creditTotal = 0n;
  let sourceRow = 2;
  const append = (account, debit, credit, note) => {
    rows.push({
      sourceType: 'GL',
      sourceRow: sourceRow++,
      account,
      currency: setup.currency_code,
      debit: debit === 0n ? '' : fromUnits(debit),
      credit: credit === 0n ? '' : fromUnits(credit),
      note,
    });
    debitTotal += debit;
    creditTotal += credit;
  };

  for (const entry of costs.values()) {
    if (entry.amount > 0n) append(entry.accountNumber, entry.amount, 0n, 'Costo de activos a la apertura');
    else if (entry.amount < 0n) append(entry.accountNumber, 0n, -entry.amount, 'Costo de activos a la apertura');
  }
  for (const entry of depreciation.values()) {
    if (entry.amount > 0n) append(entry.accountNumber, 0n, entry.amount, 'Depreciación acumulada a la apertura');
    else if (entry.amount < 0n) append(entry.accountNumber, -entry.amount, 0n, 'Depreciación acumulada a la apertura');
  }

  const difference = debitTotal - creditTotal;
  if (difference > 0n) append(setup.transition_account, 0n, difference, 'Contrapartida de apertura');
  else if (difference < 0n) append(setup.transition_account, -difference, 0n, 'Contrapartida de apertura');

  assert.equal(debitTotal, creditTotal, 'Las líneas contables construidas para la prueba deben cuadrar.');
  return rows;
}

function assetPayload(setup, assetNumber, cost, accumulated) {
  return {
    sourceRow: 2,
    assetNumber,
    name: 'Activo inicial de prueba',
    categoryCode: setup.category_code,
    serial: `SER-${assetNumber}`,
    description: 'Prueba integral con rollback',
    purchaseDate: setup.opening_date,
    serviceDate: setup.opening_date,
    cost,
    accumulatedDepreciation: accumulated,
    bookValue: fromUnits(toUnits(cost) - toUnits(accumulated)),
    depreciatedMonths: '1',
    location: setup.location_name,
    departmentType: '',
    department: '',
    costCenter: '',
    className: '',
    status: 'ACTIVO',
    currency: setup.currency_code,
    note: 'Saldo inicial de prueba',
  };
}

async function expectDatabaseError(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error.message), pattern);
    return error;
  }
  assert.fail('La operación debía ser rechazada por la base de datos.');
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='120s'");
  await db.query(migration);

  const depreciationMethods = await one(`
    select
      fixed_asset_period_depreciation(1200,0,24,'Línea Recta',0,0)::text straight_line,
      fixed_asset_period_depreciation(1200,0,24,'Suma de los Dígitos de los Años',0,0)::text syd_year_one,
      fixed_asset_period_depreciation(1200,0,24,'Suma de los Dígitos de los Años',12,800)::text syd_year_two,
      fixed_asset_period_depreciation(1200,0,24,'Suma de los Dígitos de los Años',12,0)::text syd_catch_up
  `);
  assert.ok(Math.abs(Number(depreciationMethods.straight_line) - 50) <= 0.000001);
  assert.ok(Math.abs(Number(depreciationMethods.syd_year_one) - 66.666667) <= 0.000001);
  assert.ok(Math.abs(Number(depreciationMethods.syd_year_two) - 33.333333) <= 0.000001);
  assert.ok(
    Math.abs(Number(depreciationMethods.syd_catch_up) - 100) <= 0.000001,
    'Con 12 meses restantes, SYD debe distribuir el saldo pendiente para agotarlo al final de la vida útil.',
  );

  const context = await one(`
    select u.email,u.user_id,au.id auth_id,ucs.session_id,ucs.subsidiary_id,urs.role_id
    from user_company_sessions ucs
    join users u using(user_id)
    join auth.users au on lower(au.email)=lower(u.email)
    join user_role_sessions urs on urs.session_id=ucs.session_id and urs.user_id=ucs.user_id
    where exists(
      select 1 from fiscal_periods p
      where p.subsidiary_id=ucs.subsidiary_id
        and current_date between p.start_date and p.end_date
        and p.start_date<current_date
        and not p.is_closed and not coalesce(p.gl_closed,false) and not coalesce(p.is_inactive,false)
    )
      and exists(
        select 1
        from asset_category c
        join chart_accounts aa on aa.account_id=c.asset_account_id
        join chart_accounts da on da.account_id=c.depreciation_account_id
        join chart_accounts ea on ea.account_id=c.depreciation_expense_account_id
        join account_subsidiaries ax on ax.account_id=aa.account_id and ax.subsidiary_id=ucs.subsidiary_id and ax.is_active
        join account_subsidiaries dx on dx.account_id=da.account_id and dx.subsidiary_id=ucs.subsidiary_id and dx.is_active
        join account_subsidiaries ex on ex.account_id=ea.account_id and ex.subsidiary_id=ucs.subsidiary_id and ex.is_active
        where c.subsidiary_id=ucs.subsidiary_id and c.is_active
          and c.depreciation_method<>'No Depreciable' and c.useful_life_months>2
          and coalesce(c.residual_value_percentage,0)<90
          and aa.accepts_entries and da.accepts_entries and ea.accepts_entries
          and not aa.is_inactive and not da.is_inactive and not ea.is_inactive
      )
      and exists(
        select 1 from locations l left join location_subsidiaries ls using(location_id)
        where l.subsidiary_id=ucs.subsidiary_id or ls.subsidiary_id=ucs.subsidiary_id
      )
      and exists(
        select 1 from chart_accounts a join account_subsidiaries x using(account_id)
        where a.account_number='319999' and a.accepts_entries and not a.is_inactive
          and x.subsidiary_id=ucs.subsidiary_id and x.is_active
      )
    order by ucs.selected_at desc
    limit 1
  `);
  assert.ok(context, 'Se requiere una sesión con rol, período actual abierto y configuración completa de activos.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: context.auth_id, email: context.email, session_id: context.session_id }),
  ]);
  await db.query(`
    insert into role_access_matrix(role_id,resource_key,can_view,can_create,can_edit,can_delete)
    values($1,'accounting:opening-balances',true,true,true,true)
    on conflict(role_id,resource_key)do update
      set can_view=true,can_create=true,can_edit=true,can_delete=true,updated_at=now()
  `, [context.role_id]);

  const subsidiaryId = Number(context.subsidiary_id);
  await db.query(
    "update opening_balance_runs set status='REVERSED',reversed_at=coalesce(reversed_at,now()) where subsidiary_id=$1 and status<>'REVERSED'",
    [subsidiaryId],
  );

  const setup = await one(`
    select c.category_id,c.category_code,c.useful_life_months,c.residual_value_percentage,
      c.asset_account_id,c.depreciation_account_id,c.depreciation_expense_account_id,
      aa.account_number asset_account,da.account_number depreciation_account,
      t.account_id transition_id,t.account_number transition_account,
      s.currency_id,cu.currency_code,l.location_id,l.name location_name,
      p.fiscal_period_id current_period_id,current_date::text today,(current_date-1)::date opening_date
    from subsidiaries s
    join currencies cu using(currency_id)
    join asset_category c on c.subsidiary_id=s.subsidiary_id and c.is_active
      and c.depreciation_method<>'No Depreciable' and c.useful_life_months>2
      and coalesce(c.residual_value_percentage,0)<90
    join chart_accounts aa on aa.account_id=c.asset_account_id and aa.accepts_entries and not aa.is_inactive
    join chart_accounts da on da.account_id=c.depreciation_account_id and da.accepts_entries and not da.is_inactive
    join chart_accounts ea on ea.account_id=c.depreciation_expense_account_id and ea.accepts_entries and not ea.is_inactive
    join account_subsidiaries ax on ax.account_id=aa.account_id and ax.subsidiary_id=s.subsidiary_id and ax.is_active
    join account_subsidiaries dx on dx.account_id=da.account_id and dx.subsidiary_id=s.subsidiary_id and dx.is_active
    join account_subsidiaries ex on ex.account_id=ea.account_id and ex.subsidiary_id=s.subsidiary_id and ex.is_active
    join chart_accounts t on t.account_number='319999' and t.accepts_entries and not t.is_inactive
      and t.account_id<>c.asset_account_id and t.account_id<>c.depreciation_account_id
    join account_subsidiaries tx on tx.account_id=t.account_id and tx.subsidiary_id=s.subsidiary_id and tx.is_active
    join lateral(
      select l.location_id,l.name
      from locations l left join location_subsidiaries ls using(location_id)
      where l.subsidiary_id=s.subsidiary_id or ls.subsidiary_id=s.subsidiary_id
      order by (l.subsidiary_id=s.subsidiary_id)desc,l.location_id
      limit 1
    )l on true
    join lateral(
      select p.fiscal_period_id
      from fiscal_periods p
      where p.subsidiary_id=s.subsidiary_id and current_date between p.start_date and p.end_date
        and p.start_date<current_date
        and not p.is_closed and not coalesce(p.gl_closed,false) and not coalesce(p.is_inactive,false)
      limit 1
    )p on true
    where s.subsidiary_id=$1
    order by c.category_id
    limit 1
  `, [subsidiaryId]);
  assert.ok(setup?.opening_date, 'No existe una categoría utilizable o un período actual abierto.');

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const legacyForeignCurrency = await one(
    'select currency_id,currency_code from currencies where currency_id<>$1 order by currency_id limit 1',
    [setup.currency_id],
  );
  assert.ok(legacyForeignCurrency, 'Se requiere una segunda moneda para probar el snapshot FX de la apertura.');
  await db.query(`
    insert into exchange_rates(from_currency_id,to_currency_id,effective_date,spot_rate)
    values($1,$2,$3,2.5)
    on conflict(from_currency_id,to_currency_id,effective_date)do update set spot_rate=excluded.spot_rate
  `, [legacyForeignCurrency.currency_id, setup.currency_id, setup.opening_date]);
  await db.query('alter table asset disable trigger validate_fixed_asset_local_currency_trigger');
  const legacyFxAsset = await one(`
    insert into asset(
      asset_number,asset_name,description,serial_number,category_id,subsidiary_id,location_id,
      currency_id,purchase_date,in_service_date,purchase_cost,exchange_rate,status
    )values($1,'Activo legado en moneda extranjera','Prueba de conciliación en moneda local',$2,$3,$4,$5,$6,$7,$7,137,2.5,'INACTIVO')
    returning asset_id,purchase_cost,exchange_rate
  `, [
    `TEST-FX-${stamp}`,
    `SER-FX-${stamp}`,
    setup.category_id,
    subsidiaryId,
    setup.location_id,
    legacyForeignCurrency?.currency_id || setup.currency_id,
    setup.opening_date,
  ]);
  await db.query('alter table asset enable trigger validate_fixed_asset_local_currency_trigger');
  await db.query(`
    insert into asset_depreciation(
      depreciation_date,asset_id,fiscal_period_id,gl_impact_id,depreciation_amount,
      accumulated_depreciation,depreciated_months,is_opening_balance
    )values($1,$2,$3,null,17,17,1,false)
  `, [setup.opening_date, legacyFxAsset.asset_id, setup.current_period_id]);
  const legacyFxLocal = await one(`
    select (a.purchase_cost*a.exchange_rate)::text cost_local,
      (sum(d.depreciation_amount)*a.exchange_rate)::text depreciation_local
    from asset a join asset_depreciation d using(asset_id)
    where a.asset_id=$1
    group by a.asset_id
  `, [legacyFxAsset.asset_id]);
  assert.equal(Number(legacyFxLocal.cost_local), 342.5);
  assert.equal(Number(legacyFxLocal.depreciation_local), 42.5);

  const existingRows = (await db.query(`
    with eligible as(
      select a.asset_id,a.category_id,a.purchase_cost,a.exchange_rate
      from asset a
      where a.subsidiary_id=$1 and a.purchase_date<=$2::date
        and not exists(
          select 1 from asset_disposal d
          where d.asset_id=a.asset_id and d.disposal_date<=$2::date
        )
    )
    select 'COST' kind,c.asset_account_id account_id,a.account_number,sum(e.purchase_cost*e.exchange_rate)::text amount
    from eligible e join asset_category c using(category_id)
    join chart_accounts a on a.account_id=c.asset_account_id
    group by c.asset_account_id,a.account_number
    union all
    select 'DEPRECIATION',c.depreciation_account_id,a.account_number,sum(d.depreciation_amount*e.exchange_rate)::text
    from eligible e join asset_category c using(category_id)
    join asset_depreciation d on d.asset_id=e.asset_id and d.depreciation_date<=$2::date
    join chart_accounts a on a.account_id=c.depreciation_account_id
    group by c.depreciation_account_id,a.account_number
  `, [subsidiaryId, setup.opening_date])).rows;

  const stagedCost = '1200.000000';
  const stagedAccumulated = '120.000000';
  const rows = buildLedgerRows(existingRows, setup, stagedCost, stagedAccumulated);
  rows.push(
    { sourceType: 'GL', sourceRow: 900, account: setup.transition_account, currency: legacyForeignCurrency.currency_code, debit: '10', credit: '', note: 'Prueba FX débito' },
    { sourceType: 'GL', sourceRow: 901, account: setup.transition_account, currency: legacyForeignCurrency.currency_code, debit: '', credit: '10', note: 'Prueba FX crédito' },
  );
  const assetNumber = 'AUTO';
  const matchingAsset = assetPayload(setup, assetNumber, stagedCost, stagedAccumulated);
  const basePayload = {
    expectedSubsidiaryId: subsidiaryId,
    openingDate: setup.opening_date,
    loadType: 'FISCAL_YEAR',
    transitionAccountId: setup.transition_id,
    rows,
  };

  await db.query('savepoint expected_active_subsidiary_guard');
  await expectDatabaseError(
    one('select opening_balance_validate($1::jsonb)value', [JSON.stringify({ ...basePayload, expectedSubsidiaryId: subsidiaryId + 999_999, assets: [] })]),
    /empresa activa cambi[oó]|recargue la pantalla/i,
  );
  await db.query('rollback to savepoint expected_active_subsidiary_guard');

  const mismatchedCost = '1201.000000';
  const mismatchPreview = (await one('select opening_balance_validate($1::jsonb)value', [
    JSON.stringify({ ...basePayload, assets: [assetPayload(setup, assetNumber, mismatchedCost, stagedAccumulated)] }),
  ])).value;
  assert.equal(mismatchPreview.assetSummary.balanced, false);
  assert.ok(
    mismatchPreview.assetReconciliation.some((row) => Math.abs(Number(row.difference)) > 0.005),
    'La previsualización debe identificar la cuenta que no concilia.',
  );
  await db.query('savepoint expected_mismatch');
  await expectDatabaseError(
    one('select opening_balance_post($1)value', [mismatchPreview.run.id]),
    /no coincide|conciliaci[oó]n/i,
  );
  await db.query('rollback to savepoint expected_mismatch');
  assert.equal(
    Number((await one('select count(*) n from asset where opening_run_id=$1', [mismatchPreview.run.id])).n),
    0,
    'Un auxiliar con diferencia no debe crear fichas.',
  );

  const preview = (await one('select opening_balance_validate($1::jsonb)value', [
    JSON.stringify({ ...basePayload, assets: [matchingAsset] }),
  ])).value;
  assert.equal(Number(preview.summary.difference), 0);
  assert.equal(Number(preview.assetSummary.count), 1);
  assert.equal(Number(preview.assetSummary.cost), Number(stagedCost));
  assert.equal(Number(preview.assetSummary.accumulated), Number(stagedAccumulated));
  assert.equal(preview.assetSummary.balanced, true);
  assert.ok(preview.assetReconciliation.length >= 2);
  assert.ok(preview.assetReconciliation.every((row) => 'existing' in row && 'staged' in row));
  assert.ok(preview.assetReconciliation.every((row) => Math.abs(Number(row.difference)) <= 0.005));

  const existingCost = existingRows
    .filter((row) => row.kind === 'COST' && Number(row.account_id) === Number(setup.asset_account_id))
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const costReconciliation = preview.assetReconciliation.find(
    (row) => row.type.startsWith('Costo') && Number(row.accountId) === Number(setup.asset_account_id),
  );
  assert.ok(costReconciliation);
  assert.ok(Math.abs(Number(costReconciliation.existing) - existingCost) <= 0.005);
  assert.ok(Math.abs(Number(costReconciliation.staged) - Number(stagedCost)) <= 0.005);

  const firstPost = (await one('select opening_balance_post($1)value', [preview.run.id])).value;
  assert.equal(firstPost.assetsCreated, 1);
  assert.equal(firstPost.assetsOnly, false);

  const firstJournal = await one(`
    select j.journal_id,j.journal_number,j.fiscal_period_id,j.total_debit,j.total_credit,
      count(l.journal_line_id)::int line_count
    from journal j join journal_line l using(journal_id)
    where j.journal_id=$1
    group by j.journal_id
  `, [firstPost.journalId]);
  assert.equal(firstJournal.line_count, rows.length, 'El auxiliar no debe agregar líneas contables al asiento de apertura.');
  assert.equal(Number(firstJournal.total_debit), Number(preview.summary.debit));
  assert.equal(Number(firstJournal.total_credit), Number(preview.summary.credit));

  const glTotals = await one(`
    select coalesce(sum(g.debit_amount),0) debit,coalesce(sum(g.credit_amount),0) credit
    from journal j left join gl_impact g on g.transaction_id=j.transaction_id
    where j.journal_id=$1
  `, [firstPost.journalId]);
  assert.ok(Math.abs(Number(glTotals.debit) - Number(preview.summary.debit)) <= 0.005);
  assert.ok(Math.abs(Number(glTotals.credit) - Number(preview.summary.credit)) <= 0.005);
  const fxImpacts = (await db.query(`
    select l.debit,l.credit,l.debit_fx,l.credit_fx,g.debit_amount,g.credit_amount,g.debit_fx gl_debit_fx,g.credit_fx gl_credit_fx
    from journal j join journal_line l using(journal_id)
    join gl_impact g on g.transaction_id=j.transaction_id and g.account_id=l.account_id
      and g.debit_amount=l.debit and g.credit_amount=l.credit and g.debit_fx=l.debit_fx and g.credit_fx=l.credit_fx
    where j.journal_id=$1 and l.original_currency_id=$2 and l.opening_balance_line_id is not null
    order by l.journal_line_id
  `, [firstPost.journalId, legacyForeignCurrency.currency_id])).rows;
  assert.equal(fxImpacts.length, 2);
  assert.ok(fxImpacts.every((row) => Number(row.debit_fx) + Number(row.credit_fx) === 10));
  assert.ok(fxImpacts.every((row) => Number(row.debit_amount) + Number(row.credit_amount) === 25));

  const firstAsset = await one('select * from asset where opening_run_id=$1', [preview.run.id]);
  assert.match(firstAsset.asset_number, /^ACT-\d{6}$/);
  assert.equal(firstAsset.is_opening_balance, true);
  const postedPreview = (await one('select opening_balance_preview($1)value', [preview.run.id])).value;
  assert.equal(postedPreview.assets[0].number, firstAsset.asset_number);
  assert.notEqual(postedPreview.assets[0].number, 'AUTO');
  const openingDepreciation = await one(
    'select * from asset_depreciation where asset_id=$1 and is_opening_balance',
    [firstAsset.asset_id],
  );
  assert.equal(Number(openingDepreciation.depreciation_amount), Number(stagedAccumulated));
  assert.equal(Number(openingDepreciation.depreciated_months), 1);
  assert.equal(openingDepreciation.gl_impact_id, null);

  const descriptiveEdit = await one(
    "update asset set description='Edición descriptiva permitida' where asset_id=$1 returning description",
    [firstAsset.asset_id],
  );
  assert.equal(descriptiveEdit.description, 'Edición descriptiva permitida');

  await db.query('savepoint expected_opening_asset_update_lock');
  await expectDatabaseError(
    db.query('update asset set purchase_cost=purchase_cost+1 where asset_id=$1', [firstAsset.asset_id]),
    /apertura|saldo inicial/i,
  );
  await db.query('rollback to savepoint expected_opening_asset_update_lock');

  await db.query('savepoint expected_opening_depreciation_delete_lock');
  await expectDatabaseError(
    db.query('delete from asset_depreciation where depreciation_id=$1', [openingDepreciation.depreciation_id]),
    /apertura|saldo inicial/i,
  );
  await db.query('rollback to savepoint expected_opening_depreciation_delete_lock');

  await db.query('savepoint expected_opening_asset_delete_lock');
  await expectDatabaseError(
    db.query('delete from asset where asset_id=$1', [firstAsset.asset_id]),
    /apertura|saldo inicial/i,
  );
  await db.query('rollback to savepoint expected_opening_asset_delete_lock');

  assert.equal(
    Number((await one(`
      select count(*) n
      from activos_fijos_propuestas p join journal j on j.transaction_id=p.transaction_id
      where j.journal_id=$1
    `, [firstPost.journalId])).n),
    0,
  );

  await db.query('savepoint expected_opening_edit_lock');
  await expectDatabaseError(
    db.query("update journal set memo=memo||' alterado' where journal_id=$1", [firstPost.journalId]),
    /asientos de apertura solo pueden modificarse o reversarse/i,
  );
  await db.query('rollback to savepoint expected_opening_edit_lock');

  const openingTransaction = await one(
    'select transaction_id from journal where journal_id=$1',
    [firstPost.journalId],
  );
  assert.ok(openingTransaction?.transaction_id, 'El asiento de apertura debe conservar su transacción base.');
  await db.query('savepoint expected_opening_transaction_update_lock');
  await expectDatabaseError(
    db.query("update \"transaction\" set tran_number=tran_number||'-ALTERADO' where transaction_id=$1", [openingTransaction.transaction_id]),
    /asientos de apertura solo pueden modificarse o reversarse/i,
  );
  await db.query('rollback to savepoint expected_opening_transaction_update_lock');
  await db.query('savepoint expected_opening_transaction_delete_lock');
  await expectDatabaseError(
    db.query('delete from "transaction" where transaction_id=$1', [openingTransaction.transaction_id]),
    /asientos de apertura solo pueden modificarse o reversarse/i,
  );
  await db.query('rollback to savepoint expected_opening_transaction_delete_lock');

  const reversePermission = await one(
    "select permission_id from permissions where code='accounting:journal:reverse' limit 1",
  );
  assert.ok(reversePermission, 'Debe existir el permiso de reversión genérica para probar su bloqueo.');
  await db.query(
    'insert into user_roles(user_id,role_id)values($1,$2)on conflict do nothing',
    [context.user_id, context.role_id],
  );
  await db.query(
    'insert into role_permissions(role_id,permission_id)values($1,$2)on conflict do nothing',
    [context.role_id, reversePermission.permission_id],
  );
  await db.query('savepoint expected_generic_reversal_lock');
  await expectDatabaseError(
    one('select reverse_journal_entry($1)value', [firstPost.journalId]),
    /asientos de apertura solo pueden modificarse o reversarse/i,
  );
  await db.query('rollback to savepoint expected_generic_reversal_lock');

  const openingJournalCountBeforeRetrofit = Number((await one(`
    select count(*) n from journal
    where subsidiary_id=$1 and(is_opening_balance or journal_id=$2)
  `, [subsidiaryId, firstPost.journalId])).n);
  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query('delete from asset_depreciation where asset_id=$1', [firstAsset.asset_id]);
  await db.query('delete from asset where asset_id=$1', [firstAsset.asset_id]);
  await db.query("select set_config('app.opening_balance_internal','',true)");
  assert.equal(
    Number((await one('select count(*) n from asset where opening_run_id=$1', [preview.run.id])).n),
    0,
  );

  const postedAssetAmounts = await one(`
    select l.journal_line_id,l.debit,l.debit_fx,g.gl_impact_id,g.debit_amount,g.debit_fx gl_debit_fx
    from journal j
    join journal_line l on l.journal_id=j.journal_id and l.account_id=$2
    join gl_impact g on g.transaction_id=j.transaction_id and g.account_id=l.account_id
    join accounting_books b on b.accounting_book_id=g.accounting_book_id and b.is_primary
    where j.journal_id=$1 and l.debit>0
    order by l.journal_line_id,g.gl_impact_id
    limit 1
  `, [firstPost.journalId, setup.asset_account_id]);
  assert.ok(postedAssetAmounts, 'El asiento contabilizado debe conservar el impacto de la cuenta de activo.');
  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query(
    'update journal_line set debit=debit+1,debit_fx=debit_fx+1 where journal_line_id=$1',
    [postedAssetAmounts.journal_line_id],
  );
  await db.query(
    'update gl_impact set debit_amount=debit_amount+1,debit_fx=debit_fx+1 where gl_impact_id=$1',
    [postedAssetAmounts.gl_impact_id],
  );
  await db.query("select set_config('app.opening_balance_internal','',true)");

  const mismatchedRetrofitPreview = (await one('select opening_balance_validate($1::jsonb)value', [
    JSON.stringify({ expectedSubsidiaryId: subsidiaryId, rows: [], assets: [matchingAsset] }),
  ])).value;
  assert.equal(mismatchedRetrofitPreview.assetSummary.balanced, false);
  assert.ok(
    mismatchedRetrofitPreview.assetReconciliation.some(
      (row) => Number(row.accountId) === Number(setup.asset_account_id) && Math.abs(Number(row.difference)) > 0.005,
    ),
    'Un lote POSTED debe conciliar contra el asiento/GL vigente y detectar una alteración posterior.',
  );
  await db.query('savepoint expected_posted_ledger_mismatch');
  await expectDatabaseError(
    one('select opening_balance_post($1)value', [preview.run.id]),
    /no coincide|conciliaci[oó]n/i,
  );
  await db.query('rollback to savepoint expected_posted_ledger_mismatch');

  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query(
    'update journal_line set debit=$2,debit_fx=$3 where journal_line_id=$1',
    [postedAssetAmounts.journal_line_id, postedAssetAmounts.debit, postedAssetAmounts.debit_fx],
  );
  await db.query(
    'update gl_impact set debit_amount=$2,debit_fx=$3 where gl_impact_id=$1',
    [postedAssetAmounts.gl_impact_id, postedAssetAmounts.debit_amount, postedAssetAmounts.gl_debit_fx],
  );
  await db.query("select set_config('app.opening_balance_internal','',true)");

  const retrofitPreview = (await one('select opening_balance_validate($1::jsonb)value', [
    JSON.stringify({ expectedSubsidiaryId: subsidiaryId, rows: [], assets: [matchingAsset] }),
  ])).value;
  assert.equal(Number(retrofitPreview.run.id), Number(preview.run.id));
  assert.equal(retrofitPreview.run.status, 'POSTED');
  assert.equal(retrofitPreview.assetSummary.pending, 1);
  assert.equal(retrofitPreview.assetSummary.balanced, true);
  const retrofitPost = (await one('select opening_balance_post($1)value', [preview.run.id])).value;
  assert.equal(retrofitPost.assetsOnly, true);
  assert.equal(retrofitPost.assetsCreated, 1);
  assert.equal(Number(retrofitPost.journalId), Number(firstPost.journalId));
  assert.equal(retrofitPost.journalNumber, firstPost.journalNumber);
  assert.equal(
    Number((await one(`
      select count(*) n from journal
      where subsidiary_id=$1 and(is_opening_balance or journal_id=$2)
    `, [subsidiaryId, firstPost.journalId])).n),
    openingJournalCountBeforeRetrofit,
    'Completar el auxiliar de un lote contabilizado no debe crear otro asiento.',
  );
  const retrofitAsset = await one('select * from asset where opening_run_id=$1', [preview.run.id]);
  assert.match(retrofitAsset.asset_number, /^ACT-\d{6}$/);
  assert.equal(
    (await one('select asset_number from opening_fixed_asset_lines where created_asset_id=$1', [retrofitAsset.asset_id])).asset_number,
    retrofitAsset.asset_number,
  );

  await db.query('savepoint expected_existing_assets_reversal_lock');
  await expectDatabaseError(
    one('select opening_balance_reverse($1)value', [preview.run.id]),
    /fichas?.*preexistentes|activos?.*preexistentes|conciliaci[oó]n.*existentes/i,
  );
  await db.query('rollback to savepoint expected_existing_assets_reversal_lock');

  await db.query("select set_config('app.opening_balance_internal','1',true)");
  await db.query('delete from asset_depreciation where asset_id=$1', [legacyFxAsset.asset_id]);
  await db.query('delete from asset where asset_id=$1', [legacyFxAsset.asset_id]);
  await db.query("select set_config('app.opening_balance_internal','',true)");
  assert.equal(Number((await one('select count(*) n from asset where asset_id=$1', [legacyFxAsset.asset_id])).n), 0);

  // El entorno puede contener fichas reales anteriores a la apertura. Ya se
  // comprobó que bloquean la reversión; se desplazan solo dentro de esta
  // transacción para probar también el camino reversible y luego se restauran.
  await db.query(`
    create temporary table test_opening_existing_asset_dates on commit drop as
    select asset_id,purchase_date,in_service_date
    from asset
    where subsidiary_id=$1 and opening_run_id is distinct from $2
      and purchase_date<=$3::date
      and not exists(select 1 from asset_disposal d where d.asset_id=asset.asset_id and d.disposal_date<=$3::date)
  `, [subsidiaryId, preview.run.id, setup.opening_date]);
  const shiftedExistingAssets = Number((await one('select count(*) n from test_opening_existing_asset_dates')).n);
  if (shiftedExistingAssets > 0) {
    await db.query("select set_config('app.opening_balance_internal','1',true)");
    await db.query('alter table asset disable trigger protect_depreciated_asset_values_trigger');
    await db.query('alter table asset disable trigger validate_fixed_asset_local_currency_trigger');
    await db.query(`
      update asset a
      set purchase_date=$1::date+1,in_service_date=greatest(a.in_service_date,$1::date+1)
      from test_opening_existing_asset_dates original
      where a.asset_id=original.asset_id
    `, [setup.opening_date]);
    await db.query('alter table asset enable trigger validate_fixed_asset_local_currency_trigger');
    await db.query('alter table asset enable trigger protect_depreciated_asset_values_trigger');
    await db.query("select set_config('app.opening_balance_internal','',true)");
  }

  const originalBookImpacts = (await db.query(`
    select g.accounting_book_id,g.account_id,
      sum(g.debit_amount)::text debit,sum(g.credit_amount)::text credit,
      sum(g.debit_fx)::text debit_fx,sum(g.credit_fx)::text credit_fx
    from journal j join gl_impact g on g.transaction_id=j.transaction_id
    where j.journal_id=$1
    group by g.accounting_book_id,g.account_id
    order by g.accounting_book_id,g.account_id
  `, [firstPost.journalId])).rows;

  const reversed = (await one('select opening_balance_reverse($1)value', [preview.run.id])).value;
  if (shiftedExistingAssets > 0) {
    await db.query("select set_config('app.opening_balance_internal','1',true)");
    await db.query('alter table asset disable trigger protect_depreciated_asset_values_trigger');
    await db.query('alter table asset disable trigger validate_fixed_asset_local_currency_trigger');
    await db.query(`
      update asset a set purchase_date=original.purchase_date,in_service_date=original.in_service_date
      from test_opening_existing_asset_dates original where a.asset_id=original.asset_id
    `);
    await db.query('alter table asset enable trigger validate_fixed_asset_local_currency_trigger');
    await db.query('alter table asset enable trigger protect_depreciated_asset_values_trigger');
    await db.query("select set_config('app.opening_balance_internal','',true)");
  }
  assert.match(reversed.number, /^REV-ASI-APERTURA-/);
  const reversalJournal = await one(
    `select to_char(journal_date, 'YYYY-MM-DD') journal_date,
            fiscal_period_id,
            reversed_from_journal_id
       from journal
      where journal_id=$1`,
    [reversed.reversalJournalId],
  );
  const expectedOpeningDate = setup.opening_date instanceof Date
    ? setup.opening_date.toISOString().slice(0, 10)
    : String(setup.opening_date);
  assert.equal(String(reversalJournal.journal_date), expectedOpeningDate);
  assert.equal(Number(reversalJournal.fiscal_period_id), Number(setup.current_period_id));
  assert.equal(Number(reversalJournal.reversed_from_journal_id), Number(firstPost.journalId));
  const reversalBookImpacts = (await db.query(`
    select g.accounting_book_id,g.account_id,
      sum(g.debit_amount)::text debit,sum(g.credit_amount)::text credit,
      sum(g.debit_fx)::text debit_fx,sum(g.credit_fx)::text credit_fx
    from journal j join gl_impact g on g.transaction_id=j.transaction_id
    where j.journal_id=$1
    group by g.accounting_book_id,g.account_id
    order by g.accounting_book_id,g.account_id
  `, [reversed.reversalJournalId])).rows;
  assert.deepEqual(
    reversalBookImpacts.map((row) => ({
      book: Number(row.accounting_book_id),account: Number(row.account_id),
      debit: toUnits(row.debit),credit: toUnits(row.credit),debitFx: toUnits(row.debit_fx),creditFx: toUnits(row.credit_fx),
    })),
    originalBookImpacts.map((row) => ({
      book: Number(row.accounting_book_id),account: Number(row.account_id),
      debit: toUnits(row.credit),credit: toUnits(row.debit),debitFx: toUnits(row.credit_fx),creditFx: toUnits(row.debit_fx),
    })),
    'La reversión debe conservar el libro original e invertir importes locales y de moneda origen.',
  );
  const reversedAsset = await one(
    'select asset_id,status,opening_reversed_at is not null reversed from asset where opening_run_id=$1',
    [preview.run.id],
  );
  assert.ok(reversedAsset?.reversed, 'La reversión debe conservar y marcar la ficha para mantener trazabilidad.');
  assert.equal(reversedAsset.status, 'INACTIVO');
  assert.equal(
    Number((await one('select count(*) n from asset_depreciation where opening_run_id=$1 and is_opening_balance', [preview.run.id])).n),
    1,
    'La depreciación histórica de apertura debe conservarse después de la reversión.',
  );
  const reversedDetail = (await one('select fixed_asset_detail($1)value', [reversedAsset.asset_id])).value;
  assert.equal(Number(reversedDetail.asset.id), Number(reversedAsset.asset_id));
  const operationalAssets = (await one("select fixed_asset_report('{}'::jsonb)value")).value.rows;
  assert.ok(!operationalAssets.some((row) => Number(row.id) === Number(reversedAsset.asset_id)));

  const existingRowsAfterLegacyRemoval = existingRows.map((row) => {
    if (row.kind === 'COST' && Number(row.account_id) === Number(setup.asset_account_id)) {
      return { ...row, amount: fromUnits(toUnits(row.amount) - toUnits(legacyFxLocal.cost_local)) };
    }
    if (row.kind === 'DEPRECIATION' && Number(row.account_id) === Number(setup.depreciation_account_id)) {
      return { ...row, amount: fromUnits(toUnits(row.amount) - toUnits(legacyFxLocal.depreciation_local)) };
    }
    return row;
  });
  const secondRows = buildLedgerRows(
    existingRowsAfterLegacyRemoval,
    setup,
    stagedCost,
    stagedAccumulated,
  );

  const secondPreview = (await one('select opening_balance_validate($1::jsonb)value', [
    JSON.stringify({ ...basePayload, rows: secondRows, assets: [matchingAsset] }),
  ])).value;
  const secondPost = (await one('select opening_balance_post($1)value', [secondPreview.run.id])).value;
  assert.notEqual(secondPost.journalNumber, firstPost.journalNumber, 'La reapertura de la misma fecha debe usar un número único.');
  assert.match(secondPost.journalNumber, new RegExp(`^ASI-APERTURA-${subsidiaryId}-\\d{8}(?:-\\d+)?$`));
  assert.equal(
    Number((await one('select count(distinct journal_number) n from journal where journal_id=any($1::bigint[])', [
      [firstPost.journalId, secondPost.journalId],
    ])).n),
    2,
  );

  const secondAsset = await one('select * from asset where opening_run_id=$1', [secondPreview.run.id]);
  assert.match(secondAsset.asset_number, /^ACT-\d{6}$/);
  const depreciationPreview = (await one('select fixed_asset_depreciation_preview(current_date)value')).value;
  const currentRow = depreciationPreview.rows.find((row) => Number(row.id) === Number(secondAsset.asset_id));
  assert.ok(currentRow, 'El activo de apertura debe poder depreciarse después de la fecha de apertura.');
  assert.equal(currentRow.processed, false, 'La fila histórica de apertura no debe marcar el período como procesado.');
  assert.equal(Number(currentRow.monthsConsumed), 1);

  const depreciationResult = (await one(
    'select run_fixed_asset_depreciation(current_date,$1::jsonb)value',
    [JSON.stringify([secondAsset.asset_id])],
  )).value;
  assert.equal(Number(depreciationResult.processed), 1);
  const depreciationRows = (await db.query(`
    select is_opening_balance,depreciated_months,depreciation_amount,fiscal_period_id
    from asset_depreciation where asset_id=$1 order by is_opening_balance desc
  `, [secondAsset.asset_id])).rows;
  assert.equal(depreciationRows.length, 2);
  assert.equal(depreciationRows.filter((row) => row.is_opening_balance).length, 1);
  assert.equal(depreciationRows.filter((row) => !row.is_opening_balance).length, 1);
  assert.ok(depreciationRows.every((row) => Number(row.fiscal_period_id) === Number(setup.current_period_id)));
  assert.equal(Number(depreciationRows.find((row) => !row.is_opening_balance).depreciated_months), 1);

  console.log(
    'OK: conciliaci?n local con FX, AUTO, m?todos de depreciaci?n, bloqueo del asiento, carga tard?a sobre POSTED, reversi?n y reapertura verificadas con rollback.',
  );
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
