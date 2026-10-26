import assert from 'node:assert/strict';
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

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='180s'");
  const chainReady = (await db.query(`select
    to_regprocedure('public.reverse_opening_pending_invoice_before_support_integrity(bigint,jsonb)') is not null
      and to_regprocedure('public.reverse_pending_invoice_journal_before_support_integrity(bigint,jsonb)') is not null value`)).rows[0].value;
  assert.equal(chainReady, true, 'Instale la cadena completa de migraciones de pendientes antes de ejecutar esta prueba.');

  const tables = (await db.query(`
    select relname from pg_class
    where relnamespace='public'::regnamespace and relname=any($1::text[])
  `, [[
    'opening_pending_invoice_items',
    'opening_pending_invoice_lines',
    'opening_pending_invoice_supports',
  ]])).rows.map((row) => row.relname).sort();
  assert.deepEqual(tables, [
    'opening_pending_invoice_items',
    'opening_pending_invoice_lines',
    'opening_pending_invoice_supports',
  ].sort());

  const sourceConstraint = (await db.query(`
    select pg_get_constraintdef(oid) definition from pg_constraint
    where conrelid='pending_invoice_reversal'::regclass
      and conname='pending_invoice_reversal_one_source'
  `)).rows[0]?.definition;
  assert.match(sourceConstraint || '', /source_journal_id IS NOT NULL.*<>.*source_opening_pending_id IS NOT NULL/i);

  const definitions = Object.fromEntries((await db.query(`
    select proname,pg_get_functiondef(oid) definition from pg_proc
    where pronamespace='public'::regnamespace and proname=any($1::text[])
  `, [[
    'opening_pending_invoice_stage',
    'opening_pending_invoice_reconciliation',
    'reverse_opening_pending_invoice',
    'reverse_opening_pending_invoice_before_period_type',
    'reverse_opening_pending_invoice_before_historical_fx_integrity',
    'reverse_opening_pending_invoice_before_support_integrity',
    'run_pending_invoice_control_report_before_consolidation',
  ]])).rows.map((row) => [row.proname, row.definition]));
  const openingReversalDefinition = definitions.reverse_opening_pending_invoice_before_period_type
    || definitions.reverse_opening_pending_invoice_before_historical_fx_integrity
    || definitions.reverse_opening_pending_invoice_before_support_integrity
    || definitions.reverse_opening_pending_invoice;
  assert.match(definitions.opening_pending_invoice_stage, /113003/);
  assert.match(definitions.opening_pending_invoice_stage, /413001/);
  assert.match(definitions.opening_pending_invoice_stage, /113003 al debe y 413001 al haber/i);
  assert.match(openingReversalDefinition, /counterpart_account,amount_value,0,foreign_value,0/i);
  assert.match(openingReversalDefinition, /control_account,0,amount_value,0,foreign_value/i);
  assert.match(openingReversalDefinition, /original_currency_id/i);
  assert.match(definitions.reverse_opening_pending_invoice, /reverse_opening_pending_invoice_before_support_integrity/i);
  assert.match(definitions.run_pending_invoice_control_report_before_consolidation, /'OPENING'/i);

  // Use existing master data but create every transactional test record inside
  // this transaction. ROLLBACK leaves the connected database unchanged.
  const fixture = (await db.query(`
    select ucs.session_id,u.user_id,u.email,au.id auth_id,s.subsidiary_id,
      s.currency_id local_currency_id,s.country_id,b.accounting_book_id,
      party.customer_id,party.tax_id,party.cost_center_id,
      control.account_id control_account,counterpart.account_id counterpart_account,
      transition.account_id transition_account,
      period.opening_date,period.reversal_date
    from user_company_sessions ucs
    join user_role_sessions urs on urs.session_id=ucs.session_id and urs.user_id=ucs.user_id
    join roles role on role.role_id=urs.role_id and lower(role.role_name)in('administrador','administrator','admin')
    join users u on u.user_id=ucs.user_id and u.is_active
    join auth.users au on lower(au.email)=lower(u.email)
    join user_subsidiaries access on access.user_id=u.user_id and access.subsidiary_id=ucs.subsidiary_id
    join subsidiaries s on s.subsidiary_id=ucs.subsidiary_id and s.is_active
    join accounting_books b on b.subsidiary_id=s.subsidiary_id and b.is_primary and b.is_active
    join chart_accounts control on control.account_number='113003'and control.accepts_entries and not control.is_inactive
    join account_subsidiaries control_link on control_link.account_id=control.account_id and control_link.subsidiary_id=s.subsidiary_id and control_link.is_active
    join chart_accounts counterpart on counterpart.account_number='413001'and counterpart.accepts_entries and not counterpart.is_inactive
    join account_subsidiaries counterpart_link on counterpart_link.account_id=counterpart.account_id and counterpart_link.subsidiary_id=s.subsidiary_id and counterpart_link.is_active
    join chart_accounts transition on transition.account_number='319999'and transition.accepts_entries and not transition.is_inactive
    join account_subsidiaries transition_link on transition_link.account_id=transition.account_id and transition_link.subsidiary_id=s.subsidiary_id and transition_link.is_active
    join lateral(
      select customer.customer_id,customer.tax_id,center.cost_center_id
      from customers customer
      join lateral(
       select cc.cost_center_id from cost_centers cc
       where cc.subsidiary_id=s.subsidiary_id and not cc.is_inactive
        and(cc.customer_id is null or cc.customer_id=customer.customer_id)
       order by(cc.customer_id is null)desc,cc.cost_center_id limit 1
      )center on true
      where customer.tax_id is not null and(
       customer.primary_subsidiary_id=s.subsidiary_id
       or exists(select 1 from entity_subsidiaries e where e.customer_id=customer.customer_id and e.subsidiary_id=s.subsidiary_id)
      )order by customer.customer_id limit 1
    )party on true
    join lateral(
      select (fp.start_date+1)::date reversal_date,fp.start_date::date opening_date
      from fiscal_periods fp
      where fp.subsidiary_id=s.subsidiary_id
       and not fp.is_closed and not coalesce(fp.gl_closed,false)and not coalesce(fp.is_inactive,false)
       and fp.start_date+1<=least(current_date,fp.end_date)
       and not exists(select 1 from asset a where a.subsidiary_id=s.subsidiary_id and a.purchase_date<=fp.start_date and a.opening_reversed_at is null)
      order by fp.start_date limit 1
    )period on true
    where not exists(
      select 1 from opening_balance_runs opening
      where opening.subsidiary_id=s.subsidiary_id and opening.status='POSTED'
    )
    order by ucs.selected_at desc limit 1
  `)).rows[0];
  if (!fixture) {
    const diagnostics = (await db.query(`
      select
       (select count(*)from opening_balance_runs where status='POSTED') posted_runs,
       (select count(*)from chart_accounts where account_number in('113003','413001','319999')) required_accounts,
       (select count(*)from customers) customers,
       (select count(*)from cost_centers where not is_inactive) cost_centers,
       (select count(*)from fiscal_periods where start_date<current_date and not is_closed and not coalesce(gl_closed,false)and not coalesce(is_inactive,false)) open_periods,
       (select count(*)from user_company_sessions ucs join user_role_sessions urs using(session_id,user_id)
        join roles r using(role_id)where lower(r.role_name)in('administrador','administrator','admin')) admin_sessions,
       (select jsonb_agg(to_jsonb(x))from(
        select s.subsidiary_id,
         exists(select 1 from user_company_sessions ucs join user_role_sessions urs using(session_id,user_id)join roles r using(role_id)
          where ucs.subsidiary_id=s.subsidiary_id and lower(r.role_name)in('administrador','administrator','admin'))admin,
         exists(select 1 from accounting_books b where b.subsidiary_id=s.subsidiary_id and b.is_primary and b.is_active)book,
         (select count(*)from account_subsidiaries a join chart_accounts c using(account_id)
          where a.subsidiary_id=s.subsidiary_id and a.is_active and c.account_number in('113003','413001','319999')and c.accepts_entries and not c.is_inactive)accounts,
         exists(select 1 from customers c where c.tax_id is not null and(c.primary_subsidiary_id=s.subsidiary_id or exists(select 1 from entity_subsidiaries e where e.customer_id=c.customer_id and e.subsidiary_id=s.subsidiary_id)))customer,
         exists(select 1 from cost_centers c where c.subsidiary_id=s.subsidiary_id and not c.is_inactive)cost_center,
         exists(select 1 from fiscal_periods f where f.subsidiary_id=s.subsidiary_id and f.start_date<=least(current_date,f.end_date)-1 and not f.is_closed and not coalesce(f.gl_closed,false)and not coalesce(f.is_inactive,false))period
        from subsidiaries s where s.is_active order by s.subsidiary_id
       )x)candidates
    `)).rows[0];
    throw new Error(`Faltan datos maestros para la prueba operativa: ${JSON.stringify(diagnostics)}`);
  }

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: fixture.auth_id,
    email: fixture.email,
    session_id: fixture.session_id,
    role: 'authenticated',
  })]);
  assert.equal(String((await db.query('select active_subsidiary_id() sid')).rows[0].sid), String(fixture.subsidiary_id));

  const foreignCurrency = (await db.query(`
    select currency_id,currency_code from currencies
    where currency_id<>$1 order by case when currency_code='USD'then 0 else 1 end,currency_code limit 1
  `, [fixture.local_currency_id])).rows[0];
  assert.ok(foreignCurrency, 'Se requiere una segunda moneda para validar el snapshot multimoneda.');
  await db.query(`
    insert into subsidiary_currencies(subsidiary_id,currency_id,is_primary)
    values($1,$2,false)on conflict(subsidiary_id,currency_id)do nothing
  `, [fixture.subsidiary_id, foreignCurrency.currency_id]);
  const country = (await db.query(`
    select coalesce(country_code_iso3,country_code_iso2,name)value
    from countries where country_id=$1
  `, [fixture.country_id])).rows[0].value;

  const reference = `TEST-OPEN-PEN-${Date.now()}`;
  const serviceMonth = new Date(fixture.opening_date).toISOString().slice(0, 7);
  const payload = {
    expectedSubsidiaryId: String(fixture.subsidiary_id),
    openingDate: new Date(fixture.opening_date).toISOString().slice(0, 10),
    loadType: 'FISCAL_YEAR',
    transitionAccountId: String(fixture.transition_account),
    assets: [],
    rows: [
      { sourceType: 'GL', sourceRow: 2, account: '113003', currency: foreignCurrency.currency_code, debit: 100, credit: 0, debitFx: 40, creditFx: 0, note: 'Control pendiente inicial' },
      { sourceType: 'GL', sourceRow: 3, account: '319999', currency: foreignCurrency.currency_code, debit: 0, credit: 100, debitFx: 0, creditFx: 40, note: 'Contrapartida de apertura' },
    ],
    pending: [{
      reference,
      originDate: new Date(fixture.opening_date).toISOString().slice(0, 10),
      entityTaxId: fixture.tax_id,
      currency: foreignCurrency.currency_code,
      exchangeRate: 2.5,
      periodType: 'ACTUAL',
      serviceMonth,
      serviceCountry: country,
      supportUrl: 'https://example.com/respaldo-prueba',
      note: 'Prueba automática reversible',
      lines: [
        { sourceRow: 2, account: '113003', debit: 100, credit: 0, debitFx: 40, creditFx: 0, isControlLine: true },
        { sourceRow: 3, account: '413001', debit: 0, credit: 100, debitFx: 0, creditFx: 40, isControlLine: false, costCenter: `ID:${fixture.cost_center_id}` },
      ],
    }],
  };

  const preview = (await db.query('select opening_balance_validate($1::jsonb)value', [JSON.stringify(payload)])).rows[0].value;
  const runId = preview.run.id;
  assert.equal(preview.pendingItems.length, 1);
  assert.equal(preview.pendingItems[0].reference, reference);
  assert.equal(preview.pendingItems[0].supportUrl, 'https://example.com/respaldo-prueba');
  assert.equal(Number(preview.pendingSummary.count), 1);
  assert.equal(preview.pendingSummary.balanced, true);
  assert.equal(preview.pendingReconciliation.length, 1);
  assert.equal(Number(preview.pendingReconciliation[0].ledger), 100);
  assert.equal(Number(preview.pendingReconciliation[0].existing), 0);
  assert.equal(Number(preview.pendingReconciliation[0].staged), 100);
  assert.equal(Number(preview.pendingReconciliation[0].difference), 0);
  assert.equal(Number(preview.pendingReconciliation[0].foreignDifference), 0);

  const posted = (await db.query('select opening_balance_post($1)value', [runId])).rows[0].value;
  assert.equal(Number(posted.pendingActivated), 1);
  const openingImpacts = (await db.query(`
    select a.account_number,g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx,g.original_currency_id
    from journal j join gl_impact g using(transaction_id)join chart_accounts a using(account_id)
    where j.journal_id=$1 order by a.account_number
  `, [posted.journalId])).rows;
  assert.equal(openingImpacts.length, 2, 'El auxiliar no debe crear impactos adicionales en el Mayor.');
  assert.equal(openingImpacts.filter((row) => row.account_number === '113003').length, 1);
  const activeReconciliation = (await db.query('select opening_pending_invoice_reconciliation($1)value', [runId])).rows[0].value;
  assert.equal(Number(activeReconciliation[0].existing), 100);
  assert.equal(Number(activeReconciliation[0].staged), 0);
  assert.equal(Number(activeReconciliation[0].difference), 0);

  const item = (await db.query(`
    select i.id,l.cost_center_id from opening_pending_invoice_items i
    join opening_pending_invoice_lines l on l.item_id=i.id and l.line_role='COUNTERPART'
    where i.run_id=$1 and i.reference=$2
  `, [runId, reference])).rows[0];
  assert.equal(String(item.cost_center_id), String(fixture.cost_center_id));

  const reversalDate = new Date(fixture.reversal_date).toISOString().slice(0, 10);
  const reverse = async (amount, reason, { unified = false, supports = [] } = {}) => (await db.query(
    unified
      ? 'select reverse_pending_invoice_journal($1,$2::jsonb)value'
      : 'select reverse_opening_pending_invoice($1,$2::jsonb)value',
    [unified ? -Number(item.id) : item.id, JSON.stringify({
      reversalDate, amount, type: 'ERROR_CORRECCION', errorDescription: reason, supports,
    })],
  )).rows[0].value;
  const partial = await reverse(30, 'Prueba controlada de reversión parcial', {
    unified: true,
    supports: [
      { support_type: 'Archivo', display_name: 'apertura.txt', file_name: 'apertura.txt', mime_type: 'text/plain', file_size: 6, file_data: 'data:text/plain;base64,UHJ1ZWJh' },
      { support_type: 'Enlace', display_name: 'Soporte apertura', support_url: 'https://example.com/apertura' },
    ],
  });
  const partialSupports = (await db.query(`select support_type,display_name,support_url,file_data
    from journal_support where journal_id=$1 order by support_type`, [partial.journalId])).rows;
  assert.equal(partialSupports.length, 2, 'La ruta unificada debe guardar cada respaldo una sola vez.');
  assert.equal(partialSupports.find((support) => support.support_type === 'Archivo')?.file_data, 'data:text/plain;base64,UHJ1ZWJh');
  assert.equal(partialSupports.find((support) => support.support_type === 'Enlace')?.support_url, 'https://example.com/apertura');
  const journalCountBeforeBlockedGeneric = Number((await db.query('select count(*)n from journal')).rows[0].n);
  await db.query('savepoint generic_reversal_must_fail');
  await assert.rejects(
    db.query('select reverse_journal_entry($1)', [partial.journalId]),
    /No se puede anular genéricamente una reversión controlada/,
  );
  await db.query('rollback to savepoint generic_reversal_must_fail');
  assert.equal(Number((await db.query('select count(*)n from journal')).rows[0].n), journalCountBeforeBlockedGeneric);
  assert.equal((await db.query('select status from journal where journal_id=$1', [partial.journalId])).rows[0].status, 'CONTABILIZADO');
  const final = await reverse(70, 'Prueba controlada de reversión final', {
    supports: [{ support_type: 'Enlace', display_name: 'Cierre apertura', support_url: 'https://example.com/cierre-apertura' }],
  });
  const finalSupports = (await db.query('select support_type,support_url from journal_support where journal_id=$1', [final.journalId])).rows;
  assert.deepEqual(finalSupports, [{ support_type: 'Enlace', support_url: 'https://example.com/cierre-apertura' }]);

  const assertReversal = async (journalId, local, foreign) => {
    const lines = (await db.query(`
      select a.account_number,l.debit,l.credit,l.debit_fx,l.credit_fx,l.service_month,l.service_country_id,l.cost_center_id
      from journal_line l join chart_accounts a using(account_id)
      where l.journal_id=$1 order by a.account_number
    `, [journalId])).rows;
    assert.deepEqual(lines.map((line) => ({
      account: line.account_number,
      debit: Number(line.debit),
      credit: Number(line.credit),
      debitFx: Number(line.debit_fx),
      creditFx: Number(line.credit_fx),
    })), [
      { account: '113003', debit: 0, credit: foreign, debitFx: 0, creditFx: foreign },
      { account: '413001', debit: foreign, credit: 0, debitFx: foreign, creditFx: 0 },
    ]);
    assert.ok(lines.every((line) => line.service_month === serviceMonth));
    assert.ok(lines.every((line) => String(line.service_country_id) === String(fixture.country_id)));
    assert.equal(String(lines.find((line) => line.account_number === '413001').cost_center_id), String(fixture.cost_center_id));

    const impacts = (await db.query(`
      select a.account_number,g.debit_amount,g.credit_amount,g.debit_fx,g.credit_fx,g.original_currency_id
      from journal j join gl_impact g using(transaction_id)join chart_accounts a using(account_id)
      where j.journal_id=$1 order by a.account_number
    `, [journalId])).rows;
    assert.deepEqual(impacts.map((impact) => ({
      account: impact.account_number,
      debit: Number(impact.debit_amount),
      credit: Number(impact.credit_amount),
      debitFx: Number(impact.debit_fx),
      creditFx: Number(impact.credit_fx),
      currencyId: String(impact.original_currency_id),
    })), [
      { account: '113003', debit: 0, credit: local, debitFx: 0, creditFx: foreign, currencyId: String(foreignCurrency.currency_id) },
      { account: '413001', debit: local, credit: 0, debitFx: foreign, creditFx: 0, currencyId: String(foreignCurrency.currency_id) },
    ]);
  };
  await assertReversal(partial.journalId, 30, 12);
  await assertReversal(final.journalId, 70, 28);

  const finalItem = (await db.query(`
    select reversal_status,reversed_local,reversed_foreign,balance_local,balance_foreign
    from opening_pending_invoice_items where id=$1
  `, [item.id])).rows[0];
  assert.equal(finalItem.reversal_status, 'REVERSADO_TOTAL');
  assert.equal(Number(finalItem.reversed_local), 100);
  assert.equal(Number(finalItem.reversed_foreign), 40);
  assert.equal(Number(finalItem.balance_local), 0);
  assert.equal(Number(finalItem.balance_foreign), 0);

  const report = (await db.query('select run_pending_invoice_control_report($1::jsonb)value', [JSON.stringify({
    subsidiaryIds: [fixture.subsidiary_id],
    dateFrom: '1900-01-01',
    dateTo: '2999-12-31',
  })])).rows[0].value;
  assert.ok(report.rows.some((row) => Number(row.journal_id) === -Number(item.id) && row.source_type === 'OPENING'));

  console.log(JSON.stringify({
    migration: 'preinstalled',
    reconciled: true,
    noDuplicateGl: true,
    foreignCurrencySnapshot: true,
    partialAndFinalReversal: true,
    genericReversalBlocked: true,
    reversalDebit: '413001',
    reversalCredit: '113003',
    serviceDimensionsPreserved: true,
    openingSupportsPersistedOnce: true,
    controlReportIntegrated: true,
    rollback: true,
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
