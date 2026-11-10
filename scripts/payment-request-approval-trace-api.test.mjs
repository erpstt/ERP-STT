import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentRequests} from '../dist/modules/treasury-catalogs/payment-requests.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-payment-request-trace';
const at='2026-11-10T12:00:00Z';
const document=()=>({header:{id:51,id_subsidiaria:7,estado:'PENDIENTE_APROBACION',assigned_approver_id:81},lines:[],events:[],actions:{canApprove:false}});
const step=(level,extra={})=>({id:400+level,instance_id:300,nivel:level,nombre_nivel:level===1?'Aprobación Proyectos (UP)':'Aprobación administrativa',status:level===1?'APROBADO':'PENDIENTE',politica:'CUALQUIERA',required_count:1,usuario_aprobador_id:81,rol_aprobador_id:null,...extra});
const event=(id,level,action,extra={})=>({id,instance_id:300,nivel:level,accion_tomada:action,usuario_id:92,user:'Persona que decidió',rol_id:null,role:null,fecha_hora:at,comentario_motivo:'Decisión registrada',ip_address:'PRIVATE_IP',...extra});
const workflow=()=>({instance:{id:300,entity_type:'PAYMENT_REQUEST',entity_id:51,subsidiaria_id:7,status:'EN_REVISION',current_level:2,created_at:at,completed_at:null,
  approval_context:{privateData:'PRIVATE_CONTEXT',approvalSteps:[{approverId:81,roleId:null,source:'COST_CENTER',levelName:'Aprobación Proyectos (UP)'},{approverId:81,roleId:null,source:'ADMINISTRATIVE',levelName:'Aprobación administrativa'}]}},
  steps:[step(1),step(2)],history:[event(701,1,'ENVIADO',{usuario_id:11,user:'Solicitante'}),event(702,1,'APROBAR')],privateDebug:'PRIVATE_DEBUG'});

async function fixture(t,{detail=document(),trace=workflow(),detailStatus=200,traceStatus=200,traceRaw,traceFailure=null,view=true}={}){
  const oldFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]])),calls=[];
  Object.assign(process.env,{SUPABASE_URL:'https://approval-trace.invalid',SUPABASE_ANON_KEY:'synthetic-public-key'});
  await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'treasury:payment-requests',canView:view,canCreate:false,canEdit:false,canDelete:false}]});
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init.headers),name=url.pathname.split('/').at(-1);
    assert.equal(url.origin,'https://approval-trace.invalid');assert.equal(init.method,'POST');
    assert.ok(['pr_detail','pr_report','wf_instance_detail'].includes(name),'Only existing document/history reads are permitted');
    calls.push({name,authorization:headers.get('authorization'),key:headers.get('apikey'),input:JSON.parse(init.body)});
    if(name==='wf_instance_detail'&&traceFailure)throw traceFailure;
    if(name==='wf_instance_detail'&&typeof traceRaw==='string')return new Response(traceRaw,{status:traceStatus});
    return Response.json(name==='wf_instance_detail'?trace:detail,{status:name==='wf_instance_detail'?traceStatus:detailStatus});
  };
  t.after(()=>{globalThis.fetch=oldFetch;for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;invalidateRoleAccessCaches();});
  return calls;
}

test('detail adds materialized approval history using the original authorization and the returned document ID',async t=>{
  const calls=await fixture(t),result=await paymentRequests(auth,'detail',{id:999,entityId:777,entityType:'SALES_ORDER',approverId:999});
  assert.deepEqual(calls,[
    {name:'pr_detail',authorization:auth,key:'synthetic-public-key',input:{p:{id:999,entityId:777,entityType:'SALES_ORDER',approverId:999}}},
    {name:'wf_instance_detail',authorization:auth,key:'synthetic-public-key',input:{p_entity_type:'PAYMENT_REQUEST',p_entity_id:51}}
  ]);
  assert.deepEqual({...result,approvalTrace:undefined},{...document(),approvalTrace:undefined});
  assert.equal(result.approvalTrace.state,'AVAILABLE');assert.equal(result.approvalTrace.instance.currentLevel,2);
  assert.deepEqual(result.approvalTrace.steps.map(s=>[s.id,s.level,s.userId,s.source]),[[401,1,81,'COST_CENTER'],[402,2,81,'ADMINISTRATIVE']]);
  assert.equal(result.approvalTrace.steps[0].decisions[0].userId,92,'The actual actor may differ from the assigned user');
  assert.equal(result.approvalTrace.steps[1].decisions.length,0,'Repeated users must still make separate decisions at each stage');
});

