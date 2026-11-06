import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupPaymentRequestApprovalReminder,applyPaymentRequestApprovalReminder,assumeReminderActor,assumeReminderService}from'./fixtures/setup-payment-request-approval-reminder.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const originalDateNow=Date.now,fixtureNow=Date.parse('2030-01-07T12:00:00Z');
let fixtureClockNow=fixtureNow;
const assume=(...args)=>assumeReminderActor(db,...args),service=()=>assumeReminderService(db);
const draft={type:'OTROS',currencyId:1,plannedDate:'2026-11-30',concept:'Synthetic approval reminder',lines:[{accountId:203,entityType:'Proveedor',entityId:10,departmentId:21,concept:'Synthetic expense',amount:50.123456}]};
let functionsBefore,triggersBefore,backlogId,activation;
const oldFunctions=async()=>(await db.query("select oid,oid::regprocedure::text signature,md5(prosrc) hash,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid=any($1::oid[])order by oid",[functionsBefore?.map(x=>x.oid)??(await db.query("select oid from pg_proc where pronamespace not in('pg_catalog'::regnamespace,'information_schema'::regnamespace)and pronamespace::regnamespace::text not like 'pg_%'")).rows.map(x=>x.oid)])).rows;
const oldTriggers=async()=>(await db.query("select oid,tgfoid,tgtype,tgdeferrable,tginitdeferred,pg_get_triggerdef(oid)definition from pg_trigger where not tgisinternal and tgname not like 'payment_reminder_%' order by oid")).rows;
async function detail(id){return q('select pr_detail($1)d',[{id}]);}
async function transition(id,action){const h=(await detail(id)).header;return q('select pr_transition($1)d',[{id,version:h.version,transition:action,reason:action==='REJECT'?'Synthetic rejection':null}]);}
async function pending(p=draft){const r=await q('select pr_save($1)d',[p]);await transition(r.id,'SUBMIT');return r.id;}
async function tx(t,preserveBacklog=false){fixtureClockNow=fixtureNow;await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));if(!preserveBacklog)await db.query('update payment_request_reminder_private.current_stage set active=false where request_id=$1',[backlogId]);await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),error=>error.code===code);}finally{await db.exec('rollback to denial;release denial');}}
async function rows(id){await db.exec('reset role');return(await db.query('select *from payment_request_approval_reminder_email_outbox where request_id=$1 order by created_at,id',[id])).rows;}
async function stage(id){await db.exec('reset role');return(await db.query('select *from payment_request_reminder_private.current_stage where request_id=$1 order by instance_id desc limit 1',[id])).rows[0];}
async function collectAt(value='2030-01-07T12:00:00Z'){
 await db.exec('reset role');return q('select payment_request_reminder_private.collect_at($1::timestamptz)d',[value]);
}
async function ready(id,at='2030-01-07T12:00:00Z'){
 const s=await stage(id);await db.query("update payment_request_reminder_private.current_stage set assigned_at=$1::timestamptz-interval'4000 days',next_collect_at=$1::timestamptz where instance_id=$2",[at,s.instance_id]);
 await collectAt(at);return(await rows(id)).find(x=>x.status==='PENDIENTE');
}
async function claimAt(at='2030-01-07T12:00:00Z'){await db.exec('reset role');return q('select payment_request_reminder_private.claim_at($1::timestamptz)d',[at]);}
before(async()=>{
 // PGlite's real clock_timestamp() reads Date.now. Keep public authorize/finish
 // on the same known weekday as claimAt, independent of the day CI executes.
 Date.now=()=>fixtureClockNow;
 try{
  await setupPaymentRequestApprovalReminder(db);await assume();backlogId=await pending();await db.exec('reset role');
  functionsBefore=await oldFunctions();triggersBefore=await oldTriggers();await applyPaymentRequestApprovalReminder(db);
  activation=await q('select activated_at d from payment_request_reminder_private.activation');
 }catch(error){Date.now=originalDateNow;throw error;}
});
after(async()=>{try{await db.close();}finally{Date.now=originalDateNow;}});

