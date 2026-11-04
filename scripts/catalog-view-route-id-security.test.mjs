import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {createIndexedLookup} from '../public/frontend-performance.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const validatorVersion='20261103-route-id-guard',viewVersion='20261104-catalog-view-route-id-guard';
const handoffKey='nexo_view_supplier_invoice';
const validator=(await readFile(new URL('../public/route-id.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const htmlSafety=(await readFile(new URL('../public/html-safety.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const screens=[
 {name:'supplier-invoice-view',content:'content',output:'title',value:'Factura de proveedor SYN-INVOICE'},
 {name:'journal-view',content:'document',output:'number',value:'ASI_REV_PEN-SYN'},
 {name:'supplier-note-view',content:'content',output:'title',value:'Nota de crédito SYN-NOTE'}
];
for(const screen of screens)[screen.source,screen.html]=await Promise.all(['js','html'].map(extension=>readFile(new URL('../public/'+screen.name+'.'+extension,import.meta.url),'utf8')));
const invalidIds=['','../2','..\\2','1/2','1?other=/api','1#fragment','-1','0','00','01','+1','1.0','1e3','0x10','NaN','Infinity','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000),'<img src=x onerror=alert(1)>'];
const invalidQueries=['?id=1&id=2','?id=42&id=42','?id=%2e%2e%2f2','?id=1%2f2','?id=1%5c2','?id=%252fother','?id=%00',...invalidIds.map(id=>'?'+new URLSearchParams({id}))];
class Element{
 constructor(document,tag,attributes=''){
  this.document=document;this.tag=tag;this.id=/\bid="([^"]+)"/.exec(attributes)?.[1]??'';
  this.classes=(/\bclass="([^"]*)"/.exec(attributes)?.[1]??'').split(/\s+/);
  this.dataset={};for(const match of attributes.matchAll(/\bdata-([a-z-]+)="([^"]*)"/g))this.dataset[match[1].replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=match[2];
  this.hidden=/\bhidden(?:\s|=|$)/.test(attributes);this.disabled=false;this.textContent='';this.markup='';this.children=[];this.listeners=[];
  this.classList={toggle:()=>{}};
 }
 set innerHTML(value){this.markup=value;this.document.parse(value);}
 get innerHTML(){return this.markup;}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[...nodes];}
 removeAttribute(name){delete this[name];}
 closest(selector){assert.equal(selector,'table');return this.document.table;}
 addEventListener(name,callback){this.listeners.push({name,callback});}
}
class Document{
 constructor(html){this.nodes=[];this.ids=new Map();this.table={};this.parse(html);}
 parse(html){for(const match of String(html).matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)){
  const node=new Element(this,match[1],match[2]);this.nodes.push(node);if(node.id)this.ids.set(node.id,node);
 }}
 getElementById(id){return this.ids.get(id)??null;}
 querySelectorAll(selector){
  if(selector==='[data-tab]')return this.nodes.filter(node=>Object.hasOwn(node.dataset,'tab'));
  if(selector.startsWith('.'))return this.nodes.filter(node=>node.classes.includes(selector.slice(1)));
  assert.fail('Unknown DOM selector '+selector);
 }
 createElement(tag){const node=new Element(this,tag);this.nodes.push(node);return node;}
}
const invoicePaths=['/api/purchasing/supplier-invoices','/api/purchasing/supplier-invoice-lines','/api/accounting/chart-accounts','/api/entities/suppliers','/api/configuration/payment-terms','/api/core/currencies','/api/organization/departments','/api/organization/cost-centers','/api/organization/classes','/api/configuration/tax-codes','/api/accounting/gl-impacts','/api/accounting/journal-supports','/api/organization/subsidiaries','/api/organization/locations','/api/purchasing/supplier-invoice-withholdings'];
const journalPaths=['/api/accounting/journals','/api/accounting/journal-lines','/api/accounting/gl-impacts','/api/accounting/chart-accounts','/api/core/currencies','/api/core/countries','/api/organization/accounting-periods','/api/organization/subsidiaries','/api/organization/locations','/api/configuration/tax-codes','/api/organization/departments','/api/organization/classes','/api/organization/cost-centers','/api/entities/customers','/api/entities/suppliers','/api/entities/employees','/api/accounting/journal-supports'];
const notePaths=kind=>['/api/purchasing/supplier-note-access/'+kind,'/api/purchasing/supplier-note-options/'+kind,kind==='CREDIT'?'/api/purchasing/supplier-credit-notes':'/api/purchasing/supplier-debit-notes','/api/purchasing/supplier-note-lines','/api/entities/suppliers','/api/accounting/chart-accounts','/api/configuration/tax-codes','/api/organization/departments','/api/organization/cost-centers','/api/organization/classes','/api/core/currencies','/api/organization/subsidiaries','/api/organization/locations','/api/accounting/gl-impacts','/api/accounting/journal-supports'];
const paths=(screen,kind='CREDIT')=>screen.name==='supplier-invoice-view'?invoicePaths:screen.name==='journal-view'?journalPaths:notePaths(kind);
function fixture(screen,path,id,kind){
 const journalId=screen.name==='journal-view'?id:8;
 const support=[{journal_id:journalId,support_type:'Archivo',file_name:'synthetic.pdf',file_data:'data:application/pdf;base64,JVBERi0=',display_name:'Synthetic file'},
  {journal_id:journalId,support_type:'Enlace',support_url:'https://synthetic.invalid/support',display_name:'Synthetic link'}];
 const invoices=[{invoice_id:screen.name==='supplier-invoice-view'?id:10,invoice_number:'SYN-INVOICE',supplier_id:1,currency_id:1,subsidiary_id:1,journal_id:8,transaction_id:9,total_amount:25,invoice_date:'2026-11-04'}];
 if(path.includes('/supplier-note-access/'))return{canView:true,canEdit:true};
 if(path.includes('/supplier-note-options/'))return{invoices};
 if(path==='/api/purchasing/supplier-invoices')return invoices;
 if(path==='/api/purchasing/supplier-invoice-lines')return[{invoice_id:id,account_id:7,amount:25,tax_amount:0}];
 if(path==='/api/purchasing/supplier-credit-notes'||path==='/api/purchasing/supplier-debit-notes')return[{cn_id:id,dn_id:id,cn_number:'SYN-NOTE',dn_number:'SYN-NOTE',invoice_id:10,currency_id:1,journal_id:8,transaction_id:9,amount:25}];
 if(path==='/api/purchasing/supplier-note-lines')return[{note_kind:kind,note_id:id,account_id:7,amount:25,tax_amount:0}];
 if(path==='/api/accounting/journals')return[{journal_id:id,journal_number:'ASI_REV_PEN-SYN',journal_type:'Reversión de Pendiente de Facturar',reversed_from_journal_id:2,subsidiary_id:1,currency_id:1,fiscal_period_id:1,transaction_id:9}];
 if(path==='/api/accounting/journal-lines')return[{journal_id:id,journal_line_id:1,account_id:7,service_month:'2026-11',service_country_id:1,debit:25,credit:0}];
 if(path==='/api/accounting/journal-supports')return support;
 if(path==='/api/accounting/chart-accounts')return[{account_id:7,account_number:'101',account_name:'Synthetic'}];
 if(path==='/api/core/currencies')return[{currency_id:1,currency_code:'CRC',name:'Colón'}];
 if(path==='/api/core/countries')return[{country_id:1,name:'Synthetic country'}];
 if(path==='/api/organization/subsidiaries')return[{subsidiary_id:1,name:'Synthetic company'}];
 return[];
}
async function execute(screen,search,{handoff=null,store,canView=true}={}){
 const document=new Document(screen.html),calls=[],reads=[],removes=[],writes=[],events=[],timers=[],prints=[],navigation=[];
 const sessionValues=store??new Map(handoff===null?[]:[[handoffKey,handoff]]);
 const storage=area=>({getItem(key){reads.push({area,key});events.push('read:'+key);if(key===handoffKey)return sessionValues.get(key)??null;return key==='nexo_token'?'synthetic-catalog-token':key==='nexo_device_token'?'synthetic-catalog-device':null;},
  removeItem(key){removes.push({area,key});events.push('remove:'+key);sessionValues.delete(key);},setItem(key,value){writes.push({area,key,value});sessionValues.set(key,value);}});
 const params=new URLSearchParams(search),id=params.get('id')??handoff??'42',kind=params.get('kind')==='DEBIT'?'DEBIT':'CREDIT';
 const location={search,assign:path=>navigation.push(path)},window={print:()=>prints.push(true)};
 const dependencies=[...screen.source.matchAll(/^import[^\r\n]*from\s*'([^']+)';/gm)].map(match=>match[1]);
 assert.ok(dependencies.every(path=>/^\.\/(route-id|html-safety|frontend-performance)\.js\?v=/.test(path)));
 const code=screen.source.replace(/^import[^\r\n]*\r?\n/gm,'');
 const context=vm.createContext({document,location,window,URL,URLSearchParams,Intl,Date,Map,WeakMap,
  createIndexedLookup,
  localStorage:storage('local'),sessionStorage:storage('session'),
  setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},
  async fetch(path,init={}){
   events.push('fetch:'+path);const call={path:String(path),method:init.method??'GET',headers:JSON.parse(JSON.stringify(init.headers)),body:init.body};calls.push(call);
   assert.ok(paths(screen,kind).includes(call.path),'Only fixed synthetic catalog endpoints may be requested');
   const payload=path.includes('/supplier-note-access/')?{canView,canEdit:canView}:fixture(screen,path,id,kind);
   return{ok:true,async json(){return payload;}};
  }
 });
 // Run both actual shared modules in the view's DOM realm; attachment helpers
 // must resolve the synthetic document rather than a host document or a stub.
 await vm.runInContext('(async()=>{"use strict";\n'+validator+'\n'+htmlSafety+'\n'+code+'\n})()',context,{timeout:1000,filename:screen.name+'.js'});
 return{document,calls,reads,removes,writes,events,timers,prints,navigation,store:sessionValues,location};
}
function assertClosed(screen,f){
 assert.equal(f.calls.length,0);assert.equal(f.timers.length,0);assert.equal(f.prints.length,0);assert.equal(f.navigation.length,0);assert.equal(f.writes.length,0);
 assert.match(f.document.getElementById('error').textContent,/identificador.*no es válido/);assert.equal(f.document.getElementById(screen.content).hidden,true);
 if(screen.name==='journal-view'){assert.equal(f.document.getElementById('edit').disabled,true);assert.equal(f.document.getElementById('pdf').disabled,true);}
 else assert.equal(f.document.getElementById('edit').hidden,true);
 for(const node of f.document.nodes){assert.notEqual(typeof node.onclick,'function');assert.equal(node.listeners.length,0);}
}

