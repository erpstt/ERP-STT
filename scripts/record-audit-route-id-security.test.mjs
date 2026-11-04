import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {readRouteId} from '../public/route-id.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const source=await readFile(new URL('../public/record-audit.js',import.meta.url),'utf8');
const invalidIds=['','../2','..\\2','1/2','1?other=/api','1#fragment','-1','0','00','01','+1','1.0','1e3','0x10','NaN','Infinity','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000),'<img src=x onerror=alert(1)>'];
const invalidQueries=['?id=1&id=2','?id=42&id=42','?id=%2e%2e%2f2','?id=%00',...invalidIds.map(id=>'?'+new URLSearchParams({id}))];
const uuid='11111111-1111-4111-8111-111111111111';
const actor={created_by_name:'Synthetic author',created_by_email:'synthetic@example.invalid',actor_type:'HUMAN'};
const pageTables={
 'supplier-invoice-view.html':'supplier_invoice','supplier-invoice-entry.html':'supplier_invoice',
 'sales-invoice-view.html':'invoice','sales-invoice-entry.html':'invoice','journal-view.html':'journal',
 'purchase-document-view.html':'purchase_document','sales-document-view.html':'sales_document',
 'supplier-payment-view.html':'supplier_payment','customer-payment-view.html':'customer_payment',
 'bank-check-view.html':'bank_check','bank-check-entry.html':'bank_check','bank-deposit-view.html':'bank_deposit',
 'bank-deposit-entry.html':'bank_deposit','bank-fee-view.html':'bank_fee','fixed-asset-view.html':'asset',
 'supplier-note-view.html':'supplier_credit_note','supplier-note-entry.html':'supplier_credit_note',
 'sales-note-view.html':'credit_note','sales-note-entry.html':'credit_note','pdf-template-builder.html':'pdf_templates'};
function fixture({page='index.html',search='',handoff=null,respond}={}){
 const registry=new Map(),queued=[],calls=[],reads=[],writes=[],removes=[],listeners=new Map(),created=[];
 let document;
 class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.attributes=new Map();this.dataset={};this.style={};this.textContent='';this.isConnected=false;this.classList={add:()=>{}};this.handlers=[];}
  attachShadow(){
   const shadow={content:null,markup:'',querySelector(selector){assert.equal(selector,'.content');return this.content;}};
   Object.defineProperty(shadow,'innerHTML',{set(value){this.markup=value;this.content=new Element('div');},get(){return this.markup;}});
   this.shadowRoot=shadow;return shadow;
  }
  connect(){this.isConnected=true;for(const child of this.children)child.connect();this.connectedCallback?.();}
  append(...nodes){for(const node of nodes){this.children.push(node);if(this.isConnected)node.connect();}}
  prepend(node){this.children.unshift(node);if(this.isConnected)node.connect();}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){const old=this.getAttribute(name);this.attributes.set(name,String(value));if(this.constructor.observedAttributes?.includes(name))this.attributeChangedCallback?.(name,old,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  addEventListener(name,callback){this.handlers.push({name,callback});}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){this.isConnected=false;this.disconnectedCallback?.();}
 }
 const main=new Element('main'),body=new Element('body');main.isConnected=body.isConnected=true;
 document={body,main,addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);},
  createElement(tag){const Class=registry.get(tag),element=Class?new Class():new Element(tag);element.tagName=tag.toUpperCase();created.push(element);return element;},
  querySelector(selector){assert.ok(['main','#entry'].includes(selector));return main;},
  querySelectorAll(selector){assert.equal(selector,'record-audit');return created.filter(element=>element.tagName==='RECORD-AUDIT'&&element.isConnected);}};
 const session=new Map(handoff===null?[]:[['nexo_view_supplier_invoice',handoff]]);
 const storage=area=>({getItem(key){reads.push({area,key});return key==='nexo_view_supplier_invoice'?session.get(key)??null:key==='nexo_token'?'synthetic-audit-token':key==='nexo_device_token'?'synthetic-audit-device':null;},
  setItem(key,value){writes.push(key);session.set(key,value);},removeItem(key){removes.push(key);session.delete(key);}});
 const window={};
 const context=vm.createContext({window,document,location:{pathname:'/'+page,search},HTMLElement:Element,
  customElements:{define(name,Class){assert.equal(name,'record-audit');registry.set(name,Class);}},
  URLSearchParams,AbortController,Date,Number,localStorage:storage('local'),sessionStorage:storage('session'),
  queueMicrotask(callback){queued.push(callback);},
  async fetch(path,init={}){
   const url=new URL(String(path),'https://synthetic.invalid');assert.equal(url.pathname,'/api/audit/record-actor');assert.equal(url.origin,'https://synthetic.invalid');
   calls.push({path:String(path),table:url.searchParams.get('table'),id:url.searchParams.get('id'),init});
   assert.equal(init.headers.Authorization,'Bearer synthetic-audit-token');assert.equal(init.headers['X-Device-Token'],'synthetic-audit-device');assert.equal(init.cache,'no-store');
   return respond?respond(calls.at(-1)):{ok:true,async json(){return actor;}};
  }});
 vm.runInContext(source,context,{timeout:1000,filename:'record-audit.js'});
 const drain=async()=>{for(let turn=0;turn<12;turn++){while(queued.length)queued.shift()();await Promise.resolve();}};
 const ready=async()=>{for(const callback of listeners.get('DOMContentLoaded')??[])callback();await drain();};
 const panel=()=>created.find(element=>element.tagName==='RECORD-AUDIT');
 return{window,document,created,calls,reads,writes,removes,listeners,session,drain,ready,panel,
  click(button){for(const callback of listeners.get('click')??[])callback({target:{closest(){return button;}},preventDefault(){}});}};
}

