import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {createJournalEntry,updateJournalEntry,reverseManualJournal} from '../dist/modules/accounting-catalogs/journal-entry.service.js';
import {importJournalCsv,journalCsvHeaders} from '../dist/modules/accounting-catalogs/journal-import.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const resource='accounting:journals';
const csv=journalCsvHeaders.slice(0,11).join(',')+'\nA,ASI_DIA,2026-10-10,USD,1,Synthetic,101,100,0,Line,\nA,ASI_DIA,2026-10-10,USD,1,Synthetic,102,0,100,Line,';
const journal={journal_type:'Asiento de Diario General',memo:'Synthetic',lines:[]};
const cases=[['POST','/journal-entry','create','create_journal_entry',journal],['PUT','/journal-entry/17','edit','update_journal_entry',journal],
 ['POST','/journals/import','view','import_journal_csv',{csv,preview:true,subsidiaryId:1}],['POST','/journals/import','create','import_journal_csv',{csv,preview:false,subsidiaryId:1}],
 ['POST','/api/reports/accounting/journal/17/reverse','edit','reverse_journal_entry',{}]];
test('autorizacion interna precede al parseo y a las consultas',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer journal-direct-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const action of [()=>createJournalEntry(auth,{}),()=>updateJournalEntry(auth,17,{}),()=>reverseManualJournal(auth,17),()=>importJournalCsv(auth,{})])await assert.rejects(action(),e=>e.status===403);
 await assert.rejects(createJournalEntry('',{}),e=>e.status===401);
});
test('rutas de crear, editar, previsualizar e importar requieren su accion y conservan JWT', {timeout:25000},async t=>{
 const calls=[];const roles={denied:null,reader:'view',creator:'create',editor:'edit',admin:'admin'};
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer journal-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:resource,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:false}]}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);const payload=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload});
  if(role==='admin'&&req.url.endsWith('/update_journal_entry')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}
  res.end(JSON.stringify(req.url.endsWith('/import_journal_csv')?{valid:true,created:payload.p_preview?0:1}:17));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});
 t.after(()=>child.kill());let ready=false;for(let n=0;n<70;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const base=`http://127.0.0.1:${port}`;
 for(const [method,path,action,rpc,input]of cases){
  const url=base+(path.startsWith('/api/')?path:'/api/accounting'+path);
  for(const [role,grant]of Object.entries(roles)){
   const auth=`Bearer journal-http-${role}`;const before=calls.length;
   const response=await fetch(url,{method,headers:{Authorization:auth,'X-Device-Token':'journal-http-device-fixture','Content-Type':'application/json'},body:JSON.stringify(input)});
   const allowed=role==='admin'||grant===action;const sqlDenied=role==='admin'&&rpc==='update_journal_entry';
   assert.equal(response.status,!allowed||sqlDenied?403:['create_journal_entry','reverse_journal_entry'].includes(rpc)?201:200,`${role} ${rpc} ${action}`);
   assert.equal(calls.length,before+(allowed?1:0));
   if(allowed){const call=calls.at(-1);assert.equal(call.auth,auth);assert.equal(call.key,'public-fixture');assert.equal(call.path,'/rest/v1/rpc/'+rpc);
    if(rpc==='import_journal_csv'){assert.equal(call.payload.p_preview,input.preview);assert.equal(call.payload.p_subsidiary_id,1);assert.equal(call.payload.p_rows.length,2);}
    else if(rpc==='reverse_journal_entry')assert.equal(call.payload.target_journal_id,17);
    else{assert.deepEqual(call.payload.payload,journal);if(rpc==='update_journal_entry')assert.equal(call.payload.target_journal_id,17);}}
   if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);
  }
  const before=calls.length;const anon=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(anon.status,401);assert.equal(calls.length,before);
 }
});
