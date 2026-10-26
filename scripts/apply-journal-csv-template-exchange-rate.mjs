import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const password=process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD;
if(!process.env.SUPABASE_URL||!password){
  throw Error('Configure SUPABASE_URL y SUPABASE_DB_PASSWORD antes de aplicar la migración.');
}
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

await client.connect();
try{
  await client.query('begin');
  const sql=await readFile(new URL(
    '../supabase/migrations/20261026180000_journal_csv_template_exchange_rate.sql',
    import.meta.url
  ),'utf8');
  await client.query(sql);
  const definition=(await client.query(
    "select pg_get_functiondef('public.import_journal_csv(jsonb,boolean,bigint)'::regprocedure) definition"
  )).rows[0]?.definition||'';
  assert.ok(definition.includes('if rate<=0 then'),'La función no conserva la validación de tasa positiva.');
  assert.ok(!definition.includes('expected_rate'),'La función todavía consulta una tasa esperada.');
  assert.ok(!definition.includes('exchange_rates'),'La función todavía depende del catálogo de tasas.');
  assert.ok(!definition.includes('no coincide con la tasa configurada'),'La función todavía compara la tasa del archivo.');
  await client.query('commit');
  console.log(JSON.stringify({
    applied:true,
    csvExchangeRateIsAuthoritative:true,
    configuredRateLookupRemoved:true,
    positiveRateValidationPreserved:true
  }));
}catch(error){
  await client.query('rollback').catch(()=>{});
  throw error;
}finally{
  await client.end();
}
