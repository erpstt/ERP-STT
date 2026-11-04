import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const [source,validator]=await Promise.all(['workflow-status-banner.js','route-id.js'].map(file=>readFile(new URL('../public/'+file,import.meta.url),'utf8')));
const executable=validator.replace(/^export /gm,'')+'\n'+source.replace(/^import[^\r\n]*\r?\n/gm,'');
const invalidIds=['','../2','..\\2','1/2','1\\2','1?x=2','1#fragment','%2e%2e%2f2','-1','0','00','01','+1','1.0','1e3','0x10','base36','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000)];
const invalidQueries=[...invalidIds.map(id=>'?'+new URLSearchParams({id})),'?id=1&id=2','?id=%2e%2e%2f2','?id=1%2f2','?id=1%5c2','?id=1%3fother','?id=1%23fragment','?id=%252fother','?id=%00'];

function detail(){return{
 instance:{status:'EN_REVISION',current_level:1},
 steps:[{nivel:1,status:'PENDIENTE',nombre_nivel:'<img src=x onerror=unsafe>'}],
 history:[{accion_tomada:'<script>unsafe</script>',user:'Synthetic approver',fecha_hora:'2026-11-04T00:00:00Z',comentario_motivo:'Synthetic feedback'}],
 actions:{canApprove:true,canReject:true}
};}

async function fixture({path='/purchase-document-view.html',search='',status=200,payload=detail()}={}){
 const registry=new Map(),created=[],mounted=[],calls=[],reads=[],pending=[],events=[],timers=[];let jsonReads=0;
 class Element{
  constructor(){this.attributes=new Map();this.textContent='';this.innerHTML='';}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)??null;}
  addEventListener(...args){events.push(args);}
 }
 const document={
  createElement(tag){assert.equal(tag,'workflow-status-banner');const Banner=registry.get(tag);assert.ok(Banner);const node=new Banner();created.push(node);return node;},
  querySelector(selector){assert.equal(selector,'main');return{prepend(node){mounted.push(node);pending.push(Promise.resolve(node.connectedCallback()));}};}
 };
 const storage={getItem(key){reads.push(key);return key==='nexo_token'?'synthetic-workflow-token':key==='nexo_device_token'?'synthetic-workflow-device':null;}};
 const context=vm.createContext({URLSearchParams,Date,document,HTMLElement:Element,location:{pathname:path,search},localStorage:storage,sessionStorage:storage,
  customElements:{define(name,constructor){assert.equal(registry.has(name),false);registry.set(name,constructor);}},
  setTimeout(...args){timers.push(args);return timers.length;},setInterval(...args){timers.push(args);return timers.length;},addEventListener(...args){events.push(args);},
  async fetch(url,init){
   assert.equal(url,'/api/approval-engine/detail');
   calls.push({url,method:init.method,headers:JSON.parse(JSON.stringify(init.headers)),body:JSON.parse(init.body)});
   return{ok:status>=200&&status<300,status,async json(){jsonReads++;return payload;}};
  }
 });
 vm.runInContext('"use strict";\n'+executable,context,{timeout:1000,filename:'workflow-status-banner.js'});
 await Promise.all(pending);
 return{registry,created,mounted,calls,reads,events,timers,get jsonReads(){return jsonReads;},
  async connect(type,id){const Banner=registry.get('workflow-status-banner'),node=new Banner();if(type!==null)node.setAttribute('entity-type',type);if(id!==null)node.setAttribute('entity-id',id);await node.connectedCallback();return node;}
 };
}

function noIo(state){assert.equal(state.calls.length,0);assert.equal(state.reads.length,0);assert.equal(state.events.length,0);assert.equal(state.timers.length,0);}
function requestMatches(call,type,id){
 assert.equal(call.url,'/api/approval-engine/detail');assert.equal(call.method,'POST');
 assert.deepEqual(call.body,{entityType:type,entityId:Number(id)});assert.equal(String(call.body.entityId),String(id));
 assert.deepEqual(call.headers,{Authorization:'Bearer synthetic-workflow-token','X-Device-Token':'synthetic-workflow-device','Content-Type':'application/json'});
}