test('trace exposes only the approved display fields and only recorded approval/rejection decisions',async t=>{
  const trace=workflow();trace.history.push(event(703,2,'RUTA_ACTUALIZADA',{usuario_id:null,user:'',comentario_motivo:'Ruta extendida'}));
  await fixture(t,{trace});const result=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.deepEqual(Object.keys(result).sort(),['history','instance','state','steps']);
  assert.deepEqual(Object.keys(result.instance).sort(),['completedAt','createdAt','currentLevel','id','status']);
  assert.deepEqual(Object.keys(result.steps[0]).sort(),['decisions','id','level','name','policy','requiredCount','roleId','source','status','userId']);
  assert.deepEqual(Object.keys(result.history[0]).sort(),['action','at','comment','id','level','roleId','roleName','userId','userName']);
  assert.deepEqual(Object.keys(result.steps[0].decisions[0]).sort(),['action','at','comment','id','roleId','roleName','userId','userName']);
  assert.equal(result.history.length,3);assert.equal(result.steps[1].decisions.length,0);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|ip_address|approval_context|assignedApproverId|delegat/i);
});

test('copied source labels apply only to the same level and assignee IDs; legacy routes remain available',async t=>{
  const trace=workflow();trace.instance.approval_context.approvalSteps[0].approverId=444;
  trace.steps[1]={...step(2),usuario_aprobador_id:null,rol_aprobador_id:20};
  trace.instance.approval_context.approvalSteps[1]={approverId:null,roleId:20,source:'STANDARD'};
  await fixture(t,{trace});const result=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(result.steps[0].source,null);assert.equal(result.steps[1].source,'STANDARD');assert.equal(result.steps[1].roleId,20);
  delete trace.instance.approval_context;
  const legacy=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(legacy.state,'AVAILABLE');assert.deepEqual(legacy.steps.map(s=>s.source),[null,null]);
});

test('partial unanimous approval and terminal states preserve real step states instead of inventing completion',async t=>{
  const trace=workflow();trace.instance.current_level=1;
  trace.steps[0]={...step(1),usuario_aprobador_id:null,rol_aprobador_id:20,politica:'TODOS',required_count:3,status:'PENDIENTE'};
  await fixture(t,{trace});const pending=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(pending.steps[0].status,'PENDIENTE');assert.equal(pending.steps[0].requiredCount,3);assert.equal(pending.steps[0].decisions.length,1);
  trace.instance.status='RECHAZADO';trace.instance.completed_at=at;trace.steps[0].status='RECHAZADO';trace.history.push(event(703,1,'RECHAZAR'));
  const rejected=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(rejected.instance.status,'RECHAZADO');assert.equal(rejected.steps[0].decisions.at(-1).action,'RECHAZAR');assert.equal(rejected.steps[1].status,'PENDIENTE');
});

test('a request without an instance reports NOT_STARTED and does not resolve or manufacture a route',async t=>{
  const calls=await fixture(t,{trace:null});assert.deepEqual((await paymentRequests(auth,'detail',{id:51})).approvalTrace,{state:'NOT_STARTED',instance:null,steps:[],history:[]});assert.equal(calls.length,2);
});

test('non-authorization history failures leave a visible UNAVAILABLE trace without failing document detail',async t=>{
  await fixture(t,{traceStatus:503,trace:{message:'PRIVATE_SQL'}});
  const result=await paymentRequests(auth,'detail',{id:51});assert.equal(result.header.id,51);assert.deepEqual(result.approvalTrace,{state:'UNAVAILABLE',instance:null,steps:[],history:[]});
});

test('network failures in the read-only history call do not retry or expose provider details',async t=>{
  const calls=await fixture(t,{traceFailure:Error('PRIVATE_TRANSPORT')});
  assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.state,'UNAVAILABLE');assert.equal(calls.length,2);
});

test('401 from history fails closed after the document read',async t=>{
  const calls=await fixture(t,{traceStatus:401,trace:{message:'PRIVATE_SQL'}});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===401&&!e.message.includes('PRIVATE'));assert.equal(calls.length,2);
});

test('403 from history fails closed after the document read',async t=>{
  const calls=await fixture(t,{traceStatus:403,trace:{message:'PRIVATE_SQL'}});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===403&&!e.message.includes('PRIVATE'));assert.equal(calls.length,2);
});

test('a non-JSON 401 history response still fails closed without exposing the provider body',async t=>{
  const calls=await fixture(t,{traceStatus:401,traceRaw:'<html>PRIVATE_AUTH_PROXY</html>'});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===401&&e.message==='No fue posible procesar el flujo de aprobacion.');assert.equal(calls.length,2);
});

