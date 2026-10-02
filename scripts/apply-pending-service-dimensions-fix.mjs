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

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  await db.query(await readFile(new URL('../supabase/migrations/20261001100000_fix_pending_service_dimensions.sql',import.meta.url),'utf8'));
  const check=(await db.query(`select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='journal_line' and column_name='service_month') month_column,
    position('service_month' in pg_get_functiondef('public.create_journal_entry(jsonb)'::regprocedure))>0 create_month,
    position('service_month' in pg_get_functiondef('public.update_journal_entry(bigint,jsonb)'::regprocedure))>0 update_month,
    position('service_month' in pg_get_functiondef('public.reverse_pending_invoice_journal(bigint,jsonb)'::regprocedure))>0 reversal_month,
    position('service_country_id' in pg_get_functiondef('public.reverse_pending_invoice_journal(bigint,jsonb)'::regprocedure))>0 reversal_country,
    not exists(
      select 1 from journal_line line join journal entry using(journal_id)
      where (entry.journal_type='Asientos Pendientes de Facturar' or entry.journal_number like 'ASI_PEN-%')
        and line.service_month is null
    ) pending_backfill,
    not exists(
      select 1 from journal_line line join journal entry using(journal_id)
      where entry.journal_type='Reversión de Pendiente de Facturar'
        and (line.service_month is null or line.service_country_id is null)
    ) reversal_backfill`)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('No se pudo verificar completamente Mes y País de servicio.');
  await db.query('commit');
  console.log(JSON.stringify({applied:true,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{await db.end()}
