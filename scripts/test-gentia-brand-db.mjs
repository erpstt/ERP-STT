import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,
  password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

const file=new URL('../supabase/migrations/20260929110000_gentia_brand_refresh.sql',import.meta.url);
const source=(await readFile(file,'utf8')).replace(/^\s*begin;\s*/i,'').replace(/\s*commit;\s*$/i,'');
const verifyOnly=process.argv.includes('--verify-only');
try{
  await client.connect();
  if(!verifyOnly){
    await client.query('begin');
    await client.query(source);
  }
  const tax=await client.query("select count(*)::int n from public.tax_calendar_email_templates where body_template like '%NEXO ERP%'");
  const pdf=await client.query("select count(*)::int n from public.pdf_templates where is_system and (visual_schema::text like '%NEXO ERP%' or visual_schema::text like '%#123047%')");
  const functions=await client.query("select pg_get_functiondef('public.wf_notify_level(bigint)'::regprocedure)||pg_get_functiondef('public.resolve_audit_actor()'::regprocedure) definition");
  assert.equal(tax.rows[0].n,0);
  assert.equal(pdf.rows[0].n,0);
  assert.match(functions.rows[0].definition,/GENTIA|Gentia/);
  assert.doesNotMatch(functions.rows[0].definition,/\bNEXO\b|\bNexo\b/);
  if(!verifyOnly)await client.query('rollback');
  console.log(JSON.stringify({passed:true,rolledBack:!verifyOnly,persisted:verifyOnly,taxTemplates:true,pdfTemplates:true,systemFunctions:true}));
}catch(error){
  if(!verifyOnly)await client.query('rollback').catch(()=>{});
  throw error;
}finally{
  await client.end().catch(()=>{});
}
