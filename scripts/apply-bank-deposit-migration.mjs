import pg from 'pg';
import {readFile}from'node:fs/promises';
if(process.loadEnvFile)process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||`db.${ref}.supabase.co`,port:Number(process.env.SUPABASE_DB_PORT||5432),database:'postgres',user:process.env.SUPABASE_DB_USER||'postgres',password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{const sql=await readFile(new URL('../supabase/migrations/20260902130000_bank_deposit_transaction.sql',import.meta.url),'utf8');await client.query(sql);const check=await client.query("select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='save_bank_deposit'");if(!check.rowCount)throw Error('La función save_bank_deposit no fue creada.');console.log(`Migración aplicada. Función verificada: ${check.rows[0].signature}`)}finally{await client.end()}
