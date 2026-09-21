import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
if(process.env.EMAIL_NOTIFICATIONS_ENABLED==='true')throw Error('Este instalador prepara el módulo con el envío desactivado.');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");
 await db.query("select pg_advisory_xact_lock(hashtextextended('activate-customer-statements',0))");
 const installed=(await db.query("select to_regprocedure('public.statement_claim()') is not null installed")).rows[0].installed;
 if(!installed)await db.query(await readFile(new URL('../supabase/migrations/20260920140000_customer_statement_notifications.sql',import.meta.url),'utf8'));
 const checks=(await db.query("select to_regprocedure('public.statement_settings(text,jsonb)') is not null settings,to_regprocedure('public.statement_claim()') is not null worker,exists(select 1 from information_schema.columns where table_schema='public'and table_name='customers'and column_name='envio_estado_cuenta_auto') preference,(select count(*)::int from comunicaciones_logs where tipo_notificacion='ESTADO_CUENTA') queued,(select count(*)::int from configuraciones_correos where tipo_notificacion='ESTADO_CUENTA'and activo) active_templates")).rows[0];
 if(!checks.settings||!checks.worker||!checks.preference)throw Error('Faltan componentes de la instalación.');
 if(!installed&&(checks.queued!==0||checks.active_templates!==0))throw Error('La instalación debe comenzar con el envío desactivado.');
 await db.query('commit');console.log(JSON.stringify({installed:true,alreadyInstalled:installed,smtpEnabled:false,checks}));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
