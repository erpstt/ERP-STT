import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupOtherPaymentUpAdministrative,applyOtherPaymentUpAdministrative,upAdministrativeMigration} from './fixtures/setup-other-payment-up-administrative-approval.mjs';

const db=new PGlite(),target='payment_request_private.pr_resolve_payment_request_approver(bigint)';
let sequence=0,functionsBefore,functionsAfter,beforeFinancial,afterFinancial,backfillSql;
const legacy={};
async function owner(){await db.exec('reset role');}
async function assume(user=1,role=1,sid=1){
 await owner();
 await db.query("insert into user_role_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);
 await db.query("insert into user_company_sessions values('fixture',$1,$2)on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);
 await db.exec('set role authenticated');
}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function denied(sql,params=[],code='42501'){
 await db.exec('savepoint denial');
 try{await assert.rejects(db.query(sql,params),error=>error.code===code);}
 finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
const clientLine=(center=40)=>({accountId:203,entityType:'Cliente',entityId:10,departmentId:20,costCenterId:center,concept:'Synthetic project expense',amount:50});
const internalLine=()=>({accountId:203,entityType:'Proveedor',entityId:10,departmentId:21,concept:'Synthetic internal expense',amount:50});
async function save(lines=[clientLine()]){
 await assume();
 return(await db.query('select pr_save($1) d',[{type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic UP route '+(++sequence),lines}])).rows[0].d;
}
async function saveCxp(){
 await assume();
 const invoice={invoice_number:'SYN-UP-CXP-'+(++sequence),invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
 const invoiceId=(await db.query('select save_supplier_invoice($1,null) d',[invoice])).rows[0].d.invoiceId;
 return(await db.query('select pr_save($1) d',[{type:'CXP',currencyId:1,supplierId:10,plannedDate:'2026-10-31',concept:'Synthetic CxP regression',lines:[{invoiceId,amount:50}]}])).rows[0].d;
}
async function detail(id){return(await db.query('select pr_detail($1) d',[{id}])).rows[0].d;}
async function transition(id,action){const h=(await detail(id)).header;return(await db.query('select pr_transition($1) d',[{id,version:h.version,transition:action,reason:action==='REJECT'?'Synthetic rejection':null}])).rows[0].d;}
async function route(id){await owner();return(await db.query('select payment_request_private.pr_resolve_payment_request_approver($1) d',[id])).rows[0].d;}
async function snapshotRequest(id){
 await owner();
 const header=(await db.query('select to_jsonb(h) d from solicitudes_pago h where id=$1',[id])).rows[0].d;
 const instance=(await db.query("select to_jsonb(i) d from wf_instances i where entity_type='PAYMENT_REQUEST'and entity_id=$1",[id])).rows[0]?.d;
 const result={header,instance};
 for(const [key,sql]of [
  ['steps','select to_jsonb(s) d from wf_instance_steps s where instance_id=$1 order by nivel'],
  ['decisions','select to_jsonb(d) d from wf_step_decisions d join wf_instance_steps s on s.id=d.step_id where s.instance_id=$1 order by d.step_id,d.usuario_id'],
  ['history','select to_jsonb(h) d from wf_historial_logs h where instance_id=$1 order by id']
 ])result[key]=instance?(await db.query(sql,[instance.id])).rows.map(row=>row.d):[];
 return result;
}
async function functions(){await owner();return(await db.query("select p.oid,n.nspname schema,p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) source_md5,p.prosecdef,p.provolatile,p.proowner,p.proacl::text acl,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','payment_request_private')order by p.oid")).rows;}
async function financialSnapshot(){
 await owner();const result={};
 for(const table of ['solicitudes_pago_lineas','solicitudes_pago_eventos','supplier_payment','journal','journal_line','gl_impact','bank_transaction','bank_account','wf_workflows','wf_rules','wf_notifications','wf_email_outbox'])result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text),'[]'::jsonb)d from ${table} x`)).rows[0].d;
 return result;
}
async function configure(value){await owner();await db.query('update subsidiaries set administrative_approver=$1 where subsidiary_id=1',[value]);}
async function oldRequest(name,lines,decisions=[]){
 const request=await save(lines);await transition(request.id,'SUBMIT');
 for(const [user,role,action]of decisions){await assume(user,role);await transition(request.id,action);}
 legacy[name]={id:request.id,before:await snapshotRequest(request.id)};
}
before(async()=>{
 await setupOtherPaymentUpAdministrative(db,{apply:false});
 await oldRequest('pendingUp',[clientLine()]);
 await oldRequest('legacyNoContext',[clientLine()]);await owner();
 await db.query("update wf_instances set approval_context=approval_context-'approvalSteps'where id=$1",[legacy.legacyNoContext.before.instance.id]);
 legacy.legacyNoContext.before=await snapshotRequest(legacy.legacyNoContext.id);
 await oldRequest('partialUp',[clientLine(),clientLine(41)],[[2,4,'APPROVE']]);
 await oldRequest('pendingAdmin',[clientLine(),internalLine()],[[2,4,'APPROVE']]);
 await configure('user:3');await oldRequest('pendingUpWithAdmin',[clientLine(),internalLine()]);await configure('user:11');
 await oldRequest('approved',[clientLine()],[[2,4,'APPROVE']]);
 await oldRequest('rejected',[clientLine()],[[2,4,'REJECT']]);
 await oldRequest('noUp',[internalLine()]);
 const cxp=await saveCxp();await transition(cxp.id,'SUBMIT');legacy.cxp={id:cxp.id,before:await snapshotRequest(cxp.id)};
 functionsBefore=await functions();beforeFinancial=await financialSnapshot();
 const sql=await readFile(new URL('../supabase/migrations/'+upAdministrativeMigration,import.meta.url),'utf8');
 backfillSql=sql.match(/do \$backfill\$[\s\S]*?\$backfill\$;/)?.[0];assert.ok(backfillSql,'Named backfill block is available for an isolated idempotency check');
 await applyOtherPaymentUpAdministrative(db);
 functionsAfter=await functions();afterFinancial=await financialSnapshot();
});
after(()=>db.close());

test('migration preserves financial rows, original function identity and privileges',async()=>{
 assert.deepEqual(afterFinancial,beforeFinancial);
 const prior=functionsBefore.find(row=>row.schema==='payment_request_private'&&row.proname==='pr_resolve_payment_request_approver');
 assert.equal(prior.source_md5,'69cba36f2552d27d1aeb28995adf93d4');
 const current=functionsAfter.find(row=>row.oid===prior.oid);
 assert.notEqual(current.source_md5,prior.source_md5);
 assert.deepEqual({...current,source_md5:null},{...prior,source_md5:null});
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2,'execute')ok",[role,target])).rows[0].ok,false);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'payment_request_private.pr_up_administrative_approval_step(bigint)','execute')ok",[role])).rows[0].ok,false);
 const helper=functionsAfter.find(row=>row.schema==='payment_request_private'&&row.proname==='pr_up_administrative_approval_step');assert.equal(helper.prosecdef,false);
 assert.equal(functionsAfter.length,functionsBefore.length+1);
 for(const row of functionsBefore)if(row.oid!==prior.oid)assert.deepEqual(functionsAfter.find(candidate=>candidate.oid===row.oid),row,row.schema+'.'+row.proname);
});

test('existing pending UP requests gain the final administrative stage without replaying their decisions',async t=>{
 await tx(t);
 for(const name of ['pendingUp','partialUp','legacyNoContext']){
  const {id,before}=legacy[name],current=await snapshotRequest(id);
  assert.deepEqual(current.steps.slice(0,before.steps.length),before.steps);
  assert.deepEqual(current.decisions,before.decisions);
  assert.deepEqual(current.history.slice(0,before.history.length),before.history);
  assert.equal(current.instance.current_level,before.instance.current_level);
  assert.equal(current.header.estado,'PENDIENTE_APROBACION');
  assert.equal(current.header.assigned_approver_id,before.header.assigned_approver_id);
  assert.equal(current.header.version,before.header.version+1);
  assert.equal(current.header.approval_route_source,'MIXED');
  assert.equal(current.steps.length,before.steps.length+1);
  assert.equal(current.steps.at(-1).usuario_aprobador_id,11);
  assert.match(current.steps.at(-1).nombre_nivel,/administrativ/i);
  assert.equal(current.instance.approval_context.approvalSteps.length,current.steps.length);
 }
 const updated={};for(const [name,{id}]of Object.entries(legacy))updated[name]=await snapshotRequest(id);
 await owner();await db.exec(backfillSql);await db.exec(backfillSql);
 for(const [name,{id}]of Object.entries(legacy))assert.deepEqual(await snapshotRequest(id),updated[name],'Backfill replay must be idempotent: '+name);
 const {id}=legacy.partialUp;
 await assume(3,1);await transition(id,'APPROVE');
 assert.equal((await detail(id)).header.estado,'PENDIENTE_APROBACION');
 await assume(11,91);assert.equal((await detail(id)).actions.canApprove,true);await transition(id,'APPROVE');
 assert.equal((await detail(id)).header.estado,'APROBADO');
});

test('approved, rejected, pending administrative, already complete UP routes, CxP and routes without UP remain untouched',async()=>{
 for(const name of ['approved','rejected','pendingAdmin','pendingUpWithAdmin','cxp','noUp'])assert.deepEqual(await snapshotRequest(legacy[name].id),legacy[name].before,name);
});

test('new project requests require UP then Administrative, notify each current stage and cannot pay between stages',async t=>{
 await tx(t);const r=await save();await transition(r.id,'SUBMIT');
 let state=await snapshotRequest(r.id);
 assert.deepEqual(state.steps.map(step=>step.usuario_aprobador_id),[2,11]);
 assert.deepEqual(state.steps.map(step=>step.nivel),[1,2]);
 assert.equal(state.instance.current_level,1);assert.equal(state.header.assigned_approver_id,2);
 const notices=async()=>{await owner();return(await db.query('select usuario_id from wf_notifications where instance_id=$1 order by id',[state.instance.id])).rows.map(row=>row.usuario_id);};
 assert.deepEqual(await notices(),[2]);
 await assume(11,91);assert.equal((await detail(r.id)).actions.canApprove,false);
 const premature=(await detail(r.id)).header;await denied('select pr_transition($1)',[{id:r.id,version:premature.version,transition:'APPROVE'}]);
 await assume(2,4);await transition(r.id,'APPROVE');
 state=await snapshotRequest(r.id);assert.equal(state.instance.current_level,2);assert.equal(state.header.estado,'PENDIENTE_APROBACION');assert.equal(state.header.assigned_approver_id,11);
 assert.deepEqual(await notices(),[2,11]);
 await assume(1,2);const h=(await detail(r.id)).header;await denied('select pr_execute($1)',[{id:r.id,version:h.version,date:'2026-10-31',rate:1,bankId:1,method:'TRANSFERENCIA',reference:'SYN-UP-NOT-APPROVED'}],'55000');
 await assume(11,91);await transition(r.id,'APPROVE');state=await snapshotRequest(r.id);
 assert.equal(state.header.estado,'APROBADO');assert.equal(state.instance.status,'APROBADO');assert.equal(state.instance.current_level,null);assert.equal(state.header.assigned_approver_id,null);
 assert.equal(state.header.payment_id,null);assert.equal(state.header.check_id,null);assert.equal(state.header.journal_id,null);
 assert.equal(state.decisions.length,2);
});

test('default and multiple UP approvers keep their sequence and one administrative ending',async t=>{
 await tx(t);await owner();await db.exec('update cost_centers set up_approver_id=null where cost_center_id=40');
 let r=await save(),resolved=await route(r.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[3,11]);
 await owner();await db.exec('update cost_centers set up_approver_id=2 where cost_center_id=40');
 r=await save([clientLine(),clientLine(41)]);resolved=await route(r.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[2,3,11]);
 await owner();await db.exec('update cost_centers set up_approver_id=2 where cost_center_id=41');
 r=await save([clientLine(),clientLine(41)]);resolved=await route(r.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[2,11]);
 r=await save([clientLine(),internalLine()]);resolved=await route(r.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[2,11]);
 await owner();await db.exec('update subsidiaries set default_up_approver_id=null where subsidiary_id=1;update cost_centers set up_approver_id=null where cost_center_id=40;update cost_centers set up_approver_id=4 where cost_center_id=41');
 r=await save([clientLine(),clientLine(41)]);resolved=await route(r.id);
 assert.deepEqual(resolved.steps.map(step=>step.approverId),[4,11]);assert.equal(resolved.steps[0].source,'COST_CENTER');assert.match(resolved.steps[0].levelName,/Proyectos/);
});

test('the same person in UP and Administrative must make two distinct stage decisions',async t=>{
 await tx(t);await configure('user:2');const r=await save();await transition(r.id,'SUBMIT');
 const initial=await snapshotRequest(r.id);assert.deepEqual(initial.steps.map(step=>step.usuario_aprobador_id),[2,2]);
 await assume(2,4);await transition(r.id,'APPROVE');assert.equal((await detail(r.id)).header.estado,'PENDIENTE_APROBACION');assert.equal((await detail(r.id)).actions.canApprove,true);
 await transition(r.id,'APPROVE');const final=await snapshotRequest(r.id);assert.equal(final.header.estado,'APROBADO');assert.equal(final.decisions.length,2);assert.notEqual(final.decisions[0].step_id,final.decisions[1].step_id);
 const multiple=await save([clientLine(),clientLine(41)]),resolved=await route(multiple.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[2,3,2]);
 await configure('employee:10');const employeeRequest=await save();assert.deepEqual((await route(employeeRequest.id)).steps.map(step=>step.approverId),[2,2]);
});

test('rejection at either stage stops the route and requires a reason',async t=>{
 await tx(t);
 for(const rejectAt of [1,2]){
  const r=await save();await transition(r.id,'SUBMIT');
  await assume(2,4);if(rejectAt===2){await transition(r.id,'APPROVE');await assume(11,91);}
  const h=(await detail(r.id)).header;
  await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'REJECT',reason:''}],'22023');
  await transition(r.id,'REJECT');const state=await snapshotRequest(r.id);
  assert.equal(state.header.estado,'RECHAZADO');assert.equal(state.instance.status,'RECHAZADO');assert.equal(state.header.assigned_approver_id,null);
  await assume(11,91);assert.equal((await detail(r.id)).actions.canApprove,false);
 }
});

test('missing, malformed, inactive, foreign or unauthorized Administrative blocks new UP submissions atomically',async t=>{
 await tx(t);const r=await save();
 for(const value of [null,'','user:0','user:999999','role:11','user:9223372036854775808','employee:999999','user:12','user:13']){
  await configure(value);const before=await snapshotRequest(r.id),financial=await financialSnapshot();
  await assume();const h=(await detail(r.id)).header;
  await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');
  assert.deepEqual(await snapshotRequest(r.id),before);assert.deepEqual(await financialSnapshot(),financial);
 }
 await configure('user:11');await owner();await db.exec('update users set is_active=false where user_id=11');await assume();
 let h=(await detail(r.id)).header;await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');
 await owner();await db.exec('update users set is_active=true where user_id=11;delete from user_subsidiaries where user_id=11 and subsidiary_id=1');await assume();
 h=(await detail(r.id)).header;await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');
 await configure('employee:10');
 for(const patch of ['is_active=false','is_active=true,user_id=null','user_id=2,subsidiary_id=2']){
  await owner();await db.exec('update employees set '+patch+' where employee_id=10');await assume();
  h=(await detail(r.id)).header;await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');
 }
});

test('Administrative configuration snapshots existing routes and changes only the next submission',async t=>{
 await tx(t);const a=await save();await transition(a.id,'SUBMIT');const original=await snapshotRequest(a.id);
 await configure('user:3');const b=await save();await transition(b.id,'SUBMIT');
 assert.deepEqual((await snapshotRequest(a.id)).steps,original.steps);
 assert.deepEqual((await snapshotRequest(b.id)).steps.map(step=>step.usuario_aprobador_id),[2,3]);
 await configure(null);await assume(2,4);await transition(a.id,'APPROVE');await assume(11,91);assert.equal((await detail(a.id)).actions.canApprove,true);await transition(a.id,'APPROVE');
 assert.equal((await detail(a.id)).header.estado,'APROBADO');
});

test('new CxP, Internal and tax-supervisor routes keep their single-stage behavior',async t=>{
 await tx(t);let r=await saveCxp(),resolved=await route(r.id);
 assert.deepEqual(resolved.steps.map(step=>step.approverId),[11]);assert.equal(resolved.source,'ADMINISTRATIVE');
 r=await save([internalLine()]);resolved=await route(r.id);assert.deepEqual(resolved.steps.map(step=>step.approverId),[11]);
 await owner();await db.exec('update subsidiaries set tax_supervisor_user_id=3 where subsidiary_id=1');
 r=await save([{accountId:203,entityType:'Agencia Tributaria',entityId:1,departmentId:20,costCenterId:40,concept:'Synthetic tax agency',amount:50}]);
 resolved=await route(r.id);assert.equal(resolved.source,'TAX_SUPERVISOR');assert.deepEqual(resolved.steps.map(step=>step.approverId),[3]);
});

test('role, tenant, owner and stale-version guards still protect submissions and both decisions',async t=>{
 await tx(t);const r=await save();await denied('select pr_transition($1)',[{id:r.id,version:0,transition:'SUBMIT'}],'55000');
 await assume(2,4);await denied('select pr_transition($1)',[{id:r.id,version:1,transition:'SUBMIT'}]);
 await assume(1,1,2);await denied('select pr_detail($1)',[{id:r.id}]);
 await assume();await transition(r.id,'SUBMIT');await assume(2,4);await transition(r.id,'APPROVE');
 await assume(11,91);await denied('select pr_transition($1)',[{id:r.id,version:0,transition:'APPROVE'}],'55000');
 await assume(11,92);await denied('select pr_detail($1)',[{id:r.id}]);
 await assume(11,91);await transition(r.id,'APPROVE');assert.equal((await detail(r.id)).header.estado,'APROBADO');
});

test('backfill without a valid Administrative approver aborts the entire migration before durable changes',async()=>{
 const probe=new PGlite();
 try{
  await setupOtherPaymentUpAdministrative(probe,{apply:false});
  await probe.exec("insert into user_role_sessions values('fixture',1,1);insert into user_company_sessions values('fixture',1,1)");
  await probe.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',session_id:'fixture'})]);
  await probe.exec('set role authenticated');
  const request=(await probe.query('select pr_save($1)d',[{type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic atomic backfill',lines:[clientLine()]}])).rows[0].d;
  await probe.query('select pr_transition($1)',[{id:request.id,version:1,transition:'SUBMIT'}]);
  await probe.exec("reset role;update subsidiaries set administrative_approver=null where subsidiary_id=1");
  const snapshot=async()=>{
   const state={};
   for(const table of ['solicitudes_pago','wf_instances','wf_instance_steps','wf_step_decisions','wf_historial_logs','wf_notifications','wf_email_outbox'])state[table]=(await probe.query(`select coalesce(jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text),'[]'::jsonb)d from ${table} x`)).rows[0].d;
   state.resolver=(await probe.query('select md5(prosrc)m from pg_proc where oid=$1::regprocedure',[target])).rows[0].m;
   return state;
  };
  const baseline=await snapshot();
  await assert.rejects(applyOtherPaymentUpAdministrative(probe),error=>error.code==='PRA01');
  assert.deepEqual(await snapshot(),baseline);
  assert.equal((await probe.query("select to_regprocedure('payment_request_private.pr_up_administrative_approval_step(bigint)')fn")).rows[0].fn,null);
 }finally{await probe.close();}
});

test('resolver and both published role-oracle guards reject drift and roll back the new helper and metadata',async()=>{
 const probe=new PGlite();
 try{
  await setupOtherPaymentUpAdministrative(probe,{apply:false});
  const signatures=[target,'public.app_is_admin()','public.security_assert_role_access(text,text)'];
  const metadata=async()=>(await probe.query("select p.oid,n.nspname schema,p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) source_md5,p.prosecdef,p.provolatile,p.proowner,p.proacl::text acl,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','payment_request_private')order by p.oid")).rows;
  const originalMetadata=await metadata();
  for(const signature of signatures){
   const definition=(await probe.query('select pg_get_functiondef($1::regprocedure)d',[signature])).rows[0].d;
   assert.ok(definition.includes('AS $function$'));
   await probe.exec(definition.replace('AS $function$','AS $function$\n-- Synthetic function source drift'));
   const driftedMetadata=await metadata();assert.notDeepEqual(driftedMetadata,originalMetadata);
   await assert.rejects(applyOtherPaymentUpAdministrative(probe),error=>error.code==='P0001'&&/Unexpected/.test(error.message),signature);
   assert.deepEqual(await metadata(),driftedMetadata,'A failed guarded migration preserves the preexisting metadata: '+signature);
   assert.equal((await probe.query("select to_regprocedure('payment_request_private.pr_up_administrative_approval_step(bigint)')fn")).rows[0].fn,null);
   await probe.exec(definition);assert.deepEqual(await metadata(),originalMetadata);
  }
 }finally{await probe.close();}
});
