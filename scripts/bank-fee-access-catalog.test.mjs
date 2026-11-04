import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

// No sockets, .env, real actors or SQL. Exercise the real metadata, projection,
// authorization and existing management RPC client with synthetic responses.
const originalEnvironment=process.env,originalFetch=globalThis.fetch,originalLoadEnvFile=process.loadEnvFile;
const environment={};for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP'])if(originalEnvironment[key]!==undefined)environment[key]=originalEnvironment[key];
// Preserve only Node's fixed child-runner marker so its parent counts each case.
// Arbitrary inherited values and all application credentials remain excluded.
if(originalEnvironment.NODE_TEST_CONTEXT==='child-v8')environment.NODE_TEST_CONTEXT='child-v8';
Object.assign(environment,{SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_ANON_KEY:'p165-synthetic-public',SUPABASE_PUBLISHABLE_KEY:'p165-synthetic-public',DISABLE_BACKGROUND_JOBS:'true'});
process.env={...environment};process.loadEnvFile=()=>{throw Error('Environment files disabled in this synthetic fixture');};
let unexpected=[];
const noFetch=async()=>{unexpected.push('UNEXPECTED_FETCH');throw Error('Unexpected synthetic fetch');};
globalThis.fetch=noFetch;
const access=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
const {bankingCatalogs}=await import('../dist/modules/banking-catalogs/banking-catalogs.module.js');
const {bankFeeRpc}=await import('../dist/modules/banking-catalogs/bank-fee.service.js');
const key='banking:bank-fees',actions=['view','create','edit','delete'];
const canary='P165_SYNTHETIC_PRIVATE_PROVIDER_CONTEXT';
let identity=0;
const token=()=>'Bearer p165-synthetic-'+ ++identity;
beforeEach(()=>{process.env={...environment};globalThis.fetch=noFetch;unexpected=[];access.invalidateRoleAccessCaches();});
afterEach(()=>{access.invalidateRoleAccessCaches();process.env=originalEnvironment;globalThis.fetch=originalFetch;assert.deepEqual(unexpected,[]);});
after(()=>{process.loadEnvFile=originalLoadEnvFile;});
function mock(auth,path,reply){
 const calls=[];globalThis.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.origin,environment.SUPABASE_URL);assert.equal(url.pathname,path);assert.equal(url.search,'');assert.equal(init.method,'POST');
  const headers=new Headers(init.headers);assert.ok(headers.get('authorization')===auth,'Only the synthetic actor JWT is forwarded');assert.ok(headers.get('apikey')===environment.SUPABASE_ANON_KEY,'Only the synthetic public key is forwarded');assert.equal(headers.get('content-type'),'application/json');
  const body=JSON.parse(init.body);calls.push(body);return reply(body,calls.length);
 };return calls;
}
const grant=(overrides={})=>({resourceKey:key,canView:true,canCreate:false,canEdit:false,canDelete:false,...overrides});
async function prime(auth,grants=[],isAdmin=false){await access.primeRoleAccessCache(auth,{isAdmin,grants});}
const denied=error=>error instanceof Error&&error.status===403&&error.message==='El rol activo no tiene permiso para realizar esta acción.';

test('bank fees is one custom resource with its four existing actions and no generic table CRUD registration',()=>{
 const matches=access.roleAccessModules.flatMap(module=>module.resources.filter(resource=>resource.key===key));assert.equal(matches.length,1);
 assert.deepEqual(matches[0],{key,moduleKey:'banking',moduleName:'Bancos',optionName:'Comisiones bancarias',actions});
 assert.equal(access.isRoleAccessResource(key),true);assert.equal(bankingCatalogs.some(catalog=>catalog.slug==='bank-fees'),false);
});

test('matrix reads expose the custom metadata without inventing grants or changing provider revision and privileges',async()=>{
 const auth=token(),payload={selectedRoleId:7,roles:[],grants:[],specialPermissions:[],isAdministratorRole:false,_revision:'synthetic-revision'};
 const calls=mock(auth,'/rest/v1/rpc/security_role_access_matrix_data',()=>Response.json(payload));const result=await access.roleAccessMatrix(auth,7);
 assert.deepEqual({...result,modules:undefined},{...payload,modules:undefined});assert.equal(result.modules,access.roleAccessModules);assert.deepEqual(result.grants,[]);assert.deepEqual(calls,[{p_role_id:7}]);
});

test('the existing revision-aware save accepts bank-fee actions and projects only whitelisted booleans and parameters',async()=>{
 const auth=token(),entry={resourceKey:key,canView:true,canCreate:true,canEdit:true,canDelete:true,isAdmin:true,provider_secret:canary},response={success:true,_revision:'synthetic-next'};
 const calls=mock(auth,'/rest/v1/rpc/security_save_access_matrix',()=>Response.json(response));
 const result=await access.saveRoleAccessMatrix(auth,{roleId:7,entries:[entry],specialPermissionIds:[31,31,32],_revision:'synthetic-current',isAdmin:true});
 assert.deepEqual(result,response);assert.deepEqual(calls,[{p_role_id:7,p_entries:[grant({canCreate:true,canEdit:true,canDelete:true})],p_permission_ids:[31,32],p_revision:'synthetic-current'}]);assert.ok(!JSON.stringify(calls).includes(canary));
});

