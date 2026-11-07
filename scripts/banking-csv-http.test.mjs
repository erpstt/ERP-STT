import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {parseBankingCsv,bankingCsvHeaders} from '../dist/modules/banking-catalogs/banking-csv.service.js';

function legacyCsv(text,kind,rate){const headers=[...bankingCsvHeaders[kind]],quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';headers.splice(kind==='CHECKS'?5:4,0,'tipo_cambio');return headers.join(';')+'\r\n'+parseBankingCsv(text,kind).map(row=>headers.map(key=>quote(key==='tipo_cambio'?rate:row[key])).join(';')).join('\r\n');}
test('CSV HTTP routes require view+create, public caller identity and explicit preview confirmation',{timeout:35000},async t=>{
 const csv=await readFile(new URL('../public/plantilla-cheques-transferencias.csv',import.meta.url),'utf8'),depositCsv=await readFile(new URL('../public/plantilla-depositos-bancarios.csv',import.meta.url),'utf8');const calls=[];let saved=false,fail=false;
 const stub=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer csv-http-',''),kind=req.url?.includes('preview')?'preview':'import';
  if(req.url==='/rest/v1/rpc/assert_request_access'){const view=['reader','creator','admin'].includes(role);res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:['banking:bank-checks','banking:bank-deposits'].map(resourceKey=>({resourceKey,canView:view,canCreate:['creator','blind'].includes(role),canEdit:false,canDelete:false}))}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString()||'{}');calls.push({url:req.url,auth:req.headers.authorization,key:req.headers.apikey,input});if(fail){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL details'}));return;}
  const result={valid:true,created:0,alreadyImported:false,entries:[{reference:'SYN-1',exchangeRate:'160.1234567890',rateDate:'2026-11-04',rateSource:'DIRECT'}],errors:[],totals:[],context:{userId:1,roleId:2,subsidiaryId:1,sessionId:'fixture'},fingerprint:'a'.repeat(64),validationDigest:'b'.repeat(64)};
  if(kind==='import'){result.created=saved?0:1;result.alreadyImported=saved;saved=true;}res.end(JSON.stringify(result));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'test',PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-csv-http',SUPABASE_SERVICE_ROLE_KEY:'synthetic-proof-http',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());const base=`http://127.0.0.1:${port}`;let ready=false;for(let i=0;i<90;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const request=(path,input,role='creator',method='POST')=>fetch(base+'/api/banking/csv/'+path,{method,headers:{Authorization:'Bearer csv-http-'+role,'X-Device-Token':'synthetic-csv-device','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(input)}:{})});
 for(const [kind,text]of[['checks',csv],['deposits',depositCsv]]){
  for(const role of['denied','reader','blind']){const before=calls.length;for(const action of['preview','import']){const r=await request(kind+'/'+action,{csv:text,subsidiaryId:1},role);assert.equal(r.status,403,role+' '+action);assert.equal(calls.length,before);}}
  let r=await request(kind+'/preview',{csv:text,subsidiaryId:1});assert.equal(r.status,200);const p=await r.json();assert.ok(p.previewToken);assert.deepEqual(p.entries,[{reference:'SYN-1',exchangeRate:'160.1234567890',rateDate:'2026-11-04',rateSource:'DIRECT'}]);assert.equal(calls.at(-1).input.p_kind,kind==='checks'?'CHECKS':'DEPOSITS');assert.equal(calls.at(-1).key,'public-csv-http');assert.equal(calls.at(-1).auth,'Bearer csv-http-creator');const canonicalRows=calls.at(-1).input.p_rows;assert.equal(Object.hasOwn(canonicalRows[0],'tipo_cambio'),false);assert.equal(Object.keys(canonicalRows[0]).length,kind==='checks'?19:18);const before=calls.length;
  r=await request(kind+'/import',{csv:text,subsidiaryId:1});assert.equal(r.status,409);assert.equal(calls.length,before);saved=false;
  r=await request(kind+'/import',{csv:text,subsidiaryId:1,previewToken:p.previewToken});assert.equal(r.status,201);r=await request(kind+'/import',{csv:text,subsidiaryId:1,previewToken:p.previewToken});assert.equal(r.status,200);assert.equal((await r.json()).created,0);
  r=await request(kind+'/preview',{csv:legacyCsv(text,kind==='checks'?'CHECKS':'DEPOSITS','not an authoritative rate'),subsidiaryId:1});assert.equal(r.status,200);assert.deepEqual(calls.at(-1).input.p_rows,canonicalRows);r=await request(kind+'/import',{csv:legacyCsv(text,kind==='checks'?'CHECKS':'DEPOSITS','another ignored value'),subsidiaryId:1,previewToken:p.previewToken});assert.equal(r.status,200);assert.equal((await r.json()).created,0);assert.deepEqual(calls.at(-1).input.p_rows,canonicalRows);
  fail=true;r=await request(kind+'/import',{csv:text,subsidiaryId:1,previewToken:p.previewToken});assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/private SQL/);fail=false;
  r=await request(kind+'/preview',null);assert.equal(r.status,400);r=await request(kind+'/preview',{},'creator','GET');assert.equal(r.status,405);
 }
 const before=calls.length;let r=await fetch(base+'/api/banking/csv/checks/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv,subsidiaryId:1})});assert.equal(r.status,401);assert.equal(calls.length,before);r=await request('checks/preview',{csv:'x'.repeat(5*1024*1024),subsidiaryId:1});assert.equal(r.status,413);assert.equal(calls.length,before);
});
