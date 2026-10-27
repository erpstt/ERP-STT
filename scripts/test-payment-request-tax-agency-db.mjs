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
  connectionTimeoutMillis: 15000
});

const rpc = async (functionName, payload = null) => {
  const parameters = payload === null ? [] : [JSON.stringify(payload)];
  const argument = payload === null ? '' : '$1::jsonb';
  return (await db.query(
    `select public.${functionName}(${argument}) value`, parameters
  )).rows[0].value;
};

const migrationBody = source => source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(
    /\s*commit\s*;\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i,
    ''
  );

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");

  const migration = await readFile(new URL(
    '../supabase/migrations/20261027090000_tax_agency_payment_requests.sql',
    import.meta.url
  ), 'utf8');
  await db.query(migrationBody(migration));

  const context = (await db.query(`select
      account.user_id,account.email,account.auth_user_id::text sub,
      company_session.session_id,company_session.subsidiary_id
    from public.user_company_sessions company_session
    join public.users account using(user_id)
    join public.user_role_sessions role_session
      on role_session.session_id=company_session.session_id
      and role_session.user_id=company_session.user_id
    join public.roles role using(role_id)
    where lower(role.role_name)in('administrador','administrator','admin')
      and exists(
        select 1 from public.tax_agency_subsidiaries agency_scope
        where agency_scope.subsidiary_id=company_session.subsidiary_id
      )
      and exists(
        select 1
        from public.bank_account bank_account
        join public.subsidiaries subsidiary
          on subsidiary.subsidiary_id=bank_account.subsidiary_id
        where bank_account.subsidiary_id=company_session.subsidiary_id
          and bank_account.currency_id=subsidiary.currency_id
          and not coalesce(bank_account.is_credit_card,false)
          and bank_account.balance>=0.01
      )
      and exists(
        select 1 from public.fiscal_periods period
        where period.subsidiary_id=company_session.subsidiary_id
          and current_date between period.start_date and period.end_date
          and not period.is_closed and not period.gl_closed
          and not period.is_inactive
      )
    order by company_session.selected_at desc
    limit 1`)).rows[0];
  assert.ok(context, 'No hay una sesión administrativa con agencia, banco y período abierto.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify(context)
  ]);

  const subsidiary = (await db.query(`select subsidiary_id,currency_id,name
    from public.subsidiaries where subsidiary_id=$1`, [
      context.subsidiary_id
    ])).rows[0];
  const agencies = (await db.query(`select
      agency.tax_agency_id,agency.agency_name,agency.tax_id
    from public.tax_agency_subsidiaries scope
    join public.tax_agencies agency using(tax_agency_id)
    join public.subsidiaries subsidiary
      on subsidiary.subsidiary_id=scope.subsidiary_id
    where scope.subsidiary_id=$1
      and agency.country_id=subsidiary.country_id
    order by agency.agency_name`, [context.subsidiary_id])).rows;
  assert.ok(agencies.length > 0, 'La subsidiaria no tiene agencia tributaria configurada.');
  const agency = agencies[0];

  const options = await rpc('pr_options');
  assert.deepEqual(
    options.taxAgencies.map(item => String(item.id)),
    agencies.map(item => String(item.tax_agency_id)),
    'Las agencias de las opciones no respetan la subsidiaria activa.'
  );

  const bank = (await db.query(`select bank_account.bank_account_id
    from public.bank_account bank_account
    where bank_account.subsidiary_id=$1
      and bank_account.currency_id=$2
      and not coalesce(bank_account.is_credit_card,false)
      and bank_account.balance>=0.01
    order by bank_account.balance desc,bank_account.bank_account_id
    limit 1`, [context.subsidiary_id, subsidiary.currency_id])).rows[0];
  const account = (await db.query(`select account.account_id
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1 and scope.is_active
      and account.category in('Activo','Pasivo')
      and public.pr_allowed_account(account.account_id)
    order by account.account_number
    limit 1`, [context.subsidiary_id])).rows[0];
  const period = (await db.query(`select fiscal_period_id,current_date::text payment_date
    from public.fiscal_periods
    where subsidiary_id=$1
      and current_date between start_date and end_date
      and not is_closed and not gl_closed and not is_inactive
    order by start_date desc limit 1`, [context.subsidiary_id])).rows[0];
  assert.ok(bank && account && period, 'Falta banco, cuenta permitida o período abierto.');

  const otherAgency = (await db.query(`select agency.tax_agency_id
    from public.tax_agencies agency
    where not exists(
      select 1 from public.tax_agency_subsidiaries scope
      where scope.tax_agency_id=agency.tax_agency_id
        and scope.subsidiary_id=$1
    )order by agency.tax_agency_id limit 1`, [context.subsidiary_id])).rows[0];
  assert.ok(otherAgency, 'Se requiere otra agencia para probar el aislamiento.');
  await db.query('savepoint invalid_agency');
  await assert.rejects(rpc('pr_save', {
    type: 'OTROS',
    currencyId: subsidiary.currency_id,
    plannedDate: period.payment_date,
    concept: 'Pago fiscal inválido de prueba',
    lines: [{
      accountId: account.account_id,
      entityType: 'Agencia Tributaria',
      entityId: otherAgency.tax_agency_id,
      concept: 'Agencia de otra subsidiaria',
      amount: 0.01
    }]
  }), /agencia tributaria no pertenece/i);
  await db.query('rollback to savepoint invalid_agency');

  const saved = await rpc('pr_save', {
    type: 'OTROS',
    currencyId: subsidiary.currency_id,
    plannedDate: period.payment_date,
    concept: 'Pago de impuestos de prueba',
    lines: [{
      accountId: account.account_id,
      entityType: 'Agencia Tributaria',
      entityId: agency.tax_agency_id,
      concept: 'Impuesto de prueba',
      amount: 0.01
    }]
  });
  assert.ok(saved.id, `No se guardó la solicitud: ${JSON.stringify(saved)}`);

  let detail = await rpc('pr_detail', { id: saved.id });
  assert.equal(detail.header.estado, 'BORRADOR');
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].tipo_tercero, 'Agencia Tributaria');
  assert.equal(
    String(detail.lines[0].id_agencia_tributaria),
    String(agency.tax_agency_id)
  );
  assert.equal(detail.lines[0].party, agency.agency_name);

  // The selected fixture company may not have an approval workflow. Move the
  // reversible test record to the execution precondition without weakening
  // any production function.
  await db.query(`update public.solicitudes_pago
    set estado='APROBADO',version=version+1
    where id=$1`, [saved.id]);
  detail = await rpc('pr_detail', { id: saved.id });
  assert.equal(detail.header.estado, 'APROBADO');

  const executed = await rpc('pr_execute', {
    id: saved.id,
    version: detail.header.version,
    bankId: bank.bank_account_id,
    date: period.payment_date,
    rate: 1,
    method: 'TRANSFERENCIA',
    reference: 'TEST-TAX-AGENCY'
  });
  detail = await rpc('pr_detail', { id: saved.id });
  assert.equal(detail.header.estado, 'APLICADO');

  const paymentLine = (await db.query(`select
      line.entity_type,line.tax_agency_id,bank_check.beneficiary
    from public.bank_check_line line
    join public.bank_check bank_check using(check_id)
    where bank_check.check_id=$1`, [detail.header.check_id])).rows[0];
  assert.equal(paymentLine.entity_type, 'Agencia Tributaria');
  assert.equal(String(paymentLine.tax_agency_id), String(agency.tax_agency_id));
  assert.equal(paymentLine.beneficiary, agency.agency_name);

  const journalLine = (await db.query(`select entity_type,tax_agency_id
    from public.journal_line
    where journal_id=$1 and debit>0 and tax_agency_id is not null`, [
      executed.journalId
    ])).rows[0];
  assert.equal(journalLine.entity_type, 'Agencia Tributaria');
  assert.equal(String(journalLine.tax_agency_id), String(agency.tax_agency_id));

  console.log(JSON.stringify({
    passed: true,
    rollback: true,
    subsidiary: subsidiary.name,
    agency: agency.agency_name,
    optionsFilteredBySubsidiary: true,
    foreignAgencyRejected: true,
    requestSaved: true,
    paymentExecuted: true,
    bankTracePreserved: true,
    journalTracePreserved: true,
    beneficiary: paymentLine.beneficiary
  }));
  await db.query('rollback');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
