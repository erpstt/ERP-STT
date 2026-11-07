import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentRequests} from '../dist/modules/treasury-catalogs/payment-requests.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const auth='Bearer synthetic-cxp-administrative-routing';
const configurationMessage='Configure un Aprobador Administrativo activo y autorizado en la subsidiaria antes de enviar la solicitud a aprobación.';
const submit={id:51,version:3,transition:'SUBMIT'};
async function fixture(t,{status=400,result={code:'PRA01',message:'private SQL: subsidiary 999, actor 777'},edit=true,view=true}={}){
 const oldFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_ANON_KEY'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),calls=[];
 Object.assign(process.env,{SUPABASE_URL:'https://cxp-routing.invalid',SUPABASE_ANON_KEY:'synthetic-public-key'});
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'treasury:payment-requests',canView:view,canCreate:false,canEdit:edit,canDelete:false}]});
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input)),headers=new Headers(init.headers);assert.equal(url.origin,'https://cxp-routing.invalid');assert.equal(url.pathname,'/rest/v1/rpc/pr_transition');calls.push({authorization:headers.get('authorization'),key:headers.get('apikey'),input:JSON.parse(init.body)});return Response.json(result,{status});};
 t.after(()=>{globalThis.fetch=oldFetch;for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;invalidateRoleAccessCaches();});return calls;
}

test('PRA01 gives a fixed subsidiary-configuration message without exposing SQL details or replaying SUBMIT',async t=>{
 const calls=await fixture(t);await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===409&&e.message===configurationMessage);
 assert.deepEqual(calls,[{authorization:auth,key:'synthetic-public-key',input:{p:submit}}]);
});
test('successful submit preserves the server-assigned administrative route and caller payload without an approver override',async t=>{
 const result={id:51,status:'EN_REVISION',approvalRoute:'ADMINISTRATIVE',assignedApproverId:81,approvalStepCount:1};const calls=await fixture(t,{status:200,result});
 assert.deepEqual(await paymentRequests(auth,'transition',submit),result);assert.deepEqual(calls[0].input,{p:submit});assert.equal(calls.length,1);
});
test('ordinary protected-state conflicts retain their existing safe generic contract',async t=>{
 const calls=await fixture(t,{status:400,result:{code:'55000',message:'private version/history'}});await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===409&&e.message==='La solicitud está protegida por su versión, estado, saldo o historial.');assert.equal(calls.length,1);
});
test('401 retains session identity semantics even if a body contains the configuration error code',async t=>{
 const calls=await fixture(t,{status:401});await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===401&&e.message==='La sesión no es válida.');assert.equal(calls.length,1);
});
test('403 retains authorization semantics even if a body contains the configuration error code',async t=>{
 const calls=await fixture(t,{status:403});await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===403&&e.message==='El rol activo no puede realizar esta operación.');assert.equal(calls.length,1);
});
test('a server outage is not mislabeled as missing approver configuration',async t=>{
 const calls=await fixture(t,{status:503});await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===500&&e.message==='No fue posible procesar la solicitud de pago.');assert.equal(calls.length,1);
});
test('anonymous and view-only callers cannot submit and make no provider requests',async t=>{
 const calls=await fixture(t,{edit:false});await assert.rejects(paymentRequests('', 'transition',submit),e=>e.status===401);await assert.rejects(paymentRequests(auth,'transition',submit),e=>e.status===403);assert.equal(calls.length,0);
});
