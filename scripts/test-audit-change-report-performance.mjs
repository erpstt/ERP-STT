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
  connectionTimeoutMillis: 15000
});

async function measure(sql, values = []) {
  const started = performance.now();
  const response = await db.query(sql, values);
  return { milliseconds: Math.round(performance.now() - started), value: response.rows[0]?.value };
}

await db.connect();
try {
  await db.query('begin');
  await db.query("set local statement_timeout='8s'");
  const session = (await db.query(`select ucs.session_id,u.email,auth_user.id auth_id
    from public.user_company_sessions ucs
    join public.user_role_sessions urs using(session_id,user_id)
    join public.roles role using(role_id)
    join public.users u using(user_id)
    join auth.users auth_user on lower(auth_user.email)=lower(u.email)
    where lower(role.role_name)in('administrador','administrator','admin')and u.is_active
    order by ucs.selected_at desc limit 1`)).rows[0];
  assert.ok(session, 'Se requiere una sesión administrativa activa para probar el reporte.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
    sub: session.auth_id,
    email: session.email,
    session_id: session.session_id,
    role: 'authenticated'
  })]);

  const month = (await db.query(
    "select to_char(current_timestamp at time zone 'America/Costa_Rica','YYYY-MM') value"
  )).rows[0].value;
  const options = await measure('select public.audit_change_report_options() value');
  const report = await measure(
    'select public.run_audit_change_report($1::jsonb) value',
    [{ month, page: 1, pageSize: 50 }]
  );

  assert.ok(options.value?.months?.length, 'Las opciones deben incluir meses disponibles.');
  assert.ok(options.value?.modules?.length, 'Las opciones deben incluir módulos disponibles.');
  assert.ok(options.value?.transactionTypes?.length, 'Las opciones deben incluir tipos de transacción.');
  assert.ok(options.value?.subsidiaries?.length, 'Las opciones deben limitarse a subsidiarias autorizadas.');
  assert.equal(report.value?.header?.month, month);
  assert.ok(Array.isArray(report.value?.rows));
  assert.ok(options.milliseconds < 8000, 'Las opciones excedieron el timeout de la API.');
  assert.ok(report.milliseconds < 8000, 'El reporte mensual excedió el timeout de la API.');

  console.log(JSON.stringify({
    passed: true,
    databaseTimeoutMilliseconds: 8000,
    optionsMilliseconds: options.milliseconds,
    reportMilliseconds: report.milliseconds,
    months: options.value.months.length,
    modules: options.value.modules.length,
    transactionTypes: options.value.transactionTypes.length,
    subsidiaries: options.value.subsidiaries.length,
    total: report.value.total,
    returnedRows: report.value.rows.length
  }));
} finally {
  await db.query('rollback').catch(() => {});
  await db.end();
}
