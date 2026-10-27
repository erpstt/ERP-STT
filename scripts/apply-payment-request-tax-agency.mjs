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

const migrations = [
  '../supabase/migrations/20261027090000_tax_agency_payment_requests.sql',
  '../supabase/migrations/20261027101000_payment_request_tax_agency_reporting.sql'
];

const migrationBody = source => source
  .replace(/^\uFEFF?\s*begin\s*;\s*/i, '')
  .replace(/\s*commit\s*;\s*(?=notify\s+pgrst|$)/i, '')
  .replace(/\s*notify\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i, '');

async function businessTotals() {
  return (await db.query(`select
    (select count(*)::text from public.solicitudes_pago) request_count,
    (select coalesce(sum(total),0)::text from public.solicitudes_pago) request_total,
    (select count(*)::text from public.solicitudes_pago_lineas) request_line_count,
    (select coalesce(sum(monto),0)::text from public.solicitudes_pago_lineas) request_line_total,
    (select count(*)::text from public.bank_check_line) bank_line_count,
    (select coalesce(sum(amount),0)::text from public.bank_check_line) bank_line_total,
    (select count(*)::text from public.journal_line) journal_line_count,
    (select coalesce(sum(debit),0)::text from public.journal_line) journal_debit,
    (select coalesce(sum(credit),0)::text from public.journal_line) journal_credit,
    (select coalesce(sum(debit_fx),0)::text from public.journal_line) journal_debit_fx,
    (select coalesce(sum(credit_fx),0)::text from public.journal_line) journal_credit_fx`)).rows[0];
}