test('48 weekday hours exclude complete weekends, preserve local clock and move Saturday midnight to Monday',async t=>{
 await tx(t);await db.exec('reset role');
 assert.equal(Date.now(),fixtureNow);assert.equal(new Date(await q('select clock_timestamp()d')).getTime(),fixtureNow,'Real SQL clock must match the deterministic Monday fixture clock');
 const cases=[['2026-11-02T16:00:00Z','2026-11-04T16:00:00Z'],['2026-11-05T16:00:00Z','2026-11-09T16:00:00Z'],['2026-11-06T16:00:00Z','2026-11-10T16:00:00Z'],['2026-11-06T06:00:00Z','2026-11-10T06:00:00Z'],['2026-11-05T06:00:00Z','2026-11-09T06:00:00Z'],['2026-11-07T18:00:00Z','2026-11-11T06:00:00Z'],['2026-11-08T18:00:00Z','2026-11-11T06:00:00Z']];
 for(const[start,end]of cases){const actual=await q("select payment_request_reminder_private.deadline($1,-360)d",[start]);assert.equal(new Date(actual).toISOString(),end.replace('Z','.000Z'));}
 for(const[offset,expected]of [['UTC-06:00',-360],['UTC-03:00',-180],['UTC+00:00',0],['UTC+05:30',330],['UTC+14:00',840],['UTC+14:01',null],['UTC-03:60',null],['América / Jamaica',null],['',null],[null,null]])assert.equal(await q('select payment_request_reminder_private.offset_minutes($1)d',[offset]),expected);
});

test('migration starts uncertain existing current assignments at activation and leaves financial data/history untouched',async t=>{
 await tx(t,true);const s=await stage(backlogId);assert.equal(s.active,true);assert.equal(new Date(s.assigned_at).getTime(),new Date(activation).getTime());assert.equal((await rows(backlogId)).length,0);
 assert.deepEqual(await oldFunctions(),functionsBefore);assert.deepEqual(await oldTriggers(),triggersBefore);
 const financial=await q("select jsonb_build_object('journal',(select count(*)from journal),'gl',(select count(*)from gl_impact),'payments',(select count(*)from supplier_payment))d");await collectAt();assert.deepEqual(await q("select jsonb_build_object('journal',(select count(*)from journal),'gl',(select count(*)from gl_impact),'payments',(select count(*)from supplier_payment))d"),financial);
});

test('company template follows common view/edit oracle, keeps existing kinds and rejects invalid variables/headers',async t=>{
 await tx(t);const d=await q("select payment_request_approval_reminder_email_settings('get')d");assert.equal(d.variables.length,14);assert.equal(d.subsidiary.utcOffsetMinutes,-360);assert.equal(d.subsidiary.timezoneName,'América / Costa Rica');
 const custom={subject:'Pending {{numero_solicitud}}',body:'<p>{{fecha_inicio_aprobacion}} {{fecha_limite_recordatorio}}</p>',active:true};assert.equal((await q("select payment_request_approval_reminder_email_settings('save',$1)d",[custom])).template.asunto_template,custom.subject);
 for(const patch of[{subject:'bad\r\nheader'},{body:'{{not_a_variable}}'},{active:'true'}])await denied("select payment_request_approval_reminder_email_settings('save',$1)",[{...custom,...patch}],'22023');
 await assume(1,3);assert.equal((await q("select payment_request_approval_reminder_email_settings('get')d")).canEdit,false);await denied("select payment_request_approval_reminder_email_settings('save',$1)",[custom]);await assume(1,4);await denied("select payment_request_approval_reminder_email_settings('get')");
 await assume(4,5);assert.equal((await q("select payment_request_approval_reminder_email_settings('get')d")).canEdit,true);await assume(4,999);await denied("select payment_request_approval_reminder_email_settings('get')");
});

test('real submit schedules only its current approver and bridges a real claim payload to the Node renderer',async t=>{
 await tx(t);const id=await pending(),s=await stage(id);assert.equal(s.active,true);assert.deepEqual(s.initial_approvers,[2]);
 await ready(id);const job=(await rows(id))[0];assert.equal(job.approver_user_id,2);assert.equal(job.payload.monto_total,'50.123456');assert.equal(job.payload.companyUtcOffsetMinutes,-360);assert.equal(job.payload.assignmentId,job.assignment_id);assert.equal(job.reminder_cycle,'assignment:'+job.assignment_id);assert.equal(Object.hasOwn(job.payload,'empresa_logo_url'),false);
 const claimed=await claimAt();assert.equal(claimed.id,job.id);assert.equal(await claimAt(),null);
 const{renderPaymentRequestApprovalReminderEmail}=await import('../dist/modules/notifications/payment-request-approval-reminder-email.js');
 const originalUrl=process.env.GENTIA_APP_URL;process.env.GENTIA_APP_URL='https://synthetic.example.invalid';t.after(()=>{if(originalUrl===undefined)delete process.env.GENTIA_APP_URL;else process.env.GENTIA_APP_URL=originalUrl;});
 const rendered=renderPaymentRequestApprovalReminderEmail(claimed.subject_template,claimed.body_template,claimed.payload);assert.match(rendered.html,/50[.,]123456/);assert.match(rendered.html,/synthetic\.example\.invalid/);
});

