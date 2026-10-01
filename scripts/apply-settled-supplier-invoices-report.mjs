import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260930165000_settled_supplier_invoices_report.sql',import.meta.url),'utf8'));
  const check=(await db.query(`with definitions as(
    select
      pg_get_functiondef('public.settled_supplier_invoice_report_options()'::regprocedure) options_definition,
      pg_get_functiondef('public.run_settled_supplier_invoice_report(jsonb)'::regprocedure) report_definition
  )select
    position('user_subsidiaries'in options_definition)>0 access_guard,
    position('payment_sources'in report_definition)>0 funding_allocation,
    position('exchangeDifferenceAmount'in report_definition)>0 exchange_difference,
    position('localSettlementBaseAmount'in report_definition)>0 local_currency_detail,
    exists(select 1 from pg_indexes where schemaname='public'and indexname='supplier_payment_application_settlement_idx') payment_index,
    exists(select 1 from pg_indexes where schemaname='public'and indexname='supplier_credit_note_settlement_idx') credit_note_index,
    exists(select 1 from pg_indexes where schemaname='public'and indexname='supplier_debit_note_settlement_idx') debit_note_index
  from definitions`)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('No se pudo verificar completamente el reporte de facturas de proveedor liquidadas.');
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check,accountingDataChanged:false}));
}catch(error){
  try{await db.query('rollback')}catch{}
  throw error;
}finally{
  await db.end();
}
