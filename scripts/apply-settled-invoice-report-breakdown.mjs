import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false}});
await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260930163000_settled_sales_invoice_funding_breakdown.sql',import.meta.url),'utf8'));
  const check=(await db.query(`select position('customer_advance_application'in pg_get_functiondef('run_settled_sales_invoice_report(jsonb)'::regprocedure))>0 advance_breakdown`)).rows[0];
  if(!check.advance_breakdown)throw Error('No se pudo verificar el desglose de anticipos.');
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check,accountingDataChanged:false}));
}catch(error){try{await db.query('rollback')}catch{}throw error}
finally{await db.end()}
