import pg from 'pg';
import {readFile}from'node:fs/promises';
if(process.loadEnvFile)process.loadEnvFile('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();try{const sql=await readFile(new URL('../supabase/migrations/20260902150000_manage_bank_deposits.sql',import.meta.url),'utf8');await client.query(sql);const check=await client.query("select proname from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname in('bank_deposit_report','bank_deposit_detail','update_bank_deposit','delete_bank_deposit')");if(check.rowCount!==4)throw Error('No se crearon todas las funciones de administración de depósitos.');console.log('Migración aplicada: listar, ver, editar y eliminar depósitos disponibles.')}finally{await client.end()}