test('fresh assignments cannot claim early and weekends defer without consuming a send attempt',async t=>{
 await tx(t);const id=await pending();const s=await stage(id);await db.query("update payment_request_reminder_private.current_stage set assigned_at='2030-01-04T16:00:00Z',next_collect_at='2030-01-04T16:00:00Z'where instance_id=$1",[s.instance_id]);await collectAt('2030-01-04T16:00:00Z');
 assert.equal(await claimAt('2030-01-07T16:00:00Z'),null);let job=(await rows(id))[0];assert.equal(new Date(job.due_at).toISOString(),'2030-01-08T16:00:00.000Z');
 await db.query("update payment_request_approval_reminder_email_outbox set next_attempt_at='2030-01-05T20:00:00Z'where id=$1",[job.id]);assert.equal(await claimAt('2030-01-05T20:00:00Z'),null);job=(await rows(id))[0];assert.equal(job.attempts,0);assert.equal(new Date(job.next_attempt_at).toISOString(),'2030-01-07T06:00:00.000Z');
});

test('A to B to A and header pause/resume create new epochs and never reuse an already sent notice',async t=>{
 await tx(t);const id=await pending();await ready(id);const original=(await rows(id))[0];await db.query("update payment_request_approval_reminder_email_outbox set status='ENVIADO'where id=$1",[original.id]);let s=await stage(id);
 await db.query('update wf_instance_steps set usuario_aprobador_id=1 where id=$1',[s.step_id]);const middle=await stage(id);await db.query('update wf_instance_steps set usuario_aprobador_id=2 where id=$1',[s.step_id]);s=await stage(id);assert.notEqual(s.epoch,original.stage_epoch);assert.notEqual(s.epoch,middle.epoch);
 await collectAt();const newer=(await rows(id)).find(x=>x.status==='PENDIENTE');assert.notEqual(newer.assignment_id,original.assignment_id);assert.ok(new Date(newer.assigned_at)>new Date(original.assigned_at));
 await db.query("update solicitudes_pago set estado='BORRADOR'where id=$1",[id]);assert.equal((await stage(id)).active,false);await db.query("update solicitudes_pago set estado='PENDIENTE_APROBACION'where id=$1",[id]);assert.notEqual((await stage(id)).epoch,s.epoch);
});

test('real partial TODOS excludes the deciding user and a next stage receives a new clock, never future-stage mail',async t=>{
 await tx(t);const id=await pending();let s=await stage(id);await db.exec('delete from user_roles where user_id=1 and role_id=4');await db.query("update wf_instance_steps set usuario_aprobador_id=null,rol_aprobador_id=4,politica='TODOS',required_count=2 where id=$1",[s.step_id]);await db.exec('insert into user_roles values(3,4)on conflict do nothing;insert into user_subsidiaries values(3,1)on conflict do nothing');
 await db.query("insert into wf_instance_steps(instance_id,nivel,nombre_nivel,usuario_aprobador_id,politica)values($1,2,'Synthetic next stage',1,'CUALQUIERA')",[s.instance_id]);await ready(id);assert.deepEqual((await rows(id)).map(x=>x.approver_user_id).sort(),[2,3]);
 await assume(2,4);await transition(id,'APPROVE');assert.equal((await detail(id)).header.estado,'PENDIENTE_APROBACION');await db.exec('reset role');await claimAt();assert.equal((await rows(id)).find(x=>x.approver_user_id===2).status,'CANCELADO');
 await assume(3,4);await transition(id,'APPROVE');s=await stage(id);assert.equal(s.active,true);await collectAt();assert.equal((await rows(id)).filter(x=>x.status==='PENDIENTE')[0].approver_user_id,1);
});

