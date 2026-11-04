import assert from 'node:assert/strict';
import test from 'node:test';

assert.deepEqual(process.argv.slice(2),[],'This synthetic fixture accepts no destinations or credentials');
const originalEnvironment=process.env,originalFetch=globalThis.fetch,originalLoadEnvFile=process.loadEnvFile;
const environment={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(originalEnvironment[key]!==undefined)environment[key]=originalEnvironment[key];
Object.assign(environment,{SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_ANON_KEY:'p143-synthetic-public',SUPABASE_PUBLISHABLE_KEY:'p143-synthetic-public',DISABLE_BACKGROUND_JOBS:'true'});
process.env={...environment};process.loadEnvFile=()=>{throw Error('Environment files disabled in this fixture');};
globalThis.fetch=async()=>{throw Error('Unexpected fetch during synthetic module initialization');};
const {bootstrapSession}=await import('../dist/modules/auth/services/bootstrap.service.js');
const access=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
process.env=originalEnvironment;globalThis.fetch=originalFetch;
test.beforeEach(()=>{process.env={...environment};access.invalidateRoleAccessCaches();});
test.afterEach(()=>{process.env=originalEnvironment;globalThis.fetch=originalFetch;access.invalidateRoleAccessCaches();});
test.after(()=>{process.loadEnvFile=originalLoadEnvFile;});
const canary='P143_SYNTHETIC_PRIVATE_PROVIDER_CONTEXT';
const session='La sesión no es válida. Inicie sesión nuevamente.';
const generic='No fue posible preparar la sesión. Inténtelo nuevamente.';
function expectedBootstrap(status){return status===401?session:status===403?'No tiene acceso al rol o a la empresa seleccionados.':status===429?'Espere un momento antes de volver a preparar la sesión.':[400,409,422].includes(status)?'No fue posible seleccionar el rol o la empresa. Revise su acceso e inténtelo nuevamente.':generic;}
function privateResponse(status,format){return format==='json'?Response.json({message:canary,code:canary,details:canary,hint:canary,access_token:canary},{status,headers:{'Retry-After':'999999'}}):new Response(format==='empty'?'':'<private>'+canary,{status});}
function provider(path,reply){const calls=[];globalThis.fetch=async(input,init={})=>{const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,environment.SUPABASE_URL);assert.equal(url.pathname,path);assert.equal(init.method,'POST');const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer p143-synthetic-actor');assert.equal(headers.get('apikey'),environment.SUPABASE_ANON_KEY);calls.push(JSON.parse(init.body));return reply();};return calls;}
function fixedFailure(status,message){return error=>{assert.ok(error instanceof Error);assert.equal(error.status,status);assert.equal(error.message,message);assert.ok(![error.message,error.stack,JSON.stringify(error)].join('\n').includes(canary));for(const field of['cause','code','details','hint','payload','data','retryAfterSeconds'])assert.equal(error[field],undefined);return true;};}

for(const status of[400,401,403,404,405,409,422,429,500,503])test('bootstrap HTTP '+status+' preserves status and replaces JSON, empty and malformed provider messages',async()=>{
 for(const format of['json','empty','malformed']){
  const calls=provider('/rest/v1/rpc/auth_bootstrap_context',()=>privateResponse(status,format));
  await assert.rejects(()=>bootstrapSession('Bearer p143-synthetic-actor',{preferredRoleId:2,preferredSubsidiaryId:7}),fixedFailure(status,expectedBootstrap(status)));
  assert.deepEqual(calls,[{p_preferred_role_id:2,p_preferred_subsidiary_id:7}]);
 }
});

for(const status of[400,401,403,404,409,422,429,500,503])test('matrix HTTP '+status+' preserves existing 401/403 coercion without provider JSON or parse details',async()=>{
 for(const format of['json','empty','malformed']){
  const calls=provider('/rest/v1/rpc/security_role_access_matrix_data',()=>privateResponse(status,format));
  const expected=status===401?401:403;
  await assert.rejects(()=>access.roleAccessMatrix('Bearer p143-synthetic-actor',2),fixedFailure(expected,expected===401?session:'No fue posible consultar la matriz de permisos. Verifique su acceso e inténtelo nuevamente.'));
  assert.deepEqual(calls,[{p_role_id:2}]);
 }
});

test('matrix success preserves its data and the local resource catalog',async()=>{
 const payload={selectedRoleId:2,roles:[{roleId:2,name:'Synthetic',description:null,isSystemRole:false}],grants:[{resourceKey:'accounting:journals',canView:true,canCreate:false,canEdit:false,canDelete:false}],specialPermissions:[],isAdministratorRole:false};
 const calls=provider('/rest/v1/rpc/security_role_access_matrix_data',()=>Response.json(payload));
 const result=await access.roleAccessMatrix('Bearer p143-synthetic-actor',2);
 assert.deepEqual({...result,modules:undefined},{...payload,modules:undefined});assert.ok(result.modules.length>10);assert.deepEqual(calls,[{p_role_id:2}]);
});
