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

const verification=`select
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='invoice' and column_name='unificar_lineas_pdf_descripcion') description_column,
  to_regprocedure('public.save_sales_invoice_before_pdf_description(jsonb,bigint)') is not null save_wrapper,
  to_regprocedure('public.set_sales_invoice_pdf_presentation(bigint,boolean,text)') is not null preference_rpc,
  position('unifiedLineDescription' in pg_get_functiondef('public.sales_invoice_delivery_snapshot(bigint)'::regprocedure))>0 snapshot_description,
  not exists(select 1 from public.invoice where nullif(btrim(unificar_lineas_pdf_descripcion),'') is null) historical_values`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const installed=(await db.query("select to_regprocedure('public.set_sales_invoice_pdf_presentation(bigint,boolean,text)') is not null value")).rows[0].value;
  if(!installed){
    await db.query(await readFile(new URL('../supabase/migrations/20261018090000_sales_invoice_unified_pdf_description.sql',import.meta.url),'utf8'));
  }
  const check=(await db.query(verification)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('La descripción del PDF unificado no quedó instalada correctamente.');
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
