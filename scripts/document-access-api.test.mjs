import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
import {documentCatalogs,listDocumentRows,createDocumentRow,updateDocumentRow,deleteDocumentRow} from '../dist/modules/document-catalogs/document-catalogs.module.js';
import {getAccountingCatalog,listAccountingRows,createAccountingRow,updateAccountingRow,deleteAccountingRow} from '../dist/modules/accounting-catalogs/accounting-catalogs.module.js';
const payloads={folders:{folder_name:'Synthetic',subsidiary_id:1},'document-types':{type_name:'Synthetic',allowed_extensions:'pdf',max_file_size_mb:5},documents:{file_name:'Synthetic',file_path:'synthetic/one',folder_id:1,type_id:1,uploaded_by_user_id:1,file_size:4,mime_type:'application/pdf'},'document-versions':{document_id:1,version_number:2,file_path:'synthetic/v2',uploaded_at:'2026-11-03T12:00:00Z'},'document-relations':{document_id:1,target_entity_type:'SYN',target_entity_id:1},'document-permissions':{document_id:1,user_id:1,can_read:true,can_write:false},'journal-supports':{journal_id:101,support_type:'Enlace',display_name:'Synthetic',support_url:'https://example.invalid'}};
test('direct document/support service calls reject before data, including global type maintenance',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected network');};t.after(()=>{globalThis.fetch=original;invalidateRoleAccessCaches();});const auth='Bearer p75-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 for(const c of documentCatalogs)for(const action of [()=>listDocumentRows(c,auth),()=>createDocumentRow(c,auth,{}),()=>updateDocumentRow(c,auth,1,{}),()=>deleteDocumentRow(c,auth,1)])await assert.rejects(action(),e=>e.status===403);
 const c=getAccountingCatalog('journal-supports');for(const action of [()=>listAccountingRows(c,auth),()=>createAccountingRow(c,auth,{}),()=>updateAccountingRow(c,auth,1,{}),()=>deleteAccountingRow(c,auth,1)])await assert.rejects(action(),e=>e.status===403);
 await assert.rejects(listDocumentRows(documentCatalogs[0],''),e=>e.status===401);await assert.rejects(listAccountingRows(c,''),e=>e.status===401);
 await primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'documents:document-types',canView:true,canCreate:true}]});await assert.rejects(createDocumentRow(documentCatalogs.find(x=>x.slug==='document-types'),auth,payloads['document-types']),e=>e.status===403);assert.equal(calls,0);
});
test('HTTP action matrix and safe DB errors preserve user JWT and public key across all seven catalogs',{timeout:90000},async t=>{
 const calls=[];let resource='documents:folders';const upstream=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer p75-','')||'denied';
  if(req.url==='/rest/v1/rpc/assert_request_access')return res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:role==='denied'?[]:[{resourceKey:role==='unrelated'?'inventory:products':resource,canView:true,canCreate:role==='creator',canEdit:role==='editor',canDelete:role==='deleter'}]}}));
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,method:req.method,auth:req.headers.authorization,key:req.headers.apikey,body:Buffer.concat(chunks).toString()});if(role==='sql-denied'){res.writeHead(403);return res.end(JSON.stringify({code:'42501',message:'PRIVATE_SQL_DETAILS'}));}if(req.method==='DELETE'){res.writeHead(204);return res.end();}return res.end(JSON.stringify([{synthetic:true}]));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{upstream.closeAllConnections();upstream.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_ANON_KEY:'synthetic-public',DISABLE_BACKGROUND_JOBS:'true',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const slug of Object.keys(payloads)){
  resource=(slug==='journal-supports'?'accounting:':'documents:')+slug;const path='/api/'+resource.replace(':','/');
  for(const role of ['denied','unrelated','reader','creator','editor','deleter','admin','sql-denied'])for(const method of ['GET','POST','PATCH','DELETE']){
   const before=calls.length,r=await fetch(base+path+(['PATCH','DELETE'].includes(method)?'/1':''),{method,headers:{Authorization:'Bearer p75-'+role,'X-Device-Token':'synthetic-p75-device-token-fixture','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payloads[slug])})});const body=await r.text();
   const allowed=role==='admin'||!['denied','unrelated'].includes(role)&&(method==='GET'||method==={creator:'POST',editor:'PATCH',deleter:'DELETE'}[role])&&(slug!=='document-types'||method==='GET');
   const expected=allowed?(role==='sql-denied'?403:method==='POST'?201:200):403;assert.equal(r.status,expected,[slug,role,method,body].join(' '));assert.equal(calls.length,before+Number(allowed));assert.ok(!body.includes('PRIVATE_SQL_DETAILS'));
  }
 }
 assert.ok(calls.length>20);assert.ok(calls.every(c=>c.key==='synthetic-public'&&c.auth.startsWith('Bearer p75-')));assert.ok(calls.every(c=>!c.path.includes('/rpc/')));
});
