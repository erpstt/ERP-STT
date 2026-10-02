import pg from 'pg';
import { readFile } from 'node:fs/promises';

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
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  await db.query(await readFile(new URL('../supabase/migrations/20261001090000_add_pending_journal_service_country.sql',import.meta.url),'utf8'));
  const check=(await db.query(`select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='journal_line' and column_name='service_country_id') column_installed,
    exists(select 1 from pg_indexes where schemaname='public' and indexname='journal_line_service_country_idx') index_installed,
    position('service_country_id' in pg_get_functiondef('public.create_journal_entry(jsonb)'::regprocedure))>0 create_persistence,
    position('service_country_id' in pg_get_functiondef('public.update_journal_entry(bigint,jsonb)'::regprocedure))>0 update_persistence,
    position('pais_servicio' in pg_get_functiondef('public.journal_csv_dimensions(jsonb)'::regprocedure))>0 csv_support`)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('No se pudo verificar completamente País de servicio en ASI_PEN.');
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check}));
}catch(error){
  try{await db.query('rollback')}catch{}
  throw error;
}finally{
  await db.end();
}
