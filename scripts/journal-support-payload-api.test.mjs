import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();

const originalEnvironment=process.env,originalFetch=globalThis.fetch;
const osEnvironment={};
for(const key of['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','Path','TEMP','TMP'])if(originalEnvironment[key]!==undefined)osEnvironment[key]=originalEnvironment[key];
const publicKey='p113-synthetic-public-key',canary='SYNTHETIC_P113_PRIVATE_DETAIL_NOT_FOR_OUTPUT';
const environment={...osEnvironment,SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_ANON_KEY:publicKey,SUPABASE_PUBLISHABLE_KEY:publicKey,SUPABASE_SERVICE_ROLE_KEY:canary,DISABLE_BACKGROUND_JOBS:'true',EMAIL_NOTIFICATIONS_ENABLED:'false'};
let accounting,roles;
try{
 process.env={...environment};
 globalThis.fetch=async()=>{throw Error('Unexpected import-time transport operation');};
 // Catalogs and their real permission matrix share ESM bindings.
 roles=await import('../dist/modules/security-catalogs/role-access-matrix.module.js');
 accounting=await import('../dist/modules/accounting-catalogs/accounting-catalogs.module.js');
}finally{process.env=originalEnvironment;globalThis.fetch=originalFetch;}

const catalog=accounting.getAccountingCatalog('journal-supports');
const grant=(view=true,create=true,edit=true,remove=true)=>({resourceKey:'accounting:journal-supports',canView:view,canCreate:create,canEdit:edit,canDelete:remove});
let tokenCounter=0;
const token=()=> 'Bearer p113-synthetic-user-'+(++tokenCounter);
const file=()=>({journal_id:'101',support_type:'Archivo',display_name:' Receipt / Q4 ',file_name:'receipt.txt',mime_type:'TEXT/PLAIN',file_size:'9',file_data:'data:TEXT/PLAIN;base64,U3ludGhldGlj'});
const link=()=>({journal_id:'101',support_type:'Enlace',display_name:' Receipt / Q4 ',support_url:'HTTPS://EXAMPLE.INVALID:443/receipt'});
function safe(error,status){
 assert.equal(error.status,status);assert.ok(!String(error.message).includes(canary));assert.ok(!String(error.stack).includes(canary));assert.equal(error.cause,undefined);return true;
}
const rejected=status=>error=>safe(error,status);
function unit(name,work){
 test(name,async t=>{
  process.env={...environment};roles.invalidateRoleAccessCaches();
  globalThis.fetch=async()=>{throw Error('Unexpected fixture transport operation');};
  t.after(()=>{roles.invalidateRoleAccessCaches();process.env=originalEnvironment;globalThis.fetch=originalFetch;});
  await work(t);
 });
}
function mock({grants=[grant()],respond}={}){
 const calls=[],data=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)),headers=new Headers(init.headers);
  assert.equal(url.origin,'http://127.0.0.1:9','Only the synthetic mocked provider is allowed');
  assert.equal(headers.get('apikey'),publicKey);assert.match(headers.get('authorization')??'',/^Bearer p113-synthetic-user-/);
  assert.ok(!JSON.stringify(Object.fromEntries(headers)).includes(canary));
  const call={path:url.pathname,query:url.search,method:(init.method??'GET').toUpperCase(),headers,body:init.body?JSON.parse(String(init.body)):null};
  calls.push(call);
  if(call.path==='/rest/v1/rpc/security_my_role_access')return Response.json({isAdmin:false,grants});
  assert.ok(['/rest/v1/journal_support','/rest/v1/accounting_books'].includes(call.path),'Unexpected data endpoint');
  data.push(call);
  if(respond)return respond(call);
  if(call.method==='DELETE')return new Response(null,{status:204});
  return Response.json([{support_id:7,...call.body}]);
 };
 return{calls,data};
}
async function write(action,auth,input){
 return action==='create'?accounting.createAccountingRow(catalog,auth,input):accounting.updateAccountingRow(catalog,auth,7,input);
}
function unreadable(){
 let reads=0;
 return{input:new Proxy({}, {get(){reads++;throw Error(canary);},ownKeys(){reads++;throw Error(canary);}}),reads:()=>reads};
}

unit('invalid Bearer stops before payload reads, validation, configuration and transport',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error(canary);};
 let configurationReads=0;
 process.env=new Proxy({...environment},{get(target,key){if(key==='SUPABASE_URL'||key==='SUPABASE_ANON_KEY'){configurationReads++;throw Error(canary);}return Reflect.get(target,key);}});
 const guarded=unreadable();
 for(const auth of['','Basic synthetic','Bearer','Bearer token with spaces'])for(const action of['create','edit']){
  await assert.rejects(()=>write(action,auth,guarded.input),rejected(401));
 }
 assert.equal(calls,0);assert.equal(configurationReads,0);assert.equal(guarded.reads(),0);
});

