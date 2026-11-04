import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';

assert.deepEqual(process.argv.slice(2),[],'This isolated fixture accepts no destinations or credentials');
const originalEnvironment=process.env,originalFetch=globalThis.fetch,originalLoadEnvFile=process.loadEnvFile;
const environment={};
for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(originalEnvironment[key]!==undefined)environment[key]=originalEnvironment[key];
Object.assign(environment,{SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_ANON_KEY:'p158-synthetic-public',SUPABASE_PUBLISHABLE_KEY:'p158-synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'p158-synthetic-private-not-used',DISABLE_BACKGROUND_JOBS:'true',EMAIL_NOTIFICATIONS_ENABLED:'false',SMTP_ENABLED:'false'});
process.loadEnvFile=()=>{throw Error('Environment-file reads are disabled in this synthetic fixture');};
let access,service;
try{
 process.env={...environment};globalThis.fetch=async()=>{throw Error('No provider I/O during isolated module initialization');};
 access=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
 service=await import('../dist/modules/organization-catalogs/up-approvers.service.js');
}finally{process.env=originalEnvironment;globalThis.fetch=originalFetch;}

const canary='P158_SYNTHETIC_PROVIDER_'+randomBytes(18).toString('hex');
const grant={resourceKey:'organization:cost-centers',canView:true,canCreate:false,canEdit:true,canDelete:false};
const payload={current_approver_id:1,new_approver_id:2,reassign_all:false,subsidiary_id:1,cost_center_ids:[3]};
const operations=[
 {name:'options',rpc:'up_approver_options',message:'No fue posible cargar las opciones de aprobadores UP.',args:{},call:authorization=>service.upApproverOptions(authorization)},
 {name:'selector',rpc:'up_approver_selector_options',message:'No fue posible cargar la lista de aprobadores UP.',args:{},call:authorization=>service.upApproverSelectorOptions(authorization)},
 {name:'centers',rpc:'up_cost_centers_by_approver',message:'No fue posible consultar los centros de costo del aprobador UP.',args:{p_approver_id:42},call:authorization=>service.listCostCentersByUpApprover(authorization,42)},
 {name:'reassign',rpc:'up_reassign_cost_centers',message:'No fue posible reasignar los centros de costo al aprobador UP.',args:{p:payload},call:authorization=>service.reassignCostCenterUpApprover(authorization,payload)},
];
let serial=0,unexpected=[];
test.beforeEach(()=>{
 process.env={...environment};access.invalidateRoleAccessCaches();unexpected=[];
 globalThis.fetch=async()=>{unexpected.push('unexpected fetch');throw Error('Unmocked synthetic provider I/O');};
});
test.afterEach(()=>{
 access.invalidateRoleAccessCaches();process.env=originalEnvironment;globalThis.fetch=originalFetch;
 assert.deepEqual(unexpected,[]);
});
test.after(()=>{process.loadEnvFile=originalLoadEnvFile;});

async function actor(){const authorization='Bearer p158-synthetic-'+ ++serial;await access.primeRoleAccessCache(authorization,{isAdmin:false,grants:[grant]});return authorization;}
function mock(operation,authorization,respond){
 const calls=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==environment.SUPABASE_URL||url.pathname!=='/rest/v1/rpc/'+operation.rpc){unexpected.push('unexpected provider target');throw Error('Unexpected synthetic provider target');}
  const headers=new Headers(init.headers);assert.equal(init.method,'POST');assert.equal(headers.get('authorization'),authorization);assert.equal(headers.get('apikey'),environment.SUPABASE_ANON_KEY);assert.notEqual(headers.get('apikey'),environment.SUPABASE_SERVICE_ROLE_KEY);assert.equal(headers.get('content-type'),'application/json');
  const body=JSON.parse(init.body);assert.deepEqual(body,operation.args);calls.push({path:url.pathname,body});return respond();
 };return calls;
}
function publicFailure(operation,status){return error=>{
 assert.ok(error instanceof Error);assert.equal(error.status,status);assert.equal(error.message,operation.message);
 for(const value of[error.message,error.stack,JSON.stringify(error)])assert.equal(String(value).includes(canary),false);
 assert.equal(error.cause,undefined);for(const key of['code','details','hint','payload','data','response'])assert.equal(error[key],undefined);return true;
};}

