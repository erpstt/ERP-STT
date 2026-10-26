import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');

const argument = name => process.argv
  .find(value => value.startsWith(`--${name}=`))
  ?.split('=')
  .slice(1)
  .join('=');
const subsidiarySelector = argument('subsidiary') || 'S.T.T. HOLDINGS LIMITED';
const dateFrom = argument('from') || '2026-10-01';
const dateTo = argument('to') || '2026-10-31';
const requestedBookId = argument('book-id');

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

const section = row => {
  const name = String(row.account_name || '').toLocaleLowerCase('es');
  if (/(impuesto.*renta|renta.*impuesto|provisi[oó]n.*renta)/.test(name)) return 'tax';
  if (/(cambi|financier|inter[eé]s|no operativ|otros ingresos|otros gastos)/.test(name)) return 'nonop';
  if (row.category === 'Ingreso') return 'revenue';
  if (row.category === 'Costo') return 'cost';
  return 'expense';
};
const amount = row => {
  const movement = Number(row.debit || 0) - Number(row.credit || 0);
  return row.category === 'Ingreso' ? -movement : movement;
};
const presentationResult = rows => {
  const sections = { revenue: [], cost: [], expense: [], nonop: [], tax: [] };
  rows.forEach(row => sections[section(row)].push(row));
  const total = key => sections[key].reduce((sum, row) => sum + amount(row), 0);
  const revenue = total('revenue');
  const cost = total('cost');
  const expense = total('expense');
  const tax = total('tax');
  const nonop = sections.nonop.reduce(
    (sum, row) => sum + (row.category === 'Ingreso' ? amount(row) : -amount(row)),
    0
  );
  return revenue - cost - expense + nonop - tax;
};
const closeEnough = (left, right) => Math.abs(Number(left) - Number(right)) < 0.005;

await db.connect();
try {
  await db.query('begin read only');
  await db.query("set local statement_timeout='30s'");

  const context = (await db.query(`select
      account.email,
      account.auth_user_id::text sub,
      session.session_id,
      session.subsidiary_id,
      subsidiary.name subsidiary_name,
      primary_book.accounting_book_id
    from public.user_company_sessions session
    join public.users account using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    left join lateral(
      select book.accounting_book_id
      from public.accounting_books book
      where book.subsidiary_id=session.subsidiary_id
        and book.is_primary
        and book.is_active
      order by book.accounting_book_id
      limit 1
    ) primary_book on true
    where account.is_active
      and account.auth_user_id is not null
      and (
        session.subsidiary_id::text=$1
        or upper(subsidiary.name)=upper($1)
      )
    order by session.selected_at desc
    limit 1`, [subsidiarySelector])).rows[0];
  assert.ok(context, `No existe una sesión activa para la subsidiaria ${subsidiarySelector}.`);

  const bookId = requestedBookId
    ? Number(requestedBookId)
    : Number(context.accounting_book_id || 0) || null;
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  await db.query('set local role authenticated');

  const base = {
    subsidiaryIds: [Number(context.subsidiary_id)],
    bookId,
    dateFrom,
    dateTo,
    departmentType: null,
    departmentId: null,
    locationId: null,
    classId: null,
    costCenterId: null,
    hierarchy: 4,
    excludeZero: true,
    page: 1,
    pageSize: 500
  };
  const total = (await db.query(
    "select public.run_accounting_report('income-statement',$1::jsonb) value",
    [JSON.stringify({ ...base, columnView: 'TOTAL' })]
  )).rows[0].value;
  const matrix = (await db.query(
    'select public.run_income_statement_matrix($1::jsonb) value',
    [JSON.stringify({ ...base, columnView: 'DEPARTMENT' })]
  )).rows[0].value;

  const totalRows = total.rows || [];
  const matrixRows = (matrix.rows || []).map(row => ({
    ...row,
    debit: row.category === 'Ingreso' ? 0 : Number(row.amount || 0),
    credit: row.category === 'Ingreso' ? Number(row.amount || 0) : 0
  }));
  const totalVisibleResult = presentationResult(totalRows);
  const matrixVisibleResult = presentationResult(matrixRows);
  const ledgerResult = Number(total.summary?.periodResult || 0);
  const matrixLedgerResult = Number(matrix.summary?.periodResult || 0);
  const inactiveRows = totalRows.filter(row => (
    Math.abs(Number(row.debit || 0)) < 0.000001
    && Math.abs(Number(row.credit || 0)) < 0.000001
  ));
  const diagnostics = {
    subsidiary: context.subsidiary_name,
    bookId,
    dateFrom,
    dateTo,
    totalRowsReturned: totalRows.length,
    totalRowsReported: Number(total.total || 0),
    totalRowsWithoutPeriodMovement: inactiveRows.length,
    totalVisibleResult,
    ledgerResult,
    totalDifference: totalVisibleResult - ledgerResult,
    matrixRows: matrixRows.length,
    matrixVisibleResult,
    matrixLedgerResult,
    matrixDifference: matrixVisibleResult - matrixLedgerResult
  };

  assert.equal(
    Number(total.total || 0),
    totalRows.length,
    `La vista Total está truncada o paginada y no contiene todas las cuentas: ${JSON.stringify(diagnostics)}`
  );
  assert.ok(
    closeEnough(totalVisibleResult, ledgerResult),
    `El resultado calculado desde las filas Total no coincide con el Mayor: ${JSON.stringify(diagnostics)}`
  );
  assert.ok(
    closeEnough(matrixVisibleResult, matrixLedgerResult),
    `El resultado calculado desde la matriz por Departamento no coincide con el Mayor: ${JSON.stringify(diagnostics)}`
  );
  assert.ok(
    closeEnough(ledgerResult, matrixLedgerResult),
    `Total y Departamento no aplican el mismo universo contable: ${JSON.stringify(diagnostics)}`
  );

  console.log(JSON.stringify({ reconciled: true, ...diagnostics }));
  await db.query('rollback');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
