import pg from 'pg';

process.loadEnvFile?.('.env');
const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${ref}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }
});

const section = row => {
  const name = String(row.account_name || '').toLocaleLowerCase('es');
  if (/(impuesto.*renta|renta.*impuesto|provisi[oó]n.*renta)/.test(name)) return 'tax';
  if (/(cambi|financier|inter[eé]s|no operativ|otros ingresos|otros gastos)/.test(name)) return 'nonop';
  if (row.category === 'Ingreso') return 'revenue';
  if (row.category === 'Costo') return 'cost';
  return 'expense';
};
const contribution = row => {
  const movement = Number(row.debit || 0) - Number(row.credit || 0);
  const amount = row.category === 'Ingreso' ? -movement : movement;
  const key = section(row);
  return key === 'revenue' ? amount
    : key === 'nonop' ? (row.category === 'Ingreso' ? amount : -amount)
      : -amount;
};

await db.connect();
try {
  await db.query('begin read only');
  const context = (await db.query(`select account.email,
      account.auth_user_id::text sub,session.session_id,session.subsidiary_id
    from public.user_company_sessions session
    join public.users account using(user_id)
    join public.subsidiaries subsidiary using(subsidiary_id)
    where account.is_active and account.auth_user_id is not null
      and upper(btrim(subsidiary.name))='S.T.T. HOLDINGS LIMITED'
    order by session.selected_at desc limit 1`)).rows[0];
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(context)]);
  const book = (await db.query(`select accounting_book_id id from accounting_books
    where subsidiary_id=$1 and is_primary and is_active order by accounting_book_id limit 1`,
  [context.subsidiary_id])).rows[0];
  const filters = { subsidiaryIds: [context.subsidiary_id], bookId: String(book.id),
    columnView: 'TOTAL', departmentType: null, periodId: null,
    dateFrom: '2026-10-01', dateTo: '2026-10-31', currencyId: null,
    departmentId: null, locationId: null, classId: null, costCenterId: null,
    hierarchy: 4, excludeZero: true, page: 1, pageSize: 500 };
  const total = (await db.query(
    "select run_accounting_report('income-statement',$1::jsonb) result",
    [JSON.stringify(filters)]
  )).rows[0].result;
  const rows = (total.rows || []).map(row => ({
    account_id: row.account_id,
    account_number: row.account_number,
    account_name: row.account_name,
    category: row.category,
    subsidiary: row.subsidiary,
    debit: Number(row.debit || 0),
    credit: Number(row.credit || 0),
    contribution: contribution(row),
    section: section(row)
  }));
  const duplicates = [...Map.groupBy(rows, row => String(row.account_id))]
    .filter(([, items]) => items.length > 1)
    .map(([accountId, items]) => ({ accountId, items }));
  console.log(JSON.stringify({
    summary: total.summary,
    total: total.total,
    returned: rows.length,
    calculated: rows.reduce((sum, row) => sum + row.contribution, 0),
    duplicates,
    rows
  }, null, 2));
  await db.query('rollback');
} catch (error) {
  await db.query('rollback').catch(() => {});
  throw error;
} finally {
  await db.end();
}
