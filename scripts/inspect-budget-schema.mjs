import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 console.log(JSON.stringify((await db.query("select (select count(*) from budget)legacy_headers,(select count(*) from budget_line)legacy_lines,to_regclass('public.presupuestos_encabezado')new_table")).rows));
}finally{await db.end()}
