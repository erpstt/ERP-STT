import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {test,afterEach} from 'node:test';
import {importJournalCsv,journalCsvHeaders,parseJournalCsv} from '../dist/modules/accounting-catalogs/journal-import.service.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';

const originalFetch=globalThis.fetch,originalEnvironment={...process.env};
afterEach(()=>{globalThis.fetch=originalFetch;invalidateRoleAccessCaches();for(const key of Object.keys(process.env))if(!(key in originalEnvironment))delete process.env[key];Object.assign(process.env,originalEnvironment);});
const setup=()=>Object.assign(process.env,{SUPABASE_URL:'https://journal-csv.example.invalid',SUPABASE_ANON_KEY:'synthetic-journal-public',SUPABASE_PUBLISHABLE_KEY:'synthetic-journal-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-journal-proof-key'});
const grant=(auth,canView=true,canCreate=true)=>primeRoleAccessCache(auth,{isAdmin:false,grants:[{resourceKey:'accounting:journals',canView,canCreate,canEdit:false,canDelete:false}]});
const metadata={reference:'SYN-A',date:'2026-10-10',currency:'USD',exchangeRate:'160.1234567890',rateDate:'2026-10-09',rateSource:'DIRECT',lines:2,debit:'10.123456',credit:'10.123456'};
const result=()=>({valid:true,created:0,alreadyImported:false,entries:[metadata],errors:[],context:{userId:1,roleId:2,subsidiaryId:1,sessionId:'synthetic-journal-session',revision:'synthetic-revision'},fingerprint:'a'.repeat(64),validationDigest:'b'.repeat(64)});
function csv({legacyRate,headers,overrides={}}={}){
 const columns=headers??[...journalCsvHeaders];if(legacyRate!==undefined&&!columns.includes('tipo_cambio'))columns.splice(4,0,'tipo_cambio');
 const values={asiento_referencia:'SYN-A',tipo_asiento:'ASI_DIA',fecha:'2026-10-10',moneda:'USD',nota_asiento:'Synthetic',numero_cuenta:'001',debito:'10.123456',credito:'0.000000',nota_linea:'Synthetic line',mes_servicio:'1999-01',pais_servicio:'Ignored automatic country',...overrides},quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
 return columns.join(';')+'\r\n'+columns.map(key=>quote(key==='tipo_cambio'?legacyRate:values[key])).join(';');
}
const input=()=>({csv:csv(),preview:true,subsidiaryId:1});
function signedProof(overrides={},domain='gentia/journal-csv-preview/v1',raw){
 const value={version:1,kind:'JOURNALS',context:result().context,fingerprint:result().fingerprint,validationDigest:result().validationDigest,expiresAt:Date.now()+900000,...overrides},encoded=Buffer.from(raw??JSON.stringify(value)).toString('base64url'),key=createHmac('sha256',process.env.SUPABASE_SERVICE_ROLE_KEY).update(domain).digest();
 return encoded+'.'+createHmac('sha256',key).update(encoded).digest('base64url');
}

test('journal permissions are checked before parsing: readers may preview but only current view+create grants may import',async()=>{
 setup();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(result());};
 for(const [view,create]of[[false,false],[false,true]]){const auth=`Bearer journal-denied-${view}-${create}`;await grant(auth,view,create);for(const preview of[true,false])await assert.rejects(importJournalCsv(auth,{csv:'invalid',preview,subsidiaryId:1}),error=>error.status===403);}
 await assert.rejects(importJournalCsv('',input()),error=>error.status===401);assert.equal(calls,0);
 const reader='Bearer journal-reader';await grant(reader,true,false);const preview=await importJournalCsv(reader,input());assert.ok(preview.previewToken);assert.equal(calls,1);await assert.rejects(importJournalCsv(reader,{...input(),preview:false,previewToken:preview.previewToken}),error=>error.status===403);assert.equal(calls,1);
});