test('private classic decimal route guard stays in parity with the real shared helper, including duplicate and decoded parameters',async()=>{
 const queries=[...invalidQueries,'?id=1','?id=42','?id=%34%32','?id=9007199254740991'];
 for(const search of queries){const f=fixture({page:'sales-invoice-view.html',search});await f.ready();const expected=readRouteId(search);
  assert.equal(f.calls.length,expected===null?0:1,search.slice(0,100));
  if(expected!==null)assert.equal(f.calls[0].id,expected);else assert.equal(f.reads.length,0);
 }
});
test('all numeric document pages reject malformed or duplicate query IDs before fallback, credential reads, author requests or page handlers',async()=>{
 for(const page of Object.keys(pageTables))for(const search of invalidQueries){
  const f=fixture({page,search,handoff:'42'});await f.ready();assert.equal(f.reads.length,0,page);assert.equal(f.calls.length,0,page);
  assert.equal(f.listeners.get('DOMContentLoaded')?.length??0,0);assert.equal(f.panel(),undefined);assert.equal(f.writes.length,0);assert.equal(f.removes.length,0);
 }
});
test('valid decimal pages preserve table aliases, exact string ID, encoded API query and Bearer contract',async()=>{
 for(const [page,table]of Object.entries(pageTables))for(const queryId of['42','%34%32','9007199254740991']){
  const f=fixture({page,search:'?id='+queryId});await f.ready();assert.equal(f.calls.length,1,page);assert.equal(f.calls[0].table,table);assert.equal(f.calls[0].id,decodeURIComponent(queryId));
  assert.equal(f.calls[0].path,'/api/audit/record-actor?'+new URLSearchParams({table,id:decodeURIComponent(queryId)}));
 }
 for(const [page,table]of [['supplier-note-view.html','supplier_debit_note'],['sales-note-entry.html','debit_note']]){
  const f=fixture({page,search:'?kind=DEBIT&id=42'});await f.ready();assert.equal(f.calls[0].table,table);
 }
});
test('UUID remains valid for generic records while numeric document URL pages reject UUID IDs',async()=>{
 const f=fixture();f.window.NexoRecordAudit.show('tax_calendar_events',uuid);await f.drain();assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,uuid);
 assert.ok(f.window.NexoRecordAudit.button('tax_calendar_events',uuid).includes('data-record-audit-id="'+uuid+'"'));
 for(const page of Object.keys(pageTables)){const pageFixture=fixture({page,search:'?id='+uuid});await pageFixture.ready();assert.equal(pageFixture.calls.length,0);assert.equal(pageFixture.reads.length,0);}
});
test('missing view IDs close silently while optional create mode keeps the unsaved-record message with no credentials or API',async()=>{
 for(const page of Object.keys(pageTables)){
  const f=fixture({page});await f.ready();assert.equal(f.calls.length,0);
  assert.equal(f.reads.length,page==='supplier-invoice-view.html'?1:0);
  if(page.endsWith('-view.html'))assert.equal(f.panel(),undefined);
  else assert.match(f.panel().shadowRoot.content.textContent,/al guardar/);
 }
 const journal=fixture({page:'journal-entry.html',handoff:'42'});await journal.ready();assert.equal(journal.reads.length,0);assert.equal(journal.panel(),undefined);
});
test('legacy invoice fallback is read only with absent query and captured synchronously before the view consumes it',async()=>{
 for(const page of['supplier-invoice-view.html','supplier-invoice-entry.html']){
  const f=fixture({page,search:page.includes('entry')?'?view=1':'',handoff:'9007199254740991'});
  assert.deepEqual(f.reads,[{area:'session',key:'nexo_view_supplier_invoice'}]);assert.equal(f.calls.length,0);assert.equal(f.removes.length,0);
  // P114 consumes its own legacy key before DOMContentLoaded. The classic
  // component retains the validated snapshot and never re-reads that key.
  f.session.delete('nexo_view_supplier_invoice');await f.ready();assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,'9007199254740991');
  assert.equal(f.reads.filter(read=>read.key==='nexo_view_supplier_invoice').length,1);
 }
 for(const handoff of invalidIds.filter(Boolean)){
  const f=fixture({page:'supplier-invoice-view.html',handoff});await f.ready();assert.equal(f.calls.length,0);assert.deepEqual(f.reads,[{area:'session',key:'nexo_view_supplier_invoice'}]);assert.equal(f.panel(),undefined);
 }
});
test('valid explicit query never reads stale fallback and the audit sibling never consumes the view handoff',async()=>{
 const f=fixture({page:'supplier-invoice-view.html',search:'?id=42',handoff:'01'});await f.ready();assert.equal(f.calls[0].id,'42');assert.equal(f.reads.some(read=>read.key==='nexo_view_supplier_invoice'),false);assert.equal(f.removes.length,0);
});
test('generic component and show reject invalid IDs or table identifiers before tokens, API and retry handlers',async()=>{
 for(const [table,id]of [...invalidIds.filter(Boolean).map(id=>['invoice',id]),['bad/table','42'],['security:users','42'],['UPPER','42'],['invoice?other=1','42']]){
  const f=fixture();f.window.NexoRecordAudit.show(table,id);await f.drain();assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);
  assert.match(f.panel().shadowRoot.content.textContent,/identificador.*no es válido/);assert.equal(f.panel().shadowRoot.content.children.length,0);
  assert.equal(f.window.NexoRecordAudit.button(table,id),'');
 }
 const unsaved=fixture();unsaved.window.NexoRecordAudit.show('invoice',null);await unsaved.drain();assert.equal(unsaved.calls.length,0);assert.equal(unsaved.reads.length,0);assert.match(unsaved.panel().shadowRoot.content.textContent,/al guardar/);
});
test('direct attribute updates are validated and clear a previous actor before any invalid target request',async()=>{
 const f=fixture();f.window.NexoRecordAudit.show('invoice','42');await f.drain();assert.equal(f.calls.length,1);
 for(const value of['01','../2','9007199254740992']){
  const count=f.reads.length;f.panel().setAttribute('record-id',value);await f.drain();assert.equal(f.calls.length,1);assert.equal(f.reads.length,count);assert.match(f.panel().shadowRoot.content.textContent,/no es válido/);
 }
 f.panel().setAttribute('record-id',uuid);await f.drain();assert.equal(f.calls.at(-1).id,uuid);
 f.panel().setAttribute('table','bad/table');await f.drain();assert.equal(f.calls.length,2);assert.match(f.panel().shadowRoot.content.textContent,/no es válido/);
});
test('generic numeric targets preserve safe integer identity and reject unsafe numbers or coercible objects before IO',async()=>{
 for(const id of[1,42,9007199254740991]){const f=fixture();f.window.NexoRecordAudit.show('invoice',id);await f.drain();assert.equal(f.calls[0].id,String(id));}
 for(const id of[0,-1,1.5,NaN,Infinity,9007199254740992,true,{toString(){throw Error('MUST-NOT-COERCE');}}]){
  const f=fixture();f.window.NexoRecordAudit.show('invoice',id);await f.drain();assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);assert.match(f.panel().shadowRoot.content.textContent,/no es válido/);
 }
});
test('invalid actor buttons do not bind a dialog or request; valid UUID and decimal actions retain their targets',async()=>{
 for(const [table,id]of [['invoice','01'],['invoice','../2'],['bad/table','42'],['invoice','']]){
  const f=fixture();f.click({dataset:{recordAuditTable:table,recordAuditId:id}});await f.drain();assert.equal(f.created.length,0);assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);
 }
 for(const id of['42',uuid]){
  const f=fixture();f.click({dataset:{recordAuditTable:'invoice',recordAuditId:id}});await f.drain();assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,id);assert.ok(f.created.some(element=>element.tagName==='DIALOG'&&element.open));
 }
});
test('changing a target aborts immediately and ignores late successful or failed old responses even if provider ignores abort',async()=>{
 for(const mode of['success','http-error','network-error']){
  let finish,fail;const f=fixture({respond:()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;})});f.window.NexoRecordAudit.show('invoice','42');await f.drain();assert.equal(f.calls.length,1);
  const old=f.calls[0];f.panel().setAttribute('record-id','01');assert.equal(old.init.signal.aborted,true);await f.drain();
  if(mode==='network-error')fail(Error('STALE-PRIVATE-ERROR'));
  else finish({ok:mode==='success',async json(){return mode==='success'?{created_by_name:'STALE-PRIVATE-AUTHOR'}:{error:{message:'STALE-PRIVATE-ERROR'}};}});
  await f.drain();
  assert.match(f.panel().shadowRoot.content.textContent,/no es válido/);assert.equal(f.panel().shadowRoot.content.children.length,0);assert.equal(f.calls.length,1);
 }
});
test('replacing a valid target coalesces attribute updates and never renders another records late actor',async()=>{
 const waiting=[];const f=fixture({respond:call=>new Promise(resolve=>waiting.push({call,resolve}))});f.window.NexoRecordAudit.show('invoice','42');await f.drain();
 f.window.NexoRecordAudit.show('supplier_invoice','43');await f.drain();assert.equal(f.calls.length,2);assert.equal(waiting[0].call.init.signal.aborted,true);
 const rendered=[];const original=f.panel().render;f.panel().render=function(content,row){rendered.push(row.created_by_name);original.call(this,content,row);};
 waiting[1].resolve({ok:true,async json(){return{created_by_name:'CURRENT-AUTHOR'};}});await f.drain();
 waiting[0].resolve({ok:true,async json(){return{created_by_name:'STALE-AUTHOR'};}});await f.drain();assert.deepEqual(rendered,['CURRENT-AUTHOR']);
});
test('script stays classic and existing unversioned references retain no-cache static delivery',async()=>{
 assert.doesNotMatch(source,/^import\s|^export\s|import\(/m);
 const [server,index]=await Promise.all(['../src/server.ts','../public/index.html'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
 assert.ok(server.includes('<script defer src="/record-audit.js"></script>'));assert.ok(index.includes('<script defer src="/record-audit.js"></script>'));
 assert.ok(server.includes("searchParams.has('v')"));assert.ok(server.includes(":'no-cache, must-revalidate'"));
});
