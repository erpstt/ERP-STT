import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const value = async (sql, values = []) => (await one(sql, values))?.value;
const number = input => Number(input);
const close = (actual, expected, message) => assert.ok(
  Math.abs(number(actual) - number(expected)) < 0.00001,
  `${message}: ${actual} != ${expected}`
);
const expectRejected = async (sql, values, pattern) => {
  const savepoint = `sp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await db.query(`savepoint ${savepoint}`);
  try {
    await db.query(sql, values);
    assert.fail(`Se esperaba rechazo: ${pattern}`);
  } catch (error) {
    await db.query(`rollback to savepoint ${savepoint}`);
    assert.match(String(error.message), pattern);
  }
  await db.query(`release savepoint ${savepoint}`);
};

const assertBalanced = async (journalId, transactionId, label) => {
  const balances = await one(`
    select
      abs(coalesce(sum(line.debit),0)-coalesce(sum(line.credit),0))<0.00001 journal_balanced,
      (select bool_and(abs(book.debit-book.credit)<0.00001)
       from(
         select sum(impact.debit_amount) debit,sum(impact.credit_amount) credit
         from public.gl_impact impact where impact.transaction_id=$2
         group by impact.accounting_book_id
       ) book) gl_balanced
    from public.journal_line line where line.journal_id=$1
  `, [journalId, transactionId]);
  assert.equal(balances.journal_balanced, true, `${label}: el asiento debe quedar balanceado.`);
  assert.equal(balances.gl_balanced, true, `${label}: cada libro debe quedar balanceado.`);
};

const assertInvoicePosting = async ({ invoiceId, journalId, expectedAccountId, expectedNumber, total = 100 }) => {
  const invoice = await one(`
    select invoice.payable_account_id,invoice.total_amount,invoice.transaction_id,
      account.account_number
    from public.supplier_invoice invoice
    join public.chart_accounts account on account.account_id=invoice.payable_account_id
    where invoice.invoice_id=$1
  `, [invoiceId]);
  assert.ok(invoice, 'La factura creada debe existir dentro de la transacción reversible.');
  assert.equal(String(invoice.payable_account_id), String(expectedAccountId));
  assert.equal(invoice.account_number, expectedNumber);
  close(invoice.total_amount, total, `Total de factura ${expectedNumber}`);

  const payableLine = await one(`
    select count(*)::int line_count,coalesce(sum(line.debit),0) debit,
      coalesce(sum(line.credit),0) credit
    from public.journal_line line
    where line.journal_id=$1 and line.account_id=$2
      and line.supplier_id=(select supplier_id from public.supplier_invoice where invoice_id=$3)
      and line.entity_type='Proveedor'
      and lower(coalesce(line.note,'')) like 'cuenta por pagar%'
  `, [journalId, expectedAccountId, invoiceId]);
  assert.equal(payableLine.line_count, 1, `Debe existir una única línea CxP en ${expectedNumber}.`);
  close(payableLine.debit, 0, `Débito de factura en ${expectedNumber}`);
  close(payableLine.credit, total, `Crédito de factura en ${expectedNumber}`);

  const otherRoutes = await value(`
    select count(*)::int value
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=$1
      and account.account_number in('211001','211002','211003','211004')
      and account.account_number<>$2 and line.credit>0
  `, [journalId, expectedNumber]);
  assert.equal(number(otherRoutes), 0, 'La factura no debe mezclar cuentas de control CxP.');

  const impact = await one(`
    select count(*)::int impact_count,coalesce(sum(debit_amount),0) debit,
      coalesce(sum(credit_amount),0) credit
    from public.gl_impact
    where transaction_id=$1 and account_id=$2
  `, [invoice.transaction_id, expectedAccountId]);
  assert.ok(impact.impact_count > 0, `El mayor debe contener ${expectedNumber}.`);
  close(impact.debit, 0, `Débito del mayor en ${expectedNumber}`);
  assert.ok(number(impact.credit) > 0, `El mayor debe acreditar ${expectedNumber}.`);
  await assertBalanced(journalId, invoice.transaction_id, `Factura ${expectedNumber}`);
};

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='15s'; set local statement_timeout='120s'");

  const migration = await readFile(
    new URL('../supabase/migrations/20261020110000_supplier_invoice_payable_account_routing.sql', import.meta.url),
    'utf8'
  );
  await db.query(migration);
  await db.query(migration);

  const contract = await one(`select
    exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='supplier_invoice'
        and column_name='payable_account_id'
    ) snapshot_column,
    exists(
      select 1 from pg_constraint constraint_record
      where constraint_record.conrelid='public.supplier_payment'::regclass
        and constraint_record.conname='supplier_payment_amount_paid_check'
        and position('amount_paid >= ' in pg_get_constraintdef(constraint_record.oid))>0
    ) zero_cash_advance_allowed,
    to_regprocedure('public.resolve_supplier_payable_account(bigint,bigint,text)') is not null helper_function,
    to_regprocedure('public.apply_supplier_payment_payable_accounts(bigint,numeric)') is not null payment_helper,
    position('resolve_supplier_payable_account' in pg_get_functiondef(
      'public.save_supplier_invoice_without_budget(jsonb,bigint)'::regprocedure
    ))>0 operational_wrapper,
    position('save_supplier_invoice_without_budget' in pg_get_functiondef(
      'public.budget_run(text,jsonb,bigint)'::regprocedure
    ))>0 budget_path,
    position('apply_supplier_payment_payable_accounts' in pg_get_functiondef(
      'public.save_supplier_payment_with_advances(jsonb,bigint)'::regprocedure
    ))>0 application_entrypoint,
    position('advance_total+withholding_total>expected_total' in pg_get_functiondef(
      'public.save_supplier_payment_with_advances(jsonb,bigint)'::regprocedure
    ))>0 overcoverage_guard,
    position('to_jsonb(new)' in pg_get_functiondef(
      'public.protect_applied_supplier_advance()'::regprocedure
    ))>0 protected_amount_normalization,
    not has_function_privilege('authenticated',
      'public.save_supplier_invoice_without_withholding(jsonb,bigint)','EXECUTE') invoice_base_private,
    not has_function_privilege('authenticated',
      'public.save_supplier_invoice_without_budget(jsonb,bigint)','EXECUTE') budget_inner_private,
    not has_function_privilege('authenticated',
      'public.save_supplier_payment_without_withholding(jsonb,bigint)','EXECUTE') payment_base_private,
    not has_function_privilege('authenticated',
      'public.save_supplier_payment_with_advances_base(jsonb,bigint)','EXECUTE') advance_base_private,
    has_function_privilege('authenticated',
      'public.save_supplier_invoice(jsonb,bigint)','EXECUTE') invoice_entrypoint_public,
    has_function_privilege('authenticated',
      'public.save_supplier_payment_with_advances(jsonb,bigint)','EXECUTE') advance_entrypoint_public
  `);
  assert.equal(contract.snapshot_column, true, 'Falta el snapshot CxP en la factura.');
  assert.equal(contract.zero_cash_advance_allowed, true, 'Un anticipo total debe permitir efectivo neto igual a cero.');
  assert.equal(contract.helper_function, true, 'Falta el selector contable de CxP.');
  assert.equal(contract.payment_helper, true, 'Falta el agrupador de pagos por cuenta CxP.');
  assert.equal(contract.operational_wrapper, true, 'El flujo interno usado por presupuesto debe aplicar el routing.');
  assert.equal(contract.budget_path, true, 'budget_run debe conservar el flujo operativo de facturas.');
  assert.equal(contract.application_entrypoint, true, 'El entrypoint real de pagos con anticipos debe aplicar el routing.');
  assert.equal(contract.overcoverage_guard, true, 'El pago debe impedir que anticipos y retenciones superen lo aplicado.');
  assert.equal(contract.protected_amount_normalization, true, 'La normalización interna de efectivo debe permanecer estrictamente protegida.');
  assert.equal(contract.invoice_base_private, true, 'La base de factura sin retenciones no debe exponerse por RPC.');
  assert.equal(contract.budget_inner_private, true, 'El flujo interno de presupuesto no debe exponerse por RPC.');
  assert.equal(contract.payment_base_private, true, 'La base de pago sin retenciones no debe exponerse por RPC.');
  assert.equal(contract.advance_base_private, true, 'La base de anticipos no debe exponerse por RPC.');
  assert.equal(contract.invoice_entrypoint_public, true, 'El entrypoint final de facturas debe permanecer disponible.');
  assert.equal(contract.advance_entrypoint_public, true, 'El entrypoint final de pagos con anticipos debe permanecer disponible.');

  const accounts = (await db.query(`
    select account.account_id,account.account_number,account.account_name,
      account.category,account.nature,account.financial_statement,
      account.accepts_entries,account.is_inactive
    from public.chart_accounts account
    where account.account_number in('211001','211002','211003','211004')
    order by account.account_number
  `)).rows;
  assert.deepEqual(accounts.map(account => account.account_number), ['211001', '211002', '211003', '211004']);
  for (const account of accounts) {
    assert.equal(account.category, 'Pasivo', `${account.account_number} debe ser Pasivo.`);
    assert.equal(account.nature, 'Acreedora', `${account.account_number} debe tener naturaleza acreedora.`);
    assert.equal(account.financial_statement, 'Balance General', `${account.account_number} debe pertenecer al Balance General.`);
    assert.equal(account.accepts_entries, true, `${account.account_number} debe aceptar movimientos.`);
    assert.equal(account.is_inactive, false, `${account.account_number} debe estar activa.`);
  }
  const accountByNumber = Object.fromEntries(accounts.map(account => [account.account_number, account]));

  const context = await one(`
    select app_user.user_id,app_user.email,auth_user.id sub,
      company_session.session_id,company_session.subsidiary_id,role_session.role_id
    from public.user_company_sessions company_session
    join public.users app_user using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
    join public.user_role_sessions role_session
      on role_session.session_id=company_session.session_id
     and role_session.user_id=company_session.user_id
    where exists(
      select 1 from public.role_permissions grant_record
      join public.permissions permission using(permission_id)
      where grant_record.role_id=role_session.role_id
        and permission.code='purchasing:supplier-invoice:create'
    )
      and exists(
        select 1 from public.fiscal_periods period
        where period.subsidiary_id=company_session.subsidiary_id
          and not period.is_closed and not coalesce(period.ap_closed,false)
      )
      and exists(
        select 1 from public.entity_subsidiaries assignment
        where assignment.subsidiary_id=company_session.subsidiary_id
          and assignment.supplier_id is not null
          and not exists(
            select 1 from public.entity_withholding_rules rule
            where rule.subsidiary_id=company_session.subsidiary_id
              and rule.supplier_id=assignment.supplier_id
          )
      )
      and exists(
        select 1 from public.chart_accounts account
        join public.account_subsidiaries assignment using(account_id)
        where assignment.subsidiary_id=company_session.subsidiary_id
          and assignment.is_active and account.accepts_entries and not account.is_inactive
          and account.category in('Costo','Gasto')
      )
      and exists(
        select 1 from public.bank_account bank
        join public.subsidiaries subsidiary using(subsidiary_id)
        where bank.subsidiary_id=company_session.subsidiary_id
          and bank.currency_id=subsidiary.currency_id
          and not coalesce(bank.is_credit_card,false)
      )
      and not exists(
        select 1 from (values($1::bigint),($2::bigint),($3::bigint),($4::bigint)) required(account_id)
        where not exists(
          select 1 from public.account_subsidiaries assignment
          where assignment.subsidiary_id=company_session.subsidiary_id
            and assignment.account_id=required.account_id and assignment.is_active
        )
      )
    order by company_session.selected_at desc nulls last,company_session.session_id desc
    limit 1
  `, accounts.map(account => account.account_id));
  assert.ok(context, 'Se requiere una sesión autorizada con catálogos de Compras y las cuatro cuentas CxP.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  assert.equal(String(await value('select public.active_subsidiary_id() value')), String(context.subsidiary_id));

  const setup = await one(`select
    (select assignment.supplier_id from public.entity_subsidiaries assignment
     where assignment.subsidiary_id=$1 and assignment.supplier_id is not null
       and not exists(
         select 1 from public.entity_withholding_rules rule
         where rule.subsidiary_id=$1 and rule.supplier_id=assignment.supplier_id
       ) order by assignment.supplier_id limit 1) supplier_id,
    (select account.account_id from public.chart_accounts account
     join public.account_subsidiaries assignment using(account_id)
     where assignment.subsidiary_id=$1 and assignment.is_active
       and account.accepts_entries and not account.is_inactive
       and account.category in('Costo','Gasto')
     order by account.account_id limit 1) expense_account_id,
    (select period.fiscal_period_id from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ap_closed,false)
     order by period.end_date desc limit 1) fiscal_period_id,
    (select to_char(greatest(period.start_date,least(current_date,period.end_date)),'YYYY-MM-DD')
     from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ap_closed,false)
     order by period.end_date desc limit 1) invoice_date,
    (select subsidiary.currency_id from public.subsidiaries subsidiary
     where subsidiary.subsidiary_id=$1) currency_id,
    (select terms.term_id from public.payment_terms terms order by terms.term_id limit 1) payment_term_id,
    (select bank.bank_account_id from public.bank_account bank
     join public.subsidiaries subsidiary using(subsidiary_id)
     where bank.subsidiary_id=$1 and bank.currency_id=subsidiary.currency_id
       and not coalesce(bank.is_credit_card,false)
     order by bank.bank_account_id limit 1) bank_account_id,
    (select location.location_id from public.locations location
     left join public.location_subsidiaries assignment using(location_id)
     where location.subsidiary_id=$1 or assignment.subsidiary_id=$1
     order by location.location_id limit 1) location_id
  `, [context.subsidiary_id]);
  for (const key of ['supplier_id','expense_account_id','fiscal_period_id','invoice_date','currency_id','payment_term_id','bank_account_id']) {
    assert.ok(setup[key] !== null && setup[key] !== undefined, `Falta configuración de prueba: ${key}`);
  }

  // Evita que una prueba de routing dependa del saldo disponible de un
  // presupuesto real. El cambio y todos los documentos se revierten al final.
  await db.query(`
    update public.presupuestos_encabezado set estado='HISTORICO'
    where id_subsidiaria=$1 and estado='APROBADO'
  `, [context.subsidiary_id]);
  await db.query('update public.bank_account set balance=balance+1000 where bank_account_id=$1', [setup.bank_account_id]);

  const stamp = Date.now();
  const invoicePayload = (suffix, invoiceType) => ({
    invoice_number: `TEST-CXP-${stamp}-${suffix}`,
    invoice_type: invoiceType,
    supplier_id: setup.supplier_id,
    payment_term_id: setup.payment_term_id,
    invoice_date: setup.invoice_date,
    fiscal_period_id: setup.fiscal_period_id,
    currency_id: setup.currency_id,
    exchange_rate: 1,
    memo: `Prueba reversible de CxP ${suffix}`,
    lines: [{
      account_id: setup.expense_account_id,
      quantity: 1,
      unit_price: 100,
      amount: 100,
      tax_code_id: '',
      tax_rate: 0,
      note: `Compra ${suffix}`,
      department_id: '',
      cost_center_id: '',
      class_id: '',
      financial_creditor_id: '',
      related_company_id: ''
    }]
  });
  const createInvoice = async (suffix, invoiceType, intercompany, expectedNumber) => {
    await db.query('update public.suppliers set is_intercompany=$2 where supplier_id=$1', [setup.supplier_id, intercompany]);
    const payload = invoicePayload(suffix, invoiceType);
    const result = await value('select public.save_supplier_invoice($1::jsonb,null) value', [JSON.stringify(payload)]);
    assert.ok(result.invoiceId, 'El entrypoint público debe crear la factura sin omitir el routing.');
    assert.equal(result.budgetPending, undefined, 'La prueba no debe quedar pendiente de sobreaprobación.');
    await assertInvoicePosting({
      invoiceId: result.invoiceId,
      journalId: result.journalId,
      expectedAccountId: accountByNumber[expectedNumber].account_id,
      expectedNumber
    });
    return { result, payload };
  };

  const normal = await createInvoice('NORMAL', 'Factura estándar', false, '211001');
  const intercompany = await createInvoice('INTER', 'Factura estándar', true, '211002');
  const expense = await createInvoice('EXPENSE', 'Factura Expense', true, '211003');
  const pettyCash = await createInvoice('CAJA', 'Factura Caja Chica', false, '211004');

  assert.equal(String(await value(
    "select public.resolve_supplier_payable_account($1,$2,'Factura Expense') value",
    [context.subsidiary_id, setup.supplier_id]
  )), String(accountByNumber['211003'].account_id), 'Expense debe prevalecer sobre la clasificación del proveedor.');
  await db.query('update public.suppliers set is_intercompany=true where supplier_id=$1', [setup.supplier_id]);
  assert.equal(String(await value(
    "select public.resolve_supplier_payable_account($1,$2,'Factura Caja Chica') value",
    [context.subsidiary_id, setup.supplier_id]
  )), String(accountByNumber['211004'].account_id), 'Caja Chica debe prevalecer sobre la clasificación intercompany.');

  // Un cambio posterior en el maestro no reclasifica una factura histórica.
  await db.query('update public.suppliers set is_intercompany=false where supplier_id=$1', [setup.supplier_id]);
  // Simula un documento legado/importado sin snapshot. La edición debe
  // recuperar 211002 desde la estructura del asiento antes de que el editor
  // lo reconstruya. También se cambia la glosa para probar el fallback que no
  // depende de que el texto comience con "Cuenta por pagar"; el resolver actual
  // elegiría 211001 porque el maestro ya cambió.
  await db.query(`
    update public.journal_line set note='Saldo histórico proveedor'
    where journal_id=$1 and account_id=$2 and supplier_id=$3
      and entity_type='Proveedor'
  `, [intercompany.result.journalId, accountByNumber['211002'].account_id, setup.supplier_id]);
  await db.query(
    'update public.supplier_invoice set payable_account_id=null where invoice_id=$1',
    [intercompany.result.invoiceId]
  );
  const editedIntercompany = await value(
    'select public.save_supplier_invoice($1::jsonb,$2) value',
    [JSON.stringify(intercompany.payload), intercompany.result.invoiceId]
  );
  await assertInvoicePosting({
    invoiceId: editedIntercompany.invoiceId,
    journalId: editedIntercompany.journalId,
    expectedAccountId: accountByNumber['211002'].account_id,
    expectedNumber: '211002'
  });

  await db.query('savepoint inactive_historical_payable');
  await db.query(
    'update public.supplier_invoice set payable_account_id=null where invoice_id=$1',
    [intercompany.result.invoiceId]
  );
  await db.query(`
    update public.account_subsidiaries set is_active=false
    where subsidiary_id=$1 and account_id=$2
  `, [context.subsidiary_id, accountByNumber['211002'].account_id]);
  await expectRejected(
    'select public.save_supplier_invoice($1::jsonb,$2)',
    [JSON.stringify(intercompany.payload), intercompany.result.invoiceId],
    /cuenta por pagar histórica.*no está disponible/i
  );
  await db.query('rollback to savepoint inactive_historical_payable');
  await db.query('release savepoint inactive_historical_payable');

  const createNote = async (kind, amount) => value(
    'select public.save_supplier_note($1,$2::jsonb,null) value',
    [kind, JSON.stringify({
      note_number: `TEST-${kind}-CXP-${stamp}`,
      invoice_id: intercompany.result.invoiceId,
      note_date: setup.invoice_date,
      fiscal_period_id: setup.fiscal_period_id,
      currency_id: setup.currency_id,
      exchange_rate: 1,
      memo: `Prueba reversible ${kind} CxP`,
      lines: [{
        account_id: setup.expense_account_id,
        amount,
        tax_code_id: '',
        tax_rate: 0,
        note: `Ajuste ${kind}`,
        department_id: '',
        cost_center_id: '',
        class_id: '',
        financial_creditor_id: '',
        related_company_id: ''
      }]
    })]
  );
  const creditNote = await createNote('CREDIT', 10);
  const debitNote = await createNote('DEBIT', 5);
  for (const note of [
    { kind: 'CREDIT', result: creditNote, debit: 10, credit: 0 },
    { kind: 'DEBIT', result: debitNote, debit: 0, credit: 5 }
  ]) {
    const line = await one(`
      select count(*)::int line_count,coalesce(sum(debit),0) debit,
        coalesce(sum(credit),0) credit
      from public.journal_line
      where journal_id=$1 and account_id=$2 and supplier_id=$3
        and entity_type='Proveedor'
    `, [note.result.journalId, accountByNumber['211002'].account_id, setup.supplier_id]);
    assert.equal(line.line_count, 1, `${note.kind} debe usar una línea en 211002.`);
    close(line.debit, note.debit, `Débito 211002 de ${note.kind}`);
    close(line.credit, note.credit, `Crédito 211002 de ${note.kind}`);
    const transactionId = await value(`
      select transaction_id value
      from public.${note.kind === 'CREDIT' ? 'supplier_credit_note' : 'supplier_debit_note'}
      where ${note.kind === 'CREDIT' ? 'cn_id' : 'dn_id'}=$1
    `, [note.result.noteId]);
    await assertBalanced(note.result.journalId, transactionId, `Nota ${note.kind}`);
  }

  const applications = [normal, intercompany, expense, pettyCash].map(item => ({
    invoice_id: item.result.invoiceId,
    amount: 20
  }));
  const payment = await value(
    'select public.save_supplier_payment_with_advances($1::jsonb,null) value',
    [JSON.stringify({
      supplier_id: setup.supplier_id,
      account_id: setup.bank_account_id,
      date: setup.invoice_date,
      period_id: setup.fiscal_period_id,
      location_id: setup.location_id || '',
      rate: 1,
      reference: `TEST-CXP-${stamp}`,
      memo: 'Pago reversible agrupado por cuatro snapshots CxP',
      advances: [],
      applications
    })]
  );
  close(payment.grossTotal ?? payment.total, 80, 'Total bruto del pago mixto');

  const paymentLines = (await db.query(`
    select account.account_number,count(*)::int line_count,
      sum(line.debit) debit,sum(line.credit) credit
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=$1
      and account.account_number in('211001','211002','211003','211004')
    group by account.account_number order by account.account_number
  `, [payment.journalId])).rows;
  assert.deepEqual(paymentLines.map(line => line.account_number), ['211001', '211002', '211003', '211004']);
  for (const line of paymentLines) {
    assert.equal(line.line_count, 1, `${line.account_number} debe aparecer una sola vez en el pago.`);
    close(line.debit, 20, `Débito de pago en ${line.account_number}`);
    close(line.credit, 0, `Crédito de pago en ${line.account_number}`);
  }
  const paymentTransactionId = await value(
    'select transaction_id value from public.supplier_payment where payment_id=$1',
    [payment.id]
  );
  const impactAccounts = (await db.query(`
    select account.account_number,sum(impact.debit_amount) debit,
      sum(impact.credit_amount) credit
    from public.gl_impact impact
    join public.chart_accounts account using(account_id)
    where impact.transaction_id=$1
      and account.account_number in('211001','211002','211003','211004')
    group by account.account_number order by account.account_number
  `, [paymentTransactionId])).rows;
  assert.deepEqual(impactAccounts.map(line => line.account_number), ['211001', '211002', '211003', '211004']);
  assert.ok(impactAccounts.every(line => number(line.debit) > 0 && number(line.credit) === 0));
  await assertBalanced(payment.journalId, paymentTransactionId, 'Pago con cuatro snapshots CxP');

  // Verifica el flujo real: factura + retención al pagar + anticipo existente.
  // Se usa un savepoint para reutilizar después el mismo saldo en la prueba de
  // sobrecobertura; todo el escenario continúa siendo reversible.
  const availableAdvances = await value('select public.supplier_available_advances() value');
  const advance = (availableAdvances || []).find(item => number(item.available) >= 5);
  assert.ok(advance, 'Se requiere un anticipo de proveedor disponible por al menos 5 para la prueba.');
  const advanceInvoice = await one(`
    select invoice.invoice_id
    from public.supplier_invoice invoice
    where invoice.supplier_id=$1 and invoice.currency_id=$2
      and invoice.subsidiary_id=public.active_subsidiary_id()
      and coalesce(nullif(invoice.payable_amount,0),invoice.total_amount)
        -coalesce((select sum(application.amount)
          from public.supplier_payment_application application
          where application.invoice_id=invoice.invoice_id),0)>=10
    order by invoice.invoice_id limit 1
  `, [advance.supplierId, advance.currencyId]);
  assert.ok(advanceInvoice, 'Se requiere una factura compatible con el anticipo para la prueba.');
  const advanceBank = await one(`
    select bank.bank_account_id,bank.balance
    from public.bank_account bank
    where bank.subsidiary_id=public.active_subsidiary_id()
      and bank.currency_id=$1 and not coalesce(bank.is_credit_card,false)
    order by bank.balance desc,bank.bank_account_id limit 1
  `, [advance.currencyId]);
  assert.ok(advanceBank, 'Se requiere una cuenta bancaria en la moneda del anticipo.');
  await db.query(
    'update public.bank_account set balance=greatest(balance,100) where bank_account_id=$1',
    [advanceBank.bank_account_id]
  );
  const bankBalanceBeforeAdvance = number(await value(
    'select balance value from public.bank_account where bank_account_id=$1',
    [advanceBank.bank_account_id]
  ));
  const advancePeriod = await one(`
    select period.fiscal_period_id,
      to_char(greatest(period.start_date,least(current_date,period.end_date)),'YYYY-MM-DD') date
    from public.fiscal_periods period
    where period.subsidiary_id=public.active_subsidiary_id()
      and not period.is_closed and not coalesce(period.gl_closed,false)
      and not coalesce(period.ap_closed,false) and not coalesce(period.is_inactive,false)
    order by period.end_date desc limit 1
  `);
  assert.ok(advancePeriod, 'Se requiere un período abierto para la prueba de anticipos.');
  const localCurrency = await value(
    'select currency_id value from public.subsidiaries where subsidiary_id=public.active_subsidiary_id()'
  );
  const advanceRate = String(localCurrency) === String(advance.currencyId) ? 1 : number(await value(`
    select rate.spot_rate value from public.exchange_rates rate
    where rate.from_currency_id=$1 and rate.to_currency_id=$2
      and rate.effective_date<=$3
    order by rate.effective_date desc limit 1
  `, [advance.currencyId, localCurrency, advancePeriod.date]) || 1);
  const advancePayload = (gross, appliedAdvance, reference) => ({
    supplier_id: advance.supplierId,
    account_id: advanceBank.bank_account_id,
    date: advancePeriod.date,
    period_id: advancePeriod.fiscal_period_id,
    location_id: setup.location_id || '',
    rate: advanceRate,
    reference,
    memo: 'Prueba reversible de anticipo, retención y routing CxP',
    applications: [{ invoice_id: advanceInvoice.invoice_id, amount: gross }],
    advances: [{ advanceLineId: advance.id, amount: appliedAdvance }]
  });

  await db.query('savepoint partial_supplier_advance');
  const partialReference = `TEST-ADV-PARTIAL-${stamp}`;
  const advancePayment = await value(
    'select public.save_supplier_payment_with_advances($1::jsonb,null) value',
    [JSON.stringify(advancePayload(10, 4, partialReference))]
  );
  const withholdingTotal = number(advancePayment.withholdingTotal || 0);
  const expectedCash = 10 - 4 - withholdingTotal;
  assert.ok(withholdingTotal > 0, 'La prueba debe incluir una retención calculada durante el pago.');
  close(advancePayment.grossTotal, 10, 'Total bruto con anticipo');
  close(advancePayment.advanceTotal, 4, 'Anticipo aplicado');
  close(advancePayment.cashTotal, expectedCash, 'Efectivo neto con anticipo y retención');
  close(await value(
    'select amount_paid value from public.supplier_payment where payment_id=$1',
    [advancePayment.id]
  ), expectedCash, 'amount_paid derivado');
  close(await value(
    'select balance value from public.bank_account where bank_account_id=$1',
    [advanceBank.bank_account_id]
  ), bankBalanceBeforeAdvance - expectedCash, 'Saldo bancario después del pago');
  close(await value(`
    select bank.amount value from public.bank_transaction bank
    where bank.transaction_id=(select payment.transaction_id
      from public.supplier_payment payment where payment.payment_id=$1)
  `, [advancePayment.id]), -expectedCash, 'Movimiento bancario neto');
  close(await value(
    'select amount value from public.supplier_advance_application where payment_id=$1',
    [advancePayment.id]
  ), 4, 'Aplicación del anticipo');
  const advanceInvoiceAccount = await value(
    'select payable_account_id value from public.supplier_invoice where invoice_id=$1',
    [advanceInvoice.invoice_id]
  );
  const advanceLines = (await db.query(`
    select line.account_id,line.debit,line.credit
    from public.journal_line line where line.journal_id=$1
  `, [advancePayment.journalId])).rows;
  assert.ok(advanceLines.some(line =>
    String(line.account_id) === String(advanceInvoiceAccount)
      && Math.abs(number(line.debit) - 10) < .000001
  ), 'El pago con anticipo debe debitar el snapshot CxP de la factura.');
  assert.ok(advanceLines.some(line =>
    String(line.account_id) === String(advance.accountId)
      && Math.abs(number(line.credit) - 4) < .000001
  ), 'El pago debe acreditar la cuenta del anticipo aplicado.');
  const advanceTransactionId = await value(
    'select transaction_id value from public.supplier_payment where payment_id=$1',
    [advancePayment.id]
  );
  await assertBalanced(
    advancePayment.journalId,advanceTransactionId,
    'Pago con anticipo y retención'
  );
  await expectRejected(
    'update public.supplier_payment set memo=$2 where payment_id=$1',
    [advancePayment.id, 'Edición arbitraria no permitida'],
    /anticipos.*no puede modificarse/i
  );
  await expectRejected(
    'delete from public.supplier_payment where payment_id=$1',
    [advancePayment.id],
    /anticipos.*no puede modificarse.*eliminarse/i
  );
  await db.query('rollback to savepoint partial_supplier_advance');
  await db.query('release savepoint partial_supplier_advance');

  // Un anticipo puede cubrir el 100% cuando la factura no tiene retenciones
  // pendientes al pagar. En ese caso amount_paid=0 y no debe existir salida
  // bancaria, pero el Diario y el Mayor deben seguir balanceados.
  await db.query('savepoint full_supplier_advance');
  await db.query(
    'delete from public.supplier_invoice_withholding where invoice_id=$1',
    [advanceInvoice.invoice_id]
  );
  const fullReference = `TEST-ADV-FULL-${stamp}`;
  const fullAdvancePayment = await value(
    'select public.save_supplier_payment_with_advances($1::jsonb,null) value',
    [JSON.stringify(advancePayload(5, 5, fullReference))]
  );
  close(fullAdvancePayment.withholdingTotal || 0, 0,
    'Anticipo total sin retenciones');
  close(fullAdvancePayment.cashTotal, 0,
    'Efectivo de un pago cubierto totalmente por anticipo');
  close(await value(
    'select amount_paid value from public.supplier_payment where payment_id=$1',
    [fullAdvancePayment.id]
  ), 0, 'amount_paid de anticipo total');
  close(await value(
    'select balance value from public.bank_account where bank_account_id=$1',
    [advanceBank.bank_account_id]
  ), bankBalanceBeforeAdvance, 'El anticipo total no afecta el banco');
  assert.equal(number(await value(`
    select count(*)::int value from public.bank_transaction bank
    where bank.transaction_id=(select payment.transaction_id
      from public.supplier_payment payment where payment.payment_id=$1)
  `, [fullAdvancePayment.id])), 0,
  'El anticipo total no debe crear un movimiento bancario de importe cero.');
  close(await value(
    'select amount value from public.supplier_advance_application where payment_id=$1',
    [fullAdvancePayment.id]
  ), 5, 'Aplicación total del anticipo');
  const fullTransactionId = await value(
    'select transaction_id value from public.supplier_payment where payment_id=$1',
    [fullAdvancePayment.id]
  );
  await assertBalanced(
    fullAdvancePayment.journalId,fullTransactionId,'Pago cubierto por anticipo total'
  );
  await db.query('rollback to savepoint full_supplier_advance');
  await db.query('release savepoint full_supplier_advance');

  const overcoverageReference = `TEST-ADV-OVER-${stamp}`;
  await expectRejected(
    'select public.save_supplier_payment_with_advances($1::jsonb,null)',
    [JSON.stringify(advancePayload(5, 5, overcoverageReference))],
    /suma de anticipos y retenciones.*no puede superar/i
  );
  assert.equal(number(await value(`
    select count(*)::int value from public.supplier_payment
    where bank_reference=$1
  `, [overcoverageReference])), 0, 'El rechazo debe revertir el pago completo.');
  close(await value(
    'select balance value from public.bank_account where bank_account_id=$1',
    [advanceBank.bank_account_id]
  ), bankBalanceBeforeAdvance, 'El rechazo debe conservar el saldo bancario');
  const availableAfterRejection = (await value(
    'select public.supplier_available_advances() value'
  ) || []).find(item => String(item.id) === String(advance.id));
  close(availableAfterRejection.available, advance.available,
    'El rechazo debe conservar disponible el anticipo');

  await expectRejected(
    'select public.save_supplier_invoice($1::jsonb,$2)',
    [JSON.stringify({ ...intercompany.payload, invoice_type: 'Factura Expense' }), intercompany.result.invoiceId],
    /no se puede cambiar.*tipo.*pagos o notas/i
  );

  await db.query('savepoint inactive_expense_account');
  await db.query(`
    update public.account_subsidiaries set is_active=false
    where subsidiary_id=$1 and account_id=$2
  `, [context.subsidiary_id, accountByNumber['211003'].account_id]);
  await expectRejected(
    'select public.save_supplier_invoice($1::jsonb,null)',
    [JSON.stringify(invoicePayload('EXPENSE-INACTIVA', 'Factura Expense'))],
    /211003|cuenta.*no est.*activa|vinculada/i
  );
  await db.query('rollback to savepoint inactive_expense_account');
  await db.query('release savepoint inactive_expense_account');

  await db.query('rollback');
  console.log(JSON.stringify({
    migrationIdempotent: true,
    routes: {
      normalSupplier: '211001',
      intercompanySupplier: '211002',
      expenseInvoice: '211003',
      pettyCashInvoice: '211004'
    },
    publicInvoiceEntrypoint: true,
    budgetInternalEntrypointProtected: true,
    invoiceSnapshotPreserved: true,
    missingSnapshotRecoveredBeforeEdit: true,
    inactiveHistoricalAccountRejected: true,
    supplierCreditNoteUsesSnapshot: true,
    supplierDebitNoteUsesSnapshot: true,
    mixedSupplierPaymentGroupedBySnapshot: true,
    applicationPaymentEntrypoint: 'save_supplier_payment_with_advances',
    realAdvanceWithWithholding: true,
    advanceCashAndBankReconciled: true,
    fullAdvanceWithoutCash: true,
    advanceOvercoverageRejectedAtomically: true,
    appliedAdvanceRemainsProtected: true,
    internalRpcBypassesDenied: true,
    relatedDocumentChangeBlocked: true,
    inactiveAccountRejected: true,
    journalAndLedgerBalanced: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
