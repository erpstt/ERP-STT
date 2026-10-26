import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  normalizeJournalServiceDimensions,
  normalizeJournalServiceMonths
} from '../dist/modules/accounting-catalogs/journal-import.service.js';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const automaticTypes = ['ASI_DIA', 'ASI_NOM', 'ASI_LIQ'];
const allTypes = [...automaticTypes, 'ASI_PEN'];

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");

  // Validate the migration without leaving schema or test records behind. If it
  // is already deployed, avoid wrapping the RPCs a second time.
  const installed = await one(`select
    to_regprocedure('public.automatic_journal_service_month(bigint)') is not null
    and to_regprocedure('public.import_journal_csv_before_automatic_service_month(jsonb,boolean,bigint)') is not null
    and (
      select count(*)
      from pg_trigger
      where tgrelid in ('public.journal'::regclass,'public.journal_line'::regclass)
        and tgname in(
          'enforce_automatic_journal_service_month_trigger',
          'refresh_automatic_journal_service_month_trigger'
        )
        and not tgisinternal
        and tgenabled<>'D'
    )=2 value`);
  const migrationInstalled = installed.value;
  const migrationSql = await readFile(
    new URL('../supabase/migrations/20261026190000_automatic_journal_service_month.sql', import.meta.url),
    'utf8'
  );
  if (!migrationInstalled) {
    await db.query(migrationSql);
  }
  const serviceDimensionsMigrationSql = await readFile(
    new URL('../supabase/migrations/20261026193000_normalize_journal_csv_service_dimensions.sql', import.meta.url),
    'utf8'
  );
  const importerDefinition = await one(`select pg_get_functiondef(
    'public.import_journal_csv(jsonb,boolean,bigint)'::regprocedure
  ) value`);
  const serviceDimensionsMigrationInstalled = /pais_servicio/.test(importerDefinition.value);
  if (!serviceDimensionsMigrationInstalled) {
    await db.query(serviceDimensionsMigrationSql);
  }

  const context = await one(`select
      app_user.email,
      app_user.auth_user_id::text sub,
      session.session_id,
      session.subsidiary_id
    from public.user_company_sessions session
    join public.users app_user using(user_id)
    join public.user_subsidiaries access
      on access.user_id=session.user_id
     and access.subsidiary_id=session.subsidiary_id
    where app_user.is_active
      and app_user.auth_user_id is not null
      and exists(
        select 1
        from public.locations location
        join public.location_subsidiaries scope using(location_id)
        where scope.subsidiary_id=session.subsidiary_id
      )
      and (
        select count(*)
        from public.chart_accounts account
        join public.account_subsidiaries scope using(account_id)
        where scope.subsidiary_id=session.subsidiary_id
          and scope.is_active
          and not coalesce(account.is_inactive,false)
          and coalesce(account.accepts_entries,true)
      )>=2
      and (
        select count(distinct to_char(period.start_date,'YYYY-MM'))
        from public.fiscal_periods period
        where period.subsidiary_id=session.subsidiary_id
          and not coalesce(period.is_inactive,false)
      )>=2
    order by session.selected_at desc
    limit 1`);
  assert.ok(context, 'Se requiere una sesión con subsidiaria, ubicación, cuentas y dos períodos activos.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);

  const subsidiary = await one(`select
      subsidiary.currency_id,
      currency.currency_code,
      coalesce(subsidiary.country_id,(select country_id from public.countries order by country_id limit 1)) country_id
    from public.subsidiaries subsidiary
    join public.currencies currency using(currency_id)
    where subsidiary.subsidiary_id=$1`, [context.subsidiary_id]);
  assert.ok(subsidiary?.country_id, 'Se requiere un país para las líneas ASI_PEN de prueba.');

  const periods = (await db.query(`select fiscal_period_id,
      to_char(start_date,'YYYY-MM-DD') journal_date,
      to_char(start_date,'YYYY-MM') service_month
    from (
      select distinct on (to_char(start_date,'YYYY-MM'))
        fiscal_period_id,start_date
      from public.fiscal_periods
      where subsidiary_id=$1
        and not coalesce(is_inactive,false)
      order by to_char(start_date,'YYYY-MM') desc,start_date desc
    ) selected
    order by start_date desc
    limit 2`, [context.subsidiary_id])).rows;
  assert.equal(periods.length, 2);
  assert.notEqual(periods[0].service_month, periods[1].service_month);

  const accounts = (await db.query(`select account.account_id,account.account_number
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1
      and scope.is_active
      and not coalesce(account.is_inactive,false)
      and coalesce(account.accepts_entries,true)
    order by account.account_id
    limit 2`, [context.subsidiary_id])).rows;
  assert.equal(accounts.length, 2);

  const journalTypes = new Map((await db.query(`select abbreviation,name
    from public.transaction_types
    where abbreviation=any($1::text[])`, [allTypes])).rows.map(row => [row.abbreviation, row.name]));
  assert.deepEqual([...journalTypes.keys()].sort(), [...allTypes].sort(), 'Deben estar configurados los cuatro tipos de asiento.');

  const line = (accountId, debit, credit, serviceMonth, includeCountry = false) => ({
    account_id: accountId,
    debit,
    credit,
    tax_code_id: '',
    tax_rate: '',
    gross_amount: Math.max(debit, credit),
    service_month: serviceMonth,
    ...(includeCountry ? { service_country_id: subsidiary.country_id } : {}),
    note: 'Prueba reversible de mes de servicio',
    entity_type: '',
    entity_id: '',
    department_id: '',
    class_id: '',
    cost_center_id: '',
    financial_creditor_id: '',
    related_company_id: ''
  });
  const lines = (months, includeCountry = false) => [
    line(accounts[0].account_id, 10, 0, months[0], includeCountry),
    line(accounts[1].account_id, 0, 4, months[1], includeCountry),
    line(accounts[1].account_id, 0, 6, months[2], includeCountry)
  ];
  const payload = (abbreviation, period, payloadLines) => ({
    journal_type: journalTypes.get(abbreviation),
    journal_date: period.journal_date,
    fiscal_period_id: period.fiscal_period_id,
    currency_id: subsidiary.currency_id,
    exchange_rate: 1,
    memo: `Prueba mes de servicio ${abbreviation}`,
    lines: payloadLines
  });
  const storedMonths = async journalId => (await db.query(`select service_month
    from public.journal_line
    where journal_id=$1
    order by journal_line_id`, [journalId])).rows.map(row => row.service_month);
  const storedCountries = async journalId => (await db.query(`select service_country_id
    from public.journal_line
    where journal_id=$1
    order by journal_line_id`, [journalId])).rows.map(row => row.service_country_id == null ? null : String(row.service_country_id));

  await db.query('set local role authenticated');

  let backfillJournalId;
  let typeChangeJournalId;
  for (const abbreviation of automaticTypes) {
    const originalPayload = payload(
      abbreviation,
      periods[1],
      lines(['1999-01', '1999-02', '1999-03'])
    );
    const created = await one('select public.create_journal_entry($1::jsonb) journal_id', [JSON.stringify(originalPayload)]);
    if (abbreviation === 'ASI_DIA') typeChangeJournalId = created.journal_id;
    else backfillJournalId ??= created.journal_id;
    assert.deepEqual(
      await storedMonths(created.journal_id),
      Array(3).fill(periods[1].service_month),
      `${abbreviation} debe calcular el mes en todas las líneas al crear.`
    );

    const changedDatePayload = payload(
      abbreviation,
      periods[0],
      lines(['1988-01', '1988-02', '1988-03'])
    );
    await db.query('select public.update_journal_entry($1,$2::jsonb)', [
      created.journal_id,
      JSON.stringify(changedDatePayload)
    ]);
    assert.deepEqual(
      await storedMonths(created.journal_id),
      Array(3).fill(periods[0].service_month),
      `${abbreviation} debe recalcular todas las líneas cuando cambia la fecha.`
    );
    const updatedHeader = await one(`select to_char(journal_date,'YYYY-MM') service_month
      from public.journal where journal_id=$1`, [created.journal_id]);
    assert.equal(updatedHeader.service_month, periods[0].service_month);

    // Exercise both database triggers directly: a caller cannot force another
    // month on a line, and changing only the header date refreshes every line.
    await db.query('reset role');
    await db.query(`update public.journal_line
      set service_month='1900-01'
      where journal_id=$1`, [created.journal_id]);
    assert.deepEqual(await storedMonths(created.journal_id), Array(3).fill(periods[0].service_month));
    await db.query(`update public.journal
      set journal_date=$2::date,fiscal_period_id=$3
      where journal_id=$1`, [created.journal_id, periods[1].journal_date, periods[1].fiscal_period_id]);
    assert.deepEqual(
      await storedMonths(created.journal_id),
      Array(3).fill(periods[1].service_month),
      `${abbreviation} debe refrescar todas las líneas si cambia solo la fecha del encabezado.`
    );
    await db.query('set local role authenticated');
  }

  // Editing can change an ASI_DIA into ASI_PEN without renumbering the journal.
  // A legacy ASI_DIA-* prefix must not override the now-explicit pending type.
  const typeChangeMonths = ['2022-01', '2022-02', '2022-03'];
  const originalAutomaticNumber = await one(`select journal_number
    from public.journal where journal_id=$1`, [typeChangeJournalId]);
  assert.match(originalAutomaticNumber.journal_number, /^ASI_DIA-/);
  await db.query('select public.update_journal_entry($1,$2::jsonb)', [
    typeChangeJournalId,
    JSON.stringify(payload('ASI_PEN', periods[0], lines(typeChangeMonths, true)))
  ]);
  const changedToPending = await one(`select journal_number,journal_type
    from public.journal where journal_id=$1`, [typeChangeJournalId]);
  assert.equal(changedToPending.journal_number, originalAutomaticNumber.journal_number);
  assert.equal(changedToPending.journal_type, journalTypes.get('ASI_PEN'));
  assert.deepEqual(
    await storedMonths(typeChangeJournalId),
    typeChangeMonths,
    'ASI_PEN debe conservar meses explícitos aunque mantenga un prefijo histórico ASI_DIA.'
  );

  const pendingCreateMonths = ['2024-01', '2024-02', '2024-03'];
  const pendingUpdateMonths = ['2025-04', '2025-05', '2025-06'];
  const pendingPayload = payload('ASI_PEN', periods[1], lines(pendingCreateMonths, true));
  const pending = await one('select public.create_journal_entry($1::jsonb) journal_id', [JSON.stringify(pendingPayload)]);
  assert.deepEqual(await storedMonths(pending.journal_id), pendingCreateMonths, 'ASI_PEN debe conservar cada mes explícito.');

  const pendingChangedDate = payload('ASI_PEN', periods[0], lines(pendingUpdateMonths, true));
  await db.query('select public.update_journal_entry($1,$2::jsonb)', [
    pending.journal_id,
    JSON.stringify(pendingChangedDate)
  ]);
  assert.deepEqual(
    await storedMonths(pending.journal_id),
    pendingUpdateMonths,
    'Cambiar la fecha de ASI_PEN no debe reemplazar sus meses explícitos.'
  );

  // A non-manual accounting journal can still be linked to the historical
  // ASI_DIA transaction type by journal_transaction_sync. That link must not
  // classify opening balances, invoices or payments as manual ASI_DIA entries.
  await db.query('reset role');
  const nonAutomaticNumber = `TEST-NON-AUTO-${Date.now()}`;
  const nonAutomatic = await one(`insert into public.journal(
      journal_number,journal_date,subsidiary_id,currency_id,fiscal_period_id,
      exchange_rate,memo,journal_type,total_debit,total_credit
    ) values($1,$2::date,$3,$4,$5,1,'Prueba fuera de alcance','APERTURA',10,10)
    returning journal_id,transaction_id`, [
    nonAutomaticNumber,
    periods[1].journal_date,
    context.subsidiary_id,
    subsidiary.currency_id,
    periods[1].fiscal_period_id
  ]);
  await db.query(`insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,gross_amount,note,service_month
    ) values
      ($1,$2,10,0,10,0,10,'Fuera de alcance','2020-01'),
      ($1,$3,0,10,0,10,10,'Fuera de alcance','2020-02')`, [
    nonAutomatic.journal_id,
    accounts[0].account_id,
    accounts[1].account_id
  ]);
  const nonAutomaticClassification = await one(`select
      public.automatic_journal_service_month(entry.journal_id) automatic_month,
      transaction_type.abbreviation transaction_abbreviation
    from public.journal entry
    join public."transaction" source_transaction using(transaction_id)
    join public.transaction_types transaction_type using(transaction_type_id)
    where entry.journal_id=$1`, [nonAutomatic.journal_id]);
  assert.equal(nonAutomaticClassification.transaction_abbreviation, 'ASI_DIA');
  assert.equal(nonAutomaticClassification.automatic_month, null);
  assert.deepEqual(await storedMonths(nonAutomatic.journal_id), ['2020-01', '2020-02']);

  // Simulate an old malformed row and rerun the idempotent migration. The
  // repair must touch only automatic manual journals, never ASI_PEN or APERTURA.
  await db.query('alter table public.journal_line disable trigger user');
  await db.query(`update public.journal_line
    set service_month='1901-01'
    where journal_id=$1`, [backfillJournalId]);
  await db.query('alter table public.journal_line enable trigger user');
  assert.deepEqual(await storedMonths(backfillJournalId), Array(3).fill('1901-01'));
  await db.query(migrationSql);
  await db.query(serviceDimensionsMigrationSql);
  assert.deepEqual(
    await storedMonths(backfillJournalId),
    Array(3).fill(periods[1].service_month),
    'El backfill debe reparar todas las líneas automáticas históricas.'
  );
  assert.deepEqual(await storedMonths(pending.journal_id), pendingUpdateMonths, 'El backfill no debe modificar ASI_PEN.');
  assert.deepEqual(await storedMonths(typeChangeJournalId), typeChangeMonths, 'El backfill debe respetar el tipo ASI_PEN sobre su prefijo histórico.');
  assert.deepEqual(await storedMonths(nonAutomatic.journal_id), ['2020-01', '2020-02'], 'El backfill no debe modificar APERTURA.');
  await db.query('set local role authenticated');

  await db.query('savepoint invalid_pending_month');
  await assert.rejects(
    db.query('select public.update_journal_entry($1,$2::jsonb)', [
      pending.journal_id,
      JSON.stringify(payload('ASI_PEN', periods[0], lines(['2026-13', '2025-05', '2025-06'], true)))
    ]),
    /Mes de servicio inválido|AAAA-MM/i
  );
  await db.query('rollback to savepoint invalid_pending_month');
  assert.deepEqual(await storedMonths(pending.journal_id), pendingUpdateMonths, 'Una edición inválida no debe alterar las líneas.');

  const templateRate = '987.654321';
  const csvRow = (abbreviation, reference, index, serviceMonth = '', serviceCountry = '') => ({
    asiento_referencia: reference,
    tipo_asiento: abbreviation,
    fecha: periods[1].journal_date,
    moneda: subsidiary.currency_code,
    tipo_cambio: templateRate,
    nota_asiento: `Prueba CSV ${abbreviation}`,
    numero_cuenta: index === 0 ? accounts[0].account_number : accounts[1].account_number,
    debito: index === 0 ? '10.00' : '0.00',
    credito: index === 0 ? '0.00' : index === 1 ? '4.00' : '6.00',
    nota_linea: `Línea ${index + 1}`,
    mes_servicio: serviceMonth,
    pais_servicio: serviceCountry,
    entidad: '',
    nombre: '',
    departamento: '',
    centro_costos: '',
    clase: '',
    acreedor_financiero: '',
    compania_relacionada: ''
  });
  const importCsv = async (rows, preview = false) => (await one(
    'select public.import_journal_csv($1::jsonb,$2,$3) result',
    [JSON.stringify(rows), preview, context.subsidiary_id]
  )).result;
  const stamp = Date.now();

  for (const abbreviation of allTypes) {
    const reference = `SERVICE-MONTH-${abbreviation}-${stamp}`;
    const explicitPendingMonths = ['2023-07', '2023-08', '2023-09'];
    const rawRows = [0, 1, 2].map(index => csvRow(
      abbreviation,
      reference,
      index,
      abbreviation === 'ASI_PEN' ? explicitPendingMonths[index] : `1999-0${index + 1}`,
      `ID:${subsidiary.country_id}`
    ));
    const normalizedMonths = normalizeJournalServiceMonths(rawRows);
    const normalizedRows = normalizeJournalServiceDimensions(rawRows);
    if (automaticTypes.includes(abbreviation)) {
      assert.ok(rawRows.every(row => row.mes_servicio.startsWith('1999-')));
      assert.ok(rawRows.every(row => row.pais_servicio === `ID:${subsidiary.country_id}`));
      assert.ok(normalizedMonths.every(row => row.mes_servicio === ''), `${abbreviation} debe ignorar el mes escrito en el CSV.`);
      assert.ok(normalizedRows.every(row => row.mes_servicio === ''), `${abbreviation} debe ignorar el mes escrito en el CSV.`);
      assert.ok(normalizedRows.every(row => !Object.hasOwn(row, 'pais_servicio')), `${abbreviation} debe ignorar el país escrito en el CSV.`);
    } else {
      assert.ok(normalizedRows.every(row => row.pais_servicio === `ID:${subsidiary.country_id}`));
    }
    // Send the raw rows to cover direct RPC callers. The database wrapper must
    // normalize them just like the TypeScript boundary above.
    const saved = await importCsv(rawRows);
    assert.equal(saved.valid, true, JSON.stringify(saved.errors));
    assert.equal(saved.created, 1);
    assert.deepEqual(
      await storedMonths(saved.entries[0].journalId),
      abbreviation === 'ASI_PEN' ? explicitPendingMonths : Array(3).fill(periods[1].service_month),
      `La importación ${abbreviation} debe persistir el mes correcto en todas las líneas.`
    );
    assert.deepEqual(
      await storedCountries(saved.entries[0].journalId),
      abbreviation === 'ASI_PEN'
        ? Array(3).fill(String(subsidiary.country_id))
        : Array(3).fill(null),
      `La importación ${abbreviation} debe persistir el país de servicio correcto.`
    );
    const storedHeader = await one(`select exchange_rate
      from public.journal where journal_id=$1`, [saved.entries[0].journalId]);
    assert.equal(Number(storedHeader.exchange_rate), Number(templateRate), 'Debe conservar la tasa indicada en la plantilla.');
    if (automaticTypes.includes(abbreviation)) {
      const withoutCountry = rawRows.map(({ pais_servicio, ...row }) => row);
      const duplicate = await importCsv(withoutCountry);
      assert.equal(duplicate.alreadyImported, true, `${abbreviation} debe detectar el mismo lote aunque el país se omita.`);
      assert.equal(String(duplicate.entries[0].journalId), String(saved.entries[0].journalId));
    }
  }

  const invalidAmounts = [0, 1, 2].map(index => csvRow(
    'ASI_DIA',
    `INVALID-AMOUNTS-${stamp}`,
    index,
    '1999-01',
    `ID:${subsidiary.country_id}`
  ));
  invalidAmounts[1] = { ...invalidAmounts[1], debito: '4.00', credito: '4.00' };
  const rejectedAmounts = await importCsv(invalidAmounts, true);
  assert.equal(rejectedAmounts.valid, false);
  assert.ok(rejectedAmounts.errors.some(error => /solo débito o crédito/i.test(String(error.message))));

  const rejectedPending = await importCsv([0, 1, 2].map(index => csvRow(
    'ASI_PEN',
    `INVALID-PENDING-MONTH-${stamp}`,
    index,
    index === 0 ? '2026-13' : '2026-01',
    `ID:${subsidiary.country_id}`
  )), true);
  assert.equal(rejectedPending.valid, false);
  assert.ok(rejectedPending.errors.some(error => /AAAA-MM|mes de servicio/i.test(String(error.message))));

  const missingPendingCountry = await importCsv([0, 1, 2].map(index => csvRow(
    'ASI_PEN',
    `MISSING-PENDING-COUNTRY-${stamp}`,
    index,
    '2026-01',
    ''
  )), true);
  assert.equal(missingPendingCountry.valid, false);
  assert.ok(missingPendingCountry.errors.some(error => /país de servicio.*obligatorio/i.test(String(error.message))));

  const invalidPendingCountry = await importCsv([0, 1, 2].map(index => csvRow(
    'ASI_PEN',
    `INVALID-PENDING-COUNTRY-${stamp}`,
    index,
    '2026-01',
    'ID:999999999999'
  )), true);
  assert.equal(invalidPendingCountry.valid, false);
  assert.ok(invalidPendingCountry.errors.some(error => /país de servicio.*no existe|ambiguo/i.test(String(error.message))));

  await db.query('reset role');
  await db.query('rollback');
  console.log(JSON.stringify({
    migration: migrationInstalled ? 'already-installed' : 'validated-with-rollback',
    manualCreate: automaticTypes,
    manualDateChange: automaticTypes,
    everyLineChecked: true,
    directLineAndHeaderTriggers: true,
    historicalBackfill: true,
    outOfScopeJournalPreserved: true,
    typeChangeToPendingPreserved: true,
    pendingExplicitMonthPreserved: true,
    pendingInvalidMonthRejected: true,
    csvRawMonthNormalized: automaticTypes,
    csvRawCountryNormalized: automaticTypes,
    pendingCountryPreserved: true,
    pendingCountryRequired: true,
    countryFingerprintStable: true,
    invalidAmountsStillRejected: true,
    templateExchangeRatePreserved: true,
    csvTypesChecked: allTypes,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