for(const screen of screens){
 test(screen.name+' rejects present malformed or duplicate IDs before handoff, credentials, catalogs or document actions',async()=>{
  for(const query of invalidQueries){const f=await execute(screen,query+'&print=1',{handoff:'42'});assertClosed(screen,f);assert.equal(f.reads.length,0);assert.equal(f.removes.length,0);}
 });
 test(screen.name+' preserves valid canonical ID filtering, fixed catalog calls, attachments and edit behavior',async()=>{
  for(const queryId of['1','42','9007199254740991','%34%32']){
   const id=decodeURIComponent(queryId),f=await execute(screen,'?id='+queryId,{handoff:'INVALID-UNREAD-HANDOFF'});
   assert.deepEqual(f.calls.map(call=>call.path),paths(screen));
   for(const call of f.calls){assert.equal(call.method,'GET');assert.equal(call.body,undefined);assert.equal(call.headers.Authorization,'Bearer synthetic-catalog-token');assert.equal(call.headers['X-Device-Token'],'synthetic-catalog-device');}
   assert.equal(f.document.getElementById(screen.output).textContent,screen.value);assert.equal(f.document.getElementById('error').textContent,'');
   assert.equal(f.document.getElementById(screen.content).hidden,false);assert.equal(f.timers.length,0);assert.equal(f.prints.length,0);
   assert.equal(f.reads.some(read=>read.key===handoffKey),false);
   if(screen.name==='journal-view'){f.document.getElementById('edit').onclick();assert.equal(f.location.href,'/journal-entry.html?id='+id);}
   else assert.match(f.document.getElementById('edit').href,new RegExp('(?:\\?|&)id='+id+'$'));
   const links=f.document.nodes.filter(node=>node.tag==='a'&&node.download==='synthetic.pdf');assert.equal(links.length,1);assert.equal(links[0].href,'data:application/pdf;base64,JVBERi0=');assert.equal(links[0].rel,'noopener noreferrer');
   const remoteLinks=f.document.nodes.filter(node=>node.tag==='a'&&node.href==='https://synthetic.invalid/support');assert.equal(remoteLinks.length,1);assert.equal(remoteLinks[0].rel,'noopener noreferrer');assert.equal(remoteLinks[0].target,'_blank');
  }
 });
}

