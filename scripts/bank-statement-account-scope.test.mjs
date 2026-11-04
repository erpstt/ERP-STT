import assert from 'node:assert/strict';
import {test,beforeEach,afterEach,after} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const origin='https://synthetic-p153.invalid';
const anonKey='SYNTHETIC-P153-PUBLIC-KEY';
const serviceKey='SYNTHETIC-P153-SERVICE-KEY-NEVER-TRANSMIT';
process.env.SUPABASE_URL=origin;
process.env.SUPABASE_ANON_KEY=anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY=serviceKey;
const originalFetch=globalThis.fetch;
const unexpectedFetch=async()=>{throw Error('Unexpected request in isolated bank-statement test.');};
globalThis.fetch=unexpectedFetch;
const {createBankingRow,getBankingCatalog,listBankStatementAccountOptions,updateBankingRow}=await import('../dist/modules/banking-catalogs/banking-catalogs.module.js');
const {invalidateRoleAccessCaches}=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
const catalog=getBankingCatalog('bank-statements');
const resource='banking:bank-statements';
const payload={statement_date:'2026-11-01',bank_account_id:9101,opening_balance:100,closing_balance:125,source_file_name:'SYNTHETIC-P153-STATEMENT.csv'};
const row={statement_id:9201,...payload};
const option={bank_account_id:9101,subsidiary_id:9301,bank_name:'SYNTHETIC-P153-BANK',account_number:'SYNTHETIC-P153-ACCOUNT',currency_code:'USD'};
const guardPath='/rest/v1/rpc/security_my_role_access';
const writerPath='/rest/v1/rpc/save_bank_statement_metadata';
const optionsPath='/rest/v1/rpc/bank_statement_account_options';
let identityNumber=0;
function identity(name,{view=false,create=false,edit=false,resourceKey=resource,grants}={}){
 const number=String(++identityNumber).padStart(12,'0');
 // JWT-shaped synthetic identities exercise the real cache scope and guard.
 // These tokens are not signed credentials and are never sent to a live Auth API.
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const authorization='Bearer '+encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'00000000-0000-4000-8000-'+number,session_id:'00000000-0000-4000-9000-'+number,role:'authenticated'})+'.synthetic-test-signature';
 return{name,authorization,data:{isAdmin:false,grants:grants??[{resourceKey,canView:view,canCreate:create,canEdit:edit,canDelete:false}]}};
}
function response(body,status=200){
 return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
}
function mock(t,identities,{guard,writer,options}={}){
 const calls=[],byAuthorization=new Map(identities.map(actor=>[actor.authorization,actor]));
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input)),headers=new Headers(init.headers);
  assert.equal(url.origin,origin);assert.equal(url.search,'');assert.equal(init.method,'POST');
  const actor=byAuthorization.get(headers.get('Authorization'));
  assert.ok(actor,'Only an explicitly declared synthetic identity may issue a request.');
  assert.equal(headers.get('apikey'),anonKey);
  assert.notEqual(headers.get('apikey'),serviceKey);assert.notEqual(headers.get('Authorization'),'Bearer '+serviceKey);
  const call={path:url.pathname,method:init.method,authorization:headers.get('Authorization'),apikey:headers.get('apikey'),payload:JSON.parse(init.body)};
  calls.push(call);
  if(url.pathname===guardPath){assert.deepEqual(call.payload,{});return guard?guard(call,actor):response(actor.data);}
  if(url.pathname===writerPath)return writer?writer(call,actor):response(row);
  if(url.pathname===optionsPath){assert.deepEqual(call.payload,{});return options?options(call,actor):response([option]);}
  throw Error('Unexpected endpoint; direct bank-account reads and raw statement writes are forbidden in this test.');
 };
 t.after(()=>{globalThis.fetch=unexpectedFetch;});
 return calls;
}
const expected=(actor,path,body)=>({path,method:'POST',authorization:actor.authorization,apikey:anonKey,payload:body});
beforeEach(()=>{invalidateRoleAccessCaches();globalThis.fetch=unexpectedFetch;});
afterEach(()=>{invalidateRoleAccessCaches();globalThis.fetch=unexpectedFetch;});
after(()=>{invalidateRoleAccessCaches();globalThis.fetch=originalFetch;});

test('account options use the dedicated RPC with the caller JWT, anon key and a synthetic DTO',async t=>{
 const reader=identity('reader',{view:true}),calls=mock(t,[reader]);
 assert.deepEqual(await listBankStatementAccountOptions(reader.authorization),[option]);
 assert.deepEqual(calls,[expected(reader,optionsPath,{})]);
});

test('an options RPC denial rejects without querying raw accounts or invoking a writer',async t=>{
 const denied=identity('options-denied',{grants:[]}),calls=mock(t,[denied],{options:()=>response({code:'42501',message:'No tiene acceso a las cuentas sintéticas.'},403)});
 // Options delegate scope/permission checks to their RPC; no local guard is invented.
 await assert.rejects(listBankStatementAccountOptions(denied.authorization),/No tiene acceso a las cuentas sintéticas/);
 assert.deepEqual(calls,[expected(denied,optionsPath,{})]);
});

