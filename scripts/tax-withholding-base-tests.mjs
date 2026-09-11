import pg from 'pg';

process.loadEnvFile('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
try {
  const columns = await client.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_codes'
      and column_name in ('withholding_calculation_base', 'withholding_application_moment')
  `);
  const invalid = await client.query(`
    select count(*)::int as count from public.tax_codes
    where (is_withholding and (
      withholding_calculation_base not in ('Subtotal antes de impuestos', 'Importe de impuestos', 'Total de la factura con impuestos')
      or withholding_application_moment not in ('Al registrar la factura', 'Al aplicar el pago')
    )) or (not is_withholding and (
      withholding_calculation_base is not null or withholding_application_moment is not null
    ))
  `);
  const summary = await client.query(`
    select count(*) filter (where is_withholding)::int as withholding,
      count(*) filter (where is_withholding and withholding_calculation_base is not null
        and withholding_application_moment is not null)::int as configured
    from public.tax_codes
  `);
  if (columns.rowCount !== 2 || invalid.rows[0].count) {
    throw new Error('La configuración de retenciones no es consistente.');
  }
  console.log(`PASS: campos instalados; ${summary.rows[0].configured}/${summary.rows[0].withholding} códigos de retención tienen configuración válida.`);
} finally {
  await client.end();
}
