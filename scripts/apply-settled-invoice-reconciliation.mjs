import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false}
});

await db.connect();
try{
  await db.query('begin');
  for(const migration of[
    '20260930163000_settled_sales_invoice_funding_breakdown.sql',
    '20260930163500_customer_receivable_application_guard.sql'
  ])await db.query(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8'));
  const check=(await db.query(`select
    position('customer_advance_application'in pg_get_functiondef('run_settled_sales_invoice_report(jsonb)'::regprocedure))>0 advance_breakdown,
    position('credit_note'in pg_get_functiondef('validate_customer_payment_application_receivable()'::regprocedure))>0 notes_in_payment_guard,
    exists(select 1 from pg_trigger where tgname='protect_customer_debit_note_balance_trigger'and not tgisinternal) debit_guard`)).rows[0];
  if(!check.advance_breakdown||!check.notes_in_payment_guard||!check.debit_guard)throw Error('La verificación posterior a la migración no fue satisfactoria.');
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check}));
}catch(error){try{await db.query('rollback')}catch{}throw error}
finally{await db.end()}
