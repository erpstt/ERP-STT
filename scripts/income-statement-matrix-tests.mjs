import pg from 'pg';
import { readFile } from 'node:fs/promises';

process.loadEnvFile?.('.env');
const reference = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543), database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${reference}`,
  password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false }
});
await db.connect();
try {
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260913190000_income_statement_dimensions.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../supabase/migrations/20260916140000_income_statement_accounting_period_columns.sql', import.meta.url), 'utf8'));
  const session = (await db.query('select u.email, s.session_id, s.subsidiary_id from user_company_sessions s join users u using(user_id) order by s.selected_at desc limit 1')).rows[0];
  if (!session) throw new Error('No existe una sesión activa para validar el reporte.');
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ email: session.email, session_id: session.session_id })]);
  const links = (await db.query('select income_statement_dimension_links() value')).rows[0].value;
  if (!(links.reportCostCenters || []).every(center => 'departmentId' in center && 'classId' in center)) throw new Error('Las relaciones de centros de costo están incompletas.');
  const historicalDepartments = (links.reportDepartments || []).filter(department => department.isInactive);
  if (!historicalDepartments.every(department => department.displayName.includes('con movimientos'))) throw new Error('Los departamentos históricos no están identificados correctamente.');
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const base = { subsidiaryIds: [session.subsidiary_id], dateFrom: arg('from') || '1900-01-01', dateTo: arg('to') || '2099-12-31', excludeZero: false, page: 1, pageSize: 500 };
  const consolidated = (await db.query("select run_accounting_report('income-statement',$1::jsonb) value", [JSON.stringify({ ...base, columnView: 'TOTAL' })])).rows[0].value;
  const checked = {};
  for (const columnView of ['DEPARTMENT', 'CLASS', 'LOCATION', 'COST_CENTER', 'ACCOUNTING_PERIOD']) {
    const result = (await db.query('select run_income_statement_matrix($1::jsonb) value', [JSON.stringify({ ...base, columnView })])).rows[0].value;
    for (const row of result.rows) {
      const dimensions = Object.values(row.dimensions || {}).reduce((total, value) => total + Number(value), 0);
      if (Math.abs(dimensions - Number(row.amount)) > 0.005) throw new Error(`${columnView}: la cuenta ${row.account_number} no suma al consolidado.`);
    }
    const expected = Number(consolidated.summary?.periodResult || 0), actual = Number(result.summary?.periodResult || 0);
    if (Math.abs(expected - actual) > 0.005) throw new Error(`${columnView}: diferencia contra Mayor General (${actual - expected}).`);
    checked[columnView] = { columns: result.columns.length, rows: result.rows.length, reconciled: true };
  }
  const monthly = (await db.query('select run_income_statement_matrix($1::jsonb) value', [JSON.stringify({ ...base, dateFrom: '2026-08-01', dateTo: '2026-09-30', columnView: 'ACCOUNTING_PERIOD' })])).rows[0].value;
  if (monthly.columns?.map(column => column.id).join(',') !== '2026-08,2026-09') throw new Error(`Las columnas mensuales no respetan el rango: ${JSON.stringify(monthly.columns)}`);
  if (monthly.columns?.map(column => column.name).join(',') !== 'Agosto 2026,Septiembre 2026') throw new Error('Los meses no tienen etiquetas claras en español.');
  for (const departmentType of ['Cliente', 'Interno']) {
    const allowedIds = new Set((links.reportDepartments || []).filter(department => department.type === departmentType).map(department => String(department.id)));
    const result = (await db.query('select run_income_statement_matrix($1::jsonb) value', [JSON.stringify({ ...base, columnView: 'DEPARTMENT', departmentType })])).rows[0].value;
    const invalid = (result.columns || []).filter(column => !allowedIds.has(String(column.id)));
    if (invalid.length) throw new Error(`${departmentType}: aparecen columnas de otro tipo de departamento.`);
    checked[`TYPE_${departmentType.toUpperCase()}`] = { columns: result.columns.length, scoped: true };
  }
  const apply = process.argv.includes('--apply');
  console.log(JSON.stringify({ ...checked, linkedCostCenters: links.reportCostCenters.length, historicalDepartments: historicalDepartments.length, applied: apply }));
  await db.query(apply ? 'commit' : 'rollback');
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  await db.end();
}
