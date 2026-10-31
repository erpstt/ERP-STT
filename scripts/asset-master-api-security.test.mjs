import assert from 'node:assert/strict';import{test}from'node:test';import{createServer}from'node:http';import{spawn}from'node:child_process';
import * as assets from '../dist/modules/fixed-asset-catalogs/fixed-assets.service.js';
import * as categories from '../dist/modules/fixed-asset-catalogs/asset-category.service.js';
import{getFixedAssetCatalog,listFixedAssetRows,createFixedAssetRow,updateFixedAssetRow,deleteFixedAssetRow}from'../dist/modules/fixed-asset-catalogs/fixed-asset-catalogs.module.js';
import{exportFixedAssets,loadFixedAssetExportData}from'../dist/modules/fixed-asset-catalogs/fixed-asset-export.service.js';import{exportAssetCategories,loadAssetCategoryExportData}from'../dist/modules/fixed-asset-catalogs/asset-category-export.service.js';
import{primeRoleAccessCache,invalidateRoleAccessCaches}from'../dist/modules/security-catalogs/role-access-matrix.module.js';
test('guardas de servicios, catalogos y seis formatos de exportacion niegan antes de consultar',async t=>{t.after(()=>invalidateRoleAccessCaches());const auth='Bearer master-denied';await primeRoleAccessCache(auth,{isAdmin:false,grants:[]});
 const calls=[()=>assets.fixedAssetReport(auth,{}),()=>assets.fixedAssetDetail(auth,1),()=>assets.fixedAssetAnalytics(auth,{}),()=>assets.saveFixedAsset(auth,{}),()=>assets.saveFixedAsset(auth,{},1),()=>categories.assetCategoryOptions(auth),()=>categories.assetCategoryReport(auth,{}),()=>categories.saveAssetCategory(auth,{}),()=>categories.saveAssetCategory(auth,{},1),()=>categories.deleteAssetCategory(auth,1),()=>loadFixedAssetExportData(auth,{}),()=>loadAssetCategoryExportData(auth,{})];
 for(const slug of['assets','asset-categories']){const c=getFixedAssetCatalog(slug);calls.push(()=>listFixedAssetRows(c,auth),()=>createFixedAssetRow(c,auth,{}),()=>updateFixedAssetRow(c,auth,1,{}),()=>deleteFixedAssetRow(c,auth,1));}
 for(const format of['csv','xlsx','pdf'])calls.push(()=>exportFixedAssets(auth,format,{}),()=>exportAssetCategories(auth,format,{}));for(const f of calls)await assert.rejects(f(),e=>e.status===403);await assert.rejects(categories.assetCategoryOptions(''),e=>e.status===401);
});
const base='/api/fixed-assets',a='fixed-assets:assets',c='fixed-assets:asset-categories',p={name:'Synthetic'},cases=[
 ['GET',base+'/asset-category-options',c,'view',null,[['asset_category_options',{}]],200],
 ['POST',base+'/asset-category-report',c,'view',{},[['asset_category_report',{p_filters:{}}]],200],
 ['POST',base+'/asset-category-save',c,'create',p,[['save_asset_category',{p_payload:p,p_category_id:null}]],201],
 ['PUT',base+'/asset-category-manage/1',c,'edit',p,[['save_asset_category',{p_payload:p,p_category_id:1}]],200],
 ['DELETE',base+'/asset-category-manage/1',c,'delete',null,[['delete_asset_category',{p_category_id:1}]],200],
 ['POST',base+'/workflow-report',a,'view',{},[['fixed_asset_report',{p_filters:{}}]],200],
 ['POST',base+'/workflow-save',a,'create',p,[['save_fixed_asset',{p_payload:p,p_asset_id:null}]],201],
 ['PUT',base+'/workflow-manage/1',a,'edit',p,[['save_fixed_asset',{p_payload:p,p_asset_id:1}]],200],
 ['GET',base+'/workflow-manage/1',a,'view',null,[['fixed_asset_detail',{p_asset_id:1}],['fixed_asset_proposal_origins',{p_asset_id:1}]],200],
 ['POST',base+'/analytics','fixed-assets:reports','view',{},[['fixed_asset_analytics',{p_filters:{}}]],200],
 ...[['assets',a,'asset','asset_id'],['asset-categories',c,'asset_category','category_id']].flatMap(([slug,resource,table,key])=>[
  ['GET',base+'/'+slug,resource,'view',null,[[`TABLE:${table}?select=*&order=${key}.asc`,{}]],200],
  ['POST',base+'/'+slug,resource,'create',p,[[slug==='assets'?'save_fixed_asset_catalog':'save_asset_category_catalog',{p_payload:p,[slug==='assets'?'p_asset_id':'p_category_id']:null}]],201],
  ['PATCH',base+'/'+slug+'/1',resource,'edit',p,[[slug==='assets'?'save_fixed_asset_catalog':'save_asset_category_catalog',{p_payload:p,[slug==='assets'?'p_asset_id':'p_category_id']:1}]],200],
  ['DELETE',base+'/'+slug+'/1',resource,'delete',null,[[slug==='assets'?'delete_fixed_asset':'delete_asset_category',{[slug==='assets'?'p_asset_id':'p_category_id']:1}]],200]
 ])
];
test('dieciocho rutas HTTP separan seis roles, reutilizan JWT publico y parametros y sanitizan SQL',{timeout:40000},async t=>{
 const calls=[],roles={denied:null,reader:'view',creator:'create',editor:'edit',deleter:'delete',admin:'admin'};
 const stub=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const role=req.headers.authorization?.replace('Bearer master-http-','');if(req.url==='/rest/v1/rpc/assert_request_access'){res.end(JSON.stringify({allowed:true,roleAccess:{isAdmin:role==='admin',grants:[a,c,'fixed-assets:reports'].map(resourceKey=>({resourceKey,canView:roles[role]==='view',canCreate:roles[role]==='create',canEdit:roles[role]==='edit',canDelete:roles[role]==='delete'}))}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({path:req.url,auth:req.headers.authorization,key:req.headers.apikey,payload:JSON.parse(Buffer.concat(chunks).toString()||'{}')});
  if(role==='admin'&&req.url.endsWith('/save_fixed_asset')){res.writeHead(403);res.end(JSON.stringify({code:'42501',message:'private database detail'}));return;}
  res.end(JSON.stringify(req.url.startsWith('/rest/v1/rpc/')?{fixture:true}:[]));
 });await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{stub.closeAllConnections();stub.close(r);}));const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,PORT:String(port),DISABLE_BACKGROUND_JOBS:'true',SUPABASE_URL:`http://127.0.0.1:${stub.address().port}`,SUPABASE_ANON_KEY:'public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture',AUTH_REQUEST_ACCESS_CACHE_TTL_MS:'0'},stdio:'ignore'});t.after(()=>child.kill());let ready=false;for(let n=0;n<100;n++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const [method,path,resource,action,body,expected,status]of cases){for(const [role,grant]of Object.entries(roles)){const auth=`Bearer master-http-${role}`,before=calls.length,response=await fetch(`http://127.0.0.1:${port}`+path,{method,headers:{Authorization:auth,'X-Device-Token':'master-category-http-device-fixture','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const allowed=role==='admin'||grant===action,sqlDenied=role==='admin'&&expected[0][0]==='save_fixed_asset';assert.equal(response.status,!allowed||sqlDenied?403:status,`${role} ${method} ${path}`);assert.equal(calls.length,before+(allowed?expected.length:0));if(allowed){const got=calls.slice(before).sort((x,y)=>x.path.localeCompare(y.path));const want=expected.map(([name,payload])=>({path:name.startsWith('TABLE:')?'/rest/v1/'+name.slice(6):'/rest/v1/rpc/'+name,auth,key:'public-fixture',payload})).sort((x,y)=>x.path.localeCompare(y.path));assert.deepEqual(got,want);}if(sqlDenied)assert.doesNotMatch(await response.text(),/private database detail/);}
  const before=calls.length;assert.equal((await fetch(`http://127.0.0.1:${port}`+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})).status,401);assert.equal(calls.length,before);
 }
 for(const slug of['assets','asset-categories'])for(const format of['csv','xlsx','pdf']){const before=calls.length,response=await fetch(`http://127.0.0.1:${port}${base}/${slug}/export?format=${format}`,{headers:{Authorization:'Bearer master-http-denied','X-Device-Token':'master-category-http-device-fixture'}});assert.equal(response.status,403);assert.equal(calls.length,before);}
});
