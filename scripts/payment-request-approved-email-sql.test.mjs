import assert from'node:assert/strict';
import{before,after,test}from'node:test';
import{PGlite}from'@electric-sql/pglite';
import{setupPaymentRequestApprovedEmail,applyPaymentRequestApprovedEmailMigration}from'./fixtures/setup-payment-request-approved-email.mjs';
import{assertIsolatedTestArgs}from'./lib/migration-preview.mjs';
assertIsolatedTestArgs();
const db=new PGlite();let metadataBefore,triggerBefore,existingTemplates;
const q=async(sql,p=[])=>(await db.query(sql,p)).rows[0]?.d;
const draft={type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic treasury notice',lines:[{accountId:203,entityType:'Proveedor',entityId:10,departmentId:21,concept:'Synthetic expense',amount:50}]};
const save=async(p=draft)=>q('select pr_save($1)d',[p]);
const detail=async id=>q('select pr_detail($1)d',[{id}]);
const transition=async(id,transition,reason=null)=>{const h=(await detail(id)).header;return q('select pr_transition($1)d',[{id,version:h.version,transition,reason}]);};
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture',role:'authenticated'})]);await db.exec('set role authenticated');
}
async function service(){await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);await db.exec('set role service_role');}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));await assume();}
async function denied(sql,p=[],code='42501'){await db.exec('savepoint denial');try{await assert.rejects(db.query(sql,p),e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}}
async function queue(id){await db.exec('reset role');return(await db.query('select *from payment_request_approved_email_outbox where request_id=$1 order by created_at,id',[id])).rows;}
async function configureEmail(email='treasury-one@example.invalid',sid=1){await db.exec('reset role');await db.query('update subsidiaries set treasury_email=$1 where subsidiary_id=$2',[email,sid]);await assume();}
async function approved(p=draft){const r=await save(p);await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');return r.id;}
const metadata=async()=>(await db.query("select oid,oid::regprocedure::text signature,proowner,proacl::text,proconfig,prosecdef,provolatile from pg_proc where oid in('company_master_private.save(text,jsonb,bigint)'::regprocedure,'organization_master_private.meta(text)'::regprocedure,'payment_request_private.wf_act(bigint,text,text,inet)'::regprocedure,'payment_request_private.pr_transition(jsonb)'::regprocedure,'public.payment_email_event()'::regprocedure)order by oid")).rows;
const oldTrigger=async()=>(await db.query("select oid,tgfoid,tgtype,tgdeferrable,tginitdeferred,pg_get_triggerdef(oid)definition from pg_trigger where tgrelid='solicitudes_pago'::regclass and tgname='payment_request_email_event'")).rows;
before(async()=>{await setupPaymentRequestApprovedEmail(db);metadataBefore=await metadata();triggerBefore=await oldTrigger();existingTemplates=(await db.query('select *from configuraciones_correos order by id')).rows;await applyPaymentRequestApprovedEmailMigration(db);});
after(()=>db.close());

test('optional treasury email is normalized by the protected company writer and keeps scope/revision/write guards',async t=>{
 await tx(t);let d=await q('select organization_company_detail(1)d');d=await q("select save_organization_master('subsidiaries',$1,1)d",[{treasury_email:' Treasury-One@Example.Invalid ',_revision:d._revision}]);assert.equal(d.treasury_email,'treasury-one@example.invalid');
 for(const email of['a@example.invalid,b@example.invalid','a@example.invalid\r\nBcc:x@example.invalid','a@example.invalid\r\n','\na@example.invalid','bad','x'.repeat(255)+'@example.invalid','x'.repeat(65)+'@example.invalid','.a@example.invalid','a.@example.invalid','a..b@example.invalid','a@bad_domain.invalid','a@-domain.invalid','a@domain-.invalid','a@localhost','aé@example.invalid','Name (x) <a@example.invalid>'])await denied("select save_organization_master('subsidiaries',$1,1)",[{treasury_email:email,_revision:d._revision}],'22023');
 await denied("select save_organization_master('subsidiaries',$1,1)",[{treasury_email:'other@example.invalid',_revision:'stale'}],'55000');
 d=await q("select save_organization_master('subsidiaries',$1,1)d",[{treasury_email:"Treasury+O'Neil@Example.Invalid",_revision:d._revision}]);assert.equal(d.treasury_email,"treasury+o'neil@example.invalid");
 d=await q("select save_organization_master('subsidiaries',$1,1)d",[{treasury_email:'',_revision:d._revision}]);assert.equal(d.treasury_email,null);
 await assume(1,3);await denied("select save_organization_master('subsidiaries',$1,1)",[{treasury_email:'blocked@example.invalid',_revision:d._revision}]);await denied("update subsidiaries set treasury_email='blocked@example.invalid'");
});

test('editable company-scoped template requires exact view/edit permissions and validates variables and headers',async t=>{
 await tx(t);const before=await q("select payment_request_approved_email_settings('get')d");assert.equal(before.template.tipo_notificacion,'SOLICITUD_PAGO_APROBADA');assert.equal(before.canEdit,true);
 const custom={subject:'Final {{numero_solicitud}}',body:'<p>{{empresa_nombre}} {{monto_total}} {{moneda}} {{enlace_solicitud}}</p>',active:true};
 const saved=await q("select payment_request_approved_email_settings('save',$1)d",[custom]);assert.equal(saved.template.asunto_template,custom.subject);
 for(const patch of[{subject:'Bad\r\nHeader'},{body:'{{unknown_variable}}'},{active:'true'}])await denied("select payment_request_approved_email_settings('save',$1)",[{...custom,...patch}],'22023');
 await assume(1,3);const read=await q("select payment_request_approved_email_settings('get')d");assert.equal(read.canEdit,false);await denied("select payment_request_approved_email_settings('save',$1)",[custom]);await assume(1,4);await denied("select payment_request_approved_email_settings('get')");
});

test('common oracle permits an active administrator without a template matrix row and still denies inactive roles or foreign company scope',async t=>{
 await tx(t);await db.exec("reset role;delete from role_access_matrix where role_id=5 and resource_key='configuration:notification-templates'");await assume(4,5);
 assert.equal(await q("select security_resource_allowed('configuration:notification-templates','view')and security_resource_allowed('configuration:notification-templates','edit')d"),true);
 const data=await q("select payment_request_approved_email_settings('get')d");assert.equal(data.canEdit,true);
 const saved=await q("select payment_request_approved_email_settings('save',$1)d",[{subject:'Admin {{numero_solicitud}}',body:'<p>{{empresa_nombre}}</p>',active:true}]);assert.equal(saved.template.asunto_template,'Admin {{numero_solicitud}}');
 await assume(4,999);await denied("select payment_request_approved_email_settings('get')");
 await db.exec('reset role;delete from user_subsidiaries where user_id=4 and subsidiary_id=2');await assume(4,5,2);await denied("select payment_request_approved_email_settings('get')");
 await assume(4,5);await db.exec('reset role;update users set is_active=false where user_id=4;set role authenticated');await denied("select payment_request_approved_email_settings('get')");
});

test('migration and unchanged approved rows never backfill notifications; approved INSERT is not an event',async t=>{
 await tx(t);await db.exec("reset role;update solicitudes_pago set concepto='Synthetic historical metadata'where numero='SYN-HISTORICAL-APPROVED';update solicitudes_pago set estado='APROBADO'where numero='SYN-HISTORICAL-APPROVED'");
 assert.equal((await db.query('select count(*)::int n from payment_request_approved_email_outbox')).rows[0].n,0);
 await db.exec("insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,fecha_pago_programada,id_solicitante,concepto,total,version,aprobado_por,aprobado_at)values('SYN-INSERT-APPROVED',1,1,'OTROS','APROBADO','2026-10-31',1,'Synthetic imported state',1,1,1,now())");
 assert.equal((await db.query('select count(*)::int n from payment_request_approved_email_outbox')).rows[0].n,0);
});

test('real administrative route queues exactly once on final approval with the exact company recipient and immutable templates',async t=>{
 await tx(t);await configureEmail();await db.exec('reset role');await db.query('update subsidiaries set logo_url=$1 where subsidiary_id=1',['data:image/png;base64,'+'A'.repeat(1000000)]);await assume();
 const settings=await q("select payment_request_approved_email_settings('get')d");assert.equal(Object.hasOwn(settings.subsidiary,'logo'),false);
 const id=await approved(),rows=await queue(id);assert.equal(rows.length,1);const job=rows[0];assert.equal(job.status,'PENDIENTE');assert.equal(job.recipient_email,'treasury-one@example.invalid');assert.equal(job.approval_cycle,'wf:'+job.instance_id);assert.equal(job.payload.requestId,id);assert.equal(job.payload.instanceId,job.instance_id);assert.equal(job.payload.subsidiaryId,1);assert.equal(job.payload.approvalVersion,job.approval_version);assert.equal(job.payload.approvalCycle,job.approval_cycle);assert.equal(job.payload.monto_total,50);assert.equal(job.payload.empresa_zona_horaria,'UTC');
 assert.equal(Object.hasOwn(job.payload,'empresa_logo_url'),false);assert.ok(JSON.stringify(job.payload).length<10000,'Unused company branding must not inflate the queued financial snapshot');
 await db.query("update solicitudes_pago set concepto='Unrelated same-state metadata',version=version+1 where id=$1",[id]);assert.equal((await queue(id)).length,1);
 await db.exec("update configuraciones_correos set asunto_template='Later template'where tipo_notificacion='SOLICITUD_PAGO_APROBADA'");assert.equal((await queue(id))[0].subject_template,job.subject_template);
 await service();const claimed=await q('select payment_request_approved_email_claim()d');assert.equal(claimed.id,job.id);assert.equal(claimed.status,'ENVIANDO');assert.equal(claimed.attempts,1);
 assert.equal(await q('select payment_request_approved_email_claim()d'),null);
 assert.equal(await q("select payment_request_approved_email_finish($1,$2,'ENVIADO','synthetic-message',null)d",[claimed.id,claimed.lease]),true);
 assert.equal(await q("select payment_request_approved_email_finish($1,$2,'ENVIADO','synthetic-message',null)d",[claimed.id,claimed.lease]),false);
});

test('a partial TODOS decision and an intermediate workflow level never queue the final notice',async t=>{
 await tx(t);await configureEmail();const r=await save();await transition(r.id,'SUBMIT');await db.exec('reset role');
 const wi=(await db.query("select id from wf_instances where entity_type='PAYMENT_REQUEST'and entity_id=$1",[r.id])).rows[0].id;
 await db.query("update wf_instance_steps set usuario_aprobador_id=null,rol_aprobador_id=4,politica='TODOS',required_count=2 where instance_id=$1",[wi]);
 await db.exec('insert into user_roles(user_id,role_id)values(3,4)on conflict do nothing;insert into user_subsidiaries(user_id,subsidiary_id)values(3,1)on conflict do nothing');
 await assume(2,4);await transition(r.id,'APPROVE');assert.equal((await queue(r.id)).length,0);
 await db.exec('reset role');await db.query("insert into wf_instance_steps(instance_id,nivel,nombre_nivel,usuario_aprobador_id,politica)values($1,2,'Synthetic final level',1,'CUALQUIERA')",[wi]);
 await assume(3,4);await transition(r.id,'APPROVE');assert.equal((await queue(r.id)).length,0);
 await assume();await transition(r.id,'APPROVE');assert.equal((await queue(r.id)).length,1);
});

test('missing recipient and inactive template record controlled outcomes without rejecting final approval',async t=>{
 await tx(t);const missing=await approved();assert.equal((await queue(missing))[0].status,'ERROR_SIN_CORREO');await assume();
 await q("select payment_request_approved_email_settings('save',$1)d",[{subject:'Approved {{numero_solicitud}}',body:'<p>{{empresa_nombre}}</p>',active:false}]);
 await configureEmail();const disabled=await approved();assert.equal((await queue(disabled))[0].status,'OMITIDO');
});

test('claim cancels applied or cancelled requests and never sends to a changed Treasury address',async t=>{
 await tx(t);await configureEmail();const id=await approved();await db.exec('reset role');await db.query("update solicitudes_pago set estado='APLICADO'where id=$1",[id]);assert.equal((await queue(id))[0].status,'CANCELADO');await service();assert.equal(await q('select payment_request_approved_email_claim()d'),null);
 await assume();const changed=await approved();await db.exec("reset role;update subsidiaries set treasury_email='changed@example.invalid'where subsidiary_id=1");await service();assert.equal(await q('select payment_request_approved_email_claim()d'),null);const job=(await queue(changed))[0];assert.equal(job.status,'ERROR_SIN_CORREO');assert.equal(job.recipient_email,'treasury-one@example.invalid');
});

test('retry is bounded, stale leases cannot finish, and expired sends become uncertain without automatic delivery',async t=>{
 await tx(t);await configureEmail();const id=await approved();await service();let job=await q('select payment_request_approved_email_claim()d');
 assert.equal(await q("select payment_request_approved_email_finish($1,gen_random_uuid(),'ENVIADO',null,null)d",[job.id]),false);
 for(let i=1;i<=3;i++){
  assert.equal(job.attempts,i);assert.equal(await q("select payment_request_approved_email_finish($1,$2,'REINTENTO',null,'Synthetic temporary rejection')d",[job.id,job.lease]),true);
  await db.exec('reset role');const state=(await queue(id))[0];assert.equal(state.status,i<3?'PENDIENTE':'ERROR');
  if(i<3){await db.query('update payment_request_approved_email_outbox set next_attempt_at=now()where id=$1',[job.id]);await service();job=await q('select payment_request_approved_email_claim()d');}
 }
 await assume();const expiring=await approved();await service();job=await q('select payment_request_approved_email_claim()d');await db.exec('reset role');await db.query("update payment_request_approved_email_outbox set lease_until=now()-interval'1 second'where id=$1",[job.id]);await service();assert.equal(await q("select payment_request_approved_email_finish($1,$2,'ENVIADO',null,null)d",[job.id,job.lease]),false);assert.equal(await q('select payment_request_approved_email_claim()d'),null);assert.equal((await queue(expiring))[0].status,'INCIERTO');
});

test('outbox and internal functions are closed to users and only the service role may claim or finish',async t=>{
 await tx(t);for(const role of['anon','authenticated','service_role']){await db.exec('reset role;set role '+role);await denied('select *from payment_request_approved_email_outbox');await denied("select payment_request_approved_email_private.ensure_template(1)");}
 await assume();await denied('select payment_request_approved_email_claim()');await denied("select payment_request_approved_email_finish(gen_random_uuid(),gen_random_uuid(),'ENVIADO',null,null)");
 await db.exec('reset role;set role service_role');await denied('select payment_request_approved_email_claim()');
});

test('original company security attributes, approval functions, deferred payment trigger, and older templates remain intact',async t=>{
 await tx(t);await db.exec('reset role');assert.deepEqual(await metadata(),metadataBefore);assert.deepEqual(await oldTrigger(),triggerBefore);assert.deepEqual((await db.query("select *from configuraciones_correos where tipo_notificacion<>'SOLICITUD_PAGO_APROBADA'order by id")).rows,existingTemplates);
 const newFunctions=(await db.query("select p.proname,p.proconfig,p.prosecdef from pg_proc p where proname in('payment_request_approved_email_claim','payment_request_approved_email_finish','payment_request_approved_email_settings')")).rows;assert.equal(newFunctions.length,3);assert.ok(newFunctions.every(r=>r.prosecdef&&r.proconfig.includes('search_path=pg_catalog, public, pg_temp')));
});

test('CXP standard workflow and the real default UP route both generate final notifications',async t=>{
 await tx(t);await configureEmail();
 const invoice={invoice_number:'SYN-TREASURY-INVOICE',invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
 const invoiceId=(await q('select save_supplier_invoice($1,null)d',[invoice])).invoiceId;
 await db.exec('reset role');const workflow=(await db.query("insert into wf_workflows(nombre,entity_type,subsidiaria_id)values('Synthetic standard CXP','PAYMENT_REQUEST',1)returning id")).rows[0].id;
 await db.query("insert into wf_rules(workflow_id,nivel,nombre_nivel,usuario_aprobador_id,politica)values($1,1,'Synthetic CXP approval',2,'CUALQUIERA')",[workflow]);await assume();
 const cxp=await approved({...draft,type:'CXP',supplierId:10,lines:[{invoiceId,amount:50}]});assert.equal((await queue(cxp))[0].payload.tipo_solicitud,'CXP');assert.equal((await queue(cxp))[0].payload.beneficiario_nombre,(await db.query('select company_name from suppliers where supplier_id=10')).rows[0].company_name);
 await assume();await db.exec("reset role;update subsidiaries set default_up_approver_id=2 where subsidiary_id=1;update cost_centers set up_approver_id=null,department_id=20,cost_center_type='CLIENTE'where cost_center_id=40");await assume();
 const up=await save({...draft,lines:[{...draft.lines[0],departmentId:20,costCenterId:40}]});await transition(up.id,'SUBMIT');await db.exec('reset role');
 const route=(await db.query("select approval_route_source from solicitudes_pago where id=$1",[up.id])).rows[0].approval_route_source;assert.ok(['SUBSIDIARY','MIXED','ADMIN_FALLBACK','COST_CENTER'].includes(route),route);
 await assume(2,4);await transition(up.id,'APPROVE');assert.equal((await queue(up.id)).length,1);
});

test('rejection creates no notice, and a new approval instance after resubmission creates a distinct cycle',async t=>{
 await tx(t);await configureEmail();const r=await save();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'REJECT','Synthetic rejection');assert.equal((await queue(r.id)).length,0);
 await assume();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');const original=(await queue(r.id))[0];assert.equal(original.status,'PENDIENTE');
 await assume();await transition(r.id,'CANCEL','Synthetic cancellation');assert.equal((await queue(r.id))[0].status,'CANCELADO');
 // The engine restarts rejected/cancelled workflows with a new instance. The
 // current application does not expose reopening ANULADO; prepare that state
 // synthetically, then exercise the real protected submit/approval path.
 await db.exec('reset role');await db.query("update solicitudes_pago set estado='RECHAZADO',version=version+1 where id=$1",[r.id]);await assume();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
 const jobs=await queue(r.id);assert.equal(jobs.length,2);assert.notEqual(jobs[0].instance_id,jobs[1].instance_id);assert.equal(jobs.filter(x=>x.status==='PENDIENTE').length,1);
});

test('recipient and settings follow the request company rather than the active or parent company',async t=>{
 await tx(t);await configureEmail();await configureEmail('treasury-two@example.invalid',2);
 await db.exec('reset role');await db.exec("update subsidiaries set administrative_approver='user:1'where subsidiary_id=2");
 const row=(await db.query("insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,fecha_pago_programada,id_solicitante,concepto,total,version)values('SYN-TENANT-TWO',2,1,'OTROS','PENDIENTE_APROBACION','2026-10-31',1,'Synthetic tenant two',25,2)returning id")).rows[0];
 const wi=(await db.query("insert into wf_instances(subsidiaria_id,entity_type,entity_id,amount,current_level,status,requested_by)values(2,'PAYMENT_REQUEST',$1,25,null,'APROBADO',1)returning id",[row.id])).rows[0];
 await assume(1,1,1);await db.exec('reset role');await db.query("update solicitudes_pago set estado='APROBADO',aprobado_por=1,aprobado_at=now(),version=3 where id=$1",[row.id]);
 const job=(await queue(row.id))[0];assert.equal(job.subsidiary_id,2);assert.equal(job.instance_id,wi.id);assert.equal(job.recipient_email,'treasury-two@example.invalid');
 await assume(1,1,1);const settings=await q("select payment_request_approved_email_settings('get')d");assert.equal(settings.subsidiary.id,1);assert.equal(settings.subsidiary.treasuryEmail,'treasury-one@example.invalid');
});

test('malformed approval traces and direct state aliases cannot create a final notice without the real completed workflow',async t=>{
 await tx(t);await configureEmail();const r=await save();await db.exec('reset role');await db.query("update solicitudes_pago set estado='APROBADO',aprobado_por=2,aprobado_at=now(),version=2 where id=$1",[r.id]);assert.equal((await queue(r.id)).length,0);
 await db.query("update solicitudes_pago set estado='BORRADOR',version=3 where id=$1",[r.id]);await assume();await transition(r.id,'SUBMIT');await db.exec('reset role');
 await db.query("update solicitudes_pago set estado='APROBADO',aprobado_por=2,aprobado_at=now(),version=version+1 where id=$1",[r.id]);assert.equal((await queue(r.id)).length,0,'An intermediate workflow cannot produce the final notification');
});
