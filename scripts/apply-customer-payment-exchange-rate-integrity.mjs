import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

await db.connect();
try{
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20261026140000_customer_payment_exchange_rate_integrity.sql',import.meta.url),'utf8'));
  const check=(await db.query(`select
    to_regprocedure('public.customer_payment_official_exchange_rate(bigint,date)')is not null rate_resolver,
    to_regprocedure('public.save_customer_payment_before_fx_guard(jsonb,bigint)')is not null payment_inner,
    to_regprocedure('public.save_customer_payment_with_advances_before_fx_guard(jsonb,bigint)')is not null advances_inner,
    position('customer_payment_official_exchange_rate' in pg_get_functiondef('public.save_customer_payment(jsonb,bigint)'::regprocedure))>0 payment_guard,
    position('customer_payment_official_exchange_rate' in pg_get_functiondef('public.save_customer_payment_with_advances(jsonb,bigint)'::regprocedure))>0 advances_guard`)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error(`No se pudo verificar la instalación: ${JSON.stringify(check)}`);
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{await db.end();}