test('inactive users, foreign company membership, unassigned roles and missing read permission are never recipients',async t=>{
 await tx(t);const id=await pending();await db.exec("reset role;update users set is_active=false where user_id=2");await collectAt();assert.equal((await rows(id)).length,0);
 await db.exec('update users set is_active=true where user_id=2;delete from user_subsidiaries where user_id=2 and subsidiary_id=1');await db.exec("update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt();assert.equal((await rows(id)).length,0);
 await db.exec("insert into user_subsidiaries values(2,1);delete from user_roles where user_id=2;update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt();assert.equal((await rows(id)).length,0);
 await db.exec("insert into user_roles values(2,4);update role_access_matrix set can_view=false where role_id=4 and resource_key in('treasury:payment-requests','accounting:payment-requests');update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt();assert.equal((await rows(id)).length,0);
});

test('real rejection, edit and resubmission activate the newest workflow instance with a new 48-hour clock',async t=>{
 await tx(t);const id=await pending(),first=await stage(id);await ready(id);await assume(2,4);await transition(id,'REJECT');await assume();const h=(await detail(id)).header;
 await q('select pr_save($1)d',[{...draft,id,version:h.version,concept:'Synthetic resubmitted request'}]);await transition(id,'SUBMIT');const current=await stage(id);assert.notEqual(current.instance_id,first.instance_id);assert.notEqual(current.epoch,first.epoch);assert.equal(current.active,true);
 await collectAt();const jobs=await rows(id);assert.equal(jobs.filter(x=>x.status==='PENDIENTE').length,1);const job=jobs.find(x=>x.status==='PENDIENTE');assert.equal(job.instance_id,current.instance_id);assert.equal(new Date(job.assigned_at).getTime(),new Date(current.assigned_at).getTime());assert.ok(new Date(job.due_at)>new Date(job.assigned_at));assert.equal(jobs.find(x=>x.instance_id===first.instance_id).status,'CANCELADO');
});

test('disabled templates create no job and enabling them recovers without sending an old reminder immediately',async t=>{
 await tx(t);await q("select payment_request_approval_reminder_email_settings('save',$1)d",[{subject:'Pending',body:'<p>Pending</p>',active:false}]);const id=await pending();await collectAt();assert.equal((await rows(id)).length,0);
 await assume();await q("select payment_request_approval_reminder_email_settings('save',$1)d",[{subject:'Pending',body:'<p>Pending</p>',active:true}]);await db.exec("reset role;update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt();assert.equal((await rows(id)).filter(x=>x.status==='PENDIENTE').length,1);
});

test('missing approver email is controlled and correcting it starts a new assignment without redirecting a snapshot',async t=>{
 await tx(t);const id=await pending();await db.exec("reset role;update users set email='not-an-email'where user_id=2");await collectAt();const invalid=(await rows(id))[0];assert.equal(invalid.status,'ERROR_SIN_CORREO');await db.exec("update users set email='corrected@example.invalid'where user_id=2;update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt('2030-01-08T12:00:00Z');const jobs=await rows(id);assert.equal(jobs.find(x=>x.id===invalid.id).status,'CANCELADO');assert.equal(jobs.find(x=>x.status==='PENDIENTE').recipient_email,'corrected@example.invalid');assert.equal(new Date(jobs.find(x=>x.status==='PENDIENTE').assigned_at).toISOString(),'2030-01-08T12:00:00.000Z');
});

test('template edits refresh before claim and a render-time edit requeues the same assignment without resetting its deadline',async t=>{
 await tx(t);const id=await pending();const scheduled=await ready(id);await db.exec("update configuraciones_correos set asunto_template='First current {{numero_solicitud}}',cuerpo_template='<p>First body</p>'where tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION'");let job=await claimAt();assert.equal(job.id,scheduled.id);assert.equal(job.subject_template,'First current {{numero_solicitud}}');assert.equal(job.body_template,'<p>First body</p>');
 await db.exec("update configuraciones_correos set asunto_template='Second current {{numero_solicitud}}',cuerpo_template='<p>Second body</p>'where tipo_notificacion='SOLICITUD_PAGO_RECORDATORIO_APROBACION'");await service();assert.equal(await q('select payment_request_approval_reminder_email_authorize($1,$2)d',[job.id,job.lease]),false);const requeued=(await rows(id))[0];assert.equal(requeued.status,'PENDIENTE');assert.equal(requeued.lease,null);assert.equal(requeued.assignment_id,scheduled.assignment_id);assert.equal(new Date(requeued.due_at).getTime(),new Date(scheduled.due_at).getTime());
 job=await claimAt();assert.equal(job.id,scheduled.id);assert.equal(job.assignment_id,scheduled.assignment_id);assert.equal(job.subject_template,'Second current {{numero_solicitud}}');await service();assert.equal(await q('select payment_request_approval_reminder_email_authorize($1,$2)d',[job.id,job.lease]),true);
});

test('claim and pre-SMTP authorization reject final decisions, reassignment, changed recipient and changed UTC offset',async t=>{
 await tx(t);const id=await pending();await ready(id);let job=await claimAt();await service();assert.equal(await q('select payment_request_approval_reminder_email_authorize($1,$2)d',[job.id,job.lease]),true);
 await assume(2,4);await transition(id,'APPROVE');await service();assert.equal(await q('select payment_request_approval_reminder_email_authorize($1,$2)d',[job.id,job.lease]),false);assert.equal((await rows(id))[0].status,'CANCELADO');
 await assume();const other=await pending();await ready(other);job=await claimAt();await db.exec("update users set email='different@example.invalid'where user_id=2");await service();assert.equal(await q('select payment_request_approval_reminder_email_authorize($1,$2)d',[job.id,job.lease]),false);
 await assume();const zone=await pending();await ready(zone);await db.exec("update timezones set utc_offset='UTC-05:00'");assert.equal(await claimAt(),null);assert.equal((await rows(zone))[0].status,'CANCELADO');
});

test('invalid timezone fails closed with a diagnostic; correction creates a valid deadline without current-zone guessing',async t=>{
 await tx(t);const id=await pending();await db.exec("reset role;update timezones set utc_offset='America/Costa_Rica'");await collectAt();assert.equal((await rows(id)).length,0);assert.match((await stage(id)).last_error,/UTC/);
 await db.exec("update timezones set utc_offset='UTC-06:00';update payment_request_reminder_private.current_stage set next_collect_at='2020-01-01'");await collectAt();assert.equal((await rows(id))[0].payload.companyUtcOffsetMinutes,-360);
});

test('leases are exclusive, finish uses lease CAS, SMTP retries are bounded and expired sends remain uncertain',async t=>{
 await tx(t);const id=await pending();await ready(id);let job=await claimAt();assert.equal(await claimAt(),null);await service();assert.equal(await q("select payment_request_approval_reminder_email_finish($1,gen_random_uuid(),'ENVIADO',null,null)d",[job.id]),false);
 assert.equal(await q("select payment_request_approval_reminder_email_finish($1,$2,'REINTENTO',null,'Synthetic known rejection')d",[job.id,job.lease]),true);
 for(let i=2;i<=3;i++){const retry=(await rows(id))[0];assert.equal(retry.status,'PENDIENTE');assert.equal(await claimAt(new Date(fixtureClockNow).toISOString()),null,'The persisted SMTP backoff must prevent an immediate retry');fixtureClockNow=new Date(retry.next_attempt_at).getTime();job=await claimAt(new Date(fixtureClockNow).toISOString());assert.ok(job);await service();assert.equal(await q("select payment_request_approval_reminder_email_finish($1,$2,'REINTENTO',null,'Synthetic known rejection')d",[job.id,job.lease]),true);}
 assert.equal((await rows(id))[0].status,'ERROR');await assume();const uncertain=await pending();await ready(uncertain);job=await claimAt();await db.query("update payment_request_approval_reminder_email_outbox set lease_until='2020-01-01'where id=$1",[job.id]);assert.equal(await claimAt(),null);assert.equal((await rows(uncertain))[0].status,'INCIERTO');await collectAt('2030-01-09T12:00:00Z');assert.equal((await rows(uncertain)).length,1);
});

test('service-only APIs and private tables/helpers are inaccessible to clients and service cannot mutate tables directly',async t=>{
 await tx(t);for(const sql of['select payment_request_approval_reminder_email_collect()','select payment_request_approval_reminder_email_claim()',"select payment_request_approval_reminder_email_authorize(gen_random_uuid(),gen_random_uuid())","select payment_request_approval_reminder_email_finish(gen_random_uuid(),gen_random_uuid(),'ENVIADO')",'select *from payment_request_approval_reminder_email_outbox','select *from payment_request_reminder_private.current_stage'])await denied(sql);
 await service();await denied('select *from payment_request_approval_reminder_email_outbox');await denied('select payment_request_reminder_private.collect_at(now())');
 await db.exec('reset role');const rls=(await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid in('payment_request_approval_reminder_email_outbox'::regclass,'payment_request_reminder_private.current_stage'::regclass,'payment_request_reminder_private.activation'::regclass)")).rows;assert.equal(rls.length,3);assert.ok(rls.every(x=>x.relrowsecurity&&x.relforcerowsecurity));
});
