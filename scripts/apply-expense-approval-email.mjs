import pg from 'pg';
import {readFile} from 'node:fs/promises';

if(process.loadEnvFile)process.loadEnvFile('.env');

const required=['SUPABASE_URL','SUPABASE_DB_PASSWORD'];
for(const name of required){
  if(!process.env[name])throw new Error(`Falta ${name} en el entorno.`);
}

const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),
  database:process.env.SUPABASE_DB_NAME||'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:15000
});

await db.connect();
try{
  const sql=await readFile(
    new URL('../supabase/migrations/20261005100000_expense_approval_email_notifications.sql',import.meta.url),
    'utf8'
  );
  await db.query(sql);

  const verification=(await db.query(`
    select
      to_regclass('public.expense_approval_email_outbox') is not null as outbox,
      to_regprocedure('public.expense_approval_email_settings(text,jsonb)') is not null as settings,
      to_regprocedure('public.expense_approval_email_claim()') is not null as claim,
      to_regprocedure('public.expense_approval_email_finish(uuid,uuid,text,text,text)') is not null as finish,
      (select count(*)::int from public.configuraciones_correos
        where tipo_notificacion='SOLICITUD_GASTO_APROBACION') as templates
  `)).rows[0];

  if(!verification.outbox||!verification.settings||!verification.claim||!verification.finish){
    throw new Error('La migración terminó sin instalar todos los objetos requeridos.');
  }

  console.log(JSON.stringify({
    applied:true,
    module:'expense-approval-email',
    templates:verification.templates,
    workerFunctions:true
  }));
}finally{
  await db.end();
}