test('save normalizes strict boolean flags without creating implicit view or broadening another resource actions',async()=>{
 const auth=token(),calls=mock(auth,'/rest/v1/rpc/security_save_access_matrix',()=>Response.json({success:true}));
 await access.saveRoleAccessMatrix(auth,{roleId:7,entries:[{resourceKey:key,canView:'true',canCreate:1,canEdit:'true',canDelete:true},{resourceKey:'audit:change-report',canView:true,canCreate:true,canEdit:true,canDelete:true}]});
 assert.deepEqual(calls,[{p_role_id:7,p_entries:[grant({canView:false,canDelete:true}),{resourceKey:'audit:change-report',canView:true,canCreate:false,canEdit:false,canDelete:false}],p_permission_ids:[],p_revision:null}]);
 // The existing SQL is authoritative for the invalid no-view mutation above;
 // this transport mock intentionally does not certify SQL constraint acceptance.
});

test('unknown resources remain rejected before any provider request',async()=>{
 for(const resourceKey of['banking:bank-fees-extra','banking:fees','legacy:all'])await assert.rejects(()=>access.saveRoleAccessMatrix(token(),{roleId:7,entries:[{resourceKey,canView:true,canCreate:true}]}),error=>error.message==='La matriz contiene una opción no válida.');
});

test('metadata registration grants no rights to an unassigned role, another resource or mutation flags without view',async()=>{
 for(const grants of[[],[grant({resourceKey:'banking:bank-accounts',canCreate:true,canEdit:true,canDelete:true})],[grant({canView:false,canCreate:true,canEdit:true,canDelete:true})]]){
  const auth=token();await prime(auth,grants);for(const action of actions)await assert.rejects(()=>access.assertRoleAccess(auth,key,action),denied);
 }
});

test('delegated fee view and each mutation stay independent, while the existing administrator contract remains intact',async()=>{
 for(const enabled of actions){
  const auth=token(),entry=grant(enabled==='view'?{}:{['can'+enabled[0].toUpperCase()+enabled.slice(1)]:true});await prime(auth,[entry]);
  for(const action of actions){if(action==='view'||action===enabled)assert.equal(await access.assertRoleAccess(auth,key,action),null);else await assert.rejects(()=>access.assertRoleAccess(auth,key,action),denied);}
 }
 const admin=token();await prime(admin,[],true);for(const action of actions)assert.equal(await access.assertRoleAccess(admin,key,action),null);
});

test('real fee RPC gates still stop unassigned or no-view callers before I/O and use the exact granted action',async()=>{
 for(const grants of[[],[grant({canView:false,canCreate:true,canEdit:true,canDelete:true})]]){
  const auth=token();await prime(auth,grants);for(const action of actions)await assert.rejects(()=>bankFeeRpc(auth,action,'bank_fee_options'),denied);
 }
 for(const action of actions){
  const auth=token();await prime(auth,[grant(action==='view'?{}:{['can'+action[0].toUpperCase()+action.slice(1)]:true})]);
  const name={view:'bank_fee_options',create:'save_bank_fee',edit:'update_bank_fee',delete:'delete_bank_fee'}[action],calls=mock(auth,'/rest/v1/rpc/'+name,()=>Response.json({synthetic:true}));
  assert.deepEqual(await bankFeeRpc(auth,action,name,{synthetic:true}),{synthetic:true});assert.deepEqual(calls,[{synthetic:true}]);globalThis.fetch=noFetch;
 }
});

test('matrix save preserves denial/conflict handling and does not echo private provider fields',async()=>{
 for(const[status,code,expected]of[[403,'42501',403],[409,'55000',409],[400,'22023',400]]){
  const auth=token(),calls=mock(auth,'/rest/v1/rpc/security_save_access_matrix',()=>Response.json({message:canary,details:canary,code},{status}));
  await assert.rejects(()=>access.saveRoleAccessMatrix(auth,{roleId:7,entries:[grant()],_revision:'synthetic-stale'}),error=>error.status===expected&&!error.message.includes(canary));assert.equal(calls.length,1);assert.equal(calls[0].p_revision,'synthetic-stale');
 }
});

test('successful saves keep the existing permission cache invalidation rather than retaining stale fee rights',async()=>{
 const auth=token();await prime(auth,[grant({canEdit:true})]);assert.equal(await access.assertRoleAccess(auth,key,'edit'),null);
 const saves=mock(auth,'/rest/v1/rpc/security_save_access_matrix',()=>Response.json({success:true}));await access.saveRoleAccessMatrix(auth,{roleId:7,entries:[grant()],_revision:'synthetic-current'});assert.equal(saves.length,1);
 const reads=mock(auth,'/rest/v1/rpc/security_my_role_access',()=>Response.json({isAdmin:false,grants:[grant()]}));await assert.rejects(()=>access.assertRoleAccess(auth,key,'edit'),denied);assert.equal(reads.length,1);assert.equal(await access.assertRoleAccess(auth,key,'view'),null);assert.equal(reads.length,1);
});
