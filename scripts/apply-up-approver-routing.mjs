import pg from 'pg';
import { readFile } from 'node:fs/promises';

if(process.loadEnvFile)process.loadEnvFile('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});

await client.connect();
try{
  const sql=await readFile(new URL('../supabase/migrations/20261004100000_up_approver_routing.sql',import.meta.url),'utf8');
  await client.query(sql);
  console.log(JSON.stringify({applied:true,module:'up-approver-routing'}));
}finally{await client.end();}
