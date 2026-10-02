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

const statusSql=`select
  to_regprocedure('public.purchase_transaction_support(bigint)') is not null support_reader,
  coalesce(position('support_count' in pg_get_functiondef(to_regprocedure('public.run_purchase_transaction_report(jsonb)')))>0,false) report_metadata`;

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const before=(await db.query(statusSql)).rows[0];
  const installed=before.support_reader&&before.report_metadata;
  if(!installed){
    const sql=await readFile(new URL('../supabase/migrations/20261001130000_purchase_transaction_cost_centers_supports.sql',import.meta.url),'utf8');
    await db.query(sql);
  }
  const check=(await db.query(statusSql)).rows[0];
  if(!check.support_reader||!check.report_metadata)throw Error('No se pudo verificar el acceso a respaldos del reporte de compras.');
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){await db.query('rollback').catch(()=>{});throw error}
finally{await db.end()}