test('journal preview signs authoritative rate metadata and import preserves public caller identity and exact native amounts',async()=>{
 setup();const auth='Bearer journal-proof';await grant(auth);const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:new URL(url),method:init.method,headers:new Headers(init.headers),body:JSON.parse(init.body)});return Response.json(result());};
 const before=Date.now(),preview=await importJournalCsv(auth,input());assert.deepEqual(preview.entries,[metadata]);assert.ok(Date.parse(preview.expiresAt)>before);assert.ok(Date.parse(preview.expiresAt)<=Date.now()+900001);assert.doesNotMatch(preview.previewToken,/synthetic-journal-proof-key/);
 await importJournalCsv(auth,{...input(),preview:false,previewToken:preview.previewToken});assert.equal(calls.length,2);assert.equal(calls[0].url.pathname,'/rest/v1/rpc/journal_csv_preview');assert.equal(calls[1].url.pathname,'/rest/v1/rpc/journal_csv_import');
 for(const call of calls){assert.equal(call.method,'POST');assert.equal(call.headers.get('authorization'),auth);assert.equal(call.headers.get('apikey'),'synthetic-journal-public');assert.equal(call.body.p_rows[0].debito,'10.123456');assert.equal(call.body.p_rows[0].numero_cuenta,'001');assert.equal(call.body.p_rows[0].mes_servicio,'');assert.equal(Object.hasOwn(call.body.p_rows[0],'pais_servicio'),false);assert.equal(Object.hasOwn(call.body.p_rows[0],'tipo_cambio'),false);}
 assert.deepEqual(Object.keys(calls[0].body).sort(),['p_rows','p_subsidiary_id']);assert.deepEqual(calls[1].body.p_expected_context,result().context);assert.equal(calls[1].body.p_fingerprint,result().fingerprint);assert.equal(calls[1].body.p_validation_digest,result().validationDigest);
});

test('new and legacy journal files use identical canonical RPC rows and preserve explicitly required pending-service dimensions',async()=>{
 setup();const auth='Bearer journal-canonical';await grant(auth);const calls=[];globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json(result());};
 const source={tipo_asiento:'ASI_PEN',mes_servicio:'2026-09',pais_servicio:'Synthetic country',entidad:'Cliente',nombre:'Synthetic entity'},preview=await importJournalCsv(auth,{...input(),csv:csv({overrides:source})});
 for(const legacyRate of['','0','-1','NaN','Infinity','not authoritative','quoted; ignored\nvalue'])await importJournalCsv(auth,{...input(),csv:csv({legacyRate,overrides:source}),preview:false,previewToken:preview.previewToken});
 for(const call of calls){assert.deepEqual(call.p_rows,calls[0].p_rows);assert.equal(call.p_rows[0].mes_servicio,'2026-09');assert.equal(call.p_rows[0].pais_servicio,'Synthetic country');assert.equal(call.p_rows[0].entidad,'Cliente');assert.equal(call.p_rows[0].nombre,'Synthetic entity');assert.equal(call.p_rows[0].debito,'10.123456');}
});

test('missing, malformed, expired, wrong-kind and cross-domain journal confirmations cannot reach a write RPC',async()=>{
 setup();const auth='Bearer journal-invalid-proof';await grant(auth);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(result());};
 const proofs=[undefined,null,'','invalid','x.y.z','x'.repeat(4097),signedProof({expiresAt:Date.now()-1}),signedProof({kind:'DEPOSITS'}),signedProof({version:2}),signedProof({context:{...result().context,subsidiaryId:2}}),signedProof({context:{...result().context,userId:0}}),signedProof({context:{...result().context,sessionId:''}}),signedProof({fingerprint:'not-a-hash'}),signedProof({validationDigest:'B'.repeat(64)}),signedProof({},'gentia/banking-csv-preview/v1'),signedProof({},undefined,'not-json'),signedProof()+'.x',signedProof()+'='];
 for(const previewToken of proofs)await assert.rejects(importJournalCsv(auth,{...input(),preview:false,previewToken}),error=>error.status===409);
 assert.equal(calls,0);
});

test('invalid or already-imported journal previews never issue a write capability, and a malformed authority response fails closed',async()=>{
 setup();const auth='Bearer journal-preview-state';await grant(auth);let calls=0;
 for(const state of[{valid:false,errors:[{row:2,message:'Synthetic validation error'}]},{alreadyImported:true,created:0}]){globalThis.fetch=async()=>{calls++;return Response.json({...result(),...state});};assert.equal((await importJournalCsv(auth,input())).previewToken,undefined);}
 for(const context of[null,{...result().context,subsidiaryId:2},{...result().context,userId:-1},{...result().context,sessionId:''}]){globalThis.fetch=async()=>{calls++;return Response.json({...result(),context});};await assert.rejects(importJournalCsv(auth,input()),error=>error.status===503);}
 for(const response of[{},[],null,{...result(),entries:null},{...result(),errors:null}]){globalThis.fetch=async()=>{calls++;return Response.json(response);};await assert.rejects(importJournalCsv(auth,input()),error=>error.status===503);}
 assert.equal(calls,11);
});

test('invalid journal bodies and unavailable proof configuration cause no business RPC calls',async()=>{
 setup();const auth='Bearer journal-invalid-body';await grant(auth);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not connect');};
 for(const value of[null,[],{}, {csv:csv(),preview:'true',subsidiaryId:1},{...input(),subsidiaryId:0},{...input(),subsidiaryId:1.5},{...input(),subsidiaryId:'1'},{...input(),csv:'bad'}, {...input(),csv:csv({headers:[...journalCsvHeaders,'unknown']})}])await assert.rejects(importJournalCsv(auth,value),error=>error.status===400);
 delete process.env.SUPABASE_SERVICE_ROLE_KEY;await assert.rejects(importJournalCsv(auth,input()),error=>error.status===503);assert.equal(calls,0);
});

