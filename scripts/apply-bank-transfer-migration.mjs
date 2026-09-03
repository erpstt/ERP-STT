import pg from 'pg';
import { readFile } from 'node:fs/promises';
if(process.loadEnvFile)process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();
try{const sql=await readFile(new URL('../supabase/migrations/20260902090000_bank_account_transfers.sql',import.meta.url),'utf8');await client.query(sql);console.log('Migración de transferencias bancarias aplicada correctamente.')}finally{await client.end()}
