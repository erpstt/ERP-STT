import assert from 'node:assert/strict';
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

const numeric = value => Number(value || 0);
const close = (actual, expected, message) => assert.ok(
  Math.abs(numeric(actual) - numeric(expected)) < 0.00001,
  `${message}: ${actual} != ${expected}`
);

await db.connect();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='15s'; set local statement_timeout='120s'");

  const context = (await db.query(`
    select app_user.user_id,app_user.email,auth_user.id sub,
      company_session.session_id,company_session.subsidiary_id,
      role_session.role_id
    from public.user_company_sessions company_session
    join public.users app_user using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(app_user.email)
    join public.user_role_sessions role_session
      on role_session.session_id=company_session.session_id
     and role_session.user_id=company_session.user_id
    where exists(
      select 1
      from public.supplier_invoice invoice
      join public.bank_account bank
        on bank.subsidiary_id=invoice.subsidiary_id
       and bank.currency_id=invoice.currency_id
       and not coalesce(bank.is_credit_card,false)
       and bank.balance>0
      join public.fiscal_periods period
        on period.subsidiary_id=invoice.subsidiary_id
       and not period.is_closed
       and not coalesce(period.ap_closed,false)
       and not coalesce(period.gl_closed,false)
      where invoice.subsidiary_id=company_session.subsidiary_id
        and coalesce(nullif(invoice.payable_amount,0),invoice.total_amount)>
          coalesce((select sum(application.amount)
            from public.supplier_payment_application application
            where application.invoice_id=invoice.invoice_id),0)
        and not exists(
          select 1 from public.bank_reconciliation reconciliation
          where reconciliation.bank_account_id=bank.bank_account_id
            and reconciliation.status='CERRADA'
            and reconciliation.reconciliation_date>=period.end_date
        )
        and not exists(
          select 1
          from public.solicitudes_pago_lineas request_line
          join public.solicitudes_pago request
            on request.id=request_line.id_solicitud
          where request_line.id_factura_proveedor=invoice.invoice_id
            and request.estado in('PENDIENTE_APROBACION','APROBADO')
        )
    )
    order by company_session.selected_at desc nulls last,
      company_session.session_id desc
    limit 1
  `)).rows[0];
  assert.ok(context, 'Se requiere una sesión autenticada con una factura pendiente, banco y período abierto.');

  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: context.sub,
    email: context.email,
    session_id: context.session_id,
    role: 'authenticated',
    role_id: context.role_id
  })]);

  const setup = (await db.query(`
    select invoice.invoice_id,invoice.supplier_id,invoice.currency_id,
      coalesce(nullif(invoice.payable_amount,0),invoice.total_amount)
        -coalesce((select sum(application.amount)
          from public.supplier_payment_application application
          where application.invoice_id=invoice.invoice_id),0) balance,
      bank.bank_account_id,bank.account_id bank_gl_account_id,bank.balance bank_balance,
      period.fiscal_period_id,to_char(period.end_date,'YYYY-MM-DD') payment_date,
      (select location.location_id from public.locations location
       left join public.location_subsidiaries assignment using(location_id)
       where location.subsidiary_id=invoice.subsidiary_id
          or assignment.subsidiary_id=invoice.subsidiary_id
       order by location.location_id limit 1) location_id
    from public.supplier_invoice invoice
    join public.bank_account bank
      on bank.subsidiary_id=invoice.subsidiary_id
     and bank.currency_id=invoice.currency_id
     and not coalesce(bank.is_credit_card,false)
     and bank.balance>0
    join public.fiscal_periods period
      on period.subsidiary_id=invoice.subsidiary_id
     and not period.is_closed
     and not coalesce(period.ap_closed,false)
     and not coalesce(period.gl_closed,false)
    where invoice.subsidiary_id=public.active_subsidiary_id()
      and coalesce(nullif(invoice.payable_amount,0),invoice.total_amount)>
        coalesce((select sum(application.amount)
          from public.supplier_payment_application application
          where application.invoice_id=invoice.invoice_id),0)
      and not exists(
        select 1 from public.bank_reconciliation reconciliation
        where reconciliation.bank_account_id=bank.bank_account_id
          and reconciliation.status='CERRADA'
          and reconciliation.reconciliation_date>=period.end_date
      )
      and not exists(
        select 1
        from public.solicitudes_pago_lineas request_line
        join public.solicitudes_pago request
          on request.id=request_line.id_solicitud
        where request_line.id_factura_proveedor=invoice.invoice_id
          and request.estado in('PENDIENTE_APROBACION','APROBADO')
      )
    order by period.end_date desc,bank.balance desc,invoice.invoice_id
    limit 1
  `)).rows[0];
  assert.ok(setup, 'No hay factura, banco compatible o período reversible para la prueba.');

  const amount = Math.min(numeric(setup.balance), numeric(setup.bank_balance), 1);
  assert.ok(amount > 0, 'El importe reversible debe ser mayor que cero.');
  const paymentDate = setup.payment_date;
  const bankBefore = numeric(setup.bank_balance);
  const bankGlAccount = setup.bank_gl_account_id;
  assert.ok(bankGlAccount, 'La cuenta bancaria debe tener cuenta contable asociada.');

  const payload = {
    supplier_id: setup.supplier_id,
    account_id: setup.bank_account_id,
    date: paymentDate,
    period_id: setup.fiscal_period_id,
    location_id: setup.location_id || '',
    rate: 1,
    reference: `TEST-ROLLBACK-${Date.now()}`,
    memo: 'Prueba automática reversible de pago a proveedor',
    applications: [{ invoice_id: setup.invoice_id, amount }]
  };
  const saved = (await db.query(
    'select public.save_supplier_payment($1::jsonb,null) value',
    [JSON.stringify(payload)]
  )).rows[0].value;
  const detail = (await db.query(
    'select public.supplier_payment_detail($1) value',
    [saved.id]
  )).rows[0].value;

  assert.equal(detail.applications.length, 1, 'El pago debe conservar una aplicación a factura.');
  assert.ok(detail.impact.length >= 2, 'El pago debe generar al menos las líneas CxP y banco.');

  const snapshot = (await db.query(`
    select invoice.payable_account_id,account.account_number
    from public.supplier_invoice invoice
    join public.chart_accounts account on account.account_id=invoice.payable_account_id
    where invoice.invoice_id=$1
  `, [setup.invoice_id])).rows[0];
  assert.ok(snapshot?.payable_account_id, 'La factura debe conservar la cuenta por pagar como snapshot.');
  assert.match(snapshot.account_number, /^21100[1-4]$/, 'El snapshot debe usar una cuenta CxP configurada.');
  assert.ok((saved.payableAccountIds || []).map(String).includes(String(snapshot.payable_account_id)),
    'El resultado del pago debe informar la cuenta CxP del snapshot.');

  const payableImpact = detail.impact.filter(line =>
    String(line.account_id) === String(snapshot.payable_account_id)
  );
  close(payableImpact.reduce((sum, line) => sum + numeric(line.debit), 0), amount,
    'El pago debe debitar la cuenta CxP del snapshot');
  close(payableImpact.reduce((sum, line) => sum + numeric(line.credit), 0), 0,
    'La cuenta CxP del snapshot no debe acreditarse en el pago');

  const bankImpact = detail.impact.filter(line =>
    String(line.account_id) === String(bankGlAccount)
  );
  const cashTotal = numeric(saved.cashTotal ?? saved.total);
  close(bankImpact.reduce((sum, line) => sum + numeric(line.debit), 0), 0,
    'La cuenta bancaria no debe debitarse');
  close(bankImpact.reduce((sum, line) => sum + numeric(line.credit), 0), cashTotal,
    'El crédito bancario debe coincidir con el desembolso neto');

  const bankAfter = numeric((await db.query(
    'select balance from public.bank_account where bank_account_id=$1',
    [setup.bank_account_id]
  )).rows[0].balance);
  close(bankAfter, bankBefore - cashTotal, 'El saldo bancario debe disminuir por el desembolso neto');

  const deleted = (await db.query(
    'select public.delete_supplier_payment($1) value',
    [saved.id]
  )).rows[0].value;
  assert.equal(deleted.success, true, 'La eliminación debe confirmar la reversión.');
  assert.equal(numeric((await db.query(
    'select count(*) value from public.supplier_payment where payment_id=$1',
    [saved.id]
  )).rows[0].value), 0, 'El pago debe eliminarse.');
  assert.equal(numeric((await db.query(
    'select count(*) value from public.supplier_payment_application where payment_id=$1',
    [saved.id]
  )).rows[0].value), 0, 'Las aplicaciones del pago deben eliminarse.');
  assert.equal(numeric((await db.query(
    'select count(*) value from public.journal where journal_id=$1',
    [saved.journalId]
  )).rows[0].value), 0, 'El asiento del pago debe eliminarse.');

  const bankRestored = numeric((await db.query(
    'select balance from public.bank_account where bank_account_id=$1',
    [setup.bank_account_id]
  )).rows[0].balance);
  close(bankRestored, bankBefore, 'Eliminar debe restaurar el saldo bancario');

  await db.query('rollback');
  console.log(JSON.stringify({
    authenticatedActor: true,
    application: true,
    payableSnapshot: snapshot.account_number,
    journalLines: detail.impact.length,
    bankMovement: true,
    deleteRemovesPaymentAndJournal: true,
    deleteRestoresBalance: true,
    rollback: true
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
