import pg from 'pg';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
if(process.env.EMAIL_NOTIFICATIONS_ENABLED==='true')throw Error('Este instalador prepara el módulo con el envío desactivado.');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='60s'");
 await db.query("select pg_advisory_xact_lock(hashtextextended('activate-payment-notifications',0))");
 const installed=(await db.query("select to_regclass('public.comunicaciones_logs') is not null installed")).rows[0].installed;
 if(!installed)await db.query(await readFile(new URL('../supabase/migrations/20260920120000_supplier_payment_email_notifications.sql',import.meta.url),'utf8'));
 const checks=(await db.query("select to_regprocedure('public.payment_email_settings(text,jsonb)') is not null settings,to_regprocedure('public.payment_email_claim()') is not null worker,(select count(*)::int from pg_trigger where not tgisinternal and tgname in ('supplier_payment_email_event','supplier_payment_application_email_event','supplier_payment_withholding_email_event','supplier_advance_application_email_event','payment_request_email_event')) triggers,(select count(*)::int from comunicaciones_logs) queued,(select count(*)::int from configuraciones_correos where activo) active_templates")).rows[0];
 if(!checks.settings||!checks.worker||checks.triggers!==5)throw Error('Faltan componentes de la instalación.');
 if(!installed&&(checks.queued!==0||checks.active_templates!==0))throw Error('La instalación debe iniciar sin correos pendientes ni plantillas activas.');
 await db.query('commit');console.log(JSON.stringify({installed:true,alreadyInstalled:installed,smtpEnabled:false,checks}));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
