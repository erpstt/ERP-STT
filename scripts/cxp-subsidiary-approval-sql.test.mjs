import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {setupCxpSubsidiaryApproval,applyCxpSubsidiaryApproval,cxpApprovalMigration} from './fixtures/setup-cxp-subsidiary-approval.mjs';

const db=new PGlite(),target='payment_request_private.pr_resolve_payment_request_approver(bigint)';
let beforeFunctions,afterFunctions,inflight,originalResolver,beforeState,afterState,invoiceSequence=0;
async function assume(user=1,role=1,sid=1){
 await db.exec('reset role');
 await db.query("insert into user_role_sessions values('fixture',$1,$2) on conflict(session_id)do update set user_id=$1,role_id=$2",[user,role]);
 await db.query("insert into user_company_sessions values('fixture',$1,$2) on conflict(session_id)do update set user_id=$1,subsidiary_id=$2",[user,sid]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:`00000000-0000-0000-0000-${String(user).padStart(12,'0')}`,session_id:'fixture'})]);
 await db.exec('set role authenticated');
}
async function functions(){return(await db.query(`select p.oid,n.nspname schema,p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) source_md5,p.prosecdef,p.provolatile,p.proowner,p.proacl::text acl,p.proconfig
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','payment_request_private') order by p.oid`)).rows;}
async function tx(t){await db.exec('reset role;begin');t.after(()=>db.exec('rollback;reset role'));}
async function detail(id){return(await db.query('select pr_detail($1) d',[{id}])).rows[0].d;}
async function transition(id,action){const h=(await detail(id)).header;return(await db.query('select pr_transition($1) d',[{id,version:h.version,transition:action,reason:action==='REJECT'?'Synthetic rejection':null}])).rows[0].d;}
async function saveRequest(){
 await assume();
 const invoice={invoice_number:'SYN-CXP-'+(++invoiceSequence),invoice_type:'Factura estándar',supplier_id:10,payment_term_id:1,invoice_date:'2026-10-31',fiscal_period_id:10,currency_id:1,exchange_rate:1,memo:'Synthetic',lines:[{account_id:203,quantity:2,unit_price:50,tax_code_id:1,tax_rate:13,department_id:21}]};
 const invoiceId=(await db.query('select save_supplier_invoice($1,null) d',[invoice])).rows[0].d.invoiceId;
 return(await db.query('select pr_save($1) d',[{type:'CXP',currencyId:1,supplierId:10,plannedDate:'2026-10-31',concept:'Synthetic CxP request',lines:[{invoiceId,amount:50}]}])).rows[0].d;
}
async function owner(){await db.exec('reset role');}
async function route(id){await owner();return(await db.query('select payment_request_private.pr_resolve_payment_request_approver($1) d',[id])).rows[0].d;}
async function workflow(id){await owner();return(await db.query("select to_jsonb(w) d from wf_instances w where entity_type='PAYMENT_REQUEST' and entity_id=$1",[id])).rows[0]?.d;}
async function snapshot(){
 await owner();const result={};
 for(const table of ['solicitudes_pago','solicitudes_pago_lineas','solicitudes_pago_eventos','wf_workflows','wf_rules','wf_instances','wf_instance_steps','wf_step_decisions','wf_historial_logs','wf_notifications','wf_email_outbox','supplier_payment','journal','journal_line','gl_impact','bank_transaction','bank_account']){
  result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) d from ${table} x`)).rows[0].d;
 }return result;
}
async function denied(sql,params=[],code='42501'){
 await db.exec('savepoint denial');
 try{await assert.rejects(db.query(sql,params),error=>error.code===code);}
 finally{await db.exec('rollback to savepoint denial;release savepoint denial');}
}
async function configure(value){await owner();await db.query('update subsidiaries set administrative_approver=$1 where subsidiary_id=1',[value]);}
before(async()=>{
 await setupCxpSubsidiaryApproval(db,{apply:false});
 await db.exec("create unique index if not exists wf_one_active_entity on wf_workflows(subsidiaria_id,entity_type) where estado_activo");
 // A real standard instance is created before the change. Its copied level
 // must continue to belong to user 2 even if the company later chooses another.
 const w=(await db.query("insert into wf_workflows(nombre,entity_type,subsidiaria_id)values('Synthetic previous fixed workflow','PAYMENT_REQUEST',1)returning id")).rows[0].id;
 await db.query("insert into wf_rules(workflow_id,nivel,nombre_nivel,usuario_aprobador_id)values($1,1,'Synthetic fixed level',2)",[w]);
 const r=await saveRequest();await transition(r.id,'SUBMIT');inflight=await workflow(r.id);
 await owner();beforeFunctions=await functions();beforeState=await snapshot();originalResolver=(await db.query('select pg_get_functiondef($1::regprocedure) d',[target])).rows[0].d;await applyCxpSubsidiaryApproval(db);afterFunctions=await functions();afterState=await snapshot();
});
after(()=>db.close());

test('one guarded resolver body changes; identity, privileges, configuration and other functions remain intact',async()=>{
 const changed=afterFunctions.filter((x,i)=>JSON.stringify(x)!==JSON.stringify(beforeFunctions[i]));
 assert.equal(changed.length,1);assert.equal(changed[0].proname,'pr_resolve_payment_request_approver');
 const prior=beforeFunctions.find(x=>x.oid===changed[0].oid);assert.equal(prior.source_md5,'970bc6f38da922670b44664760658212');
 assert.deepEqual({...changed[0],source_md5:null},{...prior,source_md5:null});
 assert.equal(changed[0].prosecdef,true);assert.equal(changed[0].provolatile,'v');
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') ok',[role,target])).rows[0].ok,false);
 assert.deepEqual(await workflow(inflight.entity_id),inflight);
 assert.deepEqual(afterState,beforeState,'Migration performs no historical financial, workflow, configuration or notification writes');
});
test('a new CxP uses one mandatory dynamic administrative level despite an existing fixed workflow',async t=>{
 await tx(t);await configure('user:11');const r=await saveRequest();const before=await route(r.id);
 assert.equal(before.dynamic,true);assert.equal(before.source,'ADMINISTRATIVE');assert.equal(before.approverId,11);assert.equal(before.steps.length,1);
 await assume();await transition(r.id,'SUBMIT');const w=await workflow(r.id);
 assert.equal(w.workflow_id,null);assert.equal(w.status,'EN_REVISION');assert.equal(w.current_level,1);
 const steps=(await db.query('select * from wf_instance_steps where instance_id=$1',[w.id])).rows;
 assert.equal(steps.length,1);assert.equal(steps[0].usuario_aprobador_id,11);assert.equal(steps[0].rol_aprobador_id,null);assert.equal(steps[0].required_count,1);assert.equal(steps[0].status,'PENDIENTE');
 await assume(11,91);assert.equal((await detail(r.id)).actions.canApprove,true);await transition(r.id,'APPROVE');
 assert.equal((await detail(r.id)).header.estado,'APROBADO');await owner();assert.equal((await db.query('select payment_id,check_id,journal_id from solicitudes_pago where id=$1',[r.id])).rows[0].payment_id,null);
});
test('a new company needs no standard workflow or seed and resolves only its own current configuration',async t=>{
 await tx(t);await owner();await db.exec("insert into subsidiaries(subsidiary_id,name,is_active,currency_id,administrative_approver)values(20,'Synthetic future company',true,1,'user:11');insert into user_subsidiaries values(1,20),(11,20)");
 const h=(await db.query("insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,fecha_pago_programada,id_solicitante,concepto,total)values('SYN-FUTURE',20,1,'CXP','BORRADOR','2026-10-31',1,'Synthetic',50)returning id")).rows[0];
 await assume(1,1,20);const resolved=await route(h.id);assert.equal(resolved.approverId,11);
 await assume(1,1,1);await owner();await denied('select payment_request_private.pr_resolve_payment_request_approver($1)',[h.id],'P0001');
 assert.equal((await db.query('select count(*)::int n from wf_workflows where subsidiaria_id=20')).rows[0].n,0);
});
test('employee configuration follows its exact active user and company, with no name-based selection',async t=>{
 await tx(t);await configure('employee:10');const r=await saveRequest();assert.equal((await route(r.id)).approverId,2);await assume();await transition(r.id,'SUBMIT');assert.equal((await workflow(r.id)).status,'EN_REVISION');
});
test('an administrator with no matrix grants remains eligible by the guarded published oracle',async t=>{
 await tx(t);await configure('user:4');await owner();await db.exec('delete from role_access_matrix where role_id=5');
 const r=await saveRequest();assert.equal((await route(r.id)).approverId,4);await assume();await transition(r.id,'SUBMIT');await assume(4,5);assert.equal((await detail(r.id)).actions.canApprove,true);
});
test('missing or malformed configuration blocks before sending with no fallback and no durable writes',async t=>{
 await tx(t);const r=await saveRequest();
 for(const value of [null,'','user:0','user:999999','role:4','345','user:11 extra','user:9223372036854775808','employee:9223372036854775808','user:999999999999999999999999999999']){
  await configure(value);const baseline=await snapshot();await assume();const h=(await detail(r.id)).header;
  await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');
  assert.deepEqual(await snapshot(),baseline,String(value));
 }
});
test('inactive, foreign, unassigned or blind approvers block before creating any workflow',async t=>{
 await tx(t);const r=await saveRequest();
 for(const statement of [
  "update subsidiaries set administrative_approver='user:12' where subsidiary_id=1",
  "update subsidiaries set administrative_approver='user:13' where subsidiary_id=1",
  "update subsidiaries set administrative_approver='user:11' where subsidiary_id=1;update users set is_active=false where user_id=11",
  "update users set is_active=true where user_id=11;delete from user_subsidiaries where user_id=11 and subsidiary_id=1",
 ]){
  await owner();await db.exec(statement);const baseline=await snapshot();await assume();const h=(await detail(r.id)).header;
  await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');assert.deepEqual(await snapshot(),baseline);
 }
});
test('inactive, disconnected or foreign employee configuration never falls back to an administrator',async t=>{
 await tx(t);await configure('employee:10');const r=await saveRequest();
 for(const patch of ["is_active=false","is_active=true,user_id=null","user_id=2,subsidiary_id=2"]){
  await owner();await db.exec('update employees set '+patch+' where employee_id=10');const baseline=await snapshot();await assume();const h=(await detail(r.id)).header;
  await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'SUBMIT'}],'PRA01');assert.deepEqual(await snapshot(),baseline);
 }
});
test('configuration changes apply to the next submission and never redirect an existing instance',async t=>{
 await tx(t);await configure('user:2');const a=await saveRequest();await transition(a.id,'SUBMIT');const w=await workflow(a.id);
 await configure('user:11');const b=await saveRequest();await transition(b.id,'SUBMIT');const wb=await workflow(b.id);
 assert.equal((await db.query('select usuario_aprobador_id from wf_instance_steps where instance_id=$1',[w.id])).rows[0].usuario_aprobador_id,2);
 assert.equal((await db.query('select usuario_aprobador_id from wf_instance_steps where instance_id=$1',[wb.id])).rows[0].usuario_aprobador_id,11);
 await configure(null);await assume(2,4);assert.equal((await detail(a.id)).actions.canApprove,true);await transition(a.id,'APPROVE');
 await assume(11,91);assert.equal((await detail(b.id)).actions.canApprove,true);
});
test('the previous standard instance and its history continue with their original approver',async t=>{
 await tx(t);await configure('user:11');assert.deepEqual(await workflow(inflight.entity_id),inflight);
 await assume(2,4);assert.equal((await detail(inflight.entity_id)).actions.canApprove,true);await transition(inflight.entity_id,'APPROVE');
 assert.equal((await detail(inflight.entity_id)).header.estado,'APROBADO');
 await owner();assert.equal((await db.query('select workflow_id from wf_instances where id=$1',[inflight.id])).rows[0].workflow_id,inflight.workflow_id);
});
test('caller version, ownership, tenant and current-role approval controls remain mandatory',async t=>{
 await tx(t);await configure('user:11');const r=await saveRequest();
 await denied('select pr_transition($1)',[{id:r.id,version:0,transition:'SUBMIT'}],'55000');
 await assume(2,4);await denied('select pr_transition($1)',[{id:r.id,version:1,transition:'SUBMIT'}]);
 await assume(1,1,2);await denied('select pr_transition($1)',[{id:r.id,version:1,transition:'SUBMIT'}]);
 await assume();await transition(r.id,'SUBMIT');await assume(1,1);assert.equal((await detail(r.id)).actions.canApprove,false);const h=(await detail(r.id)).header;
 await denied('select pr_transition($1)',[{id:r.id,version:h.version,transition:'APPROVE'}]);
 await assume(11,92);await denied('select pr_detail($1)',[{id:r.id}]);await assume(11,91);assert.equal((await detail(r.id)).actions.canApprove,true);
});
test('a competing invoice reservation still blocks submission before routing',async t=>{
 await tx(t);const r=await saveRequest();await owner();const i=(await db.query('select id_factura_proveedor from solicitudes_pago_lineas where id_solicitud=$1',[r.id])).rows[0].id_factura_proveedor;
 const c=(await db.query("insert into solicitudes_pago(numero,id_subsidiaria,id_moneda,tipo_solicitud,estado,fecha_pago_programada,id_solicitante,id_proveedor,concepto,total)values('SYN-RESERVED',1,1,'CXP','BORRADOR','2026-10-31',1,10,'Synthetic reservation',100)returning id")).rows[0].id;
 await db.query('insert into solicitudes_pago_lineas(id_solicitud,id_factura_proveedor,monto)values($1,$2,100)',[c,i]);
 const baseline=await snapshot();await assume();await denied('select pr_transition($1)',[{id:r.id,version:1,transition:'SUBMIT'}],'P0001');assert.deepEqual(await snapshot(),baseline);
});
test('OTROS keeps its prior resolver output byte-for-byte and its original route behaviour',async t=>{
 await tx(t);await assume();const draft={type:'OTROS',currencyId:1,plannedDate:'2026-10-31',concept:'Synthetic other',lines:[{accountId:203,entityType:'Proveedor',entityId:10,departmentId:21,concept:'Synthetic expense',amount:50}]};
 const r=(await db.query('select pr_save($1) d',[draft])).rows[0].d;const changed=await route(r.id);
 // Restore the original reviewed function inside this rollback-only transaction.
 await owner();await db.exec(originalResolver);
 assert.deepEqual(await route(r.id),changed);
});
test('exact positive bigint identifiers retain database precision instead of introducing a digit limit',async t=>{
 await tx(t);const r=await saveRequest();await owner();
 await db.exec("insert into users(user_id,is_active,first_name,last_name,email)values(9223372036854775806,true,'Synthetic','Bigint','bigint@example.invalid');insert into user_roles values(9223372036854775806,91);insert into user_subsidiaries values(9223372036854775806,1)");
 await configure('user:9223372036854775806');const value=(await db.query("select payment_request_private.pr_resolve_payment_request_approver($1)->>'approverId' id",[r.id])).rows[0].id;
 assert.equal(value,'9223372036854775806');
});
test('resolver and both published role-oracle guards reject drift before replacing any function',async()=>{
 const probe=new PGlite();
 try{
  await setupCxpSubsidiaryApproval(probe,{apply:false});
  const sql=(await readFile(new URL('../supabase/migrations/'+cxpApprovalMigration,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  for(const signature of [target,'public.app_is_admin()','public.security_assert_role_access(text,text)']){
   await probe.exec('begin');
   try{
    const definition=(await probe.query('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
    await probe.exec(definition.replace('AS $function$','AS $function$\n-- Synthetic source drift'));
    const before=(await probe.query('select md5(prosrc) m from pg_proc where oid=$1::regprocedure',[target])).rows[0].m;
    await assert.rejects(probe.exec(sql),error=>error.code==='P0001'&&/Unexpected/.test(error.message));
    await probe.exec('rollback');
    const after=(await probe.query('select md5(prosrc) m from pg_proc where oid=$1::regprocedure',[target])).rows[0].m;
    assert.equal(after,'970bc6f38da922670b44664760658212');
    if(signature!==target)assert.equal(before,after);
   }catch(error){await probe.exec('rollback');throw error;}
  }
 }finally{await probe.close();}
});
