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
  const definitions = await client.query(`
    select p.proname,pg_get_functiondef(p.oid) definition
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('opening_date_hard_lock','prevent_before_opening_lock')
  `);
  const triggers = await client.query(`
    select count(*)::int count
    from pg_trigger
    where not tgisinternal
      and tgname in (
        'opening_lock_transaction',
        'opening_lock_invoice',
        'opening_lock_supplier_invoice',
        'opening_lock_purchase_document',
        'opening_lock_sales_document'
      )
  `);
  const sql = definitions.rows.map(row=>row.definition).join('\n');
  if (definitions.rowCount !== 2 || !definitions.rows.every(row=>row.definition.includes('to_jsonb(new)')) || sql.includes('new.invoice_date') || triggers.rows[0].count !== 5) {
    throw new Error(`Disparador incompleto: triggers=${triggers.rows[0].count}`);
  }
  console.log('PASS: ambos bloqueos de apertura usan campos seguros y conservan sus disparadores.');
} finally {
  await client.end();
}
