import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 console.log(JSON.stringify((await db.query("select account_id,account_number,account_name,account_group_id,category from chart_accounts where account_number in ('614014','622005','614015') or account_name ilike '%deducib%' order by account_number")).rows));
 console.log(JSON.stringify((await db.query("select group_id,group_code,group_name,parent_id,level,category from account_group where category='Gasto' order by group_code")).rows));
 console.log(JSON.stringify((await db.query("select table_name,column_name,column_default,is_nullable from information_schema.columns where table_schema='public' and table_name in('account_group','chart_accounts','account_subsidiaries') order by table_name,ordinal_position")).rows));
}finally{await db.end()}
