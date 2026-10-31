import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import * as assets from '../dist/modules/fixed-asset-catalogs/fixed-assets.service.js';
import {getFixedAssetCatalog,createFixedAssetRow,updateFixedAssetRow,deleteFixedAssetRow,listFixedAssetRows} from '../dist/modules/fixed-asset-catalogs/fixed-asset-catalogs.module.js';
import {primeRoleAccessCache,invalidateRoleAccessCaches} from '../dist/modules/security-catalogs/role-access-matrix.module.js';
const payload={action:'CAPITALIZE',ids:[1],quantity:1,date:'2026-10-31'};
test('guardas internas niegan consultas, procesos y escritura del historial antes de acceder a Supabase',async t=>{
 t.after(()=>invalidateRoleAccessCaches());const auth='Bearer asset-posting-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 const catalog=getFixedAssetCatalog('asset-depreciations');
 for(const call of [()=>assets.fixedAssetProposalReport(auth,{}),()=>assets.processFixedAssetProposals(auth,payload),()=>assets.processFixedAssetProposals(auth,{...payload,action:'DISCARD'}),()=>assets.depreciationPreview(auth,payload.date),()=>assets.runDepreciation(auth,{date:payload.date,assetIds:[1]}),()=>listFixedAssetRows(catalog,auth),()=>createFixedAssetRow(catalog,auth,{}),()=>updateFixedAssetRow(catalog,auth,1,{}),()=>deleteFixedAssetRow(catalog,auth,1)])await assert.rejects(call(),e=>e.status===403);
 await assert.rejects(assets.depreciationPreview('',payload.date),e=>e.status===401);
});
const cases=[
 ['/api/fixed-assets/proposals/report','view','fixed_asset_proposal_report',{}, {p_filters:{}},200],
 ['/api/fixed-assets/proposals/process','create','process_fixed_asset_proposals',payload,{p_payload:payload},200],
 ['/api/fixed-assets/proposals/process','edit','process_fixed_asset_proposals',{...payload,action:'DISCARD'},{p_payload:{...payload,action:'DISCARD'}},200],
 ['/api/fixed-assets/depreciation-preview','view','fixed_asset_depreciation_preview',{date:payload.date},{p_date:payload.date},200],
 ['/api/fixed-assets/depreciation-run','create','run_fixed_asset_depreciation',{date:payload.date,assetIds:[1]},{p_date:payload.date,p_asset_ids:[1]},201]
];
test('cinco variantes HTTP verifican seis roles y preservan JWT publico y parametros; SQL denegado se sanitiza',{timeout:40000},async t=>{
 const calls=[],roles={denied:null,reader:'view',creator:'create',editor:'edit',deleter:'delete',admin:'admin'};
 const stub=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer asset-http-','');
  if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:['fixed-assets:asset-proposals','fixed-assets:asset-depreciations'].map(resourceKey=>({resourceKey,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:roles[role]==='delete'}))}}));return;}
  const chunks=[];for await(const c of req)chunks.push(c);calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&req.url.endsWith('/process_fixed_asset_proposals')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private SQL detail'}));return;}res.end(JSON.stringify({fixture:true}));
 });
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());
 let ready=false;for(let n=0;n<100;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const [path,action,rpc,body,expected,status]of cases){for(const [role,grant]of Object.entries(roles)){
  const auth=`Bearer asset-http-${role}`,before=calls.length;const response=await fetch(`http://127.0.0.1:${port}`+path,{method:'POST',headers:{Authorization:auth,'X-Device-Token':'asset-posting-http-device-fixture','Content-Type':'application/json'},body:JSON.stringify(body)});
  const allowed=role==='admin'||grant===action,sqlDenied=role==='admin'&&rpc==='process_fixed_asset_proposals';assert.equal(response.status,!allowed||sqlDenied?403:status,`${role} ${path}`);assert.equal(calls.length,before+(allowed?1:0));if(allowed)assert.deepEqual(calls.at(-1),{path:'/rest/v1/rpc/'+rpc,auth,key:'public-fixture',payload:expected});if(sqlDenied)assert.doesNotMatch(await response.text(),/private SQL detail/);
 }const before=calls.length;assert.equal((await fetch(`http://127.0.0.1:${port}`+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);assert.equal(calls.length,before);}
 for(const method of ['POST','PATCH','DELETE']){const before=calls.length;const r=await fetch(`http://127.0.0.1:${port}/api/fixed-assets/asset-depreciations${method==='POST'?'':'/1'}`,{method,headers:{Authorization:'Bearer asset-http-admin','X-Device-Token':'asset-posting-http-device-fixture','Content-Type':'application/json'},...(method!=='DELETE'?{body:'{}'}:{})});assert.equal(r.status,403);assert.equal(calls.length,before);}
});