test('a non-JSON 403 history response retains the public authorization error',async t=>{
  const calls=await fixture(t,{traceStatus:403,traceRaw:'PRIVATE_AUTH_PROXY'});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===403&&e.message==='El rol activo no puede realizar esta operacion.');assert.equal(calls.length,2);
});

test('a non-JSON server error reports UNAVAILABLE without exposing provider details',async t=>{
  const calls=await fixture(t,{traceStatus:500,traceRaw:'<html>PRIVATE_SERVER_ERROR</html>'});
  assert.deepEqual((await paymentRequests(auth,'detail',{id:51})).approvalTrace,{state:'UNAVAILABLE',instance:null,steps:[],history:[]});assert.equal(calls.length,2);
});

test('database authorization failures in history propagate rather than degrading to an available document',async t=>{
  const calls=await fixture(t,{traceStatus:400,trace:{code:'42501',message:'PRIVATE_SQL'}});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===403&&!e.message.includes('PRIVATE'));assert.equal(calls.length,2);
});

test('unauthorized document reads stop before requesting workflow history',async t=>{
  const calls=await fixture(t,{detailStatus:403,detail:{code:'42501',message:'PRIVATE_SQL'}});
  await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===403);assert.deepEqual(calls.map(c=>c.name),['pr_detail']);
});

test('anonymous callers and roles without document view access never reach the data provider',async t=>{
  const calls=await fixture(t,{view:false});await assert.rejects(paymentRequests('', 'detail',{id:51}),e=>e.status===401);await assert.rejects(paymentRequests(auth,'detail',{id:51}),e=>e.status===403);assert.equal(calls.length,0);
});

test('malformed or unrelated history cannot be presented as the request approval route',async t=>{
  const trace=workflow();await fixture(t,{trace});
  trace.instance.entity_id=999;assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.state,'UNAVAILABLE');
  trace.instance.entity_id=51;trace.steps[1].instance_id=999;assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.state,'UNAVAILABLE');
  trace.steps[1].instance_id=300;trace.steps[1].nivel=1;assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.state,'UNAVAILABLE');
});

test('invalid returned document IDs never fall back to caller-supplied IDs',async t=>{
  const calls=await fixture(t,{detail:{...document(),header:{id:'not-an-id'}}});
  assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.state,'UNAVAILABLE');assert.deepEqual(calls.map(c=>c.name),['pr_detail']);
});

test('ordinary report reads retain their original one-call response contract',async t=>{
  const report=[{id:51,estado:'PENDIENTE_APROBACION'}],calls=await fixture(t,{detail:report});
  assert.deepEqual(await paymentRequests(auth,'report',{}),report);assert.deepEqual(calls.map(c=>c.name),['pr_report']);
});

test('valid user-or-role assignments and legacy missing assignees retain their actual materialized stages',async t=>{
  const trace=workflow();trace.steps[0].rol_aprobador_id=20;trace.steps[1].usuario_aprobador_id=null;
  trace.history[1].rol_id=20;trace.history[1].role='Rol aprobador registrado';
  await fixture(t,{trace});const result=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(result.state,'AVAILABLE');assert.equal(result.steps[0].userId,81);assert.equal(result.steps[0].roleId,20);
  assert.equal(result.steps[0].source,null,'The copied source must match both IDs');
  assert.equal(result.steps[0].decisions[0].roleId,20);assert.equal(result.steps[0].decisions[0].roleName,'Rol aprobador registrado');
  assert.equal(result.steps[1].userId,null);assert.equal(result.steps[1].roleId,null);assert.equal(result.steps[1].source,null);
});

test('a new instance never inherits prior-cycle decisions or cached route metadata',async t=>{
  const trace=workflow();await fixture(t,{trace});
  assert.equal((await paymentRequests(auth,'detail',{id:51})).approvalTrace.steps[0].decisions.length,1);
  trace.instance.id=301;trace.instance.current_level=1;trace.instance.approval_context={};trace.history=[];
  trace.steps=[step(1,{id:501,instance_id:301,status:'PENDIENTE',usuario_aprobador_id:82})];
  const result=(await paymentRequests(auth,'detail',{id:51})).approvalTrace;
  assert.equal(result.instance.id,301);assert.equal(result.steps[0].userId,82);assert.equal(result.steps[0].source,null);assert.deepEqual(result.steps[0].decisions,[]);assert.deepEqual(result.history,[]);
});
