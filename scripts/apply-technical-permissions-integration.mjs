import{readFile}from'node:fs/promises';import pg from'pg';
process.loadEnvFile?.('.env');const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:process.env.SUPABASE_DB_NAME||'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const sql=await readFile(new URL('../supabase/migrations/20261012130000_secure_and_integrate_technical_permissions.sql',import.meta.url),'utf8');
await client.connect();try{await client.query('begin');await client.query(sql);await client.query('commit');console.log('Catálogo técnico y acciones especiales activados correctamente.')}catch(error){await client.query('rollback').catch(()=>{});throw error}finally{await client.end()}
