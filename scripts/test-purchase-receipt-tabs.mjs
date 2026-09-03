import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const context = (await client.query(`
    select u.email, ucs.session_id
    from user_company_sessions ucs
    join users u using (user_id)
    order by ucs.selected_at desc
    limit 1
  `)).rows[0];
  await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(context)]);
  const report = (await client.query(
    `select purchase_document_report($1::jsonb) value`,
    [JSON.stringify({ type: 'RECEIPT', from: '2000-01-01', to: '2099-12-31' })],
  )).rows[0].value;
  const rows = report.rows || [];
  const invalid = rows.filter(row => typeof row.invoiced !== 'boolean');
  if (invalid.length) throw new Error('El reporte no devolvió un estado de facturación válido.');
  console.log(JSON.stringify({
    receipts: rows.length,
    pending: rows.filter(row => !row.invoiced).map(row => row.number),
    invoiced: rows.filter(row => row.invoiced).map(row => ({ receipt: row.number, invoice: row.invoiceNumber })),
    classification: true,
  }));
} finally {
  await client.end();
}
