import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD||process.env.PGPASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try {
  await db.query('begin');
  await db.query(await readFile(new URL('../supabase/migrations/20260909090000_fx_revaluation.sql',import.meta.url),'utf8'));
  if(process.argv.includes('--apply')){await db.query('commit');console.log('FX revaluation migration applied.');}
  else {
    if(process.argv.includes('--test')){const {testRevaluation}=await import('./fx-revaluation-tests.mjs');await testRevaluation(db);}
    await db.query('rollback');console.log('FX SQL verified. All test changes rolled back.');
  }
} catch(error){await db.query('rollback');throw error;}
finally{await db.end();}
