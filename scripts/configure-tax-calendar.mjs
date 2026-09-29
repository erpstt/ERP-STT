import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

process.loadEnvFile?.('.env');
const projectRef=new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const db=new pg.Client({
  host:process.env.SUPABASE_DB_HOST||'aws-0-us-east-1.pooler.supabase.com',
  port:Number(process.env.SUPABASE_DB_PORT||6543),database:'postgres',
  user:process.env.SUPABASE_DB_USER||`postgres.${projectRef}`,
  password:process.env.SUPABASE_DB_PASSWORD,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000
});
const value=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.value;
const migrationUrl=new URL('../supabase/migrations/20260927090000_tax_calendar.sql',import.meta.url);
const apply=process.argv.includes('--apply');

await db.connect();
try{
  await db.query("begin;set local lock_timeout='10s';set local statement_timeout='180s'");
  const installed=await value("select to_regprocedure('public.tax_calendar_manage(text,jsonb)') is not null value");
  if(!installed)await db.query(await readFile(migrationUrl,'utf8'));

  const context=(await db.query(`
    select u.user_id,u.email,ucs.session_id,ucs.subsidiary_id,au.id::text sub,r.role_id
    from user_company_sessions ucs
    join users u using(user_id)
    join user_role_sessions urs using(session_id,user_id)
    join roles r using(role_id)
    join auth.users au on lower(au.email)=lower(u.email)
    where lower(r.role_name)in('administrador','administrator','admin')and u.is_active
    order by ucs.selected_at desc limit 1
  `)).rows[0];
  assert.ok(context,'Se requiere una sesión activa con rol Administrador para validar el módulo.');
  const claims={sub:context.sub,email:context.email,session_id:context.session_id,role:'authenticated'};
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
  await db.query('set local role authenticated');
  const options=await value("select tax_calendar_manage('options','{}'::jsonb)value");
  assert.equal(options.permissions.view,true);assert.equal(options.permissions.manage,true);assert.equal(options.permissions.file,true);
  assert.ok(options.subsidiaries.length>0,'No hay subsidiarias autorizadas.');
  const sid=options.subsidiaries.find(item=>String(item.id)===String(context.subsidiary_id))?.id||options.subsidiaries[0].id;
  const obligationCatalogInstalled=await value("select to_regprocedure('public.tax_obligation_catalog_manage(text,jsonb)') is not null value");
  const taxTypeCode=obligationCatalogInstalled?options.taxTypes?.find(item=>(item.subsidiaryIds||[]).map(String).includes(String(sid)))?.code:'TEST-CALENDAR';
  assert.ok(taxTypeCode,'El país de la subsidiaria necesita al menos una obligación tributaria activa.');
  const eventId=randomUUID(),storagePath=`${sid}/${eventId}/${randomUUID()}-prueba.pdf`;
  const base={
    id:eventId,subsidiaryId:Number(sid),taxTypeCode,period:'2099-FY',dueDate:'2099-12-31',
    assignedUserId:Number(context.user_id),status:'pending',documentType:'file_upload',externalLink:null,filingDate:null,
    filingReferenceNumber:null,notes:'Prueba de integración reversible del calendario tributario.',
    followers:[{userId:Number(context.user_id),notificationChannel:'both'}],reminders:[{daysBeforeDue:0}],
    file:{name:'prueba.pdf',mimeType:'application/pdf',size:128,storagePath}
  };
  await db.query('savepoint fixtures');
  const saved=await value("select tax_calendar_manage('save',$1::jsonb)value",[base]);assert.equal(saved.id,eventId);
  const detail=await value("select tax_calendar_manage('get',jsonb_build_object('id',$1::text))value",[eventId]);
  assert.equal(detail.event.id,eventId);assert.equal(detail.document.fileName,'prueba.pdf');assert.equal(detail.followers.length,1);assert.equal(detail.reminders.length,1);
  const document=await value('select tax_calendar_document($1)value',[eventId]);assert.equal(document.storagePath,storagePath);
  const listing=await value("select tax_calendar_manage('list',jsonb_build_object('subsidiaryId',$1::text,'dateFrom','2000-01-01','dateTo','2100-12-31'))value",[sid]);
  assert.ok(listing.events.some(item=>item.id===eventId));assert.ok(Number(listing.metrics.pending)>=1);

  await db.query('savepoint missing_filing');
  let filingRejected=false;
  try{await db.query("select tax_calendar_manage('save',$1::jsonb)",[JSON.stringify({...base,status:'filed',filingDate:null,file:undefined})]);}
  catch(error){filingRejected=/fecha real de presentación/i.test(error.message);await db.query('rollback to savepoint missing_filing');}
  assert.equal(filingRejected,true,'El estado filed debe exigir fecha de presentación.');

  const filedAt=new Date().toISOString();
  const filed=await value("select tax_calendar_manage('save',$1::jsonb)value",[{...base,status:'filed',filingDate:filedAt,filingReferenceNumber:'RAD-TEST',file:undefined}]);
  assert.equal(filed.id,eventId);
  await value("select tax_calendar_manage('save',$1::jsonb)value",[{...base,status:'pending',file:undefined}]);

  await db.query('savepoint raw_table');
  let rawDenied=false;
  try{await db.query('select count(*)from tax_calendar_events');}
  catch(error){rawDenied=error.code==='42501';await db.query('rollback to savepoint raw_table');}
  assert.equal(rawDenied,true,'Las tablas tributarias no deben admitir lectura directa autenticada.');

  await db.query('savepoint unauthorized_schedule');
  let workerDenied=false;
  try{await db.query('select tax_calendar_schedule()');}
  catch(error){workerDenied=error.code==='42501';await db.query('rollback to savepoint unauthorized_schedule');}
  assert.equal(workerDenied,true,'El scheduler debe ser exclusivo de service_role.');

  await db.query('reset role');
  await db.query("update tax_calendar_events set status='exempt' where id<>$1 and status not in('filed','exempt')",[eventId]);
  await db.query("update tax_calendar_email_outbox set status='ERROR',last_error='Aislado temporalmente por prueba con rollback',finished_at=now() where status='PENDIENTE'");
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
  await db.query('set local role service_role');
  const scheduled=await value("select tax_calendar_schedule('2099-12-31 18:00:00+00'::timestamptz)value");assert.equal(Number(scheduled.scheduled),1);
  await value("select tax_calendar_schedule('2099-12-31 18:00:00+00'::timestamptz)value");
  const deliveryCounts=(await db.query('select(select count(*)from tax_calendar_notifications where event_id=$1)::int notifications,(select count(*)from tax_calendar_email_outbox where event_id=$1)::int emails',[eventId])).rows[0];
  assert.equal(deliveryCounts.notifications,1);assert.equal(deliveryCounts.emails,1);
  const job=await value('select tax_calendar_claim()value');assert.equal(job.event_id,eventId);assert.ok(job.lease);
  assert.equal(await value('select tax_calendar_begin_send($1,$2)value',[job.id,job.lease]),true);
  assert.equal(await value("select tax_calendar_finish($1,$2,'ENVIADO','test-message',null)value",[job.id,job.lease]),true);

  await db.query('reset role');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
  await db.query('set local role authenticated');
  const withNotice=await value("select tax_calendar_manage('list',jsonb_build_object('subsidiaryId',$1::text,'dateFrom','2000-01-01','dateTo','2100-12-31'))value",[sid]);
  const fixtureNotices=withNotice.notifications.filter(item=>!item.readAt&&item.eventId===eventId);
  assert.equal(fixtureNotices.length,1);
  await value("select tax_calendar_manage('mark-read',jsonb_build_object('ids',jsonb_build_array($1::text)))value",[fixtureNotices[0].id]);

  await db.query('savepoint tenant_isolation');
  await db.query('reset role');
  await db.query('delete from user_subsidiaries where user_id=$1 and subsidiary_id=$2',[context.user_id,sid]);
  await db.query('set local role authenticated');
  let tenantDenied=false;
  try{await db.query("select tax_calendar_manage('list',jsonb_build_object('subsidiaryId',$1::text))",[sid]);}
  catch(error){tenantDenied=error.code==='42501';await db.query('rollback to savepoint tenant_isolation');}
  assert.equal(tenantDenied,true,'La función debe rechazar una subsidiaria retirada del vector del usuario.');

  const removed=await value("select tax_calendar_manage('delete',jsonb_build_object('id',$1::text))value",[eventId]);
  assert.equal(removed.obsoleteStoragePath,storagePath);
  await db.query('rollback to savepoint fixtures');
  await db.query(apply&&!installed?'commit':'rollback');
  console.log(JSON.stringify({
    applied:apply&&!installed,permissions:true,tenantIsolation:true,rlsDirectAccessDenied:true,
    createEditFileAndDelete:true,filedValidation:true,remindersIdempotent:true,inAppNotification:true,emailLease:true,
    bucket:'tax-calendar',fixturesRolledBack:true
  }));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