test('journal and supplier note missing IDs stop before any storage read or catalog fanout',async()=>{
 for(const screen of screens.slice(1))for(const query of['','?kind=DEBIT','?print=1']){const f=await execute(screen,query);assertClosed(screen,f);assert.equal(f.reads.length,0);}
});
test('supplier invoice absent query validates only its one-time session ID before credentials and API',async()=>{
 for(const id of['1','42','9007199254740991']){
  const f=await execute(screens[0],'?print=1',{handoff:id});
  assert.deepEqual(f.reads[0],{area:'session',key:handoffKey});assert.deepEqual(f.removes,[{area:'session',key:handoffKey}]);
  assert.ok(f.events.indexOf('remove:'+handoffKey)<f.events.indexOf('read:nexo_token'));
  assert.equal(f.reads.filter(read=>read.key===handoffKey).length,1);assert.deepEqual(f.calls.map(call=>call.path),invoicePaths);
  assert.equal(f.document.getElementById('edit').href,'/supplier-invoice-entry.html?id='+id);assert.equal(f.store.has(handoffKey),false);
 }
});
test('supplier invoice invalid or missing fallback reads only the ID key and never credentials or APIs',async()=>{
 for(const handoff of[null,...invalidIds,'{"id":"42","createdAt":1}','%34%32']){
  const f=await execute(screens[0],'',{handoff});assertClosed(screens[0],f);
  assert.deepEqual(f.reads,[{area:'session',key:handoffKey}]);assert.equal(f.removes.length,handoff===null?0:1);
 }
});
test('supplier invoice handoff cannot replay and explicit valid query wins without reading fallback',async()=>{
 const store=new Map([[handoffKey,'42']]);
 const first=await execute(screens[0],'',{handoff:'42',store});assert.equal(first.calls.length,invoicePaths.length);
 const second=await execute(screens[0],'',{store});assertClosed(screens[0],second);assert.deepEqual(second.reads,[{area:'session',key:handoffKey}]);
 const explicit=await execute(screens[0],'?id=42',{handoff:'9007199254740992'});
 assert.equal(explicit.calls.length,invoicePaths.length);assert.equal(explicit.reads.some(read=>read.key===handoffKey),false);assert.deepEqual(explicit.removes,[{area:'session',key:handoffKey}]);
});
test('supplier invoice edit handoff is written only by its valid ID action and preserves the timed entry contract',async()=>{
 const f=await execute(screens[0],'?id=9007199254740991');assert.equal(f.writes.length,0);
 const edit=f.document.getElementById('edit');assert.equal(edit.listeners.length,1);edit.listeners[0].callback();
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].key,'nexo_edit_supplier_invoice');
 const value=JSON.parse(f.writes[0].value);assert.equal(value.id,'9007199254740991');assert.ok(Number.isFinite(value.createdAt));
});
test('journal preserves service dimensions, protected attachments and its existing valid auto-print',async()=>{
 const f=await execute(screens[1],'?id=42&print=1');assert.equal(f.document.getElementById('lineFooterRemainder').colSpan,11);
 for(const selector of['.service-month-dimension-column','.service-country-dimension-column']){const cells=f.document.querySelectorAll(selector);assert.ok(cells.length>0);assert.ok(cells.every(node=>node.hidden===false));}
 assert.equal(f.timers.length,1);assert.equal(f.timers[0].delay,350);f.timers[0].callback();assert.equal(f.prints.length,1);
});
test('supplier note retains CREDIT/DEBIT access and options ordering and never loads data after access denial',async()=>{
 for(const kind of['CREDIT','DEBIT']){
  const f=await execute(screens[2],'?kind='+kind+'&id=42');assert.deepEqual(f.calls.map(call=>call.path),notePaths(kind));
  assert.equal(f.document.getElementById('edit').href,'/supplier-note-entry.html?kind='+kind+'&id=42');
  const denied=await execute(screens[2],'?kind='+kind+'&id=42',{canView:false});
  assert.deepEqual(denied.calls.map(call=>call.path),['/api/purchasing/supplier-note-access/'+kind]);assert.equal(denied.document.getElementById('content').hidden,true);
 }
});
test('three pages refresh only their own view scripts and preserve shared validator, media and performance versions',()=>{
 for(const screen of screens){
  assert.ok(screen.source.includes("import {readRouteId} from './route-id.js?v="+validatorVersion+"';"));
  const references=[...screen.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]).filter(src=>src.split('?')[0]==='/'+screen.name+'.js');
  assert.deepEqual(references,['/'+screen.name+'.js?v='+viewVersion]);
  assert.ok(screen.source.includes("from './html-safety.js?v="+(screen.name==='journal-view'?'20261101-a03-1':'20261102-a03-media')+"';"));
 }
});