test('journal transport and SQL failures are sanitized without automatic mutation retries',async()=>{
 setup();const auth='Bearer journal-errors';await grant(auth);const previewToken=signedProof();let calls=0;
 for(const [http,code,status]of[[401,'',401],[403,'42501',403],[400,'42501',403],[400,'PT409',409],[400,'55000',409],[400,'23505',409],[400,'22023',400],[400,'P0001',400],[500,'XX000',503],[408,'',503],[429,'',429]]){calls=0;globalThis.fetch=async()=>{calls++;return Response.json({code,message:'private-db-host-detail'},{status:http});};await assert.rejects(importJournalCsv(auth,{...input(),preview:false,previewToken}),error=>error.status===status&&!error.message.includes('private-db-host-detail'));assert.equal(calls,1);}
 calls=0;globalThis.fetch=async()=>{calls++;throw Error('private-network-host');};await assert.rejects(importJournalCsv(auth,{...input(),preview:false,previewToken}),error=>error.status===503&&!error.message.includes('private-network-host'));assert.equal(calls,1);
 calls=0;globalThis.fetch=async()=>{calls++;return new Response('private invalid JSON');};await assert.rejects(importJournalCsv(auth,{...input(),preview:false,previewToken}),error=>error.status===503&&!error.message.includes('private invalid JSON'));assert.equal(calls,1);
});

test('journal HTTP route preserves read-only preview, write permission, signed confirmation and current caller credentials',{timeout:40000},async t=>{
 const calls=[];let saved=false;
 const stub=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer journal-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[{resourceKey:'accounting:journals',canView:['reader','creator'].includes(role),canCreate:['creator','blind'].includes(role),canEdit:false,canDelete:false}]}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({path:req.url,body,auth:req.headers.authorization,key:req.headers.apikey});let data=result();if(req.url==='/rest/v1/rpc/journal_csv_import'){data={...data,created:saved?0:1,alreadyImported:saved};saved=true;}else assert.equal(req.url,'/rest/v1/rpc/journal_csv_preview');res.end(JSON.stringify(data));
 });
 await new Promise(resolve=>stub.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{stub.closeAllConnections();stub.close(resolve);}));
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['dist/server.js'],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'test',PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',EMAIL_NOTIFICATIONS_ENABLED:'false',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'synthetic-journal-http-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-journal-http-proof',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());const origin=`http://127.0.0.1:${port}`;let ready=false;
 for(let attempt=0;attempt<100;attempt++){try{if((await originalFetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(ready);
 const request=(body,role='creator',method='POST')=>originalFetch(origin+'/api/accounting/journals/import',{method,headers:{Authorization:'Bearer journal-http-'+role,'X-Device-Token':'synthetic-journal-device','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
 for(const role of['none','blind']){const before=calls.length;for(const preview of[true,false]){const response=await request({...input(),preview},role);assert.equal(response.status,403);assert.equal(calls.length,before);}}
 let response=await request(input(),'reader');assert.equal(response.status,200);const readerPreview=await response.json();assert.ok(readerPreview.previewToken);let before=calls.length;response=await request({...input(),preview:false,previewToken:readerPreview.previewToken},'reader');assert.equal(response.status,403);assert.equal(calls.length,before);
 response=await request({...input(),csv:csv({legacyRate:'ignored legacy rate'})});assert.equal(response.status,200);const preview=await response.json();assert.deepEqual(preview.entries,[metadata]);const previewRows=calls.at(-1).body.p_rows;assert.equal(Object.hasOwn(previewRows[0],'tipo_cambio'),false);
 before=calls.length;response=await request({...input(),preview:false});assert.equal(response.status,409);assert.equal(calls.length,before);
 for(let attempt=0;attempt<2;attempt++){response=await request({...input(),preview:false,previewToken:preview.previewToken});assert.equal(response.status,200);const data=await response.json();assert.equal(data.created,attempt===0?1:0);assert.equal(data.alreadyImported,attempt!==0);assert.deepEqual(calls.at(-1).body.p_rows,previewRows);assert.equal(calls.at(-1).auth,'Bearer journal-http-creator');assert.equal(calls.at(-1).key,'synthetic-journal-http-public');assert.deepEqual(calls.at(-1).body.p_expected_context,result().context);}
 before=calls.length;response=await request(null);assert.equal(response.status,400);assert.equal(calls.length,before);response=await request({},'creator','GET');assert.equal(response.status,404);assert.equal(calls.length,before);
 response=await originalFetch(origin+'/api/accounting/journals/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())});assert.equal(response.status,401);assert.equal(calls.length,before);
});
