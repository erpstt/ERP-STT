import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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

const migration = await readFile(new URL(
  '../supabase/migrations/20261023160000_intercompany_commercial_report.sql',
  import.meta.url
), 'utf8');
const amount = value => Number(value ?? 0);
const close = (actual, expected) => Math.abs(amount(actual) - amount(expected)) < .0001;
const iso = value => value instanceof Date
  ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

test('reporte comercial intercompany concilia auxiliar y Mayor por tercero/moneda', async () => {
  await db.connect();
  try {
    await db.query('begin');
    await db.query("set local statement_timeout='120s'");
    await db.query(migration);

    const { rows: [context] } = await db.query(`
      select session.session_id,users.email,auth_user.id auth_user_id,
        subsidiary.subsidiary_id,book.accounting_book_id,
        greatest(current_date,coalesce((
          select max(coalesce(transaction.tran_date,journal.journal_date,
            invoice.invoice_date))
          from public.invoice invoice
          left join public."transaction" transaction using(transaction_id)
          left join public.journal journal on journal.journal_id=invoice.journal_id
          join public.chart_accounts account
            on account.account_id=invoice.receivable_account_id
          where invoice.subsidiary_id=subsidiary.subsidiary_id
            and account.account_number='113002'
        ),current_date))date_to
      from public.user_company_sessions session
      join public.users users using(user_id)
      join auth.users auth_user on lower(auth_user.email)=lower(users.email)
      join public.subsidiaries subsidiary using(subsidiary_id)
      join lateral(
        select accounting_book_id
        from public.accounting_books candidate
        where candidate.subsidiary_id=subsidiary.subsidiary_id
          and candidate.is_primary and candidate.is_active
        order by accounting_book_id limit 1
      )book on true
      where exists(
        select 1
        from public.invoice invoice
        join public.chart_accounts account
          on account.account_id=invoice.receivable_account_id
        where invoice.subsidiary_id=subsidiary.subsidiary_id
          and account.account_number='113002'
      )
      order by session.selected_at desc limit 1
    `);
    assert.ok(context, 'Se requiere una subsidiaria accesible con documentos 113002.');

    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: context.auth_user_id, email: context.email,
      session_id: context.session_id, role: 'authenticated'
    })]);

    const dateTo = iso(context.date_to);
    const dateFrom = `${dateTo.slice(0, 4)}-01-01`;
    const { rows: [fixture] } = await db.query(`
      select receivable.account_id receivable_account_id,
        payable.account_id payable_account_id,source.customer_id,
        coalesce(linked.supplier_id,fallback_supplier.supplier_id)supplier_id,
        subsidiary.currency_id local_currency_id,
        foreign_currency.currency_id foreign_currency_id,
        bank.bank_account_id
      from public.subsidiaries subsidiary
      join lateral(
        select account_id from public.chart_accounts
        where account_number='113002'and not coalesce(is_summary,false)
        order by account_id limit 1
      )receivable on true
      join lateral(
        select account_id from public.chart_accounts
        where account_number='211002'and not coalesce(is_summary,false)
        order by account_id limit 1
      )payable on true
      join lateral(
        select invoice.customer_id
        from public.invoice invoice
        where invoice.subsidiary_id=subsidiary.subsidiary_id
          and invoice.receivable_account_id=receivable.account_id
        order by invoice.invoice_id limit 1
      )source on true
      left join lateral(
        select relation.supplier_id
        from public.entity_subsidiaries relation
        where relation.subsidiary_id=subsidiary.subsidiary_id
          and relation.supplier_id is not null
        order by relation.supplier_id limit 1
      )linked on true
      left join lateral(
        select supplier_id from public.suppliers order by supplier_id limit 1
      )fallback_supplier on true
      join lateral(
        select currency_id from public.currencies
        where currency_id<>subsidiary.currency_id
        order by currency_id limit 1
      )foreign_currency on true
      join lateral(
        select bank_account_id from public.bank_account
        order by case when subsidiary_id=subsidiary.subsidiary_id then 0 else 1 end,
          bank_account_id limit 1
      )bank on true
      where subsidiary.subsidiary_id=$1
    `, [context.subsidiary_id]);
    assert.ok(fixture?.supplier_id && fixture?.foreign_currency_id
      && fixture?.bank_account_id,
    'La prueba multimoneda requiere cliente, proveedor, dos monedas y una cuenta bancaria.');

    await db.query('savepoint cross_currency_fixture');
    const fixtureTag = `IC-CROSS-${Date.now()}`;
    const { rows: [receivableFixture] } = await db.query(`
      insert into public.invoice(
        invoice_number,customer_id,subsidiary_id,due_date,total_amount,
        invoice_date,currency_id,exchange_rate,receivable_account_id,
        receivable_amount
      )values($1,$2,$3,$4,100,$4,$5,2,$6,100)
      returning invoice_id
    `, [fixtureTag, fixture.customer_id, context.subsidiary_id, dateTo,
      fixture.foreign_currency_id, fixture.receivable_account_id]);
    const { rows: [customerPayment] } = await db.query(`
      insert into public.customer_payment(
        payment_number,customer_id,bank_account_id,payment_date,
        amount_received,currency_id,exchange_rate,status
      )values($1,$2,$3,$4,10,$5,3,'APROBADO')returning payment_id
    `, [`${fixtureTag}-COB`, fixture.customer_id, fixture.bank_account_id,
      dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.customer_payment_application(
        payment_id,invoice_id,amount,application_date
      )values($1,$2,10,$3)
    `, [customerPayment.payment_id, receivableFixture.invoice_id, dateTo]);
    const { rows: [cancelledCustomerPayment] } = await db.query(`
      insert into public.customer_payment(
        payment_number,customer_id,bank_account_id,payment_date,
        amount_received,currency_id,exchange_rate,status
      )values($1,$2,$3,$4,7,$5,3,'ANULADO')returning payment_id
    `, [`${fixtureTag}-COB-ANULADO`, fixture.customer_id,
      fixture.bank_account_id, dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.customer_payment_application(
        payment_id,invoice_id,amount,application_date
      )values($1,$2,7,$3)
    `, [cancelledCustomerPayment.payment_id, receivableFixture.invoice_id,
      dateTo]);
    await db.query(`
      insert into public.credit_note(
        cn_number,customer_id,invoice_id,amount,note_date,currency_id,
        exchange_rate
      )values($1,$2,$3,5,$4,$5,4)
    `, [`${fixtureTag}-NC`, fixture.customer_id, receivableFixture.invoice_id,
      dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.debit_note(
        dn_number,customer_id,invoice_id,amount,note_date,currency_id,
        exchange_rate
      )values($1,$2,$3,2,$4,$5,5)
    `, [`${fixtureTag}-ND`, fixture.customer_id, receivableFixture.invoice_id,
      dateTo, fixture.local_currency_id]);

    const { rows: [payableFixture] } = await db.query(`
      insert into public.supplier_invoice(
        invoice_number,supplier_id,subsidiary_id,due_date,total_amount,
        invoice_date,currency_id,exchange_rate,payable_account_id,
        payable_amount
      )values($1,$2,$3,$4,100,$4,$5,2,$6,100)
      returning invoice_id
    `, [fixtureTag, fixture.supplier_id, context.subsidiary_id, dateTo,
      fixture.foreign_currency_id, fixture.payable_account_id]);
    const { rows: [supplierPayment] } = await db.query(`
      insert into public.supplier_payment(
        payment_number,supplier_id,bank_account_id,payment_date,
        amount_paid,currency_id,exchange_rate,status
      )values($1,$2,$3,$4,10,$5,3,'APROBADO')returning payment_id
    `, [`${fixtureTag}-PAG`, fixture.supplier_id, fixture.bank_account_id,
      dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.supplier_payment_application(
        payment_id,invoice_id,amount,application_date
      )values($1,$2,10,$3)
    `, [supplierPayment.payment_id, payableFixture.invoice_id, dateTo]);
    const { rows: [cancelledSupplierPayment] } = await db.query(`
      insert into public.supplier_payment(
        payment_number,supplier_id,bank_account_id,payment_date,
        amount_paid,currency_id,exchange_rate,status
      )values($1,$2,$3,$4,7,$5,3,'CANCELADO')returning payment_id
    `, [`${fixtureTag}-PAG-CANCELADO`, fixture.supplier_id,
      fixture.bank_account_id, dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.supplier_payment_application(
        payment_id,invoice_id,amount,application_date
      )values($1,$2,7,$3)
    `, [cancelledSupplierPayment.payment_id, payableFixture.invoice_id,
      dateTo]);
    await db.query(`
      insert into public.supplier_credit_note(
        cn_number,supplier_id,invoice_id,amount,note_date,currency_id,
        exchange_rate
      )values($1,$2,$3,5,$4,$5,4)
    `, [`${fixtureTag}-NCP`, fixture.supplier_id, payableFixture.invoice_id,
      dateTo, fixture.local_currency_id]);
    await db.query(`
      insert into public.supplier_debit_note(
        dn_number,supplier_id,invoice_id,amount,note_date,currency_id,
        exchange_rate
      )values($1,$2,$3,2,$4,$5,5)
    `, [`${fixtureTag}-NDP`, fixture.supplier_id, payableFixture.invoice_id,
      dateTo, fixture.local_currency_id]);

    const { rows: [withheldReceivable] } = await db.query(`
      insert into public.invoice(
        invoice_number,customer_id,subsidiary_id,due_date,total_amount,
        invoice_date,currency_id,exchange_rate,receivable_account_id,
        withholding_total,receivable_amount
      )values($1,$2,$3,$4,100,$4,$5,2,$6,100,0)
      returning invoice_id
    `, [`${fixtureTag}-RET-CXC`, fixture.customer_id,
      context.subsidiary_id, dateTo, fixture.foreign_currency_id,
      fixture.receivable_account_id]);
    const { rows: [withheldPayable] } = await db.query(`
      insert into public.supplier_invoice(
        invoice_number,supplier_id,subsidiary_id,due_date,total_amount,
        invoice_date,currency_id,exchange_rate,payable_account_id,
        withholding_total,payable_amount
      )values($1,$2,$3,$4,100,$4,$5,2,$6,100,0)
      returning invoice_id
    `, [`${fixtureTag}-RET-CXP`, fixture.supplier_id,
      context.subsidiary_id, dateTo, fixture.foreign_currency_id,
      fixture.payable_account_id]);

    const filters = {
      subsidiaryIds: [Number(context.subsidiary_id)],
      bookId: Number(context.accounting_book_id), dateFrom, dateTo,
      onlyPending: false
    };
    const { rows: [response] } = await db.query(
      `select public.run_accounting_report(
        'intercompany-commercial',$1::jsonb
      )report`, [JSON.stringify(filters)]
    );
    let report = response.report;
    assert.equal(report.report, 'intercompany-commercial');
    assert.deepEqual(report.accounts.map(item => item.number).sort(), ['113002', '211002']);
    assert.ok(report.receivables.every(item => item.accountNumber === '113002'));
    assert.ok(report.payables.every(item => item.accountNumber === '211002'));
    assert.ok(report.documents.every(item => ['113002', '211002'].includes(item.accountNumber)));
    assert.ok(report.details.every(item => ['113002', '211002'].includes(item.accountNumber)));
    assert.ok(report.localPositions.every(item =>
      item.partyKey.startsWith(item.direction === 'RECEIVABLE'
        ? 'CUSTOMER:' : 'SUPPLIER:')
      && item.originalCurrencyCode && item.localCurrencyCode
    ));
    assert.equal(report.quality.thirdPartyCount, report.quality.partyCount);
    assert.equal(report.quality.missingThirdPartyCount,
      report.quality.unassignedPartyMovementCount);
    assert.ok(Array.isArray(report.quality.issues));

    // Cada aplicaciÃ³n y nota se convierte primero a moneda local y luego a la
    // moneda original de la factura. Factura TC 2: cobro/pago 10 a TC 3 = 15;
    // NC 5 a TC 4 = 10; ND 2 a TC 5 = 5. Saldo: 100 - 15 - 10 + 5 = 80.
    for (const [direction, id] of [
      ['RECEIVABLE', receivableFixture.invoice_id],
      ['PAYABLE', payableFixture.invoice_id]
    ]) {
      const item = report.documents.find(document =>
        document.direction === direction && Number(document.documentId) === Number(id));
      assert.ok(item, `Debe incluir la factura de prueba ${direction}.`);
      assert.ok(close(item.appliedAmount, 15));
      assert.ok(close(item.creditAmount, 10));
      assert.ok(close(item.debitAmount, 5));
      assert.ok(close(item.outstanding, 80));
      assert.ok(close(item.historicalLocalOutstanding, 160));
    }

    for (const [direction, id] of [
      ['RECEIVABLE', withheldReceivable.invoice_id],
      ['PAYABLE', withheldPayable.invoice_id]
    ]) {
      const item = report.documents.find(document =>
        document.direction === direction
          && Number(document.documentId) === Number(id));
      assert.ok(item, `Debe incluir el documento retenido ${direction}.`);
      assert.ok(close(item.originalAmount, 0));
      assert.ok(close(item.outstanding, 0),
        'Una factura retenida al 100 % no debe reaparecer como saldo abierto.');
    }

    // El resto de la prueba audita solo la información real. Los documentos
    // sintéticos no deben crear diferencias artificiales Mayor vs. auxiliar.
    await db.query('rollback to savepoint cross_currency_fixture');
    const { rows: [realResponse] } = await db.query(
      `select public.run_accounting_report(
        'intercompany-commercial',$1::jsonb
      )report`, [JSON.stringify(filters)]
    );
    report = realResponse.report;

    const { rows: [expected] } = await db.query(`
      with target as(
        select account_id,account_number from public.chart_accounts
        where account_number in('113002','211002')
      ),documents as(
        select invoice.invoice_id,'RECEIVABLE' direction
        from public.invoice invoice
        join target account on account.account_id=invoice.receivable_account_id
          and account.account_number='113002'
        join public.customers customer using(customer_id)
        left join public."transaction" transaction using(transaction_id)
        left join public.journal journal on journal.journal_id=invoice.journal_id
        where invoice.subsidiary_id=$1
          and coalesce(transaction.tran_date,journal.journal_date,
            invoice.invoice_date)<=$2
        union all
        select invoice.invoice_id,'PAYABLE'
        from public.supplier_invoice invoice
        join target account on account.account_id=invoice.payable_account_id
          and account.account_number='211002'
        join public.suppliers supplier using(supplier_id)
        left join public."transaction" transaction using(transaction_id)
        left join public.journal journal on journal.journal_id=invoice.journal_id
        where invoice.subsidiary_id=$1
          and coalesce(transaction.tran_date,journal.journal_date,
            invoice.invoice_date)<=$2
      )
      select count(*)document_count from documents
    `, [context.subsidiary_id, dateTo]);

    // Count directly from the returned documents because the report was called
    // with onlyPending=false. It must retain each source document exactly once.
    assert.equal(report.documents.length, Number(expected.document_count));
    assert.equal(report.documents.length, Number(report.quality.documentCount));
    assert.equal(report.quality.openDocumentCount,
      report.documents.filter(item => Math.abs(amount(item.outstanding)) > .005).length);
    assert.ok(report.documents.length > 0);

    const grouped = new Map();
    for (const item of report.documents) {
      const key = `${item.direction}:${item.currencyId}`;
      grouped.set(key, amount(grouped.get(key)) + amount(item.outstanding));
    }
    for (const item of report.currencySummaries) {
      assert.ok(close(item.receivableDocuments,
        grouped.get(`RECEIVABLE:${item.currencyId}`) ?? 0));
      assert.ok(close(item.payableDocuments,
        grouped.get(`PAYABLE:${item.currencyId}`) ?? 0));
    }

    // A customer and a supplier can have the same display name or even the
    // same numeric id. Their typed keys must remain different.
    assert.ok(report.reconciliation.every(item =>
      item.partyKey.startsWith(item.direction === 'RECEIVABLE'
        ? 'CUSTOMER:' : 'SUPPLIER:')
    ));

    const originalSummary = JSON.stringify(report.currencySummaries);
    const { rows: [searched] } = await db.query(
      'select public.run_intercompany_commercial_report($1::jsonb) report',
      [JSON.stringify({ ...filters, search: '__NO_DOCUMENT_CAN_MATCH__' })]
    );
    assert.equal(searched.report.searchScope, 'DETAIL_ONLY');
    assert.equal(searched.report.documents.length, 0);
    assert.equal(searched.report.details.length, 0);
    assert.equal(JSON.stringify(searched.report.currencySummaries), originalSummary,
      'La búsqueda de detalle no debe cambiar los saldos del reporte.');

    const { rows: [options] } = await db.query(
      'select public.accounting_report_options() options'
    );
    assert.ok(Array.isArray(options.options.intercompanyCommercialParties));
    assert.ok(options.options.intercompanyCommercialParties.some(item =>
      item.type === 'CUSTOMER' && item.partyKey.startsWith('CUSTOMER:')
        && item.subsidiaryIds.map(Number)
        .includes(Number(context.subsidiary_id))
    ));

    const { rows: [legacy] } = await db.query(
      `select public.run_accounting_report('trial-balance',$1::jsonb) report`,
      [JSON.stringify({ subsidiaryIds: [Number(context.subsidiary_id)],
        dateFrom, dateTo, page: 1, pageSize: 10 })]
    );
    assert.ok(Array.isArray(legacy.report.rows),
      'El wrapper debe preservar los reportes contables existentes.');

    const audit = report.currencySummaries.map(item => ({
      currency: item.currencyCode,
      receivableLedger: amount(item.receivableClosing),
      receivableSubledger: amount(item.receivableDocuments),
      payableLedger: amount(item.payableClosing),
      payableSubledger: amount(item.payableDocuments)
    }));
    const localAudit = report.localCurrencySummaries.map(item => ({
      currency: item.currencyCode,
      receivableLedger: amount(item.receivableClosing),
      payableLedger: amount(item.payableClosing),
      netPosition: amount(item.netPosition)
    }));
    const { rows: globalAudit } = await db.query(`
      with movement as(
        select subsidiary.name subsidiary,currency.currency_code currency,
          account.account_number,
          case account.account_number when'113002'then'RECEIVABLE'
            else'PAYABLE'end direction,
          case when account.account_number='113002'
            then coalesce(line.customer_id,transaction.customer_id)
            else coalesce(line.supplier_id,transaction.supplier_id)end party_id,
          case when journal.fx_revaluation_run_id is not null then 0
            when line.original_currency_id is not null
              or line.opening_balance_line_id is not null
            then case account.account_number when'113002'
              then line.debit_fx-line.credit_fx
              else line.credit_fx-line.debit_fx end
            else case account.account_number when'113002'
              then line.debit-line.credit else line.credit-line.debit end
          end original_movement,
          case when account.account_number='113002'
            then(case when journal.fx_revaluation_run_id is not null
              or line.opening_balance_line_id is not null
              then line.debit-line.credit
              else(line.debit-line.credit)*journal.exchange_rate end)
            else(case when journal.fx_revaluation_run_id is not null
              or line.opening_balance_line_id is not null
              then line.credit-line.debit
              else(line.credit-line.debit)*journal.exchange_rate end)
          end local_movement
        from public.journal_line line
        join public.journal journal using(journal_id)
        left join public."transaction" transaction using(transaction_id)
        join public.chart_accounts account using(account_id)
        join public.subsidiaries subsidiary
          on subsidiary.subsidiary_id=journal.subsidiary_id
        join public.currencies currency
          on currency.currency_id=coalesce(line.original_currency_id,
            journal.currency_id,transaction.currency_id,
            subsidiary.currency_id)
        where account.account_number in('113002','211002')
          and exists(
            select 1 from public.gl_impact impact
            join public.accounting_books book using(accounting_book_id)
            where impact.transaction_id=journal.transaction_id
              and impact.account_id=line.account_id
              and impact.subsidiary_id=journal.subsidiary_id
              and book.is_primary and book.is_active
          )
      )
      select subsidiary,currency,account_number,direction,
        round(sum(original_movement),2)original_balance,
        round(sum(local_movement),2)local_balance,
        count(*)filter(where party_id is null)unassigned_lines
      from movement
      group by subsidiary,currency,account_number,direction
      having abs(sum(original_movement))>.005
        or abs(sum(local_movement))>.005
        or count(*)filter(where party_id is null)>0
      order by subsidiary,account_number,currency
    `);
    process.stdout.write(`${JSON.stringify({
      passed: true, rolledBack: true,
      subsidiaryId: Number(context.subsidiary_id), dateTo,
      documents: report.documents.length,
      openDocuments: report.quality.openDocumentCount,
      reconciliationDifferences: report.quality.reconciliationDifferenceCount,
      unassignedPartyMovements: report.quality.unassignedPartyMovementCount,
      audit, localAudit, globalAudit
    })}\n`);
    await db.query('rollback');
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
});
