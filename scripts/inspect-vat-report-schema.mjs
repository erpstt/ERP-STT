import pg from 'pg';

if (process.loadEnvFile) process.loadEnvFile('.env');
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT || 6543),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD || process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const tables = [
  'subsidiaries','countries','currencies','status','transaction','journal',
  'invoice','sales_invoice_line','credit_note','debit_note','sales_note_line',
  'supplier_invoice','supplier_invoice_line','supplier_credit_note','supplier_debit_note','supplier_note_line',
  'tax_types','tax_codes','tax_code_subsidiaries',
  'sales_invoice_withholding','customer_payment_withholding','customer_payment',
  'supplier_invoice_withholding','supplier_payment_withholding','supplier_payment',
];

await client.connect();
try {
  const columns = await client.query(`
    select table_name,column_name,data_type,is_nullable
    from information_schema.columns
    where table_schema='public' and table_name=any($1)
    order by array_position($1::text[],table_name),ordinal_position
  `,[tables]);
  const grouped = {};
  for (const row of columns.rows) (grouped[row.table_name] ||= []).push(`${row.column_name}:${row.data_type}${row.is_nullable==='NO'?'!':''}`);
  console.log(JSON.stringify(grouped,null,2));

  const tax = await client.query(`
    select tc.tax_code_id,tc.code_name,tc.rate_percentage,tc.is_withholding,
           tt.type_name,tt.applies_to,c.country_code_iso3 country_code,c.name country_name,
           array_remove(array_agg(distinct coalesce(tcs.subsidiary_id,tc.subsidiary_id)),null) subsidiaries
    from tax_codes tc join tax_types tt using(tax_type_id) join countries c on c.country_id=tc.country_id
    left join tax_code_subsidiaries tcs using(tax_code_id)
    group by tc.tax_code_id,tt.type_name,tt.applies_to,c.country_code_iso3,c.name
    order by c.country_code_iso3,tc.is_withholding,tc.rate_percentage,tc.code_name
  `);
  console.log('TAX_CODES');
  console.log(JSON.stringify(tax.rows,null,2));

  const counts = await client.query(`
    select
      (select count(*) from invoice) sales_invoices,
      (select count(*) from sales_invoice_line) sales_lines,
      (select count(*) from credit_note) sales_credits,
      (select count(*) from debit_note) sales_debits,
      (select count(*) from supplier_invoice) purchase_invoices,
      (select count(*) from supplier_invoice_line) purchase_lines,
      (select count(*) from supplier_credit_note) purchase_credits,
      (select count(*) from supplier_debit_note) purchase_debits
  `);
  console.log('COUNTS');
  console.log(JSON.stringify(counts.rows[0],null,2));

  const partyColumns = await client.query(`
    select table_name,column_name,data_type
    from information_schema.columns
    where table_schema='public' and table_name in ('customers','suppliers')
    order by table_name,ordinal_position
  `);
  console.log('PARTY_COLUMNS');
  console.log(JSON.stringify(partyColumns.rows,null,2));

  const statuses = await client.query(`
    select s.code,s.name,s.module,count(*)::int document_count
    from "transaction" t join status s using(status_id)
    where t.transaction_type_id in(select transaction_type_id from transaction_types where abbreviation in('FAC_VEN','NC_VEN','ND_VEN','FAC_PRO','NC_PRO','ND_PRO'))
    group by s.code,s.name,s.module order by s.code
  `);
  console.log('DOCUMENT_STATUSES');
  console.log(JSON.stringify(statuses.rows,null,2));

  const samples = await client.query(`
    select 'SALE_INVOICE' kind,i.invoice_id id,i.invoice_number document_number,i.invoice_date document_date,
           i.subsidiary_id,i.currency_id,i.exchange_rate,j.status journal_status,s.code transaction_status,
           l.line_id,l.tax_code_id,l.tax_rate,l.amount,l.tax_amount,l.gross_amount
    from invoice i join sales_invoice_line l using(invoice_id)
    left join journal j on j.journal_id=i.journal_id left join "transaction" t on t.transaction_id=i.transaction_id left join status s using(status_id)
    union all
    select 'PURCHASE_INVOICE',i.invoice_id,i.invoice_number,i.invoice_date,i.subsidiary_id,i.currency_id,i.exchange_rate,j.status,s.code,
           l.line_id,l.tax_code_id,l.tax_rate,l.amount,l.tax_amount,l.gross_amount
    from supplier_invoice i join supplier_invoice_line l using(invoice_id)
    left join journal j on j.journal_id=i.journal_id left join "transaction" t on t.transaction_id=i.transaction_id left join status s using(status_id)
    order by document_date desc,kind limit 40
  `);
  console.log('LINE_SAMPLES');
  console.log(JSON.stringify(samples.rows,null,2));
} finally {
  await client.end();
}