unit('missing view or exact action stops before spreading, coercing or validating the input',async()=>{
 const f=mock(),guarded=unreadable();
 const cases=[
  [[],['create','edit']],[[grant(false,true,true)],['create','edit']],
  [[grant(true,false,true)],['create']],[[grant(true,true,false)],['edit']],
  [[{...grant(),resourceKey:'inventory:products'}],['create','edit']]
 ];
 for(const[grants,actions]of cases){const auth=token();await roles.primeRoleAccessCache(auth,{isAdmin:false,grants});for(const action of actions)await assert.rejects(()=>write(action,auth,guarded.input),rejected(403));}
 assert.equal(guarded.reads(),0);assert.equal(f.calls.length,0);
});

unit('live permission resolution may deny but never issues a data write or inspects denied input',async()=>{
 const f=mock({grants:[]}),guarded=unreadable();
 await assert.rejects(()=>write('create',token(),guarded.input),rejected(403));
 assert.equal(f.calls.length,1);assert.equal(f.data.length,0);assert.equal(guarded.reads(),0);
});

unit('authorized malformed JSON is rejected before any REST write in both create and update',async()=>{
 const f=mock(),auth=token();
 const inputs=[null,true,1,'invalid',[],{},[file()],{...file(),file_size:{}},{...file(),file_data:[]},{...file(),file_size:'9\n'},{...file(),file_size:1},{...file(),file_data:'data:text/plain;base64,AR=='},{...file(),mime_type:'application/pdf'},{...file(),support_id:7}];
 for(const action of['create','edit'])for(const input of inputs)await assert.rejects(()=>write(action,auth,input),rejected(400));
 assert.equal(f.calls.length,1);assert.equal(f.data.length,0);
});

unit('validation precedes reading journal_id and never invokes its accessor',async()=>{
 const f=mock(),auth=token();let reads=0;
 const input={...file(),get journal_id(){reads++;throw Error(canary);}};
 for(const action of['create','edit'])await assert.rejects(()=>write(action,auth,input),rejected(400));
 assert.equal(reads,0);assert.equal(f.data.length,0);
});

unit('valid create sends canonical bytes and metadata while preserving journal_id, user JWT and anon key',async()=>{
 const f=mock(),auth=token(),input=Object.freeze({...file(),_new:true,unrecognized:canary});
 const result=await write('create',auth,input);
 assert.equal(result.support_id,7);assert.equal(f.calls.length,2);assert.equal(f.data.length,1);
 const call=f.data[0];assert.equal(call.method,'POST');assert.equal(call.path,'/rest/v1/journal_support');assert.equal(call.query,'');
 assert.equal(call.headers.get('authorization'),auth);assert.equal(call.headers.get('Prefer'),'return=representation');
 assert.deepEqual(call.body,{journal_id:101,support_type:'Archivo',display_name:'Receipt / Q4',support_url:null,file_name:'receipt.txt',mime_type:'text/plain',file_size:9,file_data:'data:text/plain;base64,U3ludGhldGlj'});
 assert.equal(input.journal_id,'101');assert.equal(input.mime_type,'TEXT/PLAIN');assert.equal(input.file_size,'9');
 assert.ok(!JSON.stringify(call.body).includes(canary));
});

unit('valid update validates a replacement and preserves its canonical id filter and original JWT',async()=>{
 const f=mock(),auth=token();
 await write('edit',auth,{...file(),file_size:9});
 assert.equal(f.data.length,1);assert.equal(f.data[0].method,'PATCH');assert.equal(f.data[0].query,'?support_id=eq.7');
 assert.equal(f.data[0].body.journal_id,101);assert.equal(f.data[0].body.file_size,9);assert.equal(f.data[0].headers.get('authorization'),auth);
});

unit('valid links use canonical HTTPS and leave file fields empty under the existing sanitizer',async()=>{
 const f=mock(),auth=token();
 for(const action of['create','edit'])await write(action,auth,link());
 for(const call of f.data)assert.deepEqual(call.body,{journal_id:101,support_type:'Enlace',display_name:'Receipt / Q4',support_url:'https://example.invalid/receipt',file_name:null,mime_type:null,file_size:null,file_data:null});
});

