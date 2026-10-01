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
  await db.query(await readFile(new URL('../supabase/migrations/20260930164000_customer_payment_edit_options.sql',import.meta.url),'utf8'));
  const check=(await db.query(`select
    to_regprocedure('public.customer_payment_edit_options(bigint)')is not null function_exists,
    position('currentApplied'in pg_get_functiondef('public.customer_payment_edit_options(bigint)'::regprocedure))>0 current_application_exposed,
    position('editableBalance'in pg_get_functiondef('public.customer_payment_edit_options(bigint)'::regprocedure))>0 editable_balance_exposed`)).rows[0];
  if(!check.function_exists||!check.current_application_exposed||!check.editable_balance_exposed){
    throw Error('No se pudo verificar la función de edición de cobros.');
  }
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check,accountingDataChanged:false}));
}catch(error){
  try{await db.query('rollback')}catch{}
  throw error;
}finally{
  await db.end();
}