test('create permission calls the real role guard and then the metadata RPC with a null statement id',async t=>{
 const creator=identity('creator',{view:true,create:true}),calls=mock(t,[creator]);
 assert.deepEqual(await createBankingRow(catalog,creator.authorization,payload),row);
 assert.deepEqual(calls,[expected(creator,guardPath,{}),expected(creator,writerPath,{p_statement_id:null,p_payload:payload})]);
});

test('edit permission calls the real role guard and then the metadata RPC preserving id and payload',async t=>{
 const editor=identity('editor',{view:true,edit:true});
 const edited={...payload,closing_balance:130,source_file_name:'SYNTHETIC-P153-EDIT.csv'};
 const updatedRow={...row,...edited},calls=mock(t,[editor],{writer:()=>response(updatedRow)});
 assert.deepEqual(await updateBankingRow(catalog,editor.authorization,9201,edited),updatedRow);
 assert.deepEqual(calls,[expected(editor,guardPath,{}),expected(editor,writerPath,{p_statement_id:9201,p_payload:edited})]);
});

test('reader, missing, wrong-resource and viewless grants deny before any metadata writer',async t=>{
 const deniedCases=[
  [identity('no-grants-create',{grants:[]}),false],[identity('no-grants-edit',{grants:[]}),true],
  [identity('reader-create',{view:true}),false],[identity('reader-edit',{view:true}),true],
  [identity('creator-without-view',{create:true}),false],[identity('editor-without-view',{edit:true}),true],
  [identity('creator-cannot-edit',{view:true,create:true}),true],[identity('editor-cannot-create',{view:true,edit:true}),false],
  [identity('other-resource-create',{view:true,create:true,resourceKey:'banking:bank-accounts'}),false],
  [identity('other-resource-edit',{view:true,edit:true,resourceKey:'banking:bank-accounts'}),true]
 ];
 const calls=mock(t,deniedCases.map(([actor])=>actor));
 for(const [actor,isEdit]of deniedCases){
  const before=calls.length;
  await assert.rejects(isEdit?updateBankingRow(catalog,actor.authorization,9201,payload):createBankingRow(catalog,actor.authorization,payload),error=>error.status===403);
  assert.deepEqual(calls.slice(before),[expected(actor,guardPath,{})],actor.name);
 }
});

test('missing or malformed authorization is rejected before role or write requests',async t=>{
 const calls=mock(t,[]);
 for(const authorization of['','Bearer ','Basic SYNTHETIC-P153']){
  await assert.rejects(createBankingRow(catalog,authorization,payload),error=>error.status===401);
  await assert.rejects(updateBankingRow(catalog,authorization,9201,payload),error=>error.status===401);
 }
 assert.deepEqual(calls,[]);
});

test('invalid statement ids are rejected before any upstream request',async t=>{
 const editor=identity('invalid-id-editor',{view:true,edit:true}),calls=mock(t,[editor]);
 for(const id of[0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1])await assert.rejects(updateBankingRow(catalog,editor.authorization,id,payload),error=>error.status===400);
 assert.deepEqual(calls,[]);
});

test('invalid bank-account input reaches only the authorized metadata RPC and preserves its rejection',async t=>{
 const creator=identity('invalid-account-creator',{view:true,create:true});
 const invalid={...payload,bank_account_id:'SYNTHETIC-P153-NOT-AN-ID'};
 const calls=mock(t,[creator],{writer:()=>response({code:'22023',message:'SYNTHETIC-P153-PRIVATE-SQL-DETAIL'},400)});
 await assert.rejects(createBankingRow(catalog,creator.authorization,invalid),error=>error.status===422&&!error.message.includes('PRIVATE-SQL-DETAIL'));
 assert.deepEqual(calls,[expected(creator,guardPath,{}),expected(creator,writerPath,{p_statement_id:null,p_payload:invalid})]);
});

test('a metadata RPC account-scope denial is preserved without a raw-table fallback',async t=>{
 const editor=identity('foreign-scope-editor',{view:true,edit:true});
 const foreign={...payload,bank_account_id:9199};
 const calls=mock(t,[editor],{writer:()=>response({code:'42501',message:'SYNTHETIC-P153-PRIVATE-SQL-DETAIL'},403)});
 await assert.rejects(updateBankingRow(catalog,editor.authorization,9201,foreign),error=>error.status===403&&!error.message.includes('PRIVATE-SQL-DETAIL'));
 assert.deepEqual(calls,[expected(editor,guardPath,{}),expected(editor,writerPath,{p_statement_id:9201,p_payload:foreign})]);
});

test('role RPC denial fails closed before the metadata writer',async t=>{
 const creator=identity('unavailable-role-context',{view:true,create:true});
 const calls=mock(t,[creator],{guard:()=>response({code:'42501',message:'SYNTHETIC-P153-PRIVATE-ROLE-DETAIL'},403)});
 await assert.rejects(createBankingRow(catalog,creator.authorization,payload),error=>error.status===403&&!error.message.includes('PRIVATE-ROLE-DETAIL'));
 assert.deepEqual(calls,[expected(creator,guardPath,{})]);
});
