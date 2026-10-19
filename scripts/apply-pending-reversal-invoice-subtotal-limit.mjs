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

const migration=await readFile(
  new URL('../supabase/migrations/20261019090000_pending_reversal_invoice_subtotal_limit.sql',import.meta.url),
  'utf8'
);

await db.connect();
try{
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='90s'");
  const installed=(await db.query(`select
    to_regprocedure('public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(bigint,jsonb)') is not null value`)).rows[0].value;
  if(!installed)await db.query(migration);
  const check=(await db.query(`select
    to_regprocedure('public.pending_invoice_reversal_options_before_invoice_subtotal_limit(bigint,date)') is not null options_wrapper,
    to_regprocedure('public.reverse_pending_invoice_journal_before_invoice_subtotal_limit(bigint,jsonb)') is not null reversal_wrapper,
    position('subtotal' in pg_get_functiondef('public.pending_invoice_reversal_options(bigint,date)'::regprocedure))>0 options_subtotal,
    position('invoice_subtotal' in pg_get_functiondef('public.reverse_pending_invoice_journal(bigint,jsonb)'::regprocedure))>0 reversal_subtotal,
    position('already_applied' in pg_get_functiondef('public.validate_pending_reversal_invoice()'::regprocedure))>0 cumulative_guard`)).rows[0];
  if(Object.values(check).some(value=>value!==true))throw Error('El límite por subtotal de factura no quedó instalado correctamente.');
  await db.query('commit');
  console.log(JSON.stringify({applied:!installed,alreadyInstalled:installed,...check}));
}catch(error){
  await db.query('rollback').catch(()=>{});
  throw error;
}finally{
  await db.end();
}
