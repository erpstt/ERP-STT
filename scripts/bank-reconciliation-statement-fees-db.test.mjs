import assert from 'node:assert/strict';
import pg from 'pg';

process.loadEnvFile?.('.env');

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

await db.connect();
try{
  const {rows:[installation]}=await db.query(`select
    to_regprocedure('public.register_bank_statement_fees(bigint,date,bigint[])')is not null batch_rpc,
    to_regprocedure('public.post_bank_fee_internal(jsonb,boolean)')is not null internal_poster,
    has_function_privilege(
      'authenticated',
      'public.register_bank_statement_fees(bigint,date,bigint[])',
      'execute'
    ) authenticated_can_batch,
    has_function_privilege(
      'authenticated',
      'public.save_bank_fee(jsonb)',
      'execute'
    ) manual_fee_still_available,
    not has_function_privilege(
      'authenticated',
      'public.post_bank_fee_internal(jsonb,boolean)',
      'execute'
    ) internal_not_exposed`);
  assert.deepEqual(installation,{
    batch_rpc:true,
    internal_poster:true,
    authenticated_can_batch:true,
    manual_fee_still_available:true,
    internal_not_exposed:true
  });

  const {rows:[definitions]}=await db.query(`select
    pg_get_functiondef(
      'public.register_bank_statement_fees(bigint,date,bigint[])'::regprocedure
    ) batch_definition,
    pg_get_functiondef(
      'public.post_bank_fee_internal(jsonb,boolean)'::regprocedure
    ) internal_definition,
    pg_get_functiondef('public.save_bank_fee(jsonb)'::regprocedure) manual_definition`);

  for(const expected of[
    /statement_date\s*=\s*p_cutoff/i,
    /statement_line\.amount\s*<\s*0/i,
    /reconciliation_status\s*=\s*'PENDIENTE'/i,
    /insert into public\.bank_reconciliation_match/i,
    /public\.post_bank_fee_internal\(jsonb_build_object/i,
    /\),\s*true\)/i
  ])assert.match(definitions.batch_definition,expected);
  assert.match(definitions.internal_definition,/p_allow_statement_overdraft/);
  assert.match(definitions.manual_definition,/post_bank_fee_internal\(p_payload,\s*false\)/);

  console.log('PASS: RPC de comisiones desde conciliacion instalado, privado y protegido contra duplicados.');
}finally{
  await db.end();
}
