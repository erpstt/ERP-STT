import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {journalEntryOptions,journalEntryDetail,journalEntrySupports} from '../dist/modules/accounting-catalogs/journal-entry.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

test('journal form reads require the action before parsing or querying Supabase',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer journal-form-no-access';
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const operation of [()=>journalEntryOptions(auth,'header'),()=>journalEntryOptions(auth,'lines',17),()=>journalEntryDetail(auth,17),()=>journalEntrySupports(auth,17)])await assert.rejects(operation(),error=>error.status===403);
 await assert.rejects(journalEntryOptions('','header'),error=>error.status===401);
});

test('header, lines, selected detail and lazy supports preserve JWT and enforce create or edit on every route',{timeout:45000},async t=>{
 const calls=[],roles={denied:[],reader:['view'],creator:['view','create'],editor:['view','edit'],noAccessWriter:['create','edit'],admin:['view','create','edit']};
 const stub=createServer(async(request,response)=>{
  response.setHeader('Content-Type','application/json');const role=request.headers.authorization?.replace('Bearer journal-form-http-',''),grant=roles[role]||[];
  if(request.url==='/rest/v1/rpc/assert_request_access'){
   response.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:'accounting:journals',canView:grant.includes('view'),canCreate:grant.includes('create'),canEdit:grant.includes('edit'),canDelete:false}]}}));return;
  }
  const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:request.url,auth:request.headers.authorization,key:request.headers.apikey,body});
  if(role==='admin'&&request.url.endsWith('/manual_journal_form_supports')){response.writeHead(403);response.end(JSON.stringify({code:'42501',message:'private financial read detail'}));return;}
  response.end(JSON.stringify(request.url.endsWith('/manual_journal_form_detail')?{journal:{journal_id:17},lines:[]}:request.url.endsWith('/manual_journal_form_supports')?[]:{fixture:true}));
 });
 await new Promise(done=>stub.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>{stub.closeAllConnections();stub.close(done);}));
 const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});
 t.after(()=>child.kill());const origin=`http://127.0.0.1:${port}`;
 let ready=false;for(let attempt=0;attempt<150;attempt++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,100));}assert.ok(ready);
 const routes=[
  ['/options','create','manual_journal_form_options',{p_section:'header',p_journal_id:null}],
  ['/options?section=header','create','manual_journal_form_options',{p_section:'header',p_journal_id:null}],
  ['/options?section=lines','create','manual_journal_form_options',{p_section:'lines',p_journal_id:null}],
  ['/options?section=header&id=17','edit','manual_journal_form_options',{p_section:'header',p_journal_id:17}],
  ['/options?section=lines&id=17','edit','manual_journal_form_options',{p_section:'lines',p_journal_id:17}],
  ['/17','edit','manual_journal_form_detail',{p_journal_id:17}],
  ['/17/supports','edit','manual_journal_form_supports',{p_journal_id:17}],
 ];
 for(const [path,action,rpc,body] of routes){
  for(const [role,grant]of Object.entries(roles)){
   const before=calls.length,auth=`Bearer journal-form-http-${role}`;
   const response=await fetch(origin+'/api/accounting/journal-entry'+path,{headers:{Authorization:auth,'X-Device-Token':'synthetic-journal-form-device'}});
   const allowed=role==='admin'||grant.includes('view')&&grant.includes(action),sqlDenied=role==='admin'&&rpc==='manual_journal_form_supports';
   assert.equal(response.status,!allowed||sqlDenied?403:200,`${role} ${path}`);assert.equal(calls.length,before+(allowed?1:0));
   if(allowed)assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/'+rpc,auth,key:'public-fixture',body});
   assert.doesNotMatch(await response.text(),/private financial read detail/);
  }
  const before=calls.length;assert.equal((await fetch(origin+'/api/accounting/journal-entry'+path)).status,401);assert.equal(calls.length,before);
 }
 const auth='Bearer journal-form-http-editor';
 for(const path of ['/options?section=bad&id=17','/options?section=header&id=bad','/options?section=lines&id=0','/0','/0/supports']){
  const before=calls.length;const response=await fetch(origin+'/api/accounting/journal-entry'+path,{headers:{Authorization:auth,'X-Device-Token':'synthetic-journal-form-device'}});
  assert.equal(response.status,400,path);assert.equal(calls.length,before);
 }
 assert.ok(calls.every(call=>call.path.startsWith('/rest/v1/rpc/manual_journal_form_')));
});
