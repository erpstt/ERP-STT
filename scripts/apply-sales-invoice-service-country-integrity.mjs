import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const installationCheck=`select
  to_regprocedure('public.save_sales_invoice_before_service_country_integrity(jsonb,bigint)') is not null wrapper`;
const verification=`select
  to_regprocedure('public.save_sales_invoice_before_service_country_integrity(jsonb,bigint)') is not null wrapper,
  position('save_sales_invoice_before_service_country_integrity' in pg_get_functiondef('public.save_sales_invoice(jsonb,bigint)'::regprocedure))>0 active_wrapper,
  not exists(select 1 from public.sales_invoice_line where service_country_id is null) historical_backfill`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const installed=(await db.query(installationCheck)).rows[0].wrapper;
  if(!installed){
    await db.query(await readFile(
      new URL('../supabase/migrations/20261001121000_enforce_sales_invoice_service_country.sql',import.meta.url),'utf8'
    ));
  }
  const check=(await db.query(verification)).rows[0];
  if(Object.values(check).some(value=>value!==true)){
    throw Error('No se pudo completar País de servicio en las facturas de venta.');
  }
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
