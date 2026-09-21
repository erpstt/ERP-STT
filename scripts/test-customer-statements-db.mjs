import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
process.loadEnvFile?.('.env');
const ref=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',user:process.env.SUPABASE_DB_USER||`postgres.${ref}`,password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
try{
 await db.query('begin');await db.query("set local lock_timeout='5s';set local statement_timeout='90s'");
 if(!await value("select to_regprocedure('public.statement_claim()') is not null value"))await db.query(await readFile(new URL('../supabase/migrations/20260920140000_customer_statement_notifications.sql',import.meta.url),'utf8'));
 const context=(await db.query('select u.email,ucs.session_id,au.id sub from user_company_sessions ucs join users u using(user_id)join auth.users au on lower(au.email)=lower(u.email)order by selected_at desc limit 1')).rows[0];
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(context)]);
 const sid=await value('select active_subsidiary_id()value'),cutoff=await value("select to_char(now()at time zone 'America/Costa_Rica','YYYY-MM-DD')value");
 const customers=(await db.query('select customer_id from entity_subsidiaries where subsidiary_id=$1 and customer_id is not null',[sid])).rows;
 let seed;for(const c of customers){const snap=await value('select statement_snapshot($1,$2,$3)value',[sid,c.customer_id,cutoff]);if(snap.saldo_total>0){seed={id:c.customer_id,snap};break;}}
 assert.ok(seed,'Se requiere un cliente con saldo positivo para la prueba.');
 await db.query('savepoint invalid_email');
 await assert.rejects(db.query('update customers set envio_estado_cuenta_auto=true,email=null where customer_id=$1',[seed.id]),/customer_statement_email_required/);
 await db.query('rollback to savepoint invalid_email');
 await value("select statement_settings('save',$1::jsonb)value",[JSON.stringify({subject:'Estado {{cliente_nombre}}',body:'<p>Saldo {{saldo_total}}</p>',active:true})]);
 const paymentConfig=await value("select payment_email_settings('get')value");assert.ok(paymentConfig.template===null||paymentConfig.template.tipo_notificacion==='PAGO_PROVEEDOR');
 await db.query('update customers set envio_estado_cuenta_auto=true,email=$2 where customer_id=$1',[seed.id,'cliente@example.invalid']);
 const request='00000000-0000-4000-a000-000000000001';
 const sent=await value('select statement_send($1,$2,$3,$4)value',[seed.id,cutoff,'Nota de prueba',request]);assert.equal(sent.estado,'PENDIENTE');
 assert.equal((await value('select statement_send($1,$2,$3,$4)value',[seed.id,cutoff,'Nota de prueba',request])).id,sent.id);
 assert.equal(await value('select payment_email_claim()value'),null);
 const job=await value('select statement_claim()value');assert.equal(job.id,sent.id);assert.equal(job.payload.note,'Nota de prueba');assert.equal(job.payload.saldo_total,seed.snap.saldo_total);
 await value("select payment_email_finish($1,$2,'ENVIADO','mock-statement',null)value",[job.id,job.lease]);
 const details=await value('select statement_customer($1,$2)value',[seed.id,cutoff]);assert.equal(details.history[0].estado,'ENVIADO');
 await db.query('savepoint noaccess');await db.query("select set_config('request.jwt.claims','{}',true)");await assert.rejects(db.query('select statement_customer($1,$2)',[seed.id,cutoff]),/acceso/);await db.query('rollback to savepoint noaccess');
 assert.equal(await value("select has_function_privilege('authenticated','public.statement_schedule()','execute')value"),false);
 // Simulated first-of-month time is local to this rolled-back test; no SMTP transport is used.
 let definition=await value("select pg_get_functiondef('public.statement_schedule()'::regprocedure)value");
 definition=definition.replace("now()at time zone 'America/Costa_Rica'","timestamp '2026-10-01 08:00:00'");await db.query(definition);
 definition=await value("select pg_get_functiondef('public.statement_snapshot(bigint,bigint,date)'::regprocedure)value");definition=definition.replace("now()at time zone 'America/Costa_Rica'","timestamp '2026-10-01 08:00:00'");await db.query(definition);
 await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
 assert.ok(await value('select statement_schedule()value')>=1);assert.equal(await value('select statement_schedule()value'),0);
 const scheduled=await value("select payload value from comunicaciones_logs where customer_id=$1 and fingerprint='AUTO:2026-09-30'",[seed.id]);assert.equal(scheduled.automatic,true);
 await db.query(`create or replace function public.run_aging_report(p_kind text,p_filters jsonb default '{}')returns jsonb language sql stable as $$select jsonb_build_object('rows',(select jsonb_agg(jsonb_build_object('document_number','PAGE-'||n))from generate_series(((p_filters->>'page')::int-1)*250+1,least((p_filters->>'page')::int*250,501))n),'total',501,'summary',jsonb_build_object('netBalance',501,'subledger',501,'advances',0))$$`);
 const paged=await value('select statement_snapshot($1,$2,$3)value',[sid,seed.id,cutoff]);assert.equal(paged.rows.length,501);assert.equal(paged.rows.at(-1).document_number,'PAGE-501');
 await db.query('rollback');console.log(JSON.stringify({migration:true,emailRequired:true,sharedReport:true,allPages:true,templateIsolation:true,manualIdempotency:true,workerIsolation:true,history:true,monthlySchedule:true,scheduleDeduplication:true,accessControl:true,rollback:true,emailsSent:0}));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