for(const operation of operations){
 test(operation.name+' provider errors use a fixed contextual message and preserve exact 42501/status mapping',async()=>{
  for(const httpStatus of[400,401,403,422,429,500,503])for(const code of['42501','P0001','22023','PGRST301',42501,canary]){
   const authorization=await actor();const calls=mock(operation,authorization,()=>Response.json({code,message:canary,details:canary,hint:canary,status:401,isAdmin:true,grants:[grant]},{status:httpStatus}));
   await assert.rejects(()=>operation.call(authorization),publicFailure(operation,code==='42501'?403:400));assert.equal(calls.length,1);
  }
 });
 test(operation.name+' non-JSON, empty and nonobject error bodies use a safe fixed 400 fallback',async()=>{
  for(const body of['',canary,'<html>'+canary+'</html>','{"message":"'+canary,JSON.stringify(canary),'null','[]'])for(const status of[401,403,500]){
   const authorization=await actor();const calls=mock(operation,authorization,()=>new Response(body,{status}));
   await assert.rejects(()=>operation.call(authorization),publicFailure(operation,400));assert.equal(calls.length,1);
  }
 });
 test(operation.name+' successful JSON and empty success preserve payloads, RPC arguments and caller JWT/public key',async()=>{
  for(const expected of[{synthetic:true,message:'Synthetic business label',nested:{ids:[1,2]}},[{id:1,name:'Synthetic approver'}],null]){
   const authorization=await actor();const calls=mock(operation,authorization,()=>expected===null?new Response(null,{status:204}):Response.json(expected));
   assert.deepEqual(await operation.call(authorization),expected);assert.equal(calls.length,1);
  }
 });
}

test('reassignment keeps its existing exact cost-center edit guard before business RPC, including administrator and legacy roles',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('A denied operation must never call the provider');};
 for(const profile of[{isAdmin:false,grants:[]},{isAdmin:true,grants:[]},{isAdmin:false,grants:[{resourceKey:'legacy:all',canView:true,canEdit:true}]},{isAdmin:false,grants:[{...grant,canEdit:false}]}]){
  const authorization='Bearer p158-denied-'+ ++serial;await access.primeRoleAccessCache(authorization,profile);
  await assert.rejects(()=>service.reassignCostCenterUpApprover(authorization,payload),error=>error.status===403&&error.message==='Requiere permiso explícito para mantener este catálogo.');
 }
 await assert.rejects(()=>service.reassignCostCenterUpApprover('',payload),error=>error.status===401&&error.message==='Debe iniciar sesión.');assert.equal(calls,0);
});
test('local approver validator remains unchanged and rejects before provider I/O without promoting status',()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Invalid identifiers must never call the provider');};
 for(const id of[0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'42',null,undefined])assert.throws(()=>service.listCostCentersByUpApprover('Bearer synthetic',id),error=>error.message==='El aprobador UP no es válido.'&&error.status===undefined);
 assert.equal(calls,0);
});
test('valid safe-integer approver identifiers retain the original numeric RPC parameter domain',async()=>{
 const authorization=await actor();const operation={...operations[2],args:{p_approver_id:Number.MAX_SAFE_INTEGER}};const calls=mock(operation,authorization,()=>Response.json({synthetic:true}));
 assert.deepEqual(await service.listCostCentersByUpApprover(authorization,Number.MAX_SAFE_INTEGER),{synthetic:true});assert.equal(calls.length,1);
});
test('missing provider configuration keeps the existing local error without network I/O',async()=>{
 delete process.env.SUPABASE_URL;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Missing configuration must never call the provider');};
 await assert.rejects(()=>service.upApproverOptions('Bearer synthetic'),error=>error.message==='Supabase no está configurado.'&&error.status===undefined);assert.equal(calls,0);
});