async function taxAgencyAssignments() {
  const columns = (await db.query(`select
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='solicitudes_pago_lineas'
        and column_name='id_agencia_tributaria') request_column,
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='bank_check_line'
        and column_name='tax_agency_id') bank_column,
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='journal_line'
        and column_name='tax_agency_id') journal_column`)).rows[0];
  if (!Object.values(columns).every(value => value === true)) {
    return { request_lines: 0, bank_lines: 0, journal_lines: 0 };
  }
  return (await db.query(`select
    (select count(*)::int from public.solicitudes_pago_lineas
      where id_agencia_tributaria is not null) request_lines,
    (select count(*)::int from public.bank_check_line
      where tax_agency_id is not null) bank_lines,
    (select count(*)::int from public.journal_line
      where tax_agency_id is not null) journal_lines`)).rows[0];
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='120s'");
  await db.query("select set_config('lock_timeout','15s',true)");

  const totalsBefore = await businessTotals();
  const assignmentsBefore = await taxAgencyAssignments();
  for (const relativePath of migrations) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    const sql = migrationBody(source);
    assert.ok(sql.trim(), `La migración ${relativePath} quedó vacía.`);
    assert.ok(!/^\s*begin\s*;/i.test(sql), `${relativePath} conserva BEGIN interno.`);
    assert.ok(!/\bnotify\s+pgrst\b/i.test(sql), `${relativePath} conserva NOTIFY interno.`);
    await db.query(sql);
  }

  const schema = (await db.query(`select
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='solicitudes_pago_lineas'
        and column_name='id_agencia_tributaria') request_column,
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='bank_check_line'
        and column_name='tax_agency_id') bank_column,
    exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='journal_line'
        and column_name='tax_agency_id') journal_column,
    exists(select 1 from pg_constraint
      where conrelid='public.solicitudes_pago_lineas'::regclass
        and conname='solicitudes_pago_lineas_tipo_tercero_check'
        and position('Agencia Tributaria' in pg_get_constraintdef(oid))>0) request_constraint,
    exists(select 1 from pg_constraint
      where conrelid='public.journal_line'::regclass
        and conname='journal_line_entity_type_allowed'
        and position('Agencia Tributaria' in pg_get_constraintdef(oid))>0) journal_constraint`)).rows[0];
  assert.ok(
    Object.values(schema).every(value => value === true),
    `Esquema incompleto: ${JSON.stringify(schema)}`
  );

  const functions = (await db.query(`select
    to_regprocedure('public.pr_save_without_budget(jsonb)')is not null save_core,
    to_regprocedure('public.pr_execute_without_budget(jsonb)')is not null execute_core,
    to_regprocedure(
      'public.save_bank_check_transfer_without_tax_agency(jsonb,bigint)'
    )is not null bank_core,
    to_regprocedure('public.save_bank_check_transfer(jsonb,bigint)')is not null bank_wrapper,
    position('id_agencia_tributaria' in pg_get_functiondef(
      'public.pr_save_without_budget(jsonb)'::regprocedure
    ))>0 save_support,
    position('id_agencia_tributaria' in pg_get_functiondef(
      'public.pr_execute_without_budget(jsonb)'::regprocedure
    ))>0 execute_support,
    position('Agencia Tributaria' in pg_get_functiondef(
      'public.payment_request_report_options()'::regprocedure
    ))>0 report_options_support,
    position('id_agencia_tributaria' in pg_get_functiondef(
      'public.run_payment_request_report(jsonb)'::regprocedure
    ))>0 report_support,
    position('id_agencia_tributaria' in pg_get_functiondef(
      'public.expense_approval_email_snapshot(bigint,bigint,bigint)'::regprocedure
    ))>0 email_support`)).rows[0];
  assert.ok(
    Object.values(functions).every(value => value === true),
    `Funciones incompletas: ${JSON.stringify(functions)}`
  );

  const context = (await db.query(`select
      account.email,account.auth_user_id::text sub,
      company_session.session_id,company_session.subsidiary_id
    from public.user_company_sessions company_session
    join public.users account using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where upper(btrim(subsidiary.name))='S.T.T. HOLDINGS LIMITED'
      and account.is_active and account.auth_user_id is not null
      and exists(
        select 1 from public.user_subsidiaries access
        where access.user_id=account.user_id
          and access.subsidiary_id=company_session.subsidiary_id
      )
    order by company_session.selected_at desc
    limit 1`)).rows[0];
  assert.ok(context, 'No existe una sesión autorizada de S.T.T. HOLDINGS LIMITED.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify(context)
  ]);

  const options = (await db.query(
    'select public.pr_options() value'
  )).rows[0].value;
  const taxAgencies = options.taxAgencies || [];
  assert.equal(taxAgencies.length, 1, 'STT Holdings debe mostrar una agencia tributaria.');
  assert.match(taxAgencies[0].name, /^TAJ\b/i, 'STT Holdings no muestra TAJ.');
  const mappedAgency = (await db.query(`select agency.tax_agency_id,agency.agency_name
    from public.tax_agency_subsidiaries scope
    join public.tax_agencies agency using(tax_agency_id)
    where scope.subsidiary_id=$1`, [context.subsidiary_id])).rows;
  assert.deepEqual(
    taxAgencies.map(agency => String(agency.id)).sort(),
    mappedAgency.map(agency => String(agency.tax_agency_id)).sort(),
    'pr_options no coincide con tax_agency_subsidiaries.'
  );

  const assignmentsAfter = await taxAgencyAssignments();
  assert.deepEqual(
    assignmentsAfter,assignmentsBefore,
    'La instalación cambió asignaciones tributarias existentes.'
  );

  const totalsAfter = await businessTotals();
  assert.deepEqual(
    totalsAfter,totalsBefore,
    `La instalación modificó datos contables: ${JSON.stringify({ totalsBefore, totalsAfter })}`
  );

  await db.query("notify pgrst,'reload schema'");
  await db.query('commit');
  console.log(JSON.stringify({
    applied: true,
    migrations: migrations.map(path => path.split('/').at(-1)),
    schema,
    functions,
    subsidiary: 'S.T.T. HOLDINGS LIMITED',
    taxAgency: taxAgencies[0].name,
    existingDataPreserved: true,
    taxAgencyAssignments: assignmentsAfter
  }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
