import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

if (!process.env.SUPABASE_URL) throw new Error('Falta SUPABASE_URL en el entorno.');
if (!process.env.SUPABASE_DB_PASSWORD && !process.env.PGPASSWORD) {
  throw new Error('Falta SUPABASE_DB_PASSWORD o PGPASSWORD en el entorno.');
}

const skipMigration = process.argv.includes('--skip-migration');
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

const [annualReclassificationMigration, historicalFxIntegrityMigration] = await Promise.all([
  '20261021120000_pending_invoice_annual_reclassification.sql',
  '20261021130000_pending_reversal_historical_fx_integrity.sql',
].map((name) => readFile(
  new URL(`../supabase/migrations/${name}`, import.meta.url),
  'utf8',
)));
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const number = (value) => Number(value);
const stamp = `RECLASS-${Date.now()}`;

async function withSavepoint(name, action, expected) {
  await db.query(`savepoint ${name}`);
  try {
    await assert.rejects(action, expected);
  } finally {
    await db.query(`rollback to savepoint ${name}`);
    await db.query('reset role');
  }
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='240s'");
  if (!skipMigration) await db.query(annualReclassificationMigration);

  const acl = await one(`select
    has_function_privilege('authenticated','public.pending_invoice_reclassification_preview(date)','EXECUTE') auth_preview,
    has_function_privilege('authenticated','public.pending_invoice_reclassification_execute(date)','EXECUTE') auth_execute,
    not has_function_privilege('anon','public.pending_invoice_reclassification_preview(date)','EXECUTE') anon_no_preview,
    not has_function_privilege('anon','public.pending_invoice_reclassification_execute(date)','EXECUTE') anon_no_execute,
    not has_function_privilege('authenticated','public.opening_pending_invoice_stage(bigint,jsonb)','EXECUTE') auth_no_opening_stage,
    not has_function_privilege('anon','public.opening_pending_invoice_stage(bigint,jsonb)','EXECUTE') anon_no_opening_stage,
    not has_table_privilege('authenticated','public.pending_invoice_reclassification_runs','INSERT') no_direct_run_insert,
    not has_table_privilege('authenticated','public.pending_invoice_reclassification_items','UPDATE') no_direct_item_update,
    not has_table_privilege('authenticated','public.pending_invoice_reversal','INSERT') no_direct_reversal_insert,
    not has_table_privilege('authenticated','public.pending_invoice_reversal','UPDATE') no_direct_reversal_update,
    not has_table_privilege('authenticated','public.pending_invoice_reversal','DELETE') no_direct_reversal_delete,
    not has_table_privilege('anon','public.pending_invoice_reversal','INSERT,UPDATE,DELETE') anon_no_reversal_dml,
    not has_table_privilege('authenticated','public.gl_impact','INSERT') no_direct_gl_insert,
    not has_table_privilege('authenticated','public.gl_impact','UPDATE') no_direct_gl_update,
    not has_table_privilege('authenticated','public.gl_impact','DELETE') no_direct_gl_delete,
    not has_table_privilege('anon','public.gl_impact','INSERT,UPDATE,DELETE') anon_no_gl_dml,
    not has_function_privilege('authenticated','public.sync_journal_gl_impacts(bigint)','EXECUTE') auth_no_gl_sync,
    not has_function_privilege('anon','public.sync_journal_gl_impacts(bigint)','EXECUTE') anon_no_gl_sync`);
  assert.ok(Object.values(acl).every(Boolean), `Privilegios inesperados: ${JSON.stringify(acl)}`);

  const fixture = await one(`
    select session.session_id,user_row.user_id,user_row.email,auth_user.id auth_id,
      role.role_id active_role_id,
      subsidiary.subsidiary_id,subsidiary.currency_id local_currency_id,
      subsidiary.country_id,book.accounting_book_id,
      customer.customer_id,center.cost_center_id,department.department_id,
      usd.currency_id usd_currency_id,
      max(account.account_id)filter(where account.account_number='113003') current_control,
      max(account.account_id)filter(where account.account_number='113004') prior_control,
      max(account.account_id)filter(where account.account_number='413001') current_counterpart,
      max(account.account_id)filter(where account.account_number='413002') bridge_account,
      max(account.account_id)filter(where account.account_number='319999') transition_account
    from public.user_company_sessions session
    join public.user_role_sessions role_session
      on role_session.session_id=session.session_id and role_session.user_id=session.user_id
    join public.roles role on role.role_id=role_session.role_id
      and lower(role.role_name)in('administrador','administrator','admin')
    join public.users user_row on user_row.user_id=session.user_id and user_row.is_active
    join auth.users auth_user on lower(auth_user.email)=lower(user_row.email)
    join public.user_subsidiaries user_access
      on user_access.user_id=user_row.user_id and user_access.subsidiary_id=session.subsidiary_id
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=session.subsidiary_id and subsidiary.is_active
    join public.accounting_books book
      on book.subsidiary_id=subsidiary.subsidiary_id and book.is_primary and book.is_active
    join public.currencies usd on usd.currency_code='USD'and usd.currency_id<>subsidiary.currency_id
    join lateral(
      select candidate.customer_id from public.customers candidate
      where candidate.primary_subsidiary_id=subsidiary.subsidiary_id
        or exists(select 1 from public.entity_subsidiaries link
          where link.customer_id=candidate.customer_id
            and link.subsidiary_id=subsidiary.subsidiary_id)
      order by candidate.customer_id limit 1
    )customer on true
    join lateral(
      select candidate.cost_center_id from public.cost_centers candidate
      where candidate.subsidiary_id=subsidiary.subsidiary_id and not coalesce(candidate.is_inactive,false)
      order by(candidate.customer_id=customer.customer_id)desc nulls last,candidate.cost_center_id limit 1
    )center on true
    join lateral(
      select candidate.department_id from public.departments candidate
      where candidate.subsidiary_id=subsidiary.subsidiary_id and not coalesce(candidate.is_inactive,false)
      order by candidate.department_id limit 1
    )department on true
    join public.chart_accounts account
      on account.account_number in('113003','113004','413001','413002','319999')
      and account.accepts_entries and not account.is_inactive
    join public.account_subsidiaries assignment
      on assignment.account_id=account.account_id
      and assignment.subsidiary_id=subsidiary.subsidiary_id and assignment.is_active
    group by session.session_id,user_row.user_id,user_row.email,auth_user.id,role.role_id,
      subsidiary.subsidiary_id,subsidiary.currency_id,subsidiary.country_id,
      book.accounting_book_id,customer.customer_id,center.cost_center_id,
      department.department_id,usd.currency_id
    having count(distinct account.account_number)=5
    order by max(session.selected_at)desc limit 1
  `);
  if (!fixture) {
    const diagnostics = await one(`select
      (select count(*)from public.chart_accounts where account_number in('113003','113004','413001','413002','319999')) required_accounts,
      (select count(*)from public.currencies where currency_code='USD') usd,
      (select count(*)from public.user_company_sessions session
        join public.user_role_sessions role_session using(session_id,user_id)
        join public.roles role using(role_id)
        where lower(role.role_name)in('administrador','administrator','admin')) admin_sessions,
      (select jsonb_agg(jsonb_build_object('subsidiaryId',subsidiary.subsidiary_id,
        'assignedAccounts',(select count(distinct account.account_number)
          from public.chart_accounts account join public.account_subsidiaries assignment using(account_id)
          where assignment.subsidiary_id=subsidiary.subsidiary_id and assignment.is_active
            and account.account_number in('113003','113004','413001','413002','319999'))))
        from public.subsidiaries subsidiary where subsidiary.is_active) account_assignments`);
    throw new Error(`Faltan datos maestros para la prueba de reclasificación: ${JSON.stringify(diagnostics)}`);
  }

  const salesLineProduct = await one(`select product.product_id
    from public.products product
    order by product.is_active desc,product.product_id
    limit 1`);
  assert.ok(salesLineProduct, 'Falta un producto para probar una factura multimoneda con líneas.');

  await db.query(`insert into public.subsidiary_currencies(subsidiary_id,currency_id,is_primary)
    values($1,$2,false)on conflict(subsidiary_id,currency_id)do nothing`, [
    fixture.subsidiary_id,
    fixture.usd_currency_id,
  ]);

  // The legacy pending-reversal RPC still reads user_roles/role_permissions,
  // while the current session uses user_role_sessions. Keep the fixture aligned
  // inside this rollback-only transaction so the future-reversal assertions can run.
  await db.query(`insert into public.user_roles(user_id,role_id)values($1,$2)on conflict do nothing`, [
    fixture.user_id,
    fixture.active_role_id,
  ]);
  const reversalGrant = await one(`
    with granted as(
      insert into public.role_permissions(role_id,permission_id)
      select $1,permission.permission_id from public.permissions permission
      where permission.code='accounting:journal:reverse'
      on conflict do nothing returning permission_id
    )
    select exists(
      select 1 from public.role_permissions role_permission
      join public.permissions permission using(permission_id)
      where role_permission.role_id=$1 and permission.code='accounting:journal:reverse'
    ) allowed
  `, [fixture.active_role_id]);
  assert.equal(reversalGrant.allowed, true, 'No existe el permiso técnico para probar futuras reversiones.');

  const claims = JSON.stringify({
    sub: fixture.auth_id,
    email: fixture.email,
    session_id: fixture.session_id,
    role: 'authenticated',
  });
  await db.query("select set_config('request.jwt.claims',$1,true)", [claims]);
  assert.equal(String((await one('select public.active_subsidiary_id() value')).value), String(fixture.subsidiary_id));

  // A posted opening blocks transactions dated on or before its cutoff. Move
  // the existing run out of the way only inside this transaction, then reuse
  // it for the historical opening fixture after the source journal exists.
  let openingRun = await one(`select id,status from public.opening_balance_runs
    where subsidiary_id=$1 and status<>'REVERSED' order by id desc limit 1`, [fixture.subsidiary_id]);
  if (openingRun) {
    await db.query(`update public.opening_balance_runs set status='REVERSED',
      reversed_at=now() where id=$1`, [openingRun.id]);
  }

  const status = await one(`select status_id from public.status
    where code='APROBADO'and module='Transacciones'order by status_id limit 1`);
  const pendingType = await one(`select transaction_type_id from public.transaction_types
    where abbreviation='ASI_PEN'limit 1`);
  assert.ok(status && pendingType, 'Falta el tipo ASI_PEN o el estado APROBADO.');

  const priorYear = await one(`insert into public.fiscal_years(year_name,start_date,end_date,is_closed)
    values($1,'1998-01-01','1998-12-31',false)returning fiscal_year_id`, [`${stamp}-1998`]);
  const targetYear = await one(`insert into public.fiscal_years(year_name,start_date,end_date,is_closed)
    values($1,'1999-01-01','1999-12-31',false)returning fiscal_year_id`, [`${stamp}-1999`]);
  const sourcePeriod = await one(`insert into public.fiscal_periods(
      period_name,start_date,end_date,is_closed,fiscal_year_id,subsidiary_id,
      checklist_completed,ap_closed,ar_closed,gl_closed,is_inactive
    )values($1,'1998-12-01','1998-12-31',false,$2,$3,false,false,false,false,false)
    returning fiscal_period_id`, [`${stamp}-DEC`, priorYear.fiscal_year_id, fixture.subsidiary_id]);
  const closedOriginPeriod = await one(`insert into public.fiscal_periods(
      period_name,start_date,end_date,is_closed,fiscal_year_id,subsidiary_id,
      checklist_completed,ap_closed,ar_closed,gl_closed,is_inactive
    )values($1,'1998-11-01','1998-11-30',false,$2,$3,false,false,false,false,false)
    returning fiscal_period_id`, [`${stamp}-NOV`, priorYear.fiscal_year_id, fixture.subsidiary_id]);
  const targetPeriod = await one(`insert into public.fiscal_periods(
      period_name,start_date,end_date,is_closed,fiscal_year_id,subsidiary_id,
      checklist_completed,ap_closed,ar_closed,gl_closed,is_inactive
    )values($1,'1999-01-01','1999-01-31',false,$2,$3,false,false,false,false,false)
    returning fiscal_period_id`, [`${stamp}-JAN`, targetYear.fiscal_year_id, fixture.subsidiary_id]);

  // Isolate the test from existing live candidates. These metadata changes are
  // rolled back together with every other fixture record.
  await db.query(`create temporary table test_existing_pending_journal_periods
    on commit drop as
    select journal_id,pending_period_type,pending_origin_journal_id
    from public.journal
    where subsidiary_id=$1
      and(journal_number like'ASI_PEN-%'or journal_type='Asientos Pendientes de Facturar')`, [
    fixture.subsidiary_id,
  ]);
  await db.query(`create temporary table test_existing_opening_pending_periods
    on commit drop as
    select id,period_type,origin_journal_id,updated_at,updated_by
    from public.opening_pending_invoice_items where subsidiary_id=$1`, [fixture.subsidiary_id]);
  await db.query("select set_config('app.pending_reclassification_internal','1',true)");
  await db.query(`update public.journal set pending_period_type='ANTERIOR',
      pending_origin_journal_id=coalesce(pending_origin_journal_id,journal_id)
    where subsidiary_id=$1
      and(journal_number like'ASI_PEN-%'or journal_type='Asientos Pendientes de Facturar')`, [fixture.subsidiary_id]);
  await db.query(`update public.opening_pending_invoice_items item
    set period_type='ANTERIOR',origin_journal_id=coalesce(item.origin_journal_id,run.journal_id),
      updated_at=now(),updated_by=$2
    from public.opening_balance_runs run
    where item.run_id=run.id and item.subsidiary_id=$1`, [fixture.subsidiary_id, fixture.user_id]);
  await db.query("select set_config('app.pending_reclassification_internal','0',true)");

  async function createPendingSource(
    reference,
    amountForeign,
    requestedPeriodType = 'ACTUAL',
    historicalRate = 520,
    originDate = '1998-12-01',
    originCurrencyId = fixture.usd_currency_id,
    originFiscalPeriodId = sourcePeriod.fiscal_period_id,
  ) {
    const transaction = await one(`insert into public."transaction"(
        tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
        exchange_rate,fiscal_period_id,total_amount,status_id,customer_id
      )values($1,$10,$2,$3,$4,$5,$6,$7,$8,$9)
      returning transaction_id`, [
      reference,
      pendingType.transaction_type_id,
      fixture.subsidiary_id,
      originCurrencyId,
      historicalRate,
      originFiscalPeriodId,
      amountForeign,
      status.status_id,
      fixture.customer_id,
      originDate,
    ]);
    const journal = await one(`insert into public.journal(
        journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
        fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,
        status,created_by,pending_period_type
      )values($1,$11,$2,$3,$4,$5,$6,$7,
        'Asientos Pendientes de Facturar',$8,$8,'CONTABILIZADO',$9,$10)
      returning journal_id,transaction_id`, [
      reference,
      transaction.transaction_id,
      fixture.subsidiary_id,
      originCurrencyId,
      originFiscalPeriodId,
      historicalRate,
      `Prueba multimoneda ${reference}`,
      amountForeign,
      fixture.user_id,
      requestedPeriodType,
      originDate,
    ]);
    await db.query(`insert into public.journal_line(
        journal_id,account_id,debit,credit,debit_fx,credit_fx,
        department_id,cost_center_id,service_month,service_country_id,
        note,entity_type,customer_id,historical_exchange_rate,original_currency_id
      )values
      ($1,$2,$3,0,$3,0,$4,$5,'1998-12',$6,$7,'Cliente',$8,$11,$9),
      ($1,$10,0,$3,0,$3,$4,$5,'1998-12',$6,$7,'Cliente',$8,$11,$9)`, [
      journal.journal_id,
      fixture.current_control,
      amountForeign,
      fixture.department_id,
      fixture.cost_center_id,
      fixture.country_id,
      `Detalle ${reference}`,
      fixture.customer_id,
      originCurrencyId,
      fixture.current_counterpart,
      historicalRate,
    ]);
    await db.query('select public.sync_journal_gl_impacts($1)', [journal.journal_id]);
    const sourceImpact = await one(`select
        sum(impact.debit_amount)::numeric debit_local,
        sum(impact.credit_amount)::numeric credit_local,
        sum(impact.debit_fx)::numeric debit_fx,sum(impact.credit_fx)::numeric credit_fx
      from public.gl_impact impact
      where impact.transaction_id=$1 and impact.accounting_book_id=$2`, [
      journal.transaction_id,
      fixture.accounting_book_id,
    ]);
    assert.equal(number(sourceImpact.debit_local), amountForeign * historicalRate);
    assert.equal(number(sourceImpact.credit_local), amountForeign * historicalRate);
    assert.equal(number(sourceImpact.debit_fx), amountForeign);
    assert.equal(number(sourceImpact.credit_fx), amountForeign);
    return journal;
  }

  async function createBillingInvoice(reference, invoiceDate, subtotal, fiscalPeriodId) {
    return one(`insert into public.invoice(
        invoice_number,customer_id,subsidiary_id,due_date,total_amount,
        invoice_date,fiscal_period_id,currency_id,exchange_rate,memo
      )values($1,$2,$3,$4::date,$5,$4::date,$6,$7,1,$8)
      returning invoice_id`, [
      reference,
      fixture.customer_id,
      fixture.subsidiary_id,
      invoiceDate,
      subtotal,
      fiscalPeriodId,
      fixture.local_currency_id,
      `Factura para validar tasa histórica ${reference}`,
    ]);
  }

  async function createForeignBillingInvoice(
    reference,
    invoiceDate,
    subtotal,
    fiscalPeriodId,
    invoiceExchangeRate = 520,
  ) {
    const invoice = await one(`insert into public.invoice(
        invoice_number,customer_id,subsidiary_id,due_date,total_amount,
        invoice_date,fiscal_period_id,currency_id,exchange_rate,memo
      )values($1,$2,$3,$4::date,$5,$4::date,$6,$7,$8,$9)
      returning invoice_id`, [
      reference,
      fixture.customer_id,
      fixture.subsidiary_id,
      invoiceDate,
      subtotal,
      fiscalPeriodId,
      fixture.usd_currency_id,
      invoiceExchangeRate,
      `Factura USD para validar tasa histórica ${reference}`,
    ]);
    await db.query(`insert into public.sales_invoice_line(
        invoice_id,product_id,account_id,quantity,unit_price,amount,
        tax_rate,tax_amount,gross_amount,note,department_id,cost_center_id,
        service_month,service_country_id
      )values($1,$2,$3,1,$4,$4,0,0,$4,$5,$6,$7,
        to_char($8::date,'YYYY-MM'),$9)`, [
      invoice.invoice_id,
      salesLineProduct.product_id,
      fixture.current_counterpart,
      subtotal,
      `Línea USD ${reference}`,
      fixture.department_id,
      fixture.cost_center_id,
      invoiceDate,
      fixture.country_id,
    ]);
    return invoice;
  }

  async function reverseAndAssertHistoricalFx({
    sourceId,
    reversalDate,
    amountLocal,
    amountForeign,
    type,
    invoiceId = null,
    periodType,
    description,
    historicalRate = 520,
    originalCurrencyId = fixture.usd_currency_id,
    assertAlternateSpot = true,
    localFxTolerance = Math.max(0.005, historicalRate * 0.0000005 + 0.000001),
  }) {
    const payload = {
      reversalDate,
      amount: amountLocal,
      type,
      supports: [],
    };
    if (type === 'FACTURACION') payload.invoiceId = invoiceId;
    else payload.errorDescription = description || 'Validación de tasa histórica original';

    await db.query('savepoint reversal_rpc_attempt');
    await db.query('set local role authenticated');
    let result;
    try {
      result = (await one(
        `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
        [sourceId, JSON.stringify(payload)],
      )).value;
    } catch (error) {
      await db.query('rollback to savepoint reversal_rpc_attempt');
      await db.query('reset role');
      await db.query('release savepoint reversal_rpc_attempt');
      throw error;
    }
    await db.query('reset role');
    await db.query('release savepoint reversal_rpc_attempt');
    assert.equal(result.periodType, periodType);

    const header = await one(`select journal.exchange_rate,journal.total_debit,
        journal.total_credit,transaction.exchange_rate transaction_rate,
        transaction.total_amount,reversal.reversed_local,reversal.reversed_foreign,
        reversal.reversal_type,reversal.sales_invoice_id
      from public.journal journal
      join public."transaction" transaction using(transaction_id)
      join public.pending_invoice_reversal reversal
        on reversal.reversal_journal_id=journal.journal_id
      where journal.journal_id=$1`, [result.journalId]);
    assert.equal(number(header.exchange_rate), historicalRate);
    assert.equal(number(header.transaction_rate), historicalRate);
    assert.equal(number(header.total_debit), amountForeign);
    assert.equal(number(header.total_credit), amountForeign);
    assert.equal(number(header.total_amount), amountForeign);
    assert.equal(number(header.reversed_local), amountLocal);
    assert.equal(number(header.reversed_foreign), amountForeign);
    assert.equal(header.reversal_type, type);
    assert.equal(
      header.sales_invoice_id == null ? null : String(header.sales_invoice_id),
      invoiceId == null ? null : String(invoiceId),
    );

    const lines = (await db.query(`select account.account_number,line.debit,line.credit,
        line.debit_fx,line.credit_fx,line.historical_exchange_rate,
        line.original_currency_id
      from public.journal_line line
      join public.chart_accounts account using(account_id)
      where line.journal_id=$1 order by account.account_number`, [result.journalId])).rows;
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => number(line.historical_exchange_rate) === historicalRate));
    assert.ok(lines.every((line) => String(line.original_currency_id) === String(originalCurrencyId)));
    assert.equal(lines.reduce((sum, line) => sum + number(line.debit), 0), amountForeign);
    assert.equal(lines.reduce((sum, line) => sum + number(line.credit), 0), amountForeign);
    assert.equal(lines.reduce((sum, line) => sum + number(line.debit_fx), 0), amountForeign);
    assert.equal(lines.reduce((sum, line) => sum + number(line.credit_fx), 0), amountForeign);

    const impacts = (await db.query(`select account.account_number,
        sum(impact.debit_amount) debit,sum(impact.credit_amount) credit,
        sum(impact.debit_fx) debit_fx,sum(impact.credit_fx) credit_fx,
        min(impact.original_currency_id) original_currency_id
      from public.journal reversal
      join public.gl_impact impact using(transaction_id)
      join public.accounting_books book using(accounting_book_id)
      join public.chart_accounts account using(account_id)
      where reversal.journal_id=$1 and book.is_primary and book.is_active
      group by account.account_number order by account.account_number`, [result.journalId])).rows.map((row) => ({
      account: row.account_number,
      debit: number(row.debit),
      credit: number(row.credit),
      debitFx: number(row.debit_fx),
      creditFx: number(row.credit_fx),
      currencyId: String(row.original_currency_id),
    }));
    const expectedAccounts = periodType === 'ANTERIOR'
      ? [
        { account: '113004', debit: 0, credit: amountLocal, debitFx: 0, creditFx: amountForeign },
        { account: '413002', debit: amountLocal, credit: 0, debitFx: amountForeign, creditFx: 0 },
      ]
      : [
        { account: '113003', debit: 0, credit: amountLocal, debitFx: 0, creditFx: amountForeign },
        { account: '413001', debit: amountLocal, credit: 0, debitFx: amountForeign, creditFx: 0 },
      ];
    assert.deepEqual(impacts.map(({ currencyId, ...impact }) => impact), expectedAccounts);
    assert.ok(impacts.every((impact) => impact.currencyId === String(originalCurrencyId)));
    const impactDebitLocal = impacts.reduce((sum, impact) => sum + impact.debit, 0);
    const impactDebitForeign = impacts.reduce((sum, impact) => sum + impact.debitFx, 0);
    // A reversal stores the original-currency leg at six decimals. At high
    // exchange rates the implied local amount can therefore differ by a few
    // thousandths from foreign * rate without changing the frozen snapshot.
    assert.ok(
      Math.abs(impactDebitLocal - impactDebitForeign * historicalRate)
        <= localFxTolerance,
      `La reversión ${result.journalId} no reproduce la tasa histórica ${historicalRate}.`,
    );
    if (assertAlternateSpot) {
      const currentRate = await one(`select spot_rate from public.exchange_rates
        where from_currency_id=$1 and to_currency_id=$2 and effective_date=$3::date`, [
        originalCurrencyId,
        fixture.local_currency_id,
        reversalDate,
      ]);
      assert.equal(number(currentRate.spot_rate), 777);
      assert.notEqual(number(header.exchange_rate), number(currentRate.spot_rate));
    }
    return result;
  }

  async function assertOverReversalRejected(savepointName, reference, requestedAmount) {
    await withSavepoint(savepointName, async () => {
      const source = await createPendingSource(
        `ASI_PEN-${stamp}-${reference}`, 500, 'ACTUAL', 4000, '1998-12-01',
      );
      const before = await one(`select pending_reversed_local,pending_reversed_foreign,
          pending_balance_local,pending_balance_foreign,reversal_status
        from public.journal where journal_id=$1`, [source.journal_id]);
      await db.query('savepoint over_reversal_rpc_attempt');
      await db.query('set local role authenticated');
      try {
        await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
          source.journal_id,
          JSON.stringify({
            reversalDate: '1998-12-20',
            amount: requestedAmount,
            type: 'ERROR_CORRECCION',
            errorDescription: 'Debe rechazarse porque supera el saldo disponible',
            supports: [],
          }),
        ]);
      } catch (error) {
        await db.query('rollback to savepoint over_reversal_rpc_attempt');
        await db.query('reset role');
        const after = await one(`select pending_reversed_local,pending_reversed_foreign,
            pending_balance_local,pending_balance_foreign,reversal_status,
            (select count(*)::int from public.pending_invoice_reversal reversal
              where reversal.source_journal_id=journal.journal_id) reversal_count
          from public.journal journal where journal.journal_id=$1`, [source.journal_id]);
        assert.deepEqual({
          reversedLocal: number(after.pending_reversed_local),
          reversedForeign: number(after.pending_reversed_foreign),
          balanceLocal: number(after.pending_balance_local),
          balanceForeign: number(after.pending_balance_foreign),
          status: after.reversal_status,
          reversalCount: after.reversal_count,
        }, {
          reversedLocal: number(before.pending_reversed_local),
          reversedForeign: number(before.pending_reversed_foreign),
          balanceLocal: number(before.pending_balance_local),
          balanceForeign: number(before.pending_balance_foreign),
          status: before.reversal_status,
          reversalCount: 0,
        });
        throw error;
      }
      await db.query('reset role');
    }, /monto a reversar.*supera el saldo disponible|supera.*saldo.*pendiente/i);
  }

  // Reproduce the legacy representation that existed before the historical-FX
  // hardening: journal header and ordinary amounts were local, while *_fx and
  // the primary-book impact already retained the original USD amount. The new
  // migration must recognize this as metadata/presentation debt, normalize it
  // without changing GL, and preserve the source's frozen rate.
  if (!skipMigration) {
    const legacySource = await createPendingSource(
      `ASI_PEN-${stamp}-LEGACY-LOCAL-PRESENTATION`, 500, 'ACTUAL', 520, '1998-12-01',
    );
    await db.query('set local role authenticated');
    let legacyResult;
    try {
      legacyResult = (await one(
        `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
        [legacySource.journal_id, JSON.stringify({
          reversalDate: '1998-12-15',
          amount: 260000,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Fixture legado de presentación monetaria local',
          supports: [],
        })],
      )).value;
    } finally {
      await db.query('reset role');
    }

    await db.query('alter table public.journal_line disable trigger journal_line_gl_impact_sync');
    await db.query("select set_config('app.pending_reversal_finalize','1',true)");
    try {
      await db.query(`update public.journal_line
        set debit=case when debit>0 then 260000 else 0 end,
          credit=case when credit>0 then 260000 else 0 end,
          historical_exchange_rate=null,original_currency_id=null
        where journal_id=$1`, [legacyResult.journalId]);
      await db.query(`update public.journal
        set total_debit=260000,total_credit=260000
        where journal_id=$1`, [legacyResult.journalId]);
    } finally {
      await db.query("select set_config('app.pending_reversal_finalize','0',true)");
      await db.query('alter table public.journal_line enable trigger journal_line_gl_impact_sync');
    }
    const legacyBefore = await one(`select journal.total_debit,journal.total_credit,
        transaction.total_amount,
        (select sum(line.debit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit,
        (select sum(line.debit_fx) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit_fx,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit,
        (select sum(impact.debit_fx) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit_fx
      from public.journal journal
      join public."transaction" transaction using(transaction_id)
      where journal.journal_id=$1`, [legacyResult.journalId]);
    assert.deepEqual({
      header: number(legacyBefore.total_debit),
      transaction: number(legacyBefore.total_amount),
      line: number(legacyBefore.line_debit),
      lineFx: number(legacyBefore.line_debit_fx),
      gl: number(legacyBefore.gl_debit),
      glFx: number(legacyBefore.gl_debit_fx),
    }, { header: 260000, transaction: 260000, line: 260000, lineFx: 500, gl: 260000, glFx: 500 });

    // A second legitimate historical shape was emitted by the annual wrapper:
    // journal and lines were already in original currency, but transaction.total_amount
    // still held local currency. It must also be accepted and normalized.
    const wrapperLegacySource = await createPendingSource(
      `ASI_PEN-${stamp}-WRAPPER-TRANSACTION-LOCAL`, 500, 'ACTUAL', 520, '1998-12-01',
    );
    await db.query('set local role authenticated');
    let wrapperLegacyResult;
    try {
      wrapperLegacyResult = (await one(
        `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
        [wrapperLegacySource.journal_id, JSON.stringify({
          reversalDate: '1998-12-15',
          amount: 260000,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Fixture legado del wrapper anual con total local',
          supports: [],
        })],
      )).value;
    } finally {
      await db.query('reset role');
    }
    await db.query("select set_config('app.pending_reversal_finalize','1',true)");
    try {
      await db.query(`update public."transaction" transaction_row
        set total_amount=260000
        from public.journal journal
        where journal.journal_id=$1
          and transaction_row.transaction_id=journal.transaction_id`, [wrapperLegacyResult.journalId]);
    } finally {
      await db.query("select set_config('app.pending_reversal_finalize','0',true)");
    }
    const wrapperLegacyBefore = await one(`select journal.total_debit,
        transaction.total_amount,
        (select sum(line.debit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit,
        (select sum(line.debit_fx) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit_fx,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit
      from public.journal journal join public."transaction" transaction using(transaction_id)
      where journal.journal_id=$1`, [wrapperLegacyResult.journalId]);
    assert.deepEqual({
      header: number(wrapperLegacyBefore.total_debit),
      transaction: number(wrapperLegacyBefore.total_amount),
      line: number(wrapperLegacyBefore.line_debit),
      lineFx: number(wrapperLegacyBefore.line_debit_fx),
      gl: number(wrapperLegacyBefore.gl_debit),
    }, { header: 500, transaction: 260000, line: 500, lineFx: 500, gl: 260000 });

    // Historical rows created before the annual hardening could store the
    // original amount in pending_invoice_reversal.reversed_local even though
    // the source snapshot and primary-book GL were already correct in local
    // currency. The migration must repair only that row field.
    const preAnnualHardeningSource = await createPendingSource(
      `ASI_PEN-${stamp}-PRE-120000-ROW-LOCAL`, 500, 'ACTUAL', 520, '1998-12-01',
    );
    const preAnnualHardeningInvoice = await createForeignBillingInvoice(
      `FAC-${stamp}-PRE-120000-USD`, '1998-12-15', 500, sourcePeriod.fiscal_period_id,
    );
    await db.query('set local role authenticated');
    let preAnnualHardeningResult;
    try {
      preAnnualHardeningResult = (await one(
        `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
        [preAnnualHardeningSource.journal_id, JSON.stringify({
          reversalDate: '1998-12-15',
          amount: 260000,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Fixture histórico anterior al endurecimiento anual',
          supports: [],
        })],
      )).value;
    } finally {
      await db.query('reset role');
    }
    await db.query("select set_config('app.pending_reversal_finalize','1',true)");
    try {
      await db.query(`update public.pending_invoice_reversal
        set reversed_local=reversed_foreign
        where reversal_journal_id=$1`, [preAnnualHardeningResult.journalId]);
      await db.query(`update public.pending_invoice_reversal
        set reversal_type='FACTURACION',sales_invoice_id=$2,error_description=null
        where reversal_journal_id=$1`, [
        preAnnualHardeningResult.journalId,
        preAnnualHardeningInvoice.invoice_id,
      ]);
    } finally {
      await db.query("select set_config('app.pending_reversal_finalize','0',true)");
    }
    const preAnnualHardeningBefore = await one(`select reversal.reversed_local,
        reversal.reversed_foreign,source.pending_initial_local,
        source.pending_initial_foreign,source.pending_reversed_local,
        source.pending_reversed_foreign,source.pending_balance_local,
        source.pending_balance_foreign,reversal_journal.total_debit,
        reversal_journal.total_credit,
        reversal.reversal_type,reversal.sales_invoice_id,
        invoice.currency_id invoice_currency_id,invoice.exchange_rate invoice_rate,
        (select sum(invoice_line.amount) from public.sales_invoice_line invoice_line
          where invoice_line.invoice_id=invoice.invoice_id) invoice_subtotal,
        (select sum(line.debit) from public.journal_line line
          where line.journal_id=reversal.reversal_journal_id) line_debit,
        (select sum(line.debit_fx) from public.journal_line line
          where line.journal_id=reversal.reversal_journal_id) line_debit_fx,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=reversal_journal.transaction_id
            and book.is_primary and book.is_active) gl_debit,
        (select sum(impact.debit_fx) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=reversal_journal.transaction_id
            and book.is_primary and book.is_active) gl_debit_fx
      from public.pending_invoice_reversal reversal
      join public.journal reversal_journal
        on reversal_journal.journal_id=reversal.reversal_journal_id
      join public.journal source on source.journal_id=reversal.source_journal_id
      join public.invoice invoice on invoice.invoice_id=reversal.sales_invoice_id
      where reversal.reversal_journal_id=$1`, [preAnnualHardeningResult.journalId]);
    assert.deepEqual({
      rowLocal: number(preAnnualHardeningBefore.reversed_local),
      rowForeign: number(preAnnualHardeningBefore.reversed_foreign),
      sourceInitialLocal: number(preAnnualHardeningBefore.pending_initial_local),
      sourceInitialForeign: number(preAnnualHardeningBefore.pending_initial_foreign),
      sourceReversedLocal: number(preAnnualHardeningBefore.pending_reversed_local),
      sourceReversedForeign: number(preAnnualHardeningBefore.pending_reversed_foreign),
      sourceBalanceLocal: number(preAnnualHardeningBefore.pending_balance_local),
      sourceBalanceForeign: number(preAnnualHardeningBefore.pending_balance_foreign),
      headerDebit: number(preAnnualHardeningBefore.total_debit),
      headerCredit: number(preAnnualHardeningBefore.total_credit),
      lineDebit: number(preAnnualHardeningBefore.line_debit),
      lineDebitFx: number(preAnnualHardeningBefore.line_debit_fx),
      glDebit: number(preAnnualHardeningBefore.gl_debit),
      glDebitFx: number(preAnnualHardeningBefore.gl_debit_fx),
      type: preAnnualHardeningBefore.reversal_type,
      invoiceId: String(preAnnualHardeningBefore.sales_invoice_id),
      invoiceCurrencyId: String(preAnnualHardeningBefore.invoice_currency_id),
      invoiceRate: number(preAnnualHardeningBefore.invoice_rate),
      invoiceSubtotal: number(preAnnualHardeningBefore.invoice_subtotal),
    }, {
      rowLocal: 500,
      rowForeign: 500,
      sourceInitialLocal: 260000,
      sourceInitialForeign: 500,
      sourceReversedLocal: 260000,
      sourceReversedForeign: 500,
      sourceBalanceLocal: 0,
      sourceBalanceForeign: 0,
      headerDebit: 500,
      headerCredit: 500,
      lineDebit: 500,
      lineDebitFx: 500,
      glDebit: 260000,
      glDebitFx: 500,
      type: 'FACTURACION',
      invoiceId: String(preAnnualHardeningInvoice.invoice_id),
      invoiceCurrencyId: String(fixture.usd_currency_id),
      invoiceRate: 520,
      invoiceSubtotal: 500,
    });

    // The fixture isolation above temporarily classifies pre-existing live
    // sources as ANTERIOR. Restore their real snapshots while the migration
    // audits historical reversals, otherwise that artificial classification
    // would make an otherwise valid ACTUAL reversal appear inconsistent.
    await db.query("select set_config('app.pending_reclassification_internal','1',true)");
    try {
      await db.query(`update public.journal target
        set pending_period_type=snapshot.pending_period_type,
          pending_origin_journal_id=snapshot.pending_origin_journal_id
        from pg_temp.test_existing_pending_journal_periods snapshot
        where target.journal_id=snapshot.journal_id`);
      await db.query(`update public.opening_pending_invoice_items target
        set period_type=snapshot.period_type,
          origin_journal_id=snapshot.origin_journal_id,
          updated_at=snapshot.updated_at,updated_by=snapshot.updated_by
        from pg_temp.test_existing_opening_pending_periods snapshot
        where target.id=snapshot.id`);
    } finally {
      await db.query("select set_config('app.pending_reclassification_internal','0',true)");
    }

    await withSavepoint('historical_reversal_gl_does_not_reproduce_rate', async () => {
      await db.query("select set_config('app.pending_reversal_finalize','1',true)");
      try {
        await db.query(`update public.gl_impact impact
          set debit_amount=case when debit_amount>0 then debit_amount+1 else 0 end,
            credit_amount=case when credit_amount>0 then credit_amount+1 else 0 end
          from public.journal reversal_journal
          where reversal_journal.journal_id=$1
            and impact.transaction_id=reversal_journal.transaction_id`, [
          wrapperLegacyResult.journalId,
        ]);
      } finally {
        await db.query("select set_config('app.pending_reversal_finalize','0',true)");
      }
      await db.query(historicalFxIntegrityMigration);
    }, /no concilia con el Mayor|Mayor.*moneda local|impacto.*tasa|GL/i);

    await withSavepoint('historical_reversal_wrong_account_direction', async () => {
      await db.query('alter table public.journal_line disable trigger journal_line_gl_impact_sync');
      await db.query("select set_config('app.pending_reversal_finalize','1',true)");
      try {
        await db.query(`update public.journal_line
          set account_id=case account_id
            when $2 then $3 when $3 then $2 else account_id end
          where journal_id=$1 and account_id in($2,$3)`, [
          wrapperLegacyResult.journalId,
          fixture.current_control,
          fixture.current_counterpart,
        ]);
      } finally {
        await db.query("select set_config('app.pending_reversal_finalize','0',true)");
        await db.query('alter table public.journal_line enable trigger journal_line_gl_impact_sync');
      }
      await db.query(historicalFxIntegrityMigration);
    }, /pareja contable|direcci[oó]n|cuentas? esperadas?|l[ií]neas incompatibles/i);

    // Apply the definitive historical normalization with the December period
    // already closed. This proves its internal bypass is limited but sufficient
    // to repair registered reversal presentation without reopening accounting.
    await db.query(`update public.fiscal_periods
      set is_closed=true,gl_closed=true,ap_closed=true,ar_closed=true
      where fiscal_period_id=$1`, [sourcePeriod.fiscal_period_id]);
    await db.query('savepoint final_historical_fx_migration');
    try {
      await db.query(historicalFxIntegrityMigration);
      await db.query('release savepoint final_historical_fx_migration');
    } catch (error) {
      await db.query('rollback to savepoint final_historical_fx_migration');
      const failedReversalJournalId = Number(String(error.message).match(/reversi[oó]n\s+(\d+)/i)?.[1]);
      if (Number.isFinite(failedReversalJournalId)) {
        const failedReversal = await one(`select reversal.reversal_id,
            reversal.reversal_date,reversal.source_journal_id,
            reversal.source_opening_pending_id,reversal.reversal_journal_id,
            source_journal.journal_number source_number,
            source_journal.pending_period_type source_journal_period,
            opening_item.reference source_opening_reference,
            opening_item.period_type source_opening_period,
            annual_run.reclassification_date,
            (select jsonb_agg(jsonb_build_object('account',account.account_number,
                'debit',line.debit,'credit',line.credit,'debitFx',line.debit_fx,
                'creditFx',line.credit_fx)order by line.journal_line_id)
              from public.journal_line line join public.chart_accounts account using(account_id)
              where line.journal_id=reversal.reversal_journal_id) lines
          from public.pending_invoice_reversal reversal
          left join public.journal source_journal
            on source_journal.journal_id=reversal.source_journal_id
          left join public.opening_pending_invoice_items opening_item
            on opening_item.id=reversal.source_opening_pending_id
          left join public.pending_invoice_reclassification_items reclassified
            on reclassified.source_journal_id=reversal.source_journal_id
              or reclassified.source_opening_pending_id=reversal.source_opening_pending_id
          left join public.pending_invoice_reclassification_runs annual_run
            on annual_run.id=reclassified.run_id
          where reversal.reversal_journal_id=$1`, [failedReversalJournalId]);
        console.error(`Diagnóstico de migración FX: ${JSON.stringify(failedReversal)}`);
      }
      throw error;
    }
    await db.query(`update public.fiscal_periods
      set is_closed=false,gl_closed=false,ap_closed=false,ar_closed=false
      where fiscal_period_id=$1`, [sourcePeriod.fiscal_period_id]);

    const legacyAfter = await one(`select journal.exchange_rate,journal.currency_id,
        journal.total_debit,journal.total_credit,transaction.exchange_rate transaction_rate,
        transaction.currency_id transaction_currency,transaction.total_amount,
        (select sum(line.debit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit,
        (select sum(line.credit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_credit,
        (select sum(line.debit_fx) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit_fx,
        (select bool_and(line.historical_exchange_rate=520
            and line.original_currency_id=$2) from public.journal_line line
          where line.journal_id=journal.journal_id) line_metadata,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit,
        (select sum(impact.debit_fx) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit_fx
      from public.journal journal join public."transaction" transaction using(transaction_id)
      where journal.journal_id=$1`, [legacyResult.journalId, fixture.usd_currency_id]);
    assert.deepEqual({
      journalRate: number(legacyAfter.exchange_rate),
      transactionRate: number(legacyAfter.transaction_rate),
      journalCurrency: String(legacyAfter.currency_id),
      transactionCurrency: String(legacyAfter.transaction_currency),
      headerDebit: number(legacyAfter.total_debit),
      headerCredit: number(legacyAfter.total_credit),
      transactionTotal: number(legacyAfter.total_amount),
      lineDebit: number(legacyAfter.line_debit),
      lineCredit: number(legacyAfter.line_credit),
      lineDebitFx: number(legacyAfter.line_debit_fx),
      lineMetadata: legacyAfter.line_metadata,
      glDebit: number(legacyAfter.gl_debit),
      glDebitFx: number(legacyAfter.gl_debit_fx),
    }, {
      journalRate: 520,
      transactionRate: 520,
      journalCurrency: String(fixture.usd_currency_id),
      transactionCurrency: String(fixture.usd_currency_id),
      headerDebit: 500,
      headerCredit: 500,
      transactionTotal: 500,
      lineDebit: 500,
      lineCredit: 500,
      lineDebitFx: 500,
      lineMetadata: true,
      glDebit: 260000,
      glDebitFx: 500,
    });

    const wrapperLegacyAfter = await one(`select journal.total_debit,
        journal.total_credit,transaction.total_amount,
        (select sum(line.debit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_debit,
        (select sum(line.credit) from public.journal_line line
          where line.journal_id=journal.journal_id) line_credit,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit,
        (select sum(impact.debit_fx) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=journal.transaction_id
            and book.is_primary and book.is_active) gl_debit_fx
      from public.journal journal join public."transaction" transaction using(transaction_id)
      where journal.journal_id=$1`, [wrapperLegacyResult.journalId]);
    assert.deepEqual({
      headerDebit: number(wrapperLegacyAfter.total_debit),
      headerCredit: number(wrapperLegacyAfter.total_credit),
      transactionTotal: number(wrapperLegacyAfter.total_amount),
      lineDebit: number(wrapperLegacyAfter.line_debit),
      lineCredit: number(wrapperLegacyAfter.line_credit),
      glDebit: number(wrapperLegacyAfter.gl_debit),
      glDebitFx: number(wrapperLegacyAfter.gl_debit_fx),
    }, {
      headerDebit: 500,
      headerCredit: 500,
      transactionTotal: 500,
      lineDebit: 500,
      lineCredit: 500,
      glDebit: 260000,
      glDebitFx: 500,
    });

    const preAnnualHardeningAfter = await one(`select reversal.reversed_local,
        reversal.reversed_foreign,source.pending_reversed_local,
        source.pending_reversed_foreign,source.pending_balance_local,
        source.pending_balance_foreign,reversal.reversal_type,
        reversal.sales_invoice_id,invoice.currency_id invoice_currency_id,
        invoice.exchange_rate invoice_rate,
        (select sum(invoice_line.amount) from public.sales_invoice_line invoice_line
          where invoice_line.invoice_id=invoice.invoice_id) invoice_subtotal,
        (select sum(impact.debit_amount) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=reversal_journal.transaction_id
            and book.is_primary and book.is_active) gl_debit,
        (select sum(impact.debit_fx) from public.gl_impact impact
          join public.accounting_books book using(accounting_book_id)
          where impact.transaction_id=reversal_journal.transaction_id
            and book.is_primary and book.is_active) gl_debit_fx
      from public.pending_invoice_reversal reversal
      join public.journal reversal_journal
        on reversal_journal.journal_id=reversal.reversal_journal_id
      join public.journal source on source.journal_id=reversal.source_journal_id
      join public.invoice invoice on invoice.invoice_id=reversal.sales_invoice_id
      where reversal.reversal_journal_id=$1`, [preAnnualHardeningResult.journalId]);
    assert.deepEqual({
      rowLocal: number(preAnnualHardeningAfter.reversed_local),
      rowForeign: number(preAnnualHardeningAfter.reversed_foreign),
      sourceReversedLocal: number(preAnnualHardeningAfter.pending_reversed_local),
      sourceReversedForeign: number(preAnnualHardeningAfter.pending_reversed_foreign),
      sourceBalanceLocal: number(preAnnualHardeningAfter.pending_balance_local),
      sourceBalanceForeign: number(preAnnualHardeningAfter.pending_balance_foreign),
      glDebit: number(preAnnualHardeningAfter.gl_debit),
      glDebitFx: number(preAnnualHardeningAfter.gl_debit_fx),
      type: preAnnualHardeningAfter.reversal_type,
      invoiceId: String(preAnnualHardeningAfter.sales_invoice_id),
      invoiceCurrencyId: String(preAnnualHardeningAfter.invoice_currency_id),
      invoiceRate: number(preAnnualHardeningAfter.invoice_rate),
      invoiceSubtotal: number(preAnnualHardeningAfter.invoice_subtotal),
    }, {
      rowLocal: 260000,
      rowForeign: 500,
      sourceReversedLocal: 260000,
      sourceReversedForeign: 500,
      sourceBalanceLocal: 0,
      sourceBalanceForeign: 0,
      glDebit: 260000,
      glDebitFx: 500,
      type: 'FACTURACION',
      invoiceId: String(preAnnualHardeningInvoice.invoice_id),
      invoiceCurrencyId: String(fixture.usd_currency_id),
      invoiceRate: 520,
      invoiceSubtotal: 500,
    });

    // Reapply the rollback-only isolation after the historical audit so the
    // annual run below sees only the fixtures created by this test.
    await db.query("select set_config('app.pending_reclassification_internal','1',true)");
    try {
      await db.query(`update public.journal target
        set pending_period_type='ANTERIOR',
          pending_origin_journal_id=coalesce(target.pending_origin_journal_id,target.journal_id)
        where exists(select 1 from pg_temp.test_existing_pending_journal_periods snapshot
          where snapshot.journal_id=target.journal_id)`);
      await db.query(`update public.opening_pending_invoice_items target
        set period_type='ANTERIOR',
          origin_journal_id=coalesce(target.origin_journal_id,run.journal_id),
          updated_at=now(),updated_by=$1
        from public.opening_balance_runs run
        where target.run_id=run.id
          and exists(select 1 from pg_temp.test_existing_opening_pending_periods snapshot
            where snapshot.id=target.id)`, [fixture.user_id]);
    } finally {
      await db.query("select set_config('app.pending_reclassification_internal','0',true)");
    }
  }

  for (const effectiveDate of ['1998-12-15', '1998-12-20', '1999-01-02']) {
    await db.query(`insert into public.exchange_rates(
        from_currency_id,to_currency_id,effective_date,spot_rate
      )values($1,$2,$3::date,777)
      on conflict(from_currency_id,to_currency_id,effective_date)
      do update set spot_rate=excluded.spot_rate`, [
      fixture.usd_currency_id,
      fixture.local_currency_id,
      effectiveDate,
    ]);
  }

  const foreignBillingSource = await createPendingSource(
    `ASI_PEN-${stamp}-BILLING-USD`, 500, 'ACTUAL', 520, '1998-12-01',
  );
  const foreignBillingInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-BILLING-USD`, '1998-12-20', 500, sourcePeriod.fiscal_period_id, 500,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: foreignBillingSource.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: 260000,
    amountForeign: 500,
    type: 'FACTURACION',
    invoiceId: foreignBillingInvoice.invoice_id,
    periodType: 'ACTUAL',
    historicalRate: 520,
  });
  const gucsAfterBilling = await one(`select
    coalesce(current_setting('app.pending_billing_limit_validated',true),'')<>'1' billing_cleared,
    coalesce(current_setting('app.pending_reversal_finalize',true),'')<>'1' finalize_cleared,
    coalesce(current_setting('app.pending_reversal_write',true),'')<>'1' balance_write_cleared,
    coalesce(current_setting('app.pending_reversal_dimensions_write',true),'')<>'1' dimensions_write_cleared`);
  assert.ok(Object.values(gucsAfterBilling).every(Boolean),
    `Un GUC interno quedo habilitado: ${JSON.stringify(gucsAfterBilling)}`);

  // A controlled second reversal remains valid when the source's original
  // accounting period has since been closed. The invoice is in the same USD
  // currency as the source but deliberately carries a different rate (500),
  // so its USD 300 subtotal must be compared with the historical foreign
  // amount while the reversal remains frozen at the source rate of 520.
  const closedPeriodSource = await createPendingSource(
    `ASI_PEN-${stamp}-CLOSED-SOURCE-PERIOD`, 500, 'ACTUAL', 520, '1998-11-01',
    fixture.usd_currency_id, closedOriginPeriod.fiscal_period_id,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: closedPeriodSource.journal_id,
    reversalDate: '1998-12-15',
    amountLocal: 104000,
    amountForeign: 200,
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Primera reversion antes de cerrar el periodo fuente',
  });
  const closedPeriodInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-CLOSED-SOURCE-PERIOD`, '1998-12-20', 300,
    sourcePeriod.fiscal_period_id, 500,
  );
  await db.query(`update public.fiscal_periods
    set is_closed=true,gl_closed=true,ap_closed=true,ar_closed=true
    where fiscal_period_id=$1`, [closedOriginPeriod.fiscal_period_id]);
  try {
    await reverseAndAssertHistoricalFx({
      sourceId: closedPeriodSource.journal_id,
      reversalDate: '1998-12-20',
      amountLocal: 156000,
      amountForeign: 300,
      type: 'FACTURACION',
      invoiceId: closedPeriodInvoice.invoice_id,
      periodType: 'ACTUAL',
      historicalRate: 520,
    });
  } finally {
    await db.query(`update public.fiscal_periods
      set is_closed=false,gl_closed=false,ap_closed=false,ar_closed=false
      where fiscal_period_id=$1`, [closedOriginPeriod.fiscal_period_id]);
  }
  const closedPeriodFinal = await one(`select pending_balance_local,
      pending_balance_foreign,reversal_status
    from public.journal where journal_id=$1`, [closedPeriodSource.journal_id]);
  assert.deepEqual({
    local: number(closedPeriodFinal.pending_balance_local),
    foreign: number(closedPeriodFinal.pending_balance_foreign),
    status: closedPeriodFinal.reversal_status,
  }, { local: 0, foreign: 0, status: 'REVERSADO_TOTAL' });

  await assertOverReversalRejected(
    'over_reversal_above_available_balance',
    'OVER-BALANCE',
    2000000.01,
  );
  await assertOverReversalRejected(
    'over_reversal_extreme_amount',
    'OVER-BALANCE-HUGE',
    999999999999,
  );

  // Each application is individually below the invoice subtotal, but the
  // second one would take the accumulated billing reversals from USD 300 to
  // USD 550 against a USD 500 invoice. New overapplications must be rejected
  // without rewriting legitimate historical rows or the source balance.
  await db.query('savepoint cumulative_billing_fixture');
  const cumulativeInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-CUMULATIVE-LIMIT`, '1998-12-20', 500,
    sourcePeriod.fiscal_period_id, 500,
  );
  const cumulativeFirst = await createPendingSource(
    `ASI_PEN-${stamp}-CUMULATIVE-FIRST`, 300, 'ACTUAL', 520, '1998-12-01',
  );
  const cumulativeSecond = await createPendingSource(
    `ASI_PEN-${stamp}-CUMULATIVE-SECOND`, 250, 'ACTUAL', 520, '1998-12-01',
  );
  await reverseAndAssertHistoricalFx({
    sourceId: cumulativeFirst.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: 156000,
    amountForeign: 300,
    type: 'FACTURACION',
    invoiceId: cumulativeInvoice.invoice_id,
    periodType: 'ACTUAL',
    historicalRate: 520,
  });
  await withSavepoint('cumulative_billing_overapplication', async () => {
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      cumulativeSecond.journal_id,
      JSON.stringify({
        reversalDate: '1998-12-20',
        amount: 130000,
        type: 'FACTURACION',
        invoiceId: cumulativeInvoice.invoice_id,
        supports: [],
      }),
    ]);
  }, /supera.*subtotal|factura.*sin impuestos|sobreaplicaci.n/i);
  const cumulativeAfter = await one(`select
      (select coalesce(sum(reversed_foreign),0)
       from public.pending_invoice_reversal
       where sales_invoice_id=$1) invoice_applied_foreign,
      pending_reversed_local,pending_reversed_foreign,
      pending_balance_local,pending_balance_foreign,reversal_status,
      (select count(*)::int from public.pending_invoice_reversal reversal
       where reversal.source_journal_id=journal.journal_id) source_reversal_count
    from public.journal journal where journal_id=$2`, [
    cumulativeInvoice.invoice_id,
    cumulativeSecond.journal_id,
  ]);
  assert.deepEqual({
    invoiceAppliedForeign: number(cumulativeAfter.invoice_applied_foreign),
    reversedLocal: number(cumulativeAfter.pending_reversed_local),
    reversedForeign: number(cumulativeAfter.pending_reversed_foreign),
    balanceLocal: number(cumulativeAfter.pending_balance_local),
    balanceForeign: number(cumulativeAfter.pending_balance_foreign),
    status: cumulativeAfter.reversal_status,
    sourceReversalCount: cumulativeAfter.source_reversal_count,
  }, {
    invoiceAppliedForeign: 300,
    reversedLocal: 0,
    reversedForeign: 0,
    balanceLocal: 130000,
    balanceForeign: 250,
    status: 'PENDIENTE',
    sourceReversalCount: 0,
  });
  await db.query('rollback to savepoint cumulative_billing_fixture');
  await db.query('release savepoint cumulative_billing_fixture');

  await db.query('savepoint forged_prior_source');
  const forgedPrior = await createPendingSource(`ASI_PEN-${stamp}-FORGED-PRIOR`, 10, 'ANTERIOR');
  assert.equal((await one(`select pending_period_type value from public.journal
    where journal_id=$1`, [forgedPrior.journal_id])).value, 'ACTUAL');
  await db.query('rollback to savepoint forged_prior_source');

  // Ordinary ACTUAL source before the annual process: one partial correction
  // and one final billing reversal must both retain USD 500 at the frozen 520
  // rate even though 777 is the configured spot rate on both reversal dates.
  const preAnnualJournal = await createPendingSource(
    `ASI_PEN-${stamp}-PRE-ANNUAL-MATRIX`, 500, 'ACTUAL', 520, '1998-12-01',
  );
  await reverseAndAssertHistoricalFx({
    sourceId: preAnnualJournal.journal_id,
    reversalDate: '1998-12-15',
    amountLocal: 104000,
    amountForeign: 200,
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Corrección parcial antes del cierre anual',
  });
  const preAnnualJournalInvoice = await createBillingInvoice(
    `FAC-${stamp}-PRE-JOURNAL`, '1998-12-20', 156000, sourcePeriod.fiscal_period_id,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: preAnnualJournal.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: 156000,
    amountForeign: 300,
    type: 'FACTURACION',
    invoiceId: preAnnualJournalInvoice.invoice_id,
    periodType: 'ACTUAL',
  });
  const preAnnualJournalFinal = await one(`select pending_reversed_local,
      pending_reversed_foreign,pending_balance_local,pending_balance_foreign,
      reversal_status
    from public.journal where journal_id=$1`, [preAnnualJournal.journal_id]);
  assert.deepEqual({
    reversedLocal: number(preAnnualJournalFinal.pending_reversed_local),
    reversedForeign: number(preAnnualJournalFinal.pending_reversed_foreign),
    balanceLocal: number(preAnnualJournalFinal.pending_balance_local),
    balanceForeign: number(preAnnualJournalFinal.pending_balance_foreign),
    status: preAnnualJournalFinal.reversal_status,
  }, {
    reversedLocal: 260000,
    reversedForeign: 500,
    balanceLocal: 0,
    balanceForeign: 0,
    status: 'REVERSADO_TOTAL',
  });

  // Functional/local currency is the same rule with a frozen rate of 1.
  const localCurrencySource = await createPendingSource(
    `ASI_PEN-${stamp}-LOCAL-RATE-ONE`,
    500,
    'ACTUAL',
    1,
    '1998-12-01',
    fixture.local_currency_id,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: localCurrencySource.journal_id,
    reversalDate: '1998-12-15',
    amountLocal: 200,
    amountForeign: 200,
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Corrección parcial en moneda funcional',
    historicalRate: 1,
    originalCurrencyId: fixture.local_currency_id,
    assertAlternateSpot: false,
  });
  const localCurrencyInvoice = await createBillingInvoice(
    `FAC-${stamp}-LOCAL-RATE-ONE`, '1998-12-20', 300, sourcePeriod.fiscal_period_id,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: localCurrencySource.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: 300,
    amountForeign: 300,
    type: 'FACTURACION',
    invoiceId: localCurrencyInvoice.invoice_id,
    periodType: 'ACTUAL',
    historicalRate: 1,
    originalCurrencyId: fixture.local_currency_id,
    assertAlternateSpot: false,
  });

  // The frozen header and primary-book GL cannot authorize a reversal if the
  // source detail itself was altered. This also proves the rejection happens
  // before a pending_invoice_reversal row or reversal journal is created.
  await withSavepoint('journal_source_lines_do_not_reconcile', async () => {
    const inconsistentLinesSource = await createPendingSource(
      `ASI_PEN-${stamp}-SOURCE-LINES-MISMATCH`, 500, 'ACTUAL', 520, '1998-12-01',
    );
    const reversalsBefore = number((await one(`select count(*) value
      from public.pending_invoice_reversal where source_journal_id=$1`, [
      inconsistentLinesSource.journal_id,
    ])).value);
    await db.query('alter table public.journal_line disable trigger journal_line_gl_impact_sync');
    await db.query('alter table public.journal_line disable trigger refresh_pending_invoice_amounts_trigger');
    try {
      await db.query(`update public.journal_line
        set debit=case when debit>0 then 501 else 0 end,
          credit=case when credit>0 then 501 else 0 end,
          debit_fx=case when debit_fx>0 then 501 else 0 end,
          credit_fx=case when credit_fx>0 then 501 else 0 end
        where journal_id=$1`, [inconsistentLinesSource.journal_id]);
    } finally {
      await db.query('alter table public.journal_line enable trigger refresh_pending_invoice_amounts_trigger');
      await db.query('alter table public.journal_line enable trigger journal_line_gl_impact_sync');
    }
    const tamperedLines = await one(`select sum(debit) debit,sum(credit) credit,
        sum(debit_fx) debit_fx,sum(credit_fx) credit_fx
      from public.journal_line where journal_id=$1`, [inconsistentLinesSource.journal_id]);
    assert.deepEqual({
      debit: number(tamperedLines.debit),
      credit: number(tamperedLines.credit),
      debitFx: number(tamperedLines.debit_fx),
      creditFx: number(tamperedLines.credit_fx),
    }, { debit: 501, credit: 501, debitFx: 501, creditFx: 501 });
    await db.query('savepoint journal_source_line_rpc_attempt');
    await db.query('set local role authenticated');
    try {
      await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
        inconsistentLinesSource.journal_id,
        JSON.stringify({
          reversalDate: '1998-12-15',
          amount: 52000,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Debe rechazarse por detalle fuente adulterado',
          supports: [],
        }),
      ]);
    } catch (error) {
      await db.query('rollback to savepoint journal_source_line_rpc_attempt');
      await db.query('reset role');
      const reversalsAfter = number((await one(`select count(*) value
        from public.pending_invoice_reversal where source_journal_id=$1`, [
        inconsistentLinesSource.journal_id,
      ])).value);
      assert.equal(reversalsAfter, reversalsBefore);
      throw error;
    }
    await db.query('reset role');
  }, /l[ií]neas del pendiente fuente.*no concilian|importe original congelado/i);

  await withSavepoint('journal_inconsistent_historical_balance', async () => {
    const inconsistentSource = await createPendingSource(
      `ASI_PEN-${stamp}-INCONSISTENT-FX`, 500, 'ACTUAL', 520, '1998-12-01',
    );
    await db.query("select set_config('app.pending_reversal_write','1',true)");
    await db.query(`update public.journal
      set pending_balance_local=pending_balance_local+1
      where journal_id=$1`, [inconsistentSource.journal_id]);
    await db.query("select set_config('app.pending_reversal_write','0',true)");
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      inconsistentSource.journal_id,
      JSON.stringify({
        reversalDate: '1998-12-15',
        amount: 52000,
        type: 'ERROR_CORRECCION',
        errorDescription: 'Debe rechazarse por tasa histórica inconsistente',
        supports: [],
      }),
    ]);
  }, /saldo.*no reproduce.*tasa hist[oó]rica|no concilia.*moneda local|saldo.*no concilia.*reversiones hist[oó]ricas/i);

  // Rounding across several partial reversals must be absorbed by the final
  // reversal: no local or foreign dust may remain at a non-exact FX rate.
  await db.query('savepoint fractional_partial_reversals');
  try {
    const fractionalSource = await createPendingSource(
      `ASI_PEN-${stamp}-FRACTIONAL`,
      7,
      'ACTUAL',
      3.141593,
    );
    await db.query('set local role authenticated');
    for (const amount of [5.123457, 6.234569]) {
      await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
        fractionalSource.journal_id,
        JSON.stringify({
          reversalDate: '1998-12-15',
          amount,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Prueba de redondeo multimoneda',
          supports: [],
        }),
      ]);
    }
    await db.query('reset role');
    const fractionalRemaining = await one(`select pending_balance_local,pending_balance_foreign
      from public.journal where journal_id=$1`, [fractionalSource.journal_id]);
    assert.ok(number(fractionalRemaining.pending_balance_local) > 0);
    assert.ok(number(fractionalRemaining.pending_balance_foreign) > 0);
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      fractionalSource.journal_id,
      JSON.stringify({
        reversalDate: '1998-12-20',
        amount: fractionalRemaining.pending_balance_local,
        type: 'ERROR_CORRECCION',
        errorDescription: 'Consumo exacto del remanente',
        supports: [],
      }),
    ]);
    await db.query('reset role');
    const fractionalFinal = await one(`select pending_initial_local,pending_initial_foreign,
        pending_reversed_local,pending_reversed_foreign,pending_balance_local,
        pending_balance_foreign,reversal_status
      from public.journal where journal_id=$1`, [fractionalSource.journal_id]);
    assert.equal(number(fractionalFinal.pending_balance_local), 0);
    assert.equal(number(fractionalFinal.pending_balance_foreign), 0);
    assert.equal(fractionalFinal.reversal_status, 'REVERSADO_TOTAL');
    assert.ok(Math.abs(number(fractionalFinal.pending_reversed_local)
      - number(fractionalFinal.pending_initial_local)) < 0.000001);
    assert.ok(Math.abs(number(fractionalFinal.pending_reversed_foreign)
      - number(fractionalFinal.pending_initial_foreign)) < 0.000001);
    const fractionalApplied = await one(`select count(*)::int count,
        sum(reversed_local) local,sum(reversed_foreign) foreign
      from public.pending_invoice_reversal where source_journal_id=$1`, [fractionalSource.journal_id]);
    assert.equal(fractionalApplied.count, 3);
    assert.ok(Math.abs(number(fractionalApplied.local)
      - number(fractionalFinal.pending_initial_local)) < 0.000001);
    assert.ok(Math.abs(number(fractionalApplied.foreign)
      - number(fractionalFinal.pending_initial_foreign)) < 0.000001);
  } finally {
    await db.query('rollback to savepoint fractional_partial_reversals');
    await db.query('reset role');
  }

  // High historical rates magnify the six-decimal rounding of each foreign
  // leg. Four partial reversals must pass every subsequent preflight, and the
  // fifth/final reversal must consume the exact local and foreign residuals.
  const highRateSource = await createPendingSource(
    `ASI_PEN-${stamp}-HIGH-RATE-PARTIALS`, 500, 'ACTUAL', 4000, '1998-12-01',
  );
  const highRatePartials = [123456.78996, 234567.88996, 345678.90996, 456789.12996];
  for (const [index, amountLocal] of highRatePartials.entries()) {
    const rounded = await one(`select round($1::numeric/$2::numeric,6) value`, [
      amountLocal,
      4000,
    ]);
    assert.match(String(rounded.value), /^\d+\.\d{6}$/);
    const amountForeign = number(rounded.value);
    assert.ok(Math.abs(amountLocal - amountForeign * 4000) > 0);
    assert.ok(Math.abs(amountLocal - amountForeign * 4000) <= 0.005);
    await reverseAndAssertHistoricalFx({
      sourceId: highRateSource.journal_id,
      reversalDate: '1998-12-15',
      amountLocal,
      amountForeign,
      type: 'ERROR_CORRECCION',
      periodType: 'ACTUAL',
      description: `Parcial ${index + 1} con redondeo a seis decimales`,
      historicalRate: 4000,
    });
  }
  const highRateRemaining = await one(`select pending_balance_local,pending_balance_foreign
    from public.journal where journal_id=$1`, [highRateSource.journal_id]);
  assert.ok(number(highRateRemaining.pending_balance_local) > 0);
  assert.ok(number(highRateRemaining.pending_balance_foreign) > 0);
  const highRateFinalDeviation = Math.abs(
    number(highRateRemaining.pending_balance_local)
      - number(highRateRemaining.pending_balance_foreign) * 4000,
  );
  assert.ok(
    number(highRateRemaining.pending_balance_local)
      - number(highRateRemaining.pending_balance_foreign) * 4000 < -0.005,
  );
  assert.ok(highRateFinalDeviation > 0.005);
  assert.ok(highRateFinalDeviation <= 0.005 + 4000 * 0.0000005 * 6 + 0.000001);
  await reverseAndAssertHistoricalFx({
    sourceId: highRateSource.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: number(highRateRemaining.pending_balance_local),
    amountForeign: number(highRateRemaining.pending_balance_foreign),
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Cierre del residual local y original a tasa histórica alta',
    historicalRate: 4000,
    localFxTolerance: 0.005 + 4000 * 0.0000005 * 6 + 0.000001,
  });
  const highRateFinal = await one(`select pending_initial_local,pending_initial_foreign,
      pending_reversed_local,pending_reversed_foreign,pending_balance_local,
      pending_balance_foreign,reversal_status,
      (select count(*)::int from public.pending_invoice_reversal reversal
        where reversal.source_journal_id=journal.journal_id) reversal_count,
      (select count(distinct reversal_journal.exchange_rate)::int
        from public.pending_invoice_reversal reversal
        join public.journal reversal_journal
          on reversal_journal.journal_id=reversal.reversal_journal_id
        where reversal.source_journal_id=journal.journal_id) rate_count,
      (select min(reversal_journal.exchange_rate)
        from public.pending_invoice_reversal reversal
        join public.journal reversal_journal
          on reversal_journal.journal_id=reversal.reversal_journal_id
        where reversal.source_journal_id=journal.journal_id) frozen_rate
    from public.journal journal where journal.journal_id=$1`, [highRateSource.journal_id]);
  assert.deepEqual({
    initialLocal: number(highRateFinal.pending_initial_local),
    initialForeign: number(highRateFinal.pending_initial_foreign),
    reversedLocal: number(highRateFinal.pending_reversed_local),
    reversedForeign: number(highRateFinal.pending_reversed_foreign),
    balanceLocal: number(highRateFinal.pending_balance_local),
    balanceForeign: number(highRateFinal.pending_balance_foreign),
    status: highRateFinal.reversal_status,
    count: highRateFinal.reversal_count,
    rateCount: highRateFinal.rate_count,
    rate: number(highRateFinal.frozen_rate),
  }, {
    initialLocal: 2000000,
    initialForeign: 500,
    reversedLocal: 2000000,
    reversedForeign: 500,
    balanceLocal: 0,
    balanceForeign: 0,
    status: 'REVERSADO_TOTAL',
    count: 5,
    rateCount: 1,
    rate: 4000,
  });

  // The number of historical partials must not widen the tolerance of an
  // individual row. A 0.01 local deviation exceeds the 0.005 per-row limit,
  // although it is below 0.005 * five reversals, and must be rejected.
  await withSavepoint('partial_tolerance_not_scaled_by_count', async () => {
    const reversalsBefore = number((await one(`select count(*) value
      from public.pending_invoice_reversal where source_journal_id=$1`, [
      highRateSource.journal_id,
    ])).value);
    await db.query("select set_config('app.pending_reversal_finalize','1',true)");
    try {
      await db.query(`update public.pending_invoice_reversal
        set reversed_local=reversed_local-.01
        where reversal_id=(select min(reversal_id)
          from public.pending_invoice_reversal where source_journal_id=$1)`, [
        highRateSource.journal_id,
      ]);
    } finally {
      await db.query("select set_config('app.pending_reversal_finalize','0',true)");
    }
    await db.query("select set_config('app.pending_reversal_write','1',true)");
    try {
      await db.query(`update public.journal
        set pending_reversed_local=pending_reversed_local-.01,
          pending_balance_local=.01,reversal_status='REVERSADO_PARCIAL'
        where journal_id=$1`, [highRateSource.journal_id]);
    } finally {
      await db.query("select set_config('app.pending_reversal_write','0',true)");
    }
    const tamperedPartial = await one(`select reversal.reversed_local,
        reversal.reversed_foreign,
        abs(reversal.reversed_local-round(reversal.reversed_foreign*4000,6)) deviation
      from public.pending_invoice_reversal reversal
      where reversal.reversal_id=(select min(candidate.reversal_id)
        from public.pending_invoice_reversal candidate where candidate.source_journal_id=$1)`, [
      highRateSource.journal_id,
    ]);
    assert.ok(number(tamperedPartial.deviation) > 0.005);
    assert.ok(number(tamperedPartial.deviation) < 0.005 * reversalsBefore);

    await db.query('savepoint partial_tolerance_rpc_attempt');
    await db.query('set local role authenticated');
    try {
      await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
        highRateSource.journal_id,
        JSON.stringify({
          reversalDate: '1998-12-20',
          amount: 0.01,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Debe rechazarse la parcial fuera de tolerancia',
          supports: [],
        }),
      ]);
    } catch (error) {
      await db.query('rollback to savepoint partial_tolerance_rpc_attempt');
      await db.query('reset role');
      const reversalsAfter = number((await one(`select count(*) value
        from public.pending_invoice_reversal where source_journal_id=$1`, [
        highRateSource.journal_id,
      ])).value);
      assert.equal(reversalsAfter, reversalsBefore);
      throw error;
    }
    await db.query('reset role');
  }, /reversi[oó]n hist[oó]rica.*tasa congelada|parcial.*tolerancia/i);

  // Exercise the opposite rounding sign. Before the hardened wrapper, the
  // delegate attempted to write 500.000002 foreign against a 500 source and
  // violated journal_pending_reversal_amounts_valid before it could correct
  // the final residual.
  const highRateOppositeSource = await createPendingSource(
    `ASI_PEN-${stamp}-HIGH-RATE-OPPOSITE`, 500, 'ACTUAL', 4000, '1998-12-01',
  );
  for (const [index, amountLocal] of [
    123456.79,
    234567.89,
    345678.91,
    456789.13,
  ].entries()) {
    const rounded = await one(`select round($1::numeric/4000,6) value`, [amountLocal]);
    const amountForeign = number(rounded.value);
    assert.ok(amountForeign * 4000 - amountLocal > 0);
    assert.ok(amountForeign * 4000 - amountLocal <= 0.005);
    await reverseAndAssertHistoricalFx({
      sourceId: highRateOppositeSource.journal_id,
      reversalDate: '1998-12-15',
      amountLocal,
      amountForeign,
      type: 'ERROR_CORRECCION',
      periodType: 'ACTUAL',
      description: `Parcial opuesta ${index + 1} con redondeo a seis decimales`,
      historicalRate: 4000,
    });
  }
  const highRateOppositeRemaining = await one(`select pending_balance_local,
      pending_balance_foreign
    from public.journal where journal_id=$1`, [highRateOppositeSource.journal_id]);
  const highRateOppositeSignedDifference = number(highRateOppositeRemaining.pending_balance_local)
    - number(highRateOppositeRemaining.pending_balance_foreign) * 4000;
  assert.ok(highRateOppositeSignedDifference > 0.005);
  assert.ok(highRateOppositeSignedDifference
    <= 0.005 + 4000 * 0.0000005 * 6 + 0.000001);
  await reverseAndAssertHistoricalFx({
    sourceId: highRateOppositeSource.journal_id,
    reversalDate: '1998-12-20',
    amountLocal: number(highRateOppositeRemaining.pending_balance_local),
    amountForeign: number(highRateOppositeRemaining.pending_balance_foreign),
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Cierre del residual opuesto a tasa histórica alta',
    historicalRate: 4000,
    localFxTolerance: 0.005 + 4000 * 0.0000005 * 6 + 0.000001,
  });
  const highRateOppositeFinal = await one(`select pending_reversed_local,
      pending_reversed_foreign,pending_balance_local,pending_balance_foreign,
      reversal_status,(select count(*)::int from public.pending_invoice_reversal reversal
        where reversal.source_journal_id=journal.journal_id) reversal_count
    from public.journal journal where journal_id=$1`, [highRateOppositeSource.journal_id]);
  assert.deepEqual({
    reversedLocal: number(highRateOppositeFinal.pending_reversed_local),
    reversedForeign: number(highRateOppositeFinal.pending_reversed_foreign),
    balanceLocal: number(highRateOppositeFinal.pending_balance_local),
    balanceForeign: number(highRateOppositeFinal.pending_balance_foreign),
    status: highRateOppositeFinal.reversal_status,
    count: highRateOppositeFinal.reversal_count,
  }, {
    reversedLocal: 2000000,
    reversedForeign: 500,
    balanceLocal: 0,
    balanceForeign: 0,
    status: 'REVERSADO_TOTAL',
    count: 5,
  });

  const partialSource = await createPendingSource(`ASI_PEN-${stamp}-PARTIAL`, 500);

  await db.query('set local role authenticated');
  const partialReversal = (await one(
    `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
    [partialSource.journal_id, JSON.stringify({
      reversalDate: '1998-12-15',
      amount: 104000,
      type: 'ERROR_CORRECCION',
      errorDescription: 'Prueba de reversión parcial previa',
      supports: [],
    })],
  )).value;
  await db.query('reset role');
  assert.equal(partialReversal.periodType, 'ACTUAL');

  const partialImpact = await one(`select
      sum(impact.debit_amount)filter(where account.account_number='413001') debit_counterpart,
      sum(impact.credit_amount)filter(where account.account_number='113003') credit_control,
      sum(impact.debit_fx)filter(where account.account_number='413001') debit_counterpart_fx,
      sum(impact.credit_fx)filter(where account.account_number='113003') credit_control_fx
    from public.journal reversal
    join public.gl_impact impact using(transaction_id)
    join public.chart_accounts account using(account_id)
    where reversal.journal_id=$1`, [partialReversal.journalId]);
  assert.equal(number(partialImpact.debit_counterpart), 104000);
  assert.equal(number(partialImpact.credit_control), 104000);
  assert.equal(number(partialImpact.debit_counterpart_fx), 200);
  assert.equal(number(partialImpact.credit_control_fx), 200);

  const sourceStateBefore = await one(`select pending_initial_local,pending_initial_foreign,
      pending_reversed_local,pending_reversed_foreign,pending_balance_local,
      pending_balance_foreign,reversal_status
    from public.journal where journal_id=$1`, [partialSource.journal_id]);
  assert.equal(number(sourceStateBefore.pending_initial_local), 260000);
  assert.equal(number(sourceStateBefore.pending_initial_foreign), 500);
  assert.equal(number(sourceStateBefore.pending_reversed_local), 104000);
  assert.equal(number(sourceStateBefore.pending_reversed_foreign), 200);
  assert.equal(number(sourceStateBefore.pending_balance_local), 156000);
  assert.equal(number(sourceStateBefore.pending_balance_foreign), 300);

  // Once the first controlled reversal exists, the source's frozen currency,
  // rate and accounting detail are historical facts even before an annual
  // reclassification. Only the RPC's protected balance fields may change.
  await withSavepoint('partially_reversed_source_header_is_immutable', async () => {
    await db.query(`update public.journal
      set exchange_rate=exchange_rate+1,currency_id=$2
      where journal_id=$1`, [partialSource.journal_id, fixture.local_currency_id]);
  }, /pendiente.*reversi[oó]n.*inmutable|moneda.*tasa.*congelad|fuente.*inmutable/i);

  await withSavepoint('partially_reversed_source_lines_are_immutable', async () => {
    await db.query(`update public.journal_line
      set debit=debit+1
      where journal_line_id=(select min(journal_line_id)
        from public.journal_line where journal_id=$1)`, [partialSource.journal_id]);
  }, /pendiente.*reversi[oó]n.*inmutable|l[ií]neas?.*fuente.*inmutables?/i);

  await withSavepoint('partially_reversed_source_lines_cannot_be_replaced', async () => {
    await db.query(`delete from public.journal_line where journal_id=$1`, [partialSource.journal_id]);
  }, /pendiente.*reversi[oó]n.*inmutable|l[ií]neas?.*fuente.*inmutables?/i);

  // The opening auxiliary reconciles to its own historical accounting facts.
  // Keep them on a non-ASI_PEN journal so the ordinary and opening sources do
  // not double-count the same primary-book movement.
  const openingTransaction = await one(`insert into public."transaction"(
      tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
      exchange_rate,fiscal_period_id,total_amount,status_id,customer_id
    )values($1,'1998-12-01',$2,$3,$4,520,$5,1100,$6,$7)returning transaction_id`, [
    `OPEN-${stamp}`,
    pendingType.transaction_type_id,
    fixture.subsidiary_id,
    fixture.usd_currency_id,
    sourcePeriod.fiscal_period_id,
    status.status_id,
    fixture.customer_id,
  ]);
  const openingLedgerJournal = await one(`insert into public.journal(
      journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
      fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,
      status,created_by
    )values($1,'1998-12-01',$2,$3,$4,$5,520,$6,'Apertura de saldos iniciales',
      1100,1100,'CONTABILIZADO',$7)returning journal_id,transaction_id`, [
    `OPEN-${stamp}`,
    openingTransaction.transaction_id,
    fixture.subsidiary_id,
    fixture.usd_currency_id,
    sourcePeriod.fiscal_period_id,
    'Mayor histórico del auxiliar pendiente',
    fixture.user_id,
  ]);
  await db.query(`insert into public.journal_line(
      journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,
      cost_center_id,service_month,service_country_id,note,entity_type,
      customer_id,historical_exchange_rate,original_currency_id
    )values
    ($1,$2,500,0,500,0,$3,$4,'1998-11',$5,'Control apertura','Cliente',$6,520,$7),
    ($1,$8,0,500,0,500,$3,$4,'1998-11',$5,'Contrapartida apertura','Cliente',$6,520,$7),
    ($1,$2,500,0,500,0,$3,$4,'1998-10',$5,'Control apertura para reversión previa','Cliente',$6,520,$7),
    ($1,$8,0,500,0,500,$3,$4,'1998-10',$5,'Contrapartida apertura para reversión previa','Cliente',$6,520,$7),
    ($1,$9,100,0,100,0,$3,$4,'1997-12',$5,'Control anterior apertura','Cliente',$6,520,$7),
    ($1,$10,0,100,0,100,$3,$4,'1997-12',$5,'Puente anterior apertura','Cliente',$6,520,$7)`, [
    openingLedgerJournal.journal_id,
    fixture.current_control,
    fixture.department_id,
    fixture.cost_center_id,
    fixture.country_id,
    fixture.customer_id,
    fixture.usd_currency_id,
    fixture.current_counterpart,
    fixture.prior_control,
    fixture.bridge_account,
  ]);
  await db.query('select public.sync_journal_gl_impacts($1)', [openingLedgerJournal.journal_id]);

  openingRun = await one(`insert into public.opening_balance_runs(
      subsidiary_id,opening_date,load_type,transition_account_id,status,
      journal_id,created_by,posted_at
    )values($1,'1998-12-01','MID_YEAR',$2,'POSTED',$3,$4,now())returning id`, [
    fixture.subsidiary_id,
    fixture.transition_account,
    openingLedgerJournal.journal_id,
    fixture.user_id,
  ]);

  const openingItem = await one(`insert into public.opening_pending_invoice_items(
      run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,
      historical_exchange_rate,service_month,service_country_id,
      initial_local,initial_foreign,reversed_local,reversed_foreign,
      balance_local,balance_foreign,reversal_status,is_active,activated_at,
      note,raw_data,created_by,updated_by,period_type,origin_journal_id
    )values($1,$2,$3,'1998-11-30',$4,$5,520,'1998-11',$6,
      260000,500,0,0,260000,500,'PENDIENTE',true,now(),$7,'{}',$8,$8,
      'ACTUAL',$9)returning id`, [
    openingRun.id,
    fixture.subsidiary_id,
    `${stamp}-OPENING`,
    fixture.customer_id,
    fixture.usd_currency_id,
    fixture.country_id,
    'Pendiente inicial USD 500 a tasa 520',
    fixture.user_id,
    openingLedgerJournal.journal_id,
  ]);
  await db.query(`insert into public.opening_pending_invoice_lines(
      item_id,row_number,line_role,account_id,local_debit,local_credit,
      foreign_debit,foreign_credit,department_id,cost_center_id,
      service_month,service_country_id,note,raw_data
    )values
    ($1,1,'CONTROL',$2,260000,0,500,0,$3,$4,'1998-11',$5,'Control','{}'),
    ($1,2,'COUNTERPART',$6,0,260000,0,500,$3,$4,'1998-11',$5,'Contrapartida','{}')`, [
    openingItem.id,
    fixture.current_control,
    fixture.department_id,
    fixture.cost_center_id,
    fixture.country_id,
    fixture.current_counterpart,
  ]);

  const preAnnualOpening = await one(`insert into public.opening_pending_invoice_items(
      run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,
      historical_exchange_rate,service_month,service_country_id,
      initial_local,initial_foreign,reversed_local,reversed_foreign,
      balance_local,balance_foreign,reversal_status,is_active,activated_at,
      note,raw_data,created_by,updated_by,period_type,origin_journal_id
    )values($1,$2,$3,'1998-10-31',$4,$5,520,'1998-10',$6,
      260000,500,0,0,260000,500,'PENDIENTE',true,now(),$7,'{}',$8,$8,
      'ACTUAL',$9)returning id`, [
    openingRun.id,
    fixture.subsidiary_id,
    `${stamp}-OPENING-PRE-ANNUAL-MATRIX`,
    fixture.customer_id,
    fixture.usd_currency_id,
    fixture.country_id,
    'Pendiente inicial ACTUAL para matriz de reversiones',
    fixture.user_id,
    openingLedgerJournal.journal_id,
  ]);
  await db.query(`insert into public.opening_pending_invoice_lines(
      item_id,row_number,line_role,account_id,local_debit,local_credit,
      foreign_debit,foreign_credit,department_id,cost_center_id,
      service_month,service_country_id,note,raw_data
    )values
    ($1,1,'CONTROL',$2,260000,0,500,0,$3,$4,'1998-10',$5,'Control ACTUAL previo','{}'),
    ($1,2,'COUNTERPART',$6,0,260000,0,500,$3,$4,'1998-10',$5,'Contrapartida ACTUAL previa','{}')`, [
    preAnnualOpening.id,
    fixture.current_control,
    fixture.department_id,
    fixture.cost_center_id,
    fixture.country_id,
    fixture.current_counterpart,
  ]);

  const priorOpening = await one(`insert into public.opening_pending_invoice_items(
      run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,
      historical_exchange_rate,service_month,service_country_id,
      initial_local,initial_foreign,reversed_local,reversed_foreign,
      balance_local,balance_foreign,reversal_status,is_active,activated_at,
      note,raw_data,created_by,updated_by,period_type,origin_journal_id
    )values($1,$2,$3,'1997-12-31',$4,$5,520,'1997-12',$6,
      52000,100,0,0,52000,100,'PENDIENTE',true,now(),$7,'{}',$8,$8,
      'ANTERIOR',$9)returning id`, [
    openingRun.id,
    fixture.subsidiary_id,
    `${stamp}-ALREADY-PRIOR`,
    fixture.customer_id,
    fixture.usd_currency_id,
    fixture.country_id,
    'Ya era de períodos anteriores',
    fixture.user_id,
    openingLedgerJournal.journal_id,
  ]);
  await db.query(`insert into public.opening_pending_invoice_lines(
      item_id,row_number,line_role,account_id,local_debit,local_credit,
      foreign_debit,foreign_credit,department_id,cost_center_id,
      service_month,service_country_id,note,raw_data
    )values
    ($1,1,'CONTROL',$2,52000,0,100,0,$3,$4,'1997-12',$5,'Control anterior','{}'),
    ($1,2,'COUNTERPART',$6,0,52000,0,100,$3,$4,'1997-12',$5,'Puente anterior','{}')`, [
    priorOpening.id,
    fixture.prior_control,
    fixture.department_id,
    fixture.cost_center_id,
    fixture.country_id,
    fixture.bridge_account,
  ]);

  await withSavepoint('opening_source_lines_do_not_reconcile', async () => {
    const reversalsBefore = number((await one(`select count(*) value
      from public.pending_invoice_reversal where source_opening_pending_id=$1`, [
      preAnnualOpening.id,
    ])).value);
    await db.query(`update public.opening_pending_invoice_lines
      set local_debit=case when line_role='CONTROL'then 260001 else 0 end,
        local_credit=case when line_role='COUNTERPART'then 260001 else 0 end,
        foreign_debit=case when line_role='CONTROL'then 501 else 0 end,
        foreign_credit=case when line_role='COUNTERPART'then 501 else 0 end
      where item_id=$1`, [preAnnualOpening.id]);
    const tamperedLines = await one(`select sum(local_debit) local_debit,
        sum(local_credit) local_credit,sum(foreign_debit) foreign_debit,
        sum(foreign_credit) foreign_credit
      from public.opening_pending_invoice_lines where item_id=$1`, [preAnnualOpening.id]);
    assert.deepEqual({
      localDebit: number(tamperedLines.local_debit),
      localCredit: number(tamperedLines.local_credit),
      foreignDebit: number(tamperedLines.foreign_debit),
      foreignCredit: number(tamperedLines.foreign_credit),
    }, { localDebit: 260001, localCredit: 260001, foreignDebit: 501, foreignCredit: 501 });
    await db.query('savepoint opening_source_line_rpc_attempt');
    await db.query('set local role authenticated');
    try {
      await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
        -number(preAnnualOpening.id),
        JSON.stringify({
          reversalDate: '1998-12-15',
          amount: 52000,
          type: 'ERROR_CORRECCION',
          errorDescription: 'Debe rechazarse por detalle inicial adulterado',
          supports: [],
        }),
      ]);
    } catch (error) {
      await db.query('rollback to savepoint opening_source_line_rpc_attempt');
      await db.query('reset role');
      const reversalsAfter = number((await one(`select count(*) value
        from public.pending_invoice_reversal where source_opening_pending_id=$1`, [
        preAnnualOpening.id,
      ])).value);
      assert.equal(reversalsAfter, reversalsBefore);
      throw error;
    }
    await db.query('reset role');
  }, /l[ií]neas del pendiente inicial.*no concilian|importes local y original/i);

  await withSavepoint('opening_inconsistent_historical_balance', async () => {
    await db.query(`update public.opening_pending_invoice_items
      set reversed_local=1,balance_local=initial_local-1
      where id=$1`, [preAnnualOpening.id]);
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      -number(preAnnualOpening.id),
      JSON.stringify({
        reversalDate: '1998-12-15',
        amount: 52000,
        type: 'ERROR_CORRECCION',
        errorDescription: 'Debe rechazarse por tasa histórica inconsistente',
        supports: [],
      }),
    ]);
  }, /pendiente inicial.*no reproduce.*tasa hist[oó]rica|no concilia.*reversiones/i);

  // Opening ACTUAL and opening ANTERIOR before the annual process. Both use
  // ERROR_CORRECCION for the partial leg and FACTURACION for the final leg.
  await reverseAndAssertHistoricalFx({
    sourceId: -number(preAnnualOpening.id),
    reversalDate: '1998-12-15',
    amountLocal: 104000,
    amountForeign: 200,
    type: 'ERROR_CORRECCION',
    periodType: 'ACTUAL',
    description: 'Corrección parcial de apertura actual',
  });
  const preAnnualOpeningInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-PRE-OPENING-ACTUAL`, '1998-12-20', 300,
    sourcePeriod.fiscal_period_id, 500,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: -number(preAnnualOpening.id),
    reversalDate: '1998-12-20',
    amountLocal: 156000,
    amountForeign: 300,
    type: 'FACTURACION',
    invoiceId: preAnnualOpeningInvoice.invoice_id,
    periodType: 'ACTUAL',
  });

  await reverseAndAssertHistoricalFx({
    sourceId: -number(priorOpening.id),
    reversalDate: '1998-12-15',
    amountLocal: 20800,
    amountForeign: 40,
    type: 'ERROR_CORRECCION',
    periodType: 'ANTERIOR',
    description: 'Corrección parcial de apertura anterior',
  });
  const preAnnualPriorInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-PRE-OPENING-PRIOR`, '1998-12-20', 60,
    sourcePeriod.fiscal_period_id, 500,
  );
  await reverseAndAssertHistoricalFx({
    sourceId: -number(priorOpening.id),
    reversalDate: '1998-12-20',
    amountLocal: 31200,
    amountForeign: 60,
    type: 'FACTURACION',
    invoiceId: preAnnualPriorInvoice.invoice_id,
    periodType: 'ANTERIOR',
  });
  const preAnnualOpeningStates = (await db.query(`select id,reversed_local,
      reversed_foreign,balance_local,balance_foreign,reversal_status
    from public.opening_pending_invoice_items where id=any($1::bigint[])
    order by id`, [[preAnnualOpening.id, priorOpening.id]])).rows;
  assert.equal(preAnnualOpeningStates.length, 2);
  assert.ok(preAnnualOpeningStates.every((item) => number(item.balance_local) === 0));
  assert.ok(preAnnualOpeningStates.every((item) => number(item.balance_foreign) === 0));
  assert.ok(preAnnualOpeningStates.every((item) => item.reversal_status === 'REVERSADO_TOTAL'));
  const preAnnualOpeningMetadata = (await db.query(`select item.id,
      item.historical_exchange_rate,item.currency_id,
      array_agg(account.account_number order by line.line_role) accounts
    from public.opening_pending_invoice_items item
    join public.opening_pending_invoice_lines line on line.item_id=item.id
    join public.chart_accounts account using(account_id)
    where item.id=any($1::bigint[])
    group by item.id,item.historical_exchange_rate,item.currency_id
    order by item.id`, [[preAnnualOpening.id, priorOpening.id]])).rows;
  assert.ok(preAnnualOpeningMetadata.every((item) => number(item.historical_exchange_rate) === 520));
  assert.ok(preAnnualOpeningMetadata.every((item) => String(item.currency_id) === String(fixture.usd_currency_id)));
  const currentOpeningMetadata = preAnnualOpeningMetadata.find(
    (item) => String(item.id) === String(preAnnualOpening.id),
  );
  const priorOpeningMetadata = preAnnualOpeningMetadata.find(
    (item) => String(item.id) === String(priorOpening.id),
  );
  assert.deepEqual(currentOpeningMetadata.accounts, ['113003', '413001']);
  assert.deepEqual(priorOpeningMetadata.accounts, ['113004', '413002']);
  const preAnnualOpeningReversalSums = (await db.query(`select
      source_opening_pending_id,sum(reversed_local) reversed_local,
      sum(reversed_foreign) reversed_foreign,count(*)::int reversal_count
    from public.pending_invoice_reversal
    where source_opening_pending_id=any($1::bigint[])
    group by source_opening_pending_id order by source_opening_pending_id`, [
    [preAnnualOpening.id, priorOpening.id],
  ])).rows;
  assert.deepEqual(preAnnualOpeningReversalSums.map((row) => ({
    id: String(row.source_opening_pending_id),
    local: number(row.reversed_local),
    foreign: number(row.reversed_foreign),
    count: row.reversal_count,
  })), [
    { id: String(preAnnualOpening.id), local: 260000, foreign: 500, count: 2 },
    { id: String(priorOpening.id), local: 52000, foreign: 100, count: 2 },
  ]);

  const otherTenant = await one(`select subsidiary.subsidiary_id
    from public.user_subsidiaries access
    join public.subsidiaries subsidiary using(subsidiary_id)
    where access.user_id=$1 and access.subsidiary_id<>$2 and subsidiary.is_active
    order by subsidiary.subsidiary_id limit 1`, [fixture.user_id, fixture.subsidiary_id]);
  assert.ok(otherTenant, 'Se requiere una segunda subsidiaria autorizada para validar aislamiento de sesión.');

  const crossTenantPayload = JSON.stringify({
    reversalDate: '1998-12-20',
    amount: 52000,
    type: 'ERROR_CORRECCION',
    errorDescription: 'Intento desde otra subsidiaria activa',
    supports: [],
  });
  await withSavepoint('cross_tenant_regular_reversal', async () => {
    await db.query(`update public.user_company_sessions set subsidiary_id=$1
      where session_id=$2`, [otherTenant.subsidiary_id, fixture.session_id]);
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      partialSource.journal_id,
      crossTenantPayload,
    ]);
  }, /subsidiaria|sesi[oó]n activa|acceso|autoriz/i);
  await withSavepoint('cross_tenant_opening_reversal', async () => {
    await db.query(`update public.user_company_sessions set subsidiary_id=$1
      where session_id=$2`, [otherTenant.subsidiary_id, fixture.session_id]);
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      -number(openingItem.id),
      crossTenantPayload,
    ]);
  }, /subsidiaria|sesi[oó]n activa|acceso|autoriz/i);

  // A reversal posted after the January 1 cutoff makes a retroactive annual
  // move ambiguous. Preview must expose the issue and execute must reject it.
  await db.query('savepoint reversal_after_cutoff');
  try {
    const futureReversedSource = await createPendingSource(
      `ASI_PEN-${stamp}-FUTURE-REV`, 100, 'ACTUAL', 520, '1998-12-02',
    );
    await db.query('set local role authenticated');
    await db.query(`select public.reverse_pending_invoice_journal($1,$2::jsonb)`, [
      futureReversedSource.journal_id,
      JSON.stringify({
        reversalDate: '1999-01-02',
        amount: 52000,
        type: 'ERROR_CORRECCION',
        errorDescription: 'Reversión posterior al corte anual',
        supports: [],
      }),
    ]);
    const retroactivePreview = (await one(
      `select public.pending_invoice_reclassification_preview('1999-01-01')value`,
    )).value;
    assert.equal(retroactivePreview.canExecute, false);
    assert.match(JSON.stringify(retroactivePreview.issues), /revers|posterior|corte/i);
    await assert.rejects(
      () => db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`),
      /revers|posterior|corte/i,
    );
  } finally {
    await db.query('rollback to savepoint reversal_after_cutoff');
    await db.query('reset role');
  }

  // Any ledger residue in 113003 that is not backed by the operational
  // auxiliary must stop the run instead of silently sealing a difference.
  await db.query('savepoint unmatched_control_balance');
  try {
    const orphanTransaction = await one(`insert into public."transaction"(
        tran_number,tran_date,transaction_type_id,subsidiary_id,currency_id,
        exchange_rate,fiscal_period_id,total_amount,status_id,customer_id
      )values($1,'1998-12-20',$2,$3,$4,520,$5,100,$6,$7)returning transaction_id`, [
      `GL-${stamp}-UNMATCHED-113003`,
      pendingType.transaction_type_id,
      fixture.subsidiary_id,
      fixture.usd_currency_id,
      sourcePeriod.fiscal_period_id,
      status.status_id,
      fixture.customer_id,
    ]);
    const orphanJournal = await one(`insert into public.journal(
        journal_number,journal_date,transaction_id,subsidiary_id,currency_id,
        fiscal_period_id,exchange_rate,memo,journal_type,total_debit,total_credit,
        status,created_by
      )values($1,'1998-12-20',$2,$3,$4,$5,520,$6,'Diario General',100,100,
        'CONTABILIZADO',$7)returning journal_id`, [
      `GL-${stamp}-UNMATCHED-113003`,
      orphanTransaction.transaction_id,
      fixture.subsidiary_id,
      fixture.usd_currency_id,
      sourcePeriod.fiscal_period_id,
      'Residuo deliberado sin auxiliar',
      fixture.user_id,
    ]);
    await db.query(`insert into public.journal_line(
        journal_id,account_id,debit,credit,debit_fx,credit_fx,department_id,
        cost_center_id,note,entity_type,customer_id,historical_exchange_rate,
        original_currency_id
      )values
      ($1,$2,100,0,100,0,$3,$4,'Residuo 113003','Cliente',$5,520,$6),
      ($1,$7,0,100,0,100,$3,$4,'Contrapartida','Cliente',$5,520,$6)`, [
      orphanJournal.journal_id,
      fixture.current_control,
      fixture.department_id,
      fixture.cost_center_id,
      fixture.customer_id,
      fixture.usd_currency_id,
      fixture.current_counterpart,
    ]);
    await db.query('select public.sync_journal_gl_impacts($1)', [orphanJournal.journal_id]);
    await db.query('set local role authenticated');
    const unreconciledPreview = (await one(
      `select public.pending_invoice_reclassification_preview('1999-01-01')value`,
    )).value;
    assert.equal(unreconciledPreview.canExecute, false);
    assert.match(JSON.stringify(unreconciledPreview.issues), /concili|residuo|113003|mayor/i);
    await assert.rejects(
      () => db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`),
      /concili|residuo|113003|mayor/i,
    );
  } finally {
    await db.query('rollback to savepoint unmatched_control_balance');
    await db.query('reset role');
  }

  // A source with its two expected impacts plus an orphan opposite-side GL
  // impact is mixed and must never be accepted as a valid candidate.
  await db.query('savepoint mixed_source_gl');
  try {
    const mixedSource = await createPendingSource(
      `ASI_PEN-${stamp}-MIXED-GL`, 50, 'ACTUAL', 520, '1998-12-02',
    );
    await db.query(`insert into public.gl_impact(
        transaction_id,account_id,subsidiary_id,fiscal_period_id,accounting_book_id,
        debit_amount,credit_amount,debit_fx,credit_fx,posting_date,original_currency_id
      )values($1,$2,$3,$4,$5,0,5200,0,10,'1998-12-01',$6)`, [
      mixedSource.transaction_id,
      fixture.current_control,
      fixture.subsidiary_id,
      sourcePeriod.fiscal_period_id,
      fixture.accounting_book_id,
      fixture.usd_currency_id,
    ]);
    await db.query('set local role authenticated');
    const mixedPreview = (await one(
      `select public.pending_invoice_reclassification_preview('1999-01-01')value`,
    )).value;
    assert.equal(mixedPreview.canExecute, false);
    assert.match(JSON.stringify(mixedPreview.issues), /impact|mixt|concili|113003|mayor/i);
    await assert.rejects(
      () => db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`),
      /impact|mixt|concili|113003|mayor|fuente/i,
    );
  } finally {
    await db.query('rollback to savepoint mixed_source_gl');
    await db.query('reset role');
  }

  // The journal says USD 500 while its otherwise valid primary-book impacts
  // say USD 600. The source must be rejected even if its account pair is valid.
  await db.query('savepoint journal_gl_fx_mismatch');
  try {
    const mismatchedSource = await createPendingSource(
      `ASI_PEN-${stamp}-FX-MISMATCH`, 500, 'ACTUAL', 520, '1998-12-02',
    );
    await db.query(`update public.gl_impact
      set debit_fx=case when debit_amount>0 then 600 else 0 end,
        credit_fx=case when credit_amount>0 then 600 else 0 end
      where transaction_id=$1`, [mismatchedSource.transaction_id]);
    await db.query('set local role authenticated');
    const mismatchPreview = (await one(
      `select public.pending_invoice_reclassification_preview('1999-01-01')value`,
    )).value;
    assert.equal(mismatchPreview.canExecute, false);
    assert.match(JSON.stringify(mismatchPreview.issues), /tasa|impact|moneda|l[ií]nea|concili/i);
    await assert.rejects(
      () => db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`),
      /tasa|impact|moneda|l[ií]nea|concili|fuente/i,
    );
  } finally {
    await db.query('rollback to savepoint journal_gl_fx_mismatch');
    await db.query('reset role');
  }

  await withSavepoint('missing_gl_source', async () => {
    const broken = await createPendingSource(
      `ASI_PEN-${stamp}-WITHOUT-GL`, 50, 'ACTUAL', 520, '1998-12-02',
    );
    await db.query('delete from public.gl_impact where transaction_id=$1', [broken.transaction_id]);
    await db.query('set local role authenticated');
    await db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`);
  }, /impacto|mayor|concili|saldo contable|fuente|l[ií]nea|113003/i);

  await withSavepoint('future_preview_date', async () => {
    await db.query('set local role authenticated');
    await db.query(`select public.pending_invoice_reclassification_preview('2199-01-01')`);
  }, /futura|posterior.*fecha actual/i);
  await withSavepoint('future_execute_date', async () => {
    await db.query('set local role authenticated');
    await db.query(`select public.pending_invoice_reclassification_execute('2199-01-01')`);
  }, /futura|posterior.*fecha actual/i);
  assert.equal(number((await one(`select count(*) value
    from public.pending_invoice_reclassification_runs
    where subsidiary_id=$1 and fiscal_year=2199`, [fixture.subsidiary_id])).value), 0);

  await withSavepoint('invalid_reclass_date', async () => {
    await db.query('set local role authenticated');
    await db.query(`select public.pending_invoice_reclassification_execute('1999-01-02')`);
  }, /01 de enero/i);

  await withSavepoint('closed_target_period', async () => {
    await db.query(`update public.fiscal_periods set ap_closed=true,ar_closed=true,
      gl_closed=true where fiscal_period_id=$1`, [targetPeriod.fiscal_period_id]);
    await db.query('set local role authenticated');
    await db.query(`select public.pending_invoice_reclassification_execute('1999-01-01')`);
  }, /período contable abierto|periodo contable abierto/i);

  await db.query('set local role authenticated');
  const preview = (await one(
    `select public.pending_invoice_reclassification_preview('1999-01-01')value`,
  )).value;
  await db.query('reset role');
  assert.equal(preview.canExecute, true, JSON.stringify(preview.issues));
  assert.equal(number(preview.totals.count), 2);
  assert.equal(number(preview.totals.local), 416000);
  assert.equal(number(preview.totals.foreign), 800);
  const partialPreview = preview.rows.find((row) => row.sourceType === 'JOURNAL');
  const openingPreview = preview.rows.find((row) => row.sourceType === 'OPENING');
  assert.equal(number(partialPreview.balanceLocal), 156000);
  assert.equal(number(partialPreview.balanceForeign), 300);
  assert.equal(number(partialPreview.historicalExchangeRate), 520);
  assert.equal(number(openingPreview.balanceLocal), 260000);
  assert.equal(number(openingPreview.balanceForeign), 500);
  assert.ok(!preview.rows.some((row) => String(row.sourceId) === String(priorOpening.id)));

  const sourceAccountingBefore = (await one(`select jsonb_build_object(
      'transaction',(select to_jsonb(value)-array['updated_at'] from public."transaction" value where value.transaction_id=$1),
      'journal',(select to_jsonb(value)-array['pending_period_type','pending_origin_journal_id',
        'pending_initial_local','pending_initial_foreign','pending_reversed_local',
        'pending_reversed_foreign','pending_balance_local','pending_balance_foreign','reversal_status']
        from public.journal value where value.journal_id=$2),
      'lines',(select jsonb_agg(to_jsonb(value)order by value.journal_line_id)
        from public.journal_line value where value.journal_id=$2),
      'gl',(select jsonb_agg(to_jsonb(value)order by value.gl_impact_id)
        from public.gl_impact value where value.transaction_id=$1)
    )value`, [partialSource.transaction_id, partialSource.journal_id])).value;

  // December is closed before the January move. The annual routine may update
  // operational classification only; it cannot rewrite the historical entry.
  await db.query(`update public.fiscal_periods set ap_closed=true,ar_closed=true,
    gl_closed=true,is_closed=true,checklist_completed=true where fiscal_period_id=$1`, [sourcePeriod.fiscal_period_id]);

  await db.query('set local role authenticated');
  const executed = (await one(
    `select public.pending_invoice_reclassification_execute('1999-01-01')value`,
  )).value;
  await db.query('reset role');
  assert.equal(executed.status, 'POSTED');
  assert.equal(executed.alreadyExecuted, false);
  assert.equal(number(executed.itemCount), 2);
  assert.equal(number(executed.journalCount), 2);
  assert.equal(number(executed.totalLocal), 416000);

  const sourceAccountingAfter = (await one(`select jsonb_build_object(
      'transaction',(select to_jsonb(value)-array['updated_at'] from public."transaction" value where value.transaction_id=$1),
      'journal',(select to_jsonb(value)-array['pending_period_type','pending_origin_journal_id',
        'pending_initial_local','pending_initial_foreign','pending_reversed_local',
        'pending_reversed_foreign','pending_balance_local','pending_balance_foreign','reversal_status']
        from public.journal value where value.journal_id=$2),
      'lines',(select jsonb_agg(to_jsonb(value)order by value.journal_line_id)
        from public.journal_line value where value.journal_id=$2),
      'gl',(select jsonb_agg(to_jsonb(value)order by value.gl_impact_id)
        from public.gl_impact value where value.transaction_id=$1)
    )value`, [partialSource.transaction_id, partialSource.journal_id])).value;
  assert.deepEqual(sourceAccountingAfter, sourceAccountingBefore, 'La reclasificación no debe reescribir los hechos del origen cerrado.');

  const sourceStateAfter = await one(`select pending_period_type,pending_origin_journal_id,
      pending_initial_local,pending_initial_foreign,pending_reversed_local,
      pending_reversed_foreign,pending_balance_local,pending_balance_foreign,reversal_status
    from public.journal where journal_id=$1`, [partialSource.journal_id]);
  assert.equal(sourceStateAfter.pending_period_type, 'ANTERIOR');
  assert.equal(String(sourceStateAfter.pending_origin_journal_id), String(partialSource.journal_id));
  for (const key of [
    'pending_initial_local', 'pending_initial_foreign', 'pending_reversed_local',
    'pending_reversed_foreign', 'pending_balance_local', 'pending_balance_foreign',
  ]) assert.equal(number(sourceStateAfter[key]), number(sourceStateBefore[key]), key);
  assert.equal(sourceStateAfter.reversal_status, sourceStateBefore.reversal_status);

  const openingState = await one(`select period_type,initial_local,initial_foreign,
      reversed_local,reversed_foreign,balance_local,balance_foreign,reversal_status
    from public.opening_pending_invoice_items where id=$1`, [openingItem.id]);
  assert.equal(openingState.period_type, 'ANTERIOR');
  assert.equal(number(openingState.initial_local), 260000);
  assert.equal(number(openingState.initial_foreign), 500);
  assert.equal(number(openingState.balance_local), 260000);
  assert.equal(number(openingState.balance_foreign), 500);

  const openingReconciliationAfterAnnual = (await one(
    `select public.opening_pending_invoice_reconciliation($1)value`,
    [openingRun.id],
  )).value;
  assert.equal(openingReconciliationAfterAnnual.length, 2);
  assert.ok(openingReconciliationAfterAnnual.every((row) => row.balanced === true),
    JSON.stringify(openingReconciliationAfterAnnual));
  const actualOpeningReconciliation = openingReconciliationAfterAnnual.find(
    (row) => row.periodType === 'ACTUAL',
  );
  const priorOpeningReconciliation = openingReconciliationAfterAnnual.find(
    (row) => row.periodType === 'ANTERIOR',
  );
  assert.deepEqual({
    ledger: number(actualOpeningReconciliation.ledger),
    auxiliary: number(actualOpeningReconciliation.auxiliary),
    difference: number(actualOpeningReconciliation.difference),
    ledgerForeign: number(actualOpeningReconciliation.ledgerForeign),
    auxiliaryForeign: number(actualOpeningReconciliation.auxiliaryForeign),
    foreignDifference: number(actualOpeningReconciliation.foreignDifference),
  }, {
    ledger: 520000,
    auxiliary: 520000,
    difference: 0,
    ledgerForeign: 1000,
    auxiliaryForeign: 1000,
    foreignDifference: 0,
  });
  assert.deepEqual({
    ledger: number(priorOpeningReconciliation.ledger),
    auxiliary: number(priorOpeningReconciliation.auxiliary),
    difference: number(priorOpeningReconciliation.difference),
    ledgerForeign: number(priorOpeningReconciliation.ledgerForeign),
    auxiliaryForeign: number(priorOpeningReconciliation.auxiliaryForeign),
    foreignDifference: number(priorOpeningReconciliation.foreignDifference),
  }, {
    ledger: 52000,
    auxiliary: 52000,
    difference: 0,
    ledgerForeign: 100,
    auxiliaryForeign: 100,
    foreignDifference: 0,
  });

  const reclassRows = (await db.query(`select item.source_type,item.source_journal_id,
      item.source_opening_pending_id,item.local_amount,item.foreign_amount,
      item.historical_exchange_rate,item.reclassification_journal_id,
      journal.transaction_id,journal.total_debit,journal.total_credit,journal.exchange_rate,
      transaction.total_amount
    from public.pending_invoice_reclassification_items item
    join public.journal journal on journal.journal_id=item.reclassification_journal_id
    join public."transaction" transaction using(transaction_id)
    where item.run_id=$1 order by item.source_type`, [executed.runId])).rows;
  assert.equal(reclassRows.length, 2);

  for (const row of reclassRows) {
    const localAmount = number(row.local_amount);
    const foreignAmount = number(row.foreign_amount);
    assert.equal(number(row.historical_exchange_rate), 520);
    assert.equal(number(row.exchange_rate), 520);
    assert.equal(number(row.total_debit), foreignAmount * 2);
    assert.equal(number(row.total_credit), foreignAmount * 2);
    assert.equal(number(row.total_amount), foreignAmount * 2);

    const lines = (await db.query(`select account.account_number,line.debit,line.credit,
        line.debit_fx,line.credit_fx,line.service_month,line.service_country_id,
        line.customer_id,line.department_id,line.cost_center_id
      from public.journal_line line join public.chart_accounts account using(account_id)
      where line.journal_id=$1 order by line.journal_line_id`, [row.reclassification_journal_id])).rows;
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => line.service_month === (row.source_type === 'OPENING' ? '1998-11' : '1998-12')));
    assert.ok(lines.every((line) => String(line.service_country_id) === String(fixture.country_id)));
    assert.ok(lines.every((line) => String(line.customer_id) === String(fixture.customer_id)));
    assert.ok(lines.every((line) => String(line.department_id) === String(fixture.department_id)));
    assert.ok(lines.every((line) => String(line.cost_center_id) === String(fixture.cost_center_id)));
    assert.ok(!lines.some((line) => line.account_number === '413001'));
    const lineTotals = lines.reduce((total, line) => ({
      debit: total.debit + number(line.debit),
      credit: total.credit + number(line.credit),
      debitFx: total.debitFx + number(line.debit_fx),
      creditFx: total.creditFx + number(line.credit_fx),
    }), { debit: 0, credit: 0, debitFx: 0, creditFx: 0 });
    assert.deepEqual(lineTotals, {
      debit: foreignAmount * 2,
      credit: foreignAmount * 2,
      debitFx: foreignAmount * 2,
      creditFx: foreignAmount * 2,
    });
    const lineBridge = lines.filter((line) => line.account_number === '413002');
    assert.equal(lineBridge.length, 2);
    assert.equal(lineBridge.reduce((sum, line) => sum + number(line.debit) - number(line.credit), 0), 0);
    assert.equal(lineBridge.reduce((sum, line) => sum + number(line.debit_fx) - number(line.credit_fx), 0), 0);

    const impacts = (await db.query(`select account.account_number,impact.debit_amount,
        impact.credit_amount,impact.debit_fx,impact.credit_fx,impact.original_currency_id
      from public.gl_impact impact join public.chart_accounts account using(account_id)
      where impact.transaction_id=$1 and impact.accounting_book_id=$2
      order by impact.gl_impact_id`, [row.transaction_id, fixture.accounting_book_id])).rows;
    assert.equal(impacts.length, 4);
    const totals = impacts.reduce((total, impact) => ({
      debit: total.debit + number(impact.debit_amount),
      credit: total.credit + number(impact.credit_amount),
      debitFx: total.debitFx + number(impact.debit_fx),
      creditFx: total.creditFx + number(impact.credit_fx),
    }), { debit: 0, credit: 0, debitFx: 0, creditFx: 0 });
    assert.deepEqual(totals, {
      debit: localAmount * 2,
      credit: localAmount * 2,
      debitFx: foreignAmount * 2,
      creditFx: foreignAmount * 2,
    });
    assert.ok(impacts.every((impact) => String(impact.original_currency_id) === String(fixture.usd_currency_id)));
    const bridge = impacts.filter((impact) => impact.account_number === '413002');
    assert.equal(bridge.length, 2);
    assert.equal(bridge.reduce((sum, impact) => sum + number(impact.debit_amount) - number(impact.credit_amount), 0), 0);
    assert.equal(bridge.reduce((sum, impact) => sum + number(impact.debit_fx) - number(impact.credit_fx), 0), 0);
  }

  const usd500 = reclassRows.find((row) => row.source_type === 'OPENING');
  assert.equal(number(usd500.local_amount), 260000);
  assert.equal(number(usd500.foreign_amount), 500);
  assert.equal(number(usd500.total_debit), 1000);
  assert.equal(number(usd500.total_credit), 1000);

  const protectedReclass = reclassRows[0];
  await withSavepoint('immutable_reclass_header', () => db.query(
    `update public.journal set memo='ALTERADO' where journal_id=$1`,
    [protectedReclass.reclassification_journal_id],
  ), /inmutabl/i);
  await withSavepoint('immutable_reclass_line', () => db.query(
    `update public.journal_line set note='ALTERADA' where journal_id=$1`,
    [protectedReclass.reclassification_journal_id],
  ), /inmutabl/i);
  await withSavepoint('immutable_reclass_gl', () => db.query(
    `delete from public.gl_impact where transaction_id=$1`,
    [protectedReclass.transaction_id],
  ), /inmutabl/i);
  await withSavepoint('immutable_reclass_transaction', () => db.query(
    `update public."transaction" set total_amount=total_amount+1 where transaction_id=$1`,
    [protectedReclass.transaction_id],
  ), /inmutabl/i);
  await withSavepoint('immutable_reclassified_source_line', () => db.query(
    `update public.journal_line set note='ALTERADA' where journal_id=$1`,
    [partialSource.journal_id],
  ), /inmutabl/i);

  const countsBeforeRetry = await one(`select
      (select count(*)from public.pending_invoice_reclassification_runs where subsidiary_id=$1 and fiscal_year=1999)::int runs,
      (select count(*)from public.pending_invoice_reclassification_items where run_id=$2)::int items,
      (select count(*)from public.journal where journal_type='Reclasificación Anual de Pendientes de Facturar'
        and subsidiary_id=$1 and journal_date='1999-01-01')::int journals`, [fixture.subsidiary_id, executed.runId]);
  await db.query('set local role authenticated');
  const retried = (await one(
    `select public.pending_invoice_reclassification_execute('1999-01-01')value`,
  )).value;
  await db.query('reset role');
  assert.equal(String(retried.runId), String(executed.runId));
  assert.equal(retried.alreadyExecuted, true);
  const countsAfterRetry = await one(`select
      (select count(*)from public.pending_invoice_reclassification_runs where subsidiary_id=$1 and fiscal_year=1999)::int runs,
      (select count(*)from public.pending_invoice_reclassification_items where run_id=$2)::int items,
      (select count(*)from public.journal where journal_type='Reclasificación Anual de Pendientes de Facturar'
        and subsidiary_id=$1 and journal_date='1999-01-01')::int journals`, [fixture.subsidiary_id, executed.runId]);
  assert.deepEqual(countsAfterRetry, countsBeforeRetry);

  const lateStagedItem = await one(`insert into public.opening_pending_invoice_items(
      run_id,subsidiary_id,reference,origin_date,customer_id,currency_id,
      historical_exchange_rate,service_month,service_country_id,
      initial_local,initial_foreign,reversed_local,reversed_foreign,
      balance_local,balance_foreign,reversal_status,is_active,note,raw_data,
      created_by,updated_by,period_type,origin_journal_id
    )values($1,$2,$3,'1998-12-15',$4,$5,520,'1998-12',$6,
      52000,100,0,0,52000,100,'PENDIENTE',false,$7,'{}',$8,$8,
      'ACTUAL',$9)returning id`, [
    openingRun.id,
    fixture.subsidiary_id,
    `${stamp}-LATE-ACTIVATION`,
    fixture.customer_id,
    fixture.usd_currency_id,
    fixture.country_id,
    'Partida staged después del cierre anual',
    fixture.user_id,
    openingLedgerJournal.journal_id,
  ]);

  await db.query('savepoint activate_retroactive_opening_item');
  try {
    await assert.rejects(
      () => db.query(`update public.opening_pending_invoice_items
        set is_active=true,activated_at=now() where id=$1`, [lateStagedItem.id]),
      /reclasific|retroactiv|01 de enero|per[ií]odo/i,
    );
  } finally {
    await db.query('rollback to savepoint activate_retroactive_opening_item');
  }

  await withSavepoint('opening_run_with_reclassified_item', async () => {
    await db.query('set local role authenticated');
    await db.query('select public.opening_balance_reverse($1)', [openingRun.id]);
  }, /reclasific|per[ií]odos anteriores|pendiente/i);

  await db.query('set local role authenticated');
  const regularAfter = (await one(
    `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
    [partialSource.journal_id, JSON.stringify({
      reversalDate: '1999-01-02',
      amount: 52000,
      type: 'ERROR_CORRECCION',
      errorDescription: 'Reversión posterior a reclasificación',
      supports: [],
    })],
  )).value;
  const openingAfter = (await one(
    `select public.reverse_pending_invoice_journal($1,$2::jsonb)value`,
    [-number(openingItem.id), JSON.stringify({
      reversalDate: '1999-01-02',
      amount: 52000,
      type: 'ERROR_CORRECCION',
      errorDescription: 'Reversión de saldo inicial anterior',
      supports: [],
    })],
  )).value;
  await db.query('reset role');
  assert.equal(regularAfter.periodType, 'ANTERIOR');
  assert.equal(openingAfter.periodType, 'ANTERIOR');

  async function assertPriorReversal(journalId, localAmount, foreignAmount) {
    const header = await one(`select journal.total_debit,journal.total_credit,
        journal.exchange_rate,transaction.total_amount
      from public.journal journal join public."transaction" transaction using(transaction_id)
      where journal.journal_id=$1`, [journalId]);
    assert.equal(number(header.total_debit), foreignAmount);
    assert.equal(number(header.total_credit), foreignAmount);
    assert.equal(number(header.total_amount), foreignAmount);
    assert.equal(number(header.exchange_rate), 520);
    const lines = (await db.query(`select line.debit,line.credit,line.debit_fx,line.credit_fx,
        line.historical_exchange_rate,line.original_currency_id
      from public.journal_line line where line.journal_id=$1 order by line.journal_line_id`, [journalId])).rows;
    assert.equal(lines.length, 2);
    const lineTotals = lines.reduce((total, line) => ({
      debit: total.debit + number(line.debit),
      credit: total.credit + number(line.credit),
      debitFx: total.debitFx + number(line.debit_fx),
      creditFx: total.creditFx + number(line.credit_fx),
    }), { debit: 0, credit: 0, debitFx: 0, creditFx: 0 });
    assert.deepEqual(lineTotals, {
      debit: foreignAmount,
      credit: foreignAmount,
      debitFx: foreignAmount,
      creditFx: foreignAmount,
    });
    assert.ok(lines.every((line) => number(line.historical_exchange_rate) === 520));
    assert.ok(lines.every((line) => String(line.original_currency_id) === String(fixture.usd_currency_id)));
    const impacts = (await db.query(`select account.account_number,
        sum(impact.debit_amount) debit,sum(impact.credit_amount) credit,
        sum(impact.debit_fx) debit_fx,sum(impact.credit_fx) credit_fx
      from public.journal reversal
      join public.gl_impact impact using(transaction_id)
      join public.chart_accounts account using(account_id)
      where reversal.journal_id=$1 group by account.account_number
      order by account.account_number`, [journalId])).rows.map((row) => ({
      account: row.account_number,
      debit: number(row.debit),
      credit: number(row.credit),
      debitFx: number(row.debit_fx),
      creditFx: number(row.credit_fx),
    }));
    assert.deepEqual(impacts, [
      { account: '113004', debit: 0, credit: localAmount, debitFx: 0, creditFx: foreignAmount },
      { account: '413002', debit: localAmount, credit: 0, debitFx: foreignAmount, creditFx: 0 },
    ]);
  }
  await assertPriorReversal(regularAfter.journalId, 52000, 100);
  await assertPriorReversal(openingAfter.journalId, 52000, 100);

  const postAnnualJournalInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-POST-JOURNAL`, '1999-01-02', 200,
    targetPeriod.fiscal_period_id, 500,
  );
  const regularFinalAfter = await reverseAndAssertHistoricalFx({
    sourceId: partialSource.journal_id,
    reversalDate: '1999-01-02',
    amountLocal: 104000,
    amountForeign: 200,
    type: 'FACTURACION',
    invoiceId: postAnnualJournalInvoice.invoice_id,
    periodType: 'ANTERIOR',
  });
  const postAnnualOpeningInvoice = await createForeignBillingInvoice(
    `FAC-${stamp}-POST-OPENING`, '1999-01-02', 400,
    targetPeriod.fiscal_period_id, 500,
  );
  const openingFinalAfter = await reverseAndAssertHistoricalFx({
    sourceId: -number(openingItem.id),
    reversalDate: '1999-01-02',
    amountLocal: 208000,
    amountForeign: 400,
    type: 'FACTURACION',
    invoiceId: postAnnualOpeningInvoice.invoice_id,
    periodType: 'ANTERIOR',
  });
  assert.ok(regularFinalAfter.journalId);
  assert.ok(openingFinalAfter.journalId);
  const postAnnualFinalStates = await one(`select
      (select jsonb_build_object('local',pending_balance_local,
        'foreign',pending_balance_foreign,'status',reversal_status)
       from public.journal where journal_id=$1) journal,
      (select jsonb_build_object('local',balance_local,
        'foreign',balance_foreign,'status',reversal_status)
       from public.opening_pending_invoice_items where id=$2) opening`, [
    partialSource.journal_id,
    openingItem.id,
  ]);
  assert.deepEqual({
    local: number(postAnnualFinalStates.journal.local),
    foreign: number(postAnnualFinalStates.journal.foreign),
    status: postAnnualFinalStates.journal.status,
  }, { local: 0, foreign: 0, status: 'REVERSADO_TOTAL' });
  const postAnnualSourceRates = await one(`select
      (select exchange_rate from public.journal where journal_id=$1) journal_rate,
      (select historical_exchange_rate from public.opening_pending_invoice_items
       where id=$2) opening_rate`, [partialSource.journal_id, openingItem.id]);
  assert.equal(number(postAnnualSourceRates.journal_rate), 520);
  assert.equal(number(postAnnualSourceRates.opening_rate), 520);
  const postAnnualReversalSums = await one(`select
      (select sum(reversed_local) from public.pending_invoice_reversal
       where source_journal_id=$1) journal_local,
      (select sum(reversed_foreign) from public.pending_invoice_reversal
       where source_journal_id=$1) journal_foreign,
      (select sum(reversed_local) from public.pending_invoice_reversal
       where source_opening_pending_id=$2) opening_local,
      (select sum(reversed_foreign) from public.pending_invoice_reversal
       where source_opening_pending_id=$2) opening_foreign`, [
    partialSource.journal_id,
    openingItem.id,
  ]);
  assert.deepEqual({
    journalLocal: number(postAnnualReversalSums.journal_local),
    journalForeign: number(postAnnualReversalSums.journal_foreign),
    openingLocal: number(postAnnualReversalSums.opening_local),
    openingForeign: number(postAnnualReversalSums.opening_foreign),
  }, { journalLocal: 260000, journalForeign: 500, openingLocal: 260000, openingForeign: 500 });
  const postAnnualOpeningHistoricalPair = (await db.query(`select account.account_number
    from public.opening_pending_invoice_lines line
    join public.chart_accounts account using(account_id)
    where line.item_id=$1 order by line.line_role`, [openingItem.id])).rows
    .map((row) => row.account_number);
  assert.deepEqual(postAnnualOpeningHistoricalPair, ['113003', '413001']);
  assert.deepEqual({
    local: number(postAnnualFinalStates.opening.local),
    foreign: number(postAnnualFinalStates.opening.foreign),
    status: postAnnualFinalStates.opening.status,
  }, { local: 0, foreign: 0, status: 'REVERSADO_TOTAL' });

  await withSavepoint('generic_reverse_of_controlled_pending_reversal', async () => {
    await db.query('set local role authenticated');
    await db.query('select public.reverse_journal_entry($1)', [regularAfter.journalId]);
  }, /ASI_REV_PEN|pendiente|reversi[oó]n controlada/i);

  const sourceAccountingAfterReversal = (await one(`select jsonb_build_object(
      'transaction',(select to_jsonb(value)-array['updated_at'] from public."transaction" value where value.transaction_id=$1),
      'journal',(select to_jsonb(value)-array['pending_period_type','pending_origin_journal_id',
        'pending_initial_local','pending_initial_foreign','pending_reversed_local',
        'pending_reversed_foreign','pending_balance_local','pending_balance_foreign','reversal_status']
        from public.journal value where value.journal_id=$2),
      'lines',(select jsonb_agg(to_jsonb(value)order by value.journal_line_id)
        from public.journal_line value where value.journal_id=$2),
      'gl',(select jsonb_agg(to_jsonb(value)order by value.gl_impact_id)
        from public.gl_impact value where value.transaction_id=$1)
    )value`, [partialSource.transaction_id, partialSource.journal_id])).value;
  assert.deepEqual(sourceAccountingAfterReversal, sourceAccountingBefore,
    'La reversión posterior no debe reescribir fecha, tasa, líneas ni GL del origen cerrado.');

  console.log(JSON.stringify({
    migration: skipMigration ? 'preinstalled' : 'transactional',
    usd500At520: true,
    journalTransactionCurrency: true,
    glLocal260000AndFx500: true,
    bridgeLocalAndFxNetZero: true,
    partialLiveBalanceOnly: true,
    sourceClosedAndImmutable: true,
    internalGucsCleared: true,
    idempotent: true,
    janFirstAndOpenPeriod: true,
    regularPriorReversal: true,
    openingPriorReversal: true,
    allPendingReversalFxPaths: true,
    billingAndCorrectionReversals: true,
    foreignCurrencyBillingReversal: true,
    sameCurrencyBillingDifferentInvoiceRate: true,
    closedOriginPeriodReversal: true,
    partialAndTotalReversals: true,
    partialSourceHeaderImmutableBeforeAnnual: true,
    partialSourceLinesImmutableBeforeAnnual: true,
    controlledBalanceUpdatesStillAllowed: true,
    currentSpotRateIgnored: true,
    overReversalAboveBalanceRejected: true,
    hugeOverReversalRejected: true,
    cumulativeBillingOverapplicationRejected: true,
    localCurrencyRateOne: true,
    legacyLocalPresentationNormalized: true,
    annualWrapperLegacyNormalized: true,
    historicalClosedPeriodNormalization: true,
    preAnnualLocalRowRepaired: true,
    legacyForeignBillingRowRepaired: true,
    tamperedHistoricalDirectionRejected: true,
    historicalGlFxMismatchRejected: true,
    inconsistentJournalSourceLinesRejected: true,
    inconsistentOpeningSourceLinesRejected: true,
    inconsistentJournalFxRejected: true,
    inconsistentOpeningFxRejected: true,
    fractionalPartialsClosed: true,
    highRateRoundedPartialsClosed: true,
    highRateBothResidualSignsClosed: true,
    perPartialToleranceNotScaledByCount: true,
    openingReversalSumsReconciled: true,
    historicalOpeningPairPreserved: true,
    dimensionsPreserved: true,
    crossTenantWrappersRejected: true,
    journalGlFxMismatchRejected: true,
    missingAndMixedGlRejected: true,
    unreconciledControlBalanceRejected: true,
    futureAndPostCutoffRunsRejected: true,
    openingActivationAfterCutoffRejected: true,
    openingReconciliationBalancedAfterAnnual: true,
    controlledReversalsImmutable: true,
    aclChecked: true,
    rollback: true,
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
