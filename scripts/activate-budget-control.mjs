import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
if(!process.argv.includes('--apply'))throw Error('Use --apply to install the tested budget migration.');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 const existing=(await db.query("select to_regclass('public.presupuestos_encabezado') present")).rows[0].present;
 if(existing)throw Error('Budget schema already exists; inspect its version before applying changes.');
 await db.query(await readFile(new URL('../supabase/migrations/20260921120000_budget_control.sql',import.meta.url),'utf8'));
 const check=(await db.query("select (select count(*)from presupuestos_encabezado)headers,(select count(*)from permissions where code like 'BUDGET_%')permissions,has_function_privilege('authenticated','public.save_supplier_invoice_without_withholding(jsonb,bigint)','EXECUTE')bypass")).rows[0];
 if(Number(check.headers)!==0||Number(check.permissions)!==5||check.bypass)throw Error('Activation checks failed.');
 await db.query('commit');console.log(JSON.stringify({installed:true,approvedBudgets:0,permissions:5}));
}catch(e){await db.query('rollback').catch(()=>{});throw e;}finally{await db.end();}
