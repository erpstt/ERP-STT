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
  const table = await client.query(`select to_regclass('public.entity_withholding_rules') as name`);
  const obsoleteColumns = await client.query(`
    select count(*)::int as count from information_schema.columns
    where table_schema = 'public' and table_name in ('customers', 'suppliers')
      and column_name = 'withholding_tax_code_id'
  `);
  const invalid = await client.query(`
    select count(*)::int as count
    from public.entity_withholding_rules r
    join public.tax_codes tc on tc.tax_code_id = r.tax_code_id
    join public.tax_types tt on tt.tax_type_id = tc.tax_type_id
    where not tc.is_withholding
       or not exists (
         select 1 from public.tax_code_subsidiaries tcs
         where tcs.tax_code_id = r.tax_code_id and tcs.subsidiary_id = r.subsidiary_id
       )
       or (r.customer_id is not null and tt.applies_to not in ('Ventas', 'Ambos'))
       or (r.supplier_id is not null and tt.applies_to not in ('Compras', 'Ambos'))
       or (r.customer_id is not null and not exists (
         select 1 from public.entity_subsidiaries es
         where es.customer_id = r.customer_id and es.subsidiary_id = r.subsidiary_id
       ))
       or (r.supplier_id is not null and not exists (
         select 1 from public.entity_subsidiaries es
         where es.supplier_id = r.supplier_id and es.subsidiary_id = r.subsidiary_id
       ))
  `);
  const summary = await client.query(`
    select count(*)::int as rules,
      count(distinct subsidiary_id)::int as subsidiaries
    from public.entity_withholding_rules
  `);
  if (!table.rows[0].name || obsoleteColumns.rows[0].count || invalid.rows[0].count) {
    throw new Error('El modelo de retenciones por subsidiaria no es consistente.');
  }
  console.log(`PASS: ${summary.rows[0].rules} reglas válidas en ${summary.rows[0].subsidiaries} subsidiarias.`);
} finally {
  await client.end();
}
