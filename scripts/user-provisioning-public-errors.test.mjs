import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

assert.deepEqual(process.argv.slice(2),[],'This isolated fixture accepts no destinations or credentials');
const path=new URL('../src/modules/auth/services/user-provisioning.service.ts',import.meta.url);
const source=await readFile(path,'utf8');
const ast=ts.createSourceFile(path.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['payload','serviceRestMessage','actorRpcMessage','authAdminMessage','legacyAuthDuplicate','serviceRest','actorRpc','authAdmin'];
const declarations=ast.statements.filter(node=>ts.isClassDeclaration(node)&&node.name?.text==='UserProvisioningError'||ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));
assert.equal(declarations.length,names.length+1);
// Evaluate the actual private helpers, without importing Auth/SMTP modules or
// running account flows. Existing isolated suites cover their real callers.
const compiled=ts.transpileModule(declarations.map(node=>node.getText(ast)).join('\n')+'\nexport {serviceRest,actorRpc,authAdmin};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const canary='P159_SYNTHETIC_PRIVATE_'+randomBytes(18).toString('hex');
const config=Object.freeze({url:'http://127.0.0.1:9',anonKey:'fake-public',serviceKey:'fake-service'});
const authorization='Bearer p159-synthetic-actor';
const erpDuplicate='Ya existe un usuario con ese correo electrónico.';
const authDuplicate='Ya existe una cuenta de acceso para ese correo electrónico.';
const restMessages=new Map([
 ['users','No fue posible administrar la información del usuario.'],
 ['user_invitation_grants','No fue posible administrar la invitación del usuario.'],
 ['password_recovery_grants','No fue posible administrar el enlace de recuperación.'],
 ['password_history','No fue posible consultar o registrar el historial de contraseñas.'],
 ['rpc/consume_user_invitation_grant','No fue posible verificar y consumir la invitación.'],
 ['rpc/security_audit_user_password_notification','No fue posible registrar la auditoría del enlace de recuperación.'],
 ['rpc/security_revoke_user_sessions','No fue posible cerrar las sesiones del usuario.'],
 ['unknown','No fue posible administrar la invitación.'],
]);
const rpcMessages=new Map([
 ['security_assert_role_access','No fue posible verificar el permiso para crear usuarios.'],
 ['security_create_user','No fue posible crear el usuario en el ERP.'],
 ['security_mark_user_invitation_sent','No fue posible registrar el envío de la invitación.'],
 ['security_prepare_user_password_recovery','No fue posible preparar el enlace de recuperación para el usuario indicado.'],
 ['unknown','No fue posible crear el usuario en el ERP.'],
]);
function fixture(respond){
 const calls=[],unexpected=[];const exports={};
 const context=vm.createContext({exports,URL,Response,Error,JSON,Number,String,Object,Array,config:()=>config,
  fetch(){unexpected.push('unmocked fetch');throw Error('Provider fetch must remain synthetic');},
  async fetchSupabase(input,init={}){const url=new URL(String(input));if(url.origin!==config.url){unexpected.push('unexpected provider origin');throw Error('Unexpected synthetic provider origin');}const call={url,init,headers:new Headers(init.headers)};calls.push(call);return respond(call);},
  console:{log(){unexpected.push('logging');},error(){unexpected.push('logging');},warn(){unexpected.push('logging');}}
 });
 new vm.Script(compiled,{filename:'actual-user-provisioning-helpers.cjs'}).runInContext(context,{timeout:1000});
 return{...exports,calls,unexpected};
}
function publicError(f,status,message){return error=>{
 assert.ok(error instanceof f.UserProvisioningError);assert.equal(error.name,'UserProvisioningError');assert.equal(error.status,status);assert.equal(error.retryAfterSeconds,undefined);assert.equal(error.message,message);
 for(const value of[error.message,error.stack,JSON.stringify(error)])assert.equal(String(value).includes(canary),false);
 for(const key of['cause','code','details','hint','payload','data','response'])assert.equal(error[key],undefined);
 assert.deepEqual(f.unexpected,[]);return true;
};}
function errorBody(code){return{...(code===undefined?{}:{code}),message:canary,msg:canary,error_description:canary,details:canary,hint:canary};}
function serviceHeaders(call){assert.equal(call.headers.get('apikey'),config.serviceKey);assert.equal(call.headers.get('authorization'),'Bearer '+config.serviceKey);assert.equal(call.headers.get('content-type'),'application/json');}
function actorHeaders(call){assert.equal(call.headers.get('apikey'),config.anonKey);assert.equal(call.headers.get('authorization'),authorization);assert.equal(call.headers.get('content-type'),'application/json');}

test('service REST selects only closed contextual constants and never reflects a path, query or provider field',async()=>{
 for(const[resource,message]of restMessages){const f=fixture(call=>{serviceHeaders(call);return Response.json(errorBody(),{status:500});});await assert.rejects(()=>f.serviceRest(resource+'?sensitive='+canary),publicError(f,503,message));assert.equal(f.calls.length,1);}
});
test('service REST preserves strict 23505 conflicts, every existing status branch and private request credentials',async()=>{
 const cases=[[400,undefined,503],[401,undefined,503],[403,'42501',503],[409,undefined,409],[429,undefined,503],[500,undefined,503],[503,'23505',409],[400,'23505',409],[400,23505,503]];
 for(const[status,code,expected]of cases){const f=fixture(call=>{serviceHeaders(call);assert.equal(call.init.method,'POST');assert.equal(call.headers.get('prefer'),'return=minimal');assert.deepEqual(JSON.parse(call.init.body),{synthetic:true});return Response.json(errorBody(code),{status});});await assert.rejects(()=>f.serviceRest('users',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({synthetic:true})}),publicError(f,expected,expected===409?erpDuplicate:restMessages.get('users')));assert.equal(f.calls.length,1);}
});
test('service REST non-JSON and nonobject error bodies keep the existing 409-or-503 fallback',async()=>{
 for(const status of[400,401,403,409,429,500,503])for(const body of['',canary,'<html>'+canary+'</html>','{"message":"'+canary,'null','[]',JSON.stringify(canary)]){const f=fixture(()=>new Response(body,{status}));await assert.rejects(()=>f.serviceRest('user_invitation_grants'),publicError(f,status===409?409:503,status===409?erpDuplicate:restMessages.get('user_invitation_grants')));}
});
test('actor RPC contexts remain fixed while the caller JWT, public key and arguments remain untouched',async()=>{
 for(const[name,message]of rpcMessages){const body={synthetic:true};const f=fixture(call=>{actorHeaders(call);assert.equal(call.init.method,'POST');assert.equal(call.url.pathname,'/rest/v1/rpc/'+name);assert.deepEqual(JSON.parse(call.init.body),body);return Response.json(errorBody(),{status:400});});await assert.rejects(()=>f.actorRpc(authorization,name,body),publicError(f,400,message));assert.equal(f.calls.length,1);}
});
test('actor RPC retains conflict-before-forbidden precedence and its existing numeric-code coercion',async()=>{
 const cases=[[400,undefined,400],[401,undefined,403],[403,undefined,403],[409,'42501',409],[403,'23505',409],[500,'23505',409],[500,'42501',403],[400,23505,409],[400,42501,403],[429,undefined,400],[500,undefined,503],[503,undefined,503]];
 for(const[status,code,expected]of cases){const f=fixture(call=>{actorHeaders(call);return Response.json(errorBody(code),{status});});await assert.rejects(()=>f.actorRpc(authorization,'security_create_user',{}),publicError(f,expected,expected===409?erpDuplicate:rpcMessages.get('security_create_user')));}
});
test('actor RPC empty and non-JSON errors use fixed messages without promoting statuses',async()=>{
 for(const[status,expected]of[[400,400],[401,403],[403,403],[409,409],[429,400],[500,503],[503,503]])for(const body of['',canary,'<html>'+canary+'</html>','{"message":"'+canary]){const f=fixture(()=>new Response(body,{status}));await assert.rejects(()=>f.actorRpc(authorization,'security_prepare_user_password_recovery',{}),publicError(f,expected,expected===409?erpDuplicate:rpcMessages.get('security_prepare_user_password_recovery')));}
});
test('Auth administration uses only closed link/account constants, including unknown or identifier-bearing paths',async()=>{
 for(const[path,message]of[['admin/generate_link','No fue posible generar el enlace de acceso.'],['admin/users','No fue posible crear la cuenta de acceso.'],['admin/users/'+canary,'No fue posible administrar la cuenta de acceso.'],['unknown?value='+canary,'No fue posible administrar la cuenta de acceso.']]){const f=fixture(call=>{serviceHeaders(call);assert.equal(call.init.method,'PUT');assert.deepEqual(JSON.parse(call.init.body),{synthetic:true});return Response.json(errorBody(),{status:500});});await assert.rejects(()=>f.authAdmin(path,{method:'PUT',body:JSON.stringify({synthetic:true})}),publicError(f,400,message));assert.equal(f.calls.length,1);}
});
test('Auth duplicate classification preserves the exact first-nonempty message/msg/error_description precedence privately',async()=>{
 const cases=[
  [400,{message:canary},400],
  [400,{message:'already '+canary},409],
  [400,{msg:'registered '+canary},409],
  [400,{error_description:'exists '+canary},409],
  [400,{message:canary,msg:'duplicate '+canary},400],
  [400,{message:' \n',msg:'duplicate '+canary},409],
  [400,{message:10,msg:'DUPLICATE '+canary},409],
  [400,{message:null,msg:'   ',error_description:'already '+canary},409],
  [400,{details:'duplicate '+canary,hint:'exists '+canary,error:'already '+canary},400],
  [400,{code:'email_exists',message:canary},400],
  [409,{message:canary},409],
  [500,{message:'already '+canary},409],
 ];
 for(const[status,body,expected]of cases){const f=fixture(()=>Response.json(body,{status}));await assert.rejects(()=>f.authAdmin('admin/users',{method:'POST'}),publicError(f,expected,expected===409?authDuplicate:'No fue posible crear la cuenta de acceso.'));}
});
test('Auth empty, malformed and nonobject error bodies retain HTTP409-only duplicates and 400 otherwise',async()=>{
 for(const status of[400,401,403,409,429,500,503])for(const body of['',canary,'{"message":"'+canary,'null','[]',JSON.stringify('already '+canary)]){const f=fixture(()=>new Response(body,{status}));await assert.rejects(()=>f.authAdmin('admin/generate_link',{method:'POST'}),publicError(f,status===409?409:400,status===409?authDuplicate:'No fue posible generar el enlace de acceso.'));}
});
test('all three actual helpers preserve successful JSON and empty/non-JSON payload behavior',async()=>{
 for(const expected of[{synthetic:true,message:'Synthetic business response'},[{synthetic:true}],null])for(const kind of['serviceRest','actorRpc','authAdmin']){
  const f=fixture(call=>{if(kind==='actorRpc')actorHeaders(call);else serviceHeaders(call);return expected===null?new Response(null,{status:204}):Response.json(expected);});
  const received=kind==='serviceRest'?await f.serviceRest('users'):kind==='actorRpc'?await f.actorRpc(authorization,'security_create_user',{}):await f.authAdmin('admin/users',{method:'POST'});
  assert.deepEqual(received,expected);assert.equal(f.calls.length,1);assert.deepEqual(f.unexpected,[]);
 }
 for(const kind of['serviceRest','actorRpc','authAdmin']){const f=fixture(()=>new Response('synthetic non-JSON success'));const received=kind==='serviceRest'?await f.serviceRest('users'):kind==='actorRpc'?await f.actorRpc(authorization,'security_create_user',{}):await f.authAdmin('admin/users',{method:'POST'});assert.equal(received,null);}
});
test('the actual UserProvisioningError class keeps local status and Retry-After independently of provider fields',()=>{
 const f=fixture(()=>{throw Error('No provider I/O expected');});const error=new f.UserProvisioningError('Local rate-limit message',429,37);assert.equal(error.name,'UserProvisioningError');assert.equal(error.status,429);assert.equal(error.retryAfterSeconds,37);assert.equal(new f.UserProvisioningError('Local validator message').status,400);assert.equal(f.calls.length,0);
});
