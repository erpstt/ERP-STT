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
  const tables = await client.query(`
    select to_regclass('public.supplier_invoice_withholding') invoice_table,
      to_regclass('public.supplier_payment_withholding') payment_table
  `);
  const columns = await client.query(`
    select count(*)::int count from information_schema.columns
    where table_schema='public' and table_name='supplier_invoice'
      and column_name in ('subtotal_amount','tax_total','withholding_total','payable_amount')
  `);
  const invalid = await client.query(`
    select count(*)::int count from supplier_invoice_withholding w
    join tax_codes tc using(tax_code_id) join tax_types tt using(tax_type_id)
    where not tc.is_withholding or tt.applies_to not in ('Compras','Ambos')
      or w.application_moment not in ('Al registrar la factura','Al aplicar el pago')
      or w.liability_account_id is distinct from tt.liability_account_id
  `);
  const definitions = await client.query(`
    select string_agg(pg_get_functiondef(p.oid), E'\n') definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('save_supplier_invoice','save_supplier_payment','save_supplier_payment_with_advances')
  `);
  const syncDefinition = await client.query(`
    select pg_get_functiondef(p.oid) definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='sync_journal_gl_impacts'
    limit 1
  `);
  const definition = definitions.rows[0].definition || '';
  const sync = syncDefinition.rows[0]?.definition || '';
  if (!tables.rows[0].invoice_table || !tables.rows[0].payment_table || columns.rows[0].count !== 4 || invalid.rows[0].count || !definition.includes('supplier_payment_withholding') || !definition.includes('supplier_invoice_withholding') || !sync.includes("not like 'Retención %'")) {
    throw new Error('La configuración contable de retenciones de proveedores no está completa.');
  }
  console.log('PASS: cálculo, trazabilidad y contabilización de retenciones instalados correctamente.');
} finally {
  await client.end();
}
