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
const asNumber = input => Number(input);
const close = (actual, expected, message) => assert.ok(
  Math.abs(asNumber(actual) - asNumber(expected)) < 0.00001,
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

const assertInvoicePosting = async ({ invoiceId, journalId, expectedAccountId, expectedNumber }) => {
  const invoice = await one(`
    select invoice.receivable_account_id,invoice.receivable_amount,
      account.account_number,invoice.transaction_id
    from public.invoice invoice
    join public.chart_accounts account
      on account.account_id=invoice.receivable_account_id
    where invoice.invoice_id=$1
  `, [invoiceId]);
  assert.ok(invoice, 'La factura creada debe existir dentro de la transacción de prueba.');
  assert.equal(String(invoice.receivable_account_id), String(expectedAccountId));
  assert.equal(invoice.account_number, expectedNumber);
  assert.ok(asNumber(invoice.receivable_amount) > 0, 'La cuenta por cobrar debe tener un importe positivo.');

  const journal = await one(`
    select count(*)::int line_count,coalesce(sum(line.debit),0) debit,
      coalesce(sum(line.credit),0) credit
    from public.journal_line line
    where line.journal_id=$1 and line.account_id=$2
      and line.customer_id=(select customer_id from public.invoice where invoice_id=$3)
      and line.entity_type='Cliente' and line.debit>0
  `, [journalId, expectedAccountId, invoiceId]);
  assert.equal(journal.line_count, 1, `Debe existir una única línea CxC en ${expectedNumber}.`);
  close(journal.debit, invoice.receivable_amount, `Débito de CxC en ${expectedNumber}`);
  close(journal.credit, 0, `Crédito de CxC en ${expectedNumber}`);

  assert.equal(asNumber(await value(`
    select count(*)::int value from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=$1 and account.account_number in('113001','113002')
      and account.account_number<>$2 and line.debit>0
  `, [journalId, expectedNumber])), 0, 'El asiento no debe mezclar las dos cuentas de clientes.');

  const gl = await one(`
    select count(*)::int impact_count,coalesce(sum(impact.debit_amount),0) debit,
      coalesce(sum(impact.credit_amount),0) credit
    from public.gl_impact impact
    where impact.transaction_id=$1 and impact.account_id=$2
  `, [invoice.transaction_id, expectedAccountId]);
  assert.ok(gl.impact_count > 0, `El mayor debe contener ${expectedNumber}.`);
  assert.ok(asNumber(gl.debit) > 0, `El mayor debe debitar ${expectedNumber}.`);
  close(gl.credit, 0, `Crédito del mayor en ${expectedNumber}`);

  const balanced = await one(`
    select
      abs(coalesce(sum(line.debit),0)-coalesce(sum(line.credit),0))<0.00001 journal_balanced,
      (select bool_and(abs(book.debit-book.credit)<0.00001)
       from(
         select sum(impact.debit_amount) debit,sum(impact.credit_amount) credit
         from public.gl_impact impact where impact.transaction_id=$2
         group by impact.accounting_book_id
       ) book) gl_balanced
    from public.journal_line line where line.journal_id=$1
  `, [journalId, invoice.transaction_id]);
  assert.equal(balanced.journal_balanced, true, 'El asiento de factura debe quedar balanceado.');
  assert.equal(balanced.gl_balanced, true, 'Cada libro contable debe quedar balanceado.');
};

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='15s'; set local statement_timeout='120s'");

  const migration = await readFile(
    new URL('../supabase/migrations/20261020100000_sales_invoice_intercompany_receivable_account.sql', import.meta.url),
    'utf8'
  );
  // Reaplicar dentro de la transacción verifica idempotencia. Todo se revierte al terminar.
  await db.query(migration);
  await db.query(migration);

  const contract = await one(`select
    exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='invoice'
        and column_name='receivable_account_id'
    ) snapshot_column,
    to_regprocedure('public.resolve_customer_receivable_account(bigint,bigint)') is not null helper_function,
    position('receivable_account_id' in pg_get_functiondef(
      'public.save_sales_invoice(jsonb,bigint)'::regprocedure
    ))>0 invoice_wrapper
  `);
  assert.equal(contract.snapshot_column, true, 'Falta el snapshot de cuenta CxC en factura.');
  assert.equal(contract.helper_function, true, 'Falta el selector contable de CxC.');
  assert.equal(contract.invoice_wrapper, true, 'save_sales_invoice debe guardar el snapshot contable.');

  const accounts = (await db.query(`
    select account.account_id,account.account_number,account.account_name,
      account.category,account.accepts_entries,account.is_inactive
    from public.chart_accounts account
    where account.account_number in('113001','113002')
    order by account.account_number
  `)).rows;
  assert.deepEqual(accounts.map(account => account.account_number), ['113001', '113002']);
  for (const account of accounts) {
    assert.equal(account.category, 'Activo', `${account.account_number} debe ser de Activo.`);
    assert.equal(account.accepts_entries, true, `${account.account_number} debe aceptar movimientos.`);
    assert.equal(account.is_inactive, false, `${account.account_number} debe estar activa.`);
  }
  const normalAccount = accounts[0];
  const intercompanyAccount = accounts[1];

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
        and permission.code='sales:invoice:create'
    )
      and exists(
        select 1 from public.role_permissions grant_record
        join public.permissions permission using(permission_id)
        where grant_record.role_id=role_session.role_id
          and permission.code='sales:note:create'
      )
      and exists(
        select 1 from public.fiscal_periods period
        where period.subsidiary_id=company_session.subsidiary_id
          and not period.is_closed and not coalesce(period.ar_closed,false)
      )
      and exists(
        select 1 from public.entity_subsidiaries assignment
        where assignment.subsidiary_id=company_session.subsidiary_id
          and not exists(
            select 1 from public.entity_withholding_rules rule
            where rule.subsidiary_id=company_session.subsidiary_id
              and rule.customer_id=assignment.customer_id
          )
      )
      and exists(
        select 1 from public.products product
        join public.product_subsidiaries assignment using(product_id)
        where assignment.subsidiary_id=company_session.subsidiary_id
          and assignment.is_active and product.is_active
          and product.product_usage in('Venta','Ambas')
          and product.sales_account_id is not null
      )
      and exists(
        select 1 from public.locations location
        join public.location_subsidiaries assignment using(location_id)
        where assignment.subsidiary_id=company_session.subsidiary_id
      )
      and exists(
        select 1 from public.accounting_books book
        where book.subsidiary_id=company_session.subsidiary_id and book.is_active
      )
      and exists(
        select 1 from public.bank_account bank
        join public.subsidiaries subsidiary using(subsidiary_id)
        where bank.subsidiary_id=company_session.subsidiary_id
          and bank.currency_id=subsidiary.currency_id
      )
      and exists(
        select 1 from public.account_subsidiaries assignment
        where assignment.subsidiary_id=company_session.subsidiary_id
          and assignment.account_id=$1 and assignment.is_active
      )
      and exists(
        select 1 from public.account_subsidiaries assignment
        where assignment.subsidiary_id=company_session.subsidiary_id
          and assignment.account_id=$2 and assignment.is_active
      )
    order by company_session.selected_at desc nulls last,company_session.session_id desc
    limit 1
  `, [normalAccount.account_id, intercompanyAccount.account_id]);
  assert.ok(context, 'Se requiere una sesión autorizada con catálogos completos de venta y ambas cuentas CxC.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  assert.equal(String(await value('select public.active_subsidiary_id() value')), String(context.subsidiary_id));

  const setup = await one(`select
    (select assignment.customer_id from public.entity_subsidiaries assignment
     where assignment.subsidiary_id=$1 and not exists(
       select 1 from public.entity_withholding_rules rule
       where rule.subsidiary_id=$1 and rule.customer_id=assignment.customer_id
     ) order by assignment.customer_id limit 1) customer_id,
    (select product.product_id from public.products product
     join public.product_subsidiaries assignment using(product_id)
     where assignment.subsidiary_id=$1 and assignment.is_active
       and product.is_active and product.product_usage in('Venta','Ambas')
       and product.sales_account_id is not null
     order by product.product_id limit 1) product_id,
    (select period.fiscal_period_id from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ar_closed,false)
     order by period.end_date desc limit 1) fiscal_period_id,
    (select to_char(greatest(period.start_date,least(current_date,period.end_date)),'YYYY-MM-DD')
     from public.fiscal_periods period
     where period.subsidiary_id=$1 and not period.is_closed
       and not coalesce(period.ar_closed,false)
     order by period.end_date desc limit 1) invoice_date,
    (select subsidiary.currency_id from public.subsidiaries subsidiary
     where subsidiary.subsidiary_id=$1) currency_id,
    coalesce(
      (select subsidiary.country_id from public.subsidiaries subsidiary
       where subsidiary.subsidiary_id=$1),
      (select country.country_id from public.countries country order by country.country_id limit 1)
    ) country_id,
    (select terms.term_id from public.payment_terms terms order by terms.term_id limit 1) payment_term_id
    ,(select bank.bank_account_id from public.bank_account bank
      join public.subsidiaries subsidiary using(subsidiary_id)
      where bank.subsidiary_id=$1 and bank.currency_id=subsidiary.currency_id
      order by bank.bank_account_id limit 1) bank_account_id
    ,(select location.location_id from public.locations location
      join public.location_subsidiaries assignment using(location_id)
      where assignment.subsidiary_id=$1 order by location.location_id limit 1) location_id
  `, [context.subsidiary_id]);
  for (const key of [
    'customer_id', 'product_id', 'fiscal_period_id', 'invoice_date', 'currency_id',
    'country_id', 'payment_term_id', 'bank_account_id', 'location_id'
  ]) {
    assert.ok(setup[key] !== null && setup[key] !== undefined, `Falta configuración de prueba: ${key}`);
  }

  const createInvoice = async label => {
    const payload = {
      invoice_number: 'AUTO',
      customer_id: setup.customer_id,
      payment_term_id: setup.payment_term_id,
      invoice_date: setup.invoice_date,
      fiscal_period_id: setup.fiscal_period_id,
      currency_id: setup.currency_id,
      exchange_rate: 1,
      memo: `Prueba reversible de CxC ${label}`,
      lines: [{
        product_id: setup.product_id,
        quantity: 1,
        unit_price: 125,
        tax_code_id: '',
        tax_rate: 0,
        service_country_id: setup.country_id,
        service_month: String(setup.invoice_date).slice(0, 7),
        note: `Venta ${label}`,
        department_id: '',
        cost_center_id: '',
        class_id: '',
        related_company_id: ''
      }]
    };
    return value('select public.save_sales_invoice($1::jsonb,null) value', [JSON.stringify(payload)]);
  };

  await db.query('update public.customers set is_intercompany=false where customer_id=$1', [setup.customer_id]);
  const normalInvoice = await createInvoice('cliente normal');
  await assertInvoicePosting({
    invoiceId: normalInvoice.invoiceId,
    journalId: normalInvoice.journalId,
    expectedAccountId: normalAccount.account_id,
    expectedNumber: '113001'
  });

  await db.query('update public.customers set is_intercompany=true where customer_id=$1', [setup.customer_id]);
  const intercompanyInvoice = await createInvoice('cliente intercompany');
  await assertInvoicePosting({
    invoiceId: intercompanyInvoice.invoiceId,
    journalId: intercompanyInvoice.journalId,
    expectedAccountId: intercompanyAccount.account_id,
    expectedNumber: '113002'
  });

  // La cuenta queda congelada en la factura. Cambiar el maestro después de
  // emitirla no debe llevar sus notas ni sus cobros a otra cuenta.
  await db.query('update public.customers set is_intercompany=false where customer_id=$1', [setup.customer_id]);

  const createNote = async (kind, amount) => value(
    "select public.save_sales_note($1,$2::jsonb,null) value",
    [kind, JSON.stringify({
      invoice_id: intercompanyInvoice.invoiceId,
      note_date: setup.invoice_date,
      fiscal_period_id: setup.fiscal_period_id,
      currency_id: setup.currency_id,
      exchange_rate: 1,
      memo: `Prueba reversible ${kind} sobre factura intercompany`,
      lines: [{
        product_id: setup.product_id,
        quantity: 1,
        unit_price: amount,
        tax_code_id: '',
        tax_rate: 0,
        service_country_id: setup.country_id,
        service_month: String(setup.invoice_date).slice(0, 7),
        note: `Ajuste ${kind}`,
        department_id: '',
        cost_center_id: '',
        class_id: ''
      }]
    })]
  );

  const creditNote = await createNote('CREDIT', 20);
  const debitNote = await createNote('DEBIT', 10);
  for (const note of [
    { kind: 'CREDIT', result: creditNote, debit: 0, credit: 20 },
    { kind: 'DEBIT', result: debitNote, debit: 10, credit: 0 }
  ]) {
    const journalLine = await one(`
      select count(*)::int line_count,coalesce(sum(debit),0) debit,
        coalesce(sum(credit),0) credit
      from public.journal_line
      where journal_id=$1 and account_id=$2 and customer_id=$3
        and entity_type='Cliente'
    `, [note.result.journalId, intercompanyAccount.account_id, setup.customer_id]);
    assert.equal(journalLine.line_count, 1, `${note.kind} debe usar una sola línea CxC intercompany.`);
    close(journalLine.debit, note.debit, `Débito CxC de ${note.kind}`);
    close(journalLine.credit, note.credit, `Crédito CxC de ${note.kind}`);

    const transactionId = await value(`
      select transaction_id value from public.${note.kind === 'CREDIT' ? 'credit_note' : 'debit_note'}
      where ${note.kind === 'CREDIT' ? 'cn_id' : 'dn_id'}=$1
    `, [note.result.noteId]);
    const impact = await one(`
      select count(*)::int impact_count,
        coalesce(sum(debit_amount),0) debit,coalesce(sum(credit_amount),0) credit
      from public.gl_impact where transaction_id=$1 and account_id=$2
    `, [transactionId, intercompanyAccount.account_id]);
    assert.ok(impact.impact_count > 0, `${note.kind} debe llegar al mayor en 113002.`);
    assert.ok(note.debit === 0 ? asNumber(impact.credit) > 0 : asNumber(impact.debit) > 0);
  }

  // Un mismo cliente puede conservar facturas históricas en ambas cuentas.
  // El cobro debe separar el crédito por snapshot de cada factura.
  const normalApplied = 25;
  const intercompanyApplied = 115;
  const payment = await value(
    'select public.save_customer_payment_with_advances($1::jsonb,null) value',
    [JSON.stringify({
      customer_id: setup.customer_id,
      account_id: setup.bank_account_id,
      date: setup.invoice_date,
      period_id: setup.fiscal_period_id,
      location_id: setup.location_id,
      reference: `TEST-CXC-${Date.now()}`,
      memo: 'Cobro reversible con dos snapshots CxC',
      advances: [],
      applications: [
        { invoice_id: normalInvoice.invoiceId, amount: normalApplied },
        { invoice_id: intercompanyInvoice.invoiceId, amount: intercompanyApplied }
      ]
    })]
  );
  close(payment.total, normalApplied + intercompanyApplied, 'Total del cobro mixto');

  const paymentLines = (await db.query(`
    select account.account_number,line.debit,line.credit
    from public.journal_line line
    join public.chart_accounts account using(account_id)
    where line.journal_id=$1 and account.account_number in('113001','113002')
    order by account.account_number
  `, [payment.journalId])).rows;
  assert.deepEqual(paymentLines.map(line => line.account_number), ['113001', '113002']);
  close(paymentLines[0].debit, 0, 'Débito 113001 en cobro');
  close(paymentLines[0].credit, normalApplied, 'Crédito 113001 en cobro');
  close(paymentLines[1].debit, 0, 'Débito 113002 en cobro');
  close(paymentLines[1].credit, intercompanyApplied, 'Crédito 113002 en cobro');

  const paymentTransaction = await value(`
    select transaction_id value from public.customer_payment where payment_id=$1
  `, [payment.id]);
  const paymentImpacts = (await db.query(`
    select account.account_number,count(*)::int impact_count,
      sum(impact.debit_amount) debit,sum(impact.credit_amount) credit
    from public.gl_impact impact join public.chart_accounts account using(account_id)
    where impact.transaction_id=$1 and account.account_number in('113001','113002')
    group by account.account_number order by account.account_number
  `, [paymentTransaction])).rows;
  assert.deepEqual(paymentImpacts.map(line => line.account_number), ['113001', '113002']);
  assert.ok(paymentImpacts.every(line => asNumber(line.credit) > 0 && asNumber(line.debit) === 0));

  const intercompanyBalance = await value(`
    select coalesce(nullif(invoice.receivable_amount,0),invoice.total_amount)
      +coalesce((select sum(note.amount) from public.debit_note note
        where note.invoice_id=invoice.invoice_id),0)
      -coalesce((select sum(note.amount) from public.credit_note note
        where note.invoice_id=invoice.invoice_id),0)
      -coalesce((select sum(application.amount) from public.customer_payment_application application
        where application.invoice_id=invoice.invoice_id),0) value
    from public.invoice invoice where invoice.invoice_id=$1
  `, [intercompanyInvoice.invoiceId]);
  close(intercompanyBalance, 0, 'Saldo final de la factura intercompany');

  // Reactivar la condición intercompany para comprobar el error de catálogo.
  await db.query('update public.customers set is_intercompany=true where customer_id=$1', [setup.customer_id]);

  await db.query('savepoint inactive_intercompany_account');
  await db.query(`
    update public.account_subsidiaries set is_active=false
    where subsidiary_id=$1 and account_id=$2
  `, [context.subsidiary_id, intercompanyAccount.account_id]);
  await expectRejected(
    'select public.save_sales_invoice($1::jsonb,null)',
    [JSON.stringify({
      invoice_number: 'AUTO', customer_id: setup.customer_id,
      payment_term_id: setup.payment_term_id, invoice_date: setup.invoice_date,
      fiscal_period_id: setup.fiscal_period_id, currency_id: setup.currency_id,
      exchange_rate: 1, memo: 'Debe fallar sin 113002 activa',
      lines: [{
        product_id: setup.product_id, quantity: 1, unit_price: 1,
        tax_code_id: '', tax_rate: 0, service_country_id: setup.country_id,
        service_month: String(setup.invoice_date).slice(0, 7), note: 'Cuenta inactiva',
        department_id: '', cost_center_id: '', class_id: '', related_company_id: ''
      }]
    })],
    /113002|intercompany|cuenta.*cobrar/i
  );
  await db.query('rollback to savepoint inactive_intercompany_account');
  await db.query('release savepoint inactive_intercompany_account');

  await db.query('rollback');
  console.log(JSON.stringify({
    migrationIdempotent: true,
    normalCustomerAccount: '113001',
    intercompanyCustomerAccount: '113002',
    invoiceSnapshot: true,
    creditNoteUsesInvoiceSnapshot: true,
    debitNoteUsesInvoiceSnapshot: true,
    mixedPaymentGroupedBySnapshot: true,
    applicationPaymentEntryPoint: 'save_customer_payment_with_advances',
    intercompanyInvoiceSettled: true,
    journalPosting: true,
    generalLedgerPosting: true,
    inactiveAccountRejected: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
