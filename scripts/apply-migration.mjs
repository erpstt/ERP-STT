import fs from 'node:fs';import pg from 'pg';
process.loadEnvFile('.env');const file=process.argv[2];if(!file)throw Error('Indique la migración.');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0],client=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:6543,database:'postgres',user:`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false}});
await client.connect();await client.query(fs.readFileSync(file,'utf8'));console.log(`Aplicada: ${file}`);await client.end();