unit('empty link file fields cannot survive projection and become coerced numeric metadata',async()=>{
 const f=mock(),auth=token();
 for(const action of['create','edit'])for(const empty of[' ',null,'']){
  await write(action,auth,{...link(),file_name:empty,mime_type:empty,file_size:empty,file_data:empty});
 }
 assert.equal(f.data.length,6);
 for(const call of f.data)for(const key of['file_name','mime_type','file_size','file_data'])assert.equal(call.body[key],null);
});

unit('unsafe links, executable MIME and mixed link/file payloads return safe 400 without REST writes',async()=>{
 const f=mock(),auth=token();
 const bad=[
  {...link(),support_url:'http://example.invalid/receipt'},
  {...link(),support_url:'https://'+canary+'@example.invalid/receipt'},
  {...link(),support_url:'https://example.invalid/\nreceipt'},
  {...link(),support_url:'https://example.invalid\\@other.invalid/'},
  {...link(),file_size:0}, {...file(),support_url:'https://example.invalid/'},
  {...file(),mime_type:'text/html',file_data:'data:text/html;base64,U3ludGhldGlj'}
 ];
 for(const action of['create','edit'])for(const input of bad)await assert.rejects(()=>write(action,auth,input),rejected(400));
 assert.equal(f.data.length,0);
});

unit('oversized metadata and encoded content retain typed safe 413 and produce no REST writes',async()=>{
 const f=mock(),auth=token();
 const oversized={...file(),file_data:'data:text/plain;base64,'+'A'.repeat(7_000_100)};
 for(const action of['create','edit'])for(const input of[{...file(),file_size:5*1024*1024+1},oversized]){
  await assert.rejects(()=>write(action,auth,input),error=>{safe(error,413);assert.equal(error.code,'SUPPORT_LIMIT_EXCEEDED');return true;});
 }
 assert.equal(f.data.length,0);
});

unit('all previously compatible download families still reach REST through the generic writer',async()=>{
 const f=mock(),auth=token();
 for(const mime_type of['application/octet-stream','application/zip','application/xml','application/msword','application/vnd.synthetic.future+zip','text/xml','text/csv']){
  await write('create',auth,{...file(),file_name:'receipt.opaque',mime_type,file_data:'data:'+mime_type+';base64,U3ludGhldGlj'});
 }
 assert.equal(f.data.length,7);
});

unit('historical list and delete keep their original behavior and authorization without revalidation',async()=>{
 const historical={support_id:7,journal_id:101,support_type:'Archivo',display_name:'Historical',mime_type:'text/html',file_size:0,file_data:'historical noncanonical bytes'};
 const f=mock({respond:call=>call.method==='GET'?Response.json([historical]):new Response(null,{status:204})}),auth=token();
 assert.deepEqual(await accounting.listAccountingRows(catalog,auth),[historical]);
 assert.equal(await accounting.deleteAccountingRow(catalog,auth,7),null);
 assert.deepEqual(f.data.map(call=>call.method),['GET','DELETE']);
 assert.equal(f.data[0].query,'?select=*&order=support_id.asc');assert.equal(f.data[1].query,'?support_id=eq.7');
 const deniedToken=token();await roles.primeRoleAccessCache(deniedToken,{isAdmin:false,grants:[]});
 await assert.rejects(()=>accounting.listAccountingRows(catalog,deniedToken),rejected(403));
 await assert.rejects(()=>accounting.deleteAccountingRow(catalog,deniedToken,7),rejected(403));
 assert.equal(f.data.length,2);
});

unit('provider failures retain the existing safe support error mapping with no private details',async()=>{
 const auth=token();
 for(const[status,code,expected]of[[401,'PGRST',401],[403,'42501',403],[400,'22023',400]]){
  const f=mock({respond:()=>Response.json({code,message:canary},{status})});
  await assert.rejects(()=>write('create',auth,link()),rejected(expected));
  assert.equal(f.data.length,1);
 }
});

unit('other accounting catalogs keep their existing payload contract',async()=>{
 const f=mock(),auth=token(),book=accounting.getAccountingCatalog('accounting-books');
 const input={book_name:'Synthetic book',subsidiary_id:'1',base_currency_id:'2',is_primary:false,is_active:true,support_type:'invalid',file_data:{invalid:true},file_size:-1,support_url:'javascript:invalid'};
 await accounting.createAccountingRow(book,auth,input);await accounting.updateAccountingRow(book,auth,8,input);
 assert.equal(f.data.length,2);assert.ok(f.data.every(call=>call.path==='/rest/v1/accounting_books'));
 for(const call of f.data)assert.deepEqual(call.body,{book_name:'Synthetic book',subsidiary_id:1,base_currency_id:2,is_primary:false,is_active:true});
});
