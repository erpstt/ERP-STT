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
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_country_id') country_column,
  position('save_sales_note_before_service_country_fix' in pg_get_functiondef('public.save_sales_note(text,jsonb,bigint)'::regprocedure))>0 country_wrapper`;
const verification=`select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_note_line' and column_name='service_country_id') country_column,
  position('save_sales_note_before_service_country_fix' in pg_get_functiondef('public.save_sales_note(text,jsonb,bigint)'::regprocedure))>0 country_wrapper,
  not exists(select 1 from public.sales_note_line where service_country_id is null) historical_backfill`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const before=(await db.query(installationCheck)).rows[0];
  const installed=before.country_column&&before.country_wrapper;
  if(!installed){
    await db.query(await readFile(
      new URL('../supabase/migrations/20261001120000_add_sales_note_service_country.sql',import.meta.url),'utf8'
    ));
  }
  const check=(await db.query(verification)).rows[0];
  if(Object.values(check).some(value=>value!==true)){
    throw Error('No se pudo verificar País de servicio en las notas de ventas.');
  }
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
