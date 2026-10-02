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
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_invoice_line' and column_name='service_month') invoice_column,
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_month') note_column,
  exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.proname in('save_sales_invoice','save_sales_invoice_before_service_country_integrity')
      and position('save_sales_invoice_before_service_month_fix' in pg_get_functiondef(proc.oid))>0) invoice_wrapper,
  exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.proname in('save_sales_note','save_sales_note_before_service_country_fix')
      and position('save_sales_note_before_service_month_fix' in pg_get_functiondef(proc.oid))>0) note_wrapper`;
const verification=`select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_invoice_line' and column_name='service_month') invoice_column,
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_month') note_column,
  exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.proname in('save_sales_invoice','save_sales_invoice_before_service_country_integrity')
      and position('save_sales_invoice_before_service_month_fix' in pg_get_functiondef(proc.oid))>0) invoice_wrapper,
  exists(select 1 from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.proname in('save_sales_note','save_sales_note_before_service_country_fix')
      and position('save_sales_note_before_service_month_fix' in pg_get_functiondef(proc.oid))>0) note_wrapper,
  not exists(select 1 from public.sales_invoice_line where service_month is null) invoice_backfill,
  not exists(select 1 from public.sales_note_line where service_month is null) note_backfill`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const before=(await db.query(installationCheck)).rows[0];
  const installed=before.invoice_column&&before.note_column&&before.invoice_wrapper&&before.note_wrapper;
  if(!installed){
    const migration=await readFile(
      new URL('../supabase/migrations/20261001110000_fix_sales_service_month.sql',import.meta.url),'utf8'
    );
    await db.query(migration);
  }
  const check=(await db.query(verification)).rows[0];
  if(Object.values(check).some(value=>value!==true)){
    throw Error('No se pudo verificar completamente el Mes de servicio de ventas.');
  }
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{await db.end()}