test('import on legitimate pages without document ID or on unrelated routes performs no credential reads or API actions',async()=>{
 for(const [path,search]of[['/purchase-document-view.html',''],['/sales-document-view.html','?print=1'],['/index.html','?id=42'],['/other-page.html','?id=42']]){
  const state=await fixture({path,search});noIo(state);assert.equal(state.created.length,0);assert.equal(state.registry.size,1);
 }
 const empty=await fixture();const node=await empty.connect(null,null);noIo(empty);assert.equal(node.textContent,'');
});

test('malformed, duplicate and unsafe query IDs cannot auto-mount a banner, read credentials or POST',async()=>{
 for(const path of['/purchase-document-view.html','/sales-document-view.html'])for(const search of invalidQueries){
  const state=await fixture({path,search:search+'&print=1'});noIo(state);assert.equal(state.created.length,0);assert.equal(state.mounted.length,0);
 }
});

test('component attributes are independently validated before credential reads even when invoked directly',async()=>{
 for(const id of[...invalidIds,'1&id=2','?id=1']){
  const state=await fixture();const node=await state.connect('PURCHASE_ORDER',id);noIo(state);assert.match(node.textContent,/identificador.*no es válido/);assert.equal(node.innerHTML,'');
 }
 for(const [type,id]of[['OTHER','1'],['purchase_order','1'],[null,'1'],['SALES_ORDER',null]]){
  const state=await fixture();const node=await state.connect(type,id);noIo(state);assert.match(node.textContent,/no es válido/);
 }
});

test('valid purchase/sales query IDs preserve the exact detail POST and safely render history without actions',async()=>{
 for(const [path,type]of[['/purchase-document-view.html','PURCHASE_ORDER'],['/sales-document-view.html','SALES_ORDER']])for(const queryId of['1','42','9007199254740991','%34%32']){
  const id=decodeURIComponent(queryId),state=await fixture({path,search:'?id='+queryId});
  assert.equal(state.calls.length,1);requestMatches(state.calls[0],type,id);assert.equal(state.mounted.length,1);
  const markup=state.mounted[0].innerHTML;
  assert.match(markup,/Flujo de aprobación/);assert.match(markup,/EN REVISION/);assert.match(markup,/&lt;img/);assert.match(markup,/&lt;script&gt;/);
  assert.doesNotMatch(markup,/<(?:script|img|button|form)\b|\bonclick=/i);assert.equal(state.events.length,0);assert.equal(state.timers.length,0);
 }
});

test('all supported explicit entity types keep the server detail body contract without inventing approval actions',async()=>{
 for(const type of['PURCHASE_ORDER','SALES_ORDER','PAYMENT_REQUEST','BUDGET_TRANSFER']){
  const state=await fixture({path:'/other-page.html'});noIo(state);const node=await state.connect(type,'42');
  assert.equal(state.calls.length,1);requestMatches(state.calls[0],type,'42');assert.match(node.innerHTML,/Historial de aprobación/);
  assert.doesNotMatch(node.innerHTML,/<(?:button|form)\b|data-(?:approve|reject)|\/act|\/bulk/);assert.equal(state.events.length,0);assert.equal(state.timers.length,0);
 }
});

test('permission denial and missing instances never render workflow details or issue follow-up actions',async()=>{
 for(const status of[401,403]){
  const state=await fixture({search:'?id=42',status,payload:{error:{message:'synthetic denied'}}});
  assert.equal(state.calls.length,1);requestMatches(state.calls[0],'PURCHASE_ORDER','42');assert.equal(state.jsonReads,0);assert.equal(state.mounted[0].innerHTML,'');assert.equal(state.events.length,0);assert.equal(state.timers.length,0);
 }
 const missing=await fixture({search:'?id=42',payload:{instance:null}});assert.equal(missing.calls.length,1);assert.equal(missing.mounted[0].innerHTML,'');assert.equal(missing.events.length,0);
});

test('banner dependency and both tracked load paths use fresh versions while view94 cache keys stay intact',async()=>{
 assert.ok(source.includes("import {readRouteId} from './route-id.js?v=20261103-route-id-guard';"));
 const [purchase,sales]=await Promise.all(['purchase-document-view.html','sales-document-view.js'].map(file=>readFile(new URL('../public/'+file,import.meta.url),'utf8')));
 assert.ok(purchase.includes('/workflow-status-banner.js?v=20261104-workflow-id-guard'));
 assert.ok(purchase.includes('/purchase-document-view.js?v=20261103-route-id-guard'));
 assert.ok(sales.includes("import('/workflow-status-banner.js?v=20261104-workflow-id-guard')"));
});
