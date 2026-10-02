import pg from 'pg';
import {readFile} from 'node:fs/promises';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

const statusSql=`select
  to_regclass('public.quadratic_bank_reconciliations') is not null header_table,
  to_regclass('public.quadratic_reconciliation_items') is not null item_table,
  to_regprocedure('public.quadratic_reconciliation_options()') is not null options_rpc,
  to_regprocedure('public.quadratic_reconciliation_get(bigint)') is not null detail_rpc,
  to_regprocedure('public.quadratic_reconciliation_transition(bigint,text)') is not null workflow_rpc,
  exists(select 1 from public.permissions where code='BANK_QUADRATIC_VIEW') view_permission,
  exists(select 1 from public.permissions where code='BANK_QUADRATIC_MANAGE') manage_permission,
  exists(select 1 from public.permissions where code='BANK_QUADRATIC_APPROVE') approve_permission`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='10s'; set local statement_timeout='120s'");
  const before=(await db.query(statusSql)).rows[0];
  const installed=Object.values(before).every(Boolean);
  if(!installed){
    const migration=await readFile(new URL('../supabase/migrations/20261001140000_quadratic_bank_reconciliation.sql',import.meta.url),'utf8');
    await db.query(migration);
  }
  const monthlyFilter=await readFile(new URL('../supabase/migrations/20261002090000_quadratic_list_month_filter.sql',import.meta.url),'utf8');
  await db.query(monthlyFilter);
  const exportHeader=await readFile(new URL('../supabase/migrations/20261002100000_quadratic_export_header.sql',import.meta.url),'utf8');
  await db.query(exportHeader);
  const check=(await db.query(statusSql)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('No fue posible verificar la instalación completa de la conciliación cuadrática.');
  const listDefinition=(await db.query("select pg_get_functiondef('public.quadratic_reconciliation_list(jsonb)'::regprocedure) definition")).rows[0].definition;
  if(!listDefinition.replace(/\s+/g,'').includes('r.period_month=mo'))throw Error('No fue posible verificar el filtro mensual de conciliaciones.');
  const detailDefinition=(await db.query("select pg_get_functiondef('public.quadratic_reconciliation_get(bigint)'::regprocedure) definition")).rows[0].definition;
  if(!detailDefinition.includes('ledgerAccountNumber')||!detailDefinition.includes('bankAccountNumber'))throw Error('No fue posible verificar el encabezado profesional de exportación.');
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,monthlyFilter:true,professionalExportHeader:true,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
