import { performance } from 'node:perf_hooks';
import pg from 'pg';

process.loadEnvFile?.('.env');

const rowCount = Number(process.argv[2] || 81);
const journalCount = Number(process.argv[3] || 7);
const timeoutMs = Number(process.argv[4] || 0);
const mode = process.argv[5] || 'preview';
if (!Number.isSafeInteger(rowCount) || rowCount < journalCount || !Number.isSafeInteger(journalCount) || journalCount < 1) {
  throw Error('Use: node benchmark-journal-csv-preview.mjs [lineas] [asientos] [timeout_ms] [preview|import].');
}
if (!['preview', 'import'].includes(mode)) throw Error('El modo debe ser preview o import.');

const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

await client.connect();
try {
  await client.query('begin');
  const roleTimeouts = (await client.query(`select rolname,rolconfig
    from pg_roles
    where rolname in('authenticator','authenticated')
    order by rolname`)).rows;
  const context = (await client.query(`select
      app_user.email,
      app_user.auth_user_id::text sub,
      session.session_id,
      session.subsidiary_id
    from public.user_company_sessions session
    join public.users app_user using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where app_user.is_active
      and app_user.auth_user_id is not null
      and upper(subsidiary.name)='S.T.T. HOLDINGS LIMITED'
    order by session.selected_at desc
    limit 1`)).rows[0];
  if (!context) throw Error('No se encontró una sesión activa para la subsidiaria de prueba.');

  const setup = (await client.query(`select
      currency.currency_code,
      to_char(period.start_date,'YYYY-MM-DD') journal_date
    from public.subsidiaries subsidiary
    join public.currencies currency using(currency_id)
    cross join lateral(
      select start_date
      from public.fiscal_periods
      where subsidiary_id=subsidiary.subsidiary_id
        and not coalesce(is_inactive,false)
      order by start_date desc
      limit 1
    ) period
    where subsidiary.subsidiary_id=$1`, [context.subsidiary_id])).rows[0];
  const accounts = (await client.query(`select account.account_number
    from public.chart_accounts account
    join public.account_subsidiaries scope using(account_id)
    where scope.subsidiary_id=$1
      and scope.is_active
      and not coalesce(account.is_inactive,false)
      and coalesce(account.accepts_entries,true)
    order by account.account_id
    limit 11`, [context.subsidiary_id])).rows;
  const dimensions = (await client.query(`select
      center.cost_center_id,
      center.customer_id,
      customer.department_id,
      center.class_id,
      center.name center_name,
      customer.company_name customer_name,
      department.name department_name,
      class.name class_name
    from public.cost_centers center
    join public.customers customer using(customer_id)
    join public.departments department
      on department.department_id=customer.department_id
    left join public.classes class using(class_id)
    join public.department_subsidiaries department_scope
      on department_scope.department_id=customer.department_id
     and department_scope.subsidiary_id=center.subsidiary_id
    where center.subsidiary_id=$1
      and not coalesce(center.is_inactive,false)
    order by center.cost_center_id
    limit 7`, [context.subsidiary_id])).rows;
  if (accounts.length < 2 || dimensions.length < 1 || !setup) {
    throw Error('La subsidiaria no tiene catálogos suficientes para construir el lote sintético.');
  }

  const stamp = Date.now();
  const sizes = Array(journalCount).fill(Math.floor(rowCount / journalCount));
  for (let index = 0; index < rowCount % journalCount; index++) sizes[index]++;
  const rows = [];
  for (let journalIndex = 0; journalIndex < sizes.length; journalIndex++) {
    const size = sizes[journalIndex];
    const reference = `BENCH-NOM-${stamp}-${journalIndex + 1}`;
    for (let lineIndex = 0; lineIndex < size; lineIndex++) {
      const dimension = dimensions[rows.length % dimensions.length];
      rows.push({
        asiento_referencia: reference,
        tipo_asiento: 'ASI_NOM',
        fecha: setup.journal_date,
        moneda: setup.currency_code,
        tipo_cambio: '1.000000',
        nota_asiento: 'Prueba sintética de rendimiento',
        numero_cuenta: accounts[rows.length % accounts.length].account_number,
        debito: lineIndex === 0 ? String(size - 1) : '0',
        credito: lineIndex === 0 ? '0' : '1',
        nota_linea: 'Línea sintética',
        mes_servicio: '1999-01',
        pais_servicio: 'VALOR-IGNORADO',
        entidad: 'Cliente',
        nombre: dimension.customer_name,
        departamento: dimension.department_name,
        centro_costos: dimension.center_name,
        clase: dimension.class_name || '',
        acreedor_financiero: '',
        compania_relacionada: ''
      });
    }
  }

  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  await client.query(`set local statement_timeout='${Math.max(0, timeoutMs)}ms'; set local role authenticated`);
  const started = performance.now();
  const result = (await client.query(
    'select public.import_journal_csv($1::jsonb,$2,$3) result',
    [JSON.stringify(rows), mode === 'preview', context.subsidiary_id]
  )).rows[0].result;
  const elapsedMs = performance.now() - started;

  console.log(JSON.stringify({
    synthetic: true,
    mode,
    rows: rows.length,
    journals: journalCount,
    accounts: accounts.length,
    dimensions: dimensions.length,
    roleTimeouts,
    timeoutMs,
    elapsedMs: Math.round(elapsedMs),
    valid: result.valid,
    errors: result.errors?.length || 0
  }));
  await client.query('rollback');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
