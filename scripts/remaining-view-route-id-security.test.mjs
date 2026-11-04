import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {escapeHtml,configureImage,configureAttachmentLink} from '../public/html-safety.js';
import {createIndexedLookup} from '../public/frontend-performance.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const validatorVersion='20261103-route-id-guard';
const viewVersion='20261104-remaining-view-route-id-guard';
const validator=(await readFile(new URL('../public/route-id.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const sourceNames=['bank-check-view-main','bank-check-view','customer-payment-view','sales-invoice-view','sales-note-view'];
const sources=new Map(await Promise.all(sourceNames.map(async name=>[name,await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8')])));
const screens=[
 {name:'bank-check-view',content:'document',disabled:['print','back'],edit:true,output:'number',value:'SYN-CHECK'},
 {name:'bank-check-view-main',page:'bank-check-view',content:'document',disabled:['print','back'],edit:true,output:'number',value:'SYN-CHECK'},
 {name:'customer-payment-view',content:'document',disabled:['downloadPdf','close'],output:'number',value:'SYN-PAYMENT'},
 {name:'sales-invoice-view',content:'invoice',disabled:['print','sendEmail','confirmEmail','back'],edit:true,output:'invoiceNumber',value:'SYN-INVOICE'},
 {name:'sales-note-view',content:'invoice',disabled:['print','back'],edit:true,output:'number',value:'SYN-NOTE'}
];
for(const screen of screens)screen.html=await readFile(new URL('../public/'+(screen.page??screen.name)+'.html',import.meta.url),'utf8');
const invalidQueries=['','?id=','?id=1&id=2','?id=42&id=42','?ID=42',
 ...['../2','..\\2','1/2','1\\2','1?other=/api','1#fragment','-1','0','00','01','+1','1.0','1e3','0x10','NaN','Infinity','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000),'<img src=x onerror=alert(1)>'].map(id=>'?'+new URLSearchParams({id})),
 '?id=%2e%2e%2f2','?id=1%2f2','?id=1%5c2','?id=1%3fother','?id=1%23fragment','?id=%252fother','?id=%00'];

class Element{
 constructor(document,tag,attributes=''){
  this.document=document;this.tag=tag;this.id=/\bid="([^"]+)"/.exec(attributes)?.[1]??'';
  this.disabled=/\bdisabled(?:\s|=|$)/.test(attributes);this.hidden=/\bhidden(?:\s|=|$)/.test(attributes);
  this.textContent='';this.markup='';this.children=[];this.attributes=new Map();this.classList={add:()=>{}};
 }
 set innerHTML(value){this.markup=value;this.document.parse(value);}
 get innerHTML(){return this.markup;}
 append(...nodes){this.children.push(...nodes);}
 removeAttribute(name){this.attributes.delete(name);delete this[name];}
 setAttribute(name,value){this.attributes.set(name,String(value));this[name]=String(value);}
 closest(selector){assert.equal(selector,'table');return this.document.lineTable;}
 showModal(){this.open=true;}
 close(){this.open=false;}
}
class Document{
 constructor(html){
  this.nodes=[];this.ids=new Map();this.body=new Element(this,'body');this.body.markup=html;this.parse(html);
  const parts=new Map([['thead',new Element(this,'thead')],['tfoot tr',new Element(this,'tr')]]);
  this.lineTable={querySelector:selector=>{assert.ok(parts.has(selector));return parts.get(selector);}};
 }
 parse(html){for(const match of String(html).matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)){
  const node=new Element(this,match[1],match[2]);this.nodes.push(node);if(node.id)this.ids.set(node.id,node);
 }}
 getElementById(id){return this.ids.get(id)??null;}
 createElement(tag){const node=new Element(this,tag);this.nodes.push(node);return node;}
}

const checkCatalogs=['/api/accounting/chart-accounts','/api/entities/customers','/api/entities/suppliers','/api/entities/employees',
 '/api/organization/departments','/api/organization/cost-centers','/api/organization/classes','/api/organization/financial-creditors','/api/organization/related-companies'];
function detail(name,path,id,kind){
 if(name.startsWith('bank-check-view'))return path.startsWith('/api/banking/checks/')
  ?{header:{check_number:'SYN-CHECK',payment_type:'CHEQUE',subsidiaryName:'Synthetic',payment_date:'2026-11-04',amount:25,currencyCode:'CRC'},lines:[{line_number:1,account_id:7,amount:25}],impact:[]}
  :path==='/api/accounting/chart-accounts'?[{account_id:7,account_number:'101',account_name:'Synthetic'}]:[];
 if(name==='customer-payment-view')return{header:{payment_number:'SYN-PAYMENT',currency:'CRC',amount_received:25,payment_date:'2026-11-04'},applications:[],advances:[],impact:[]};
 if(name==='sales-invoice-view')return{invoices:[{invoice_id:id,invoice_number:'SYN-INVOICE',customer_id:1,currency_id:1,total_amount:25}],invoiceLines:[],withholdings:[],customers:[{customer_id:1,company_name:'Synthetic',email:'synthetic@example.invalid'}],products:[],taxes:[],terms:[],currencies:[{currency_id:1,currency_code:'CRC'}],countries:[],supports:[],subsidiaries:[{name:'Synthetic'}],access:{canEdit:true}};
 const note={cn_id:id,dn_id:id,cn_number:'SYN-NOTE',dn_number:'SYN-NOTE',invoice_id:1,customer_id:1,currency_id:1,amount:25};
 return{credits:kind==='CREDIT'?[note]:[],debits:kind==='DEBIT'?[note]:[],noteLines:[],invoices:[{invoice_id:1,invoice_number:'SYN-INVOICE'}],customers:[{customer_id:1,company_name:'Synthetic'}],products:[],currencies:[{currency_id:1,currency_code:'CRC'}],countries:[],subsidiaries:[{name:'Synthetic'}],access:{canEdit:true}};
}
function expectedPaths(screen,id,kind='CREDIT'){
 if(screen.name==='bank-check-view')return['/api/banking/checks/'+id,checkCatalogs[0],'/api/banking/checks/'+id,...checkCatalogs];
 if(screen.name==='bank-check-view-main')return['/api/banking/checks/'+id,checkCatalogs[0]];
 if(screen.name==='customer-payment-view')return['/api/sales/customer-payments/'+id];
 if(screen.name==='sales-invoice-view')return['/api/sales/invoice-context?action=view&id='+id];
 return['/api/sales/note-context/'+kind+'?action=view&id='+id];
}

async function execute(screen,search){
 const document=new Document(screen.html),calls=[],reads=[],timers=[],navigation=[],prints=[],imports=[],historyChanges=[];
 const params=new URLSearchParams(search),id=params.get('id'),kind=params.get('kind')==='DEBIT'?'DEBIT':'CREDIT';
 const allowed=expectedPaths(screen,id,kind);
 const storage={getItem(key){reads.push(key);return key==='nexo_token'?'synthetic-view-token':key==='nexo_device_token'?'synthetic-view-device':null;}};
 const location={search,pathname:'/'+(screen.page??screen.name)+'.html',assign:path=>navigation.push(path)};
 const window={location,print:()=>prints.push(true)};
 let context;
 const evaluate=async name=>{
  const source=sources.get(name);assert.ok(source,'Unknown module');
  const dependencies=[...source.matchAll(/^import[^\r\n]*from\s*'([^']+)';/gm)].map(match=>match[1]);
  assert.ok(dependencies.every(path=>/^\.\/(route-id|html-safety|frontend-performance)\.js\?v=/.test(path)),'Unknown imports cannot be silently mocked');
  let code=source.replace(/^import[^\r\n]*\r?\n/gm,'');
  if(name==='bank-check-view'){
   assert.equal([...code.matchAll(/await import\(/g)].length,1);
   code=code.replace("await import('./bank-check-view-main.js?v="+viewVersion+"')","await loadBankCheckMain('./bank-check-view-main.js?v="+viewVersion+"')");
  }
  await vm.runInContext('(async()=>{"use strict";\n'+validator+'\n'+code+'\n})()',context,{timeout:1000,filename:name+'.js'});
 };
 context=vm.createContext({document,location,window,URLSearchParams,Intl,Date,Map,WeakMap,
  escapeHtml,htmlText:escapeHtml,configureImage,configureAttachmentLink,createIndexedLookup,
  localStorage:storage,sessionStorage:storage,print:window.print,
  history:{length:1,back:()=>navigation.push('back'),replaceState(_state,_title,url){historyChanges.push(url);location.search=new URL(url,'https://synthetic.invalid').search;}},
  setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},clearTimeout(){},
  async loadBankCheckMain(path){assert.equal(path,'./bank-check-view-main.js?v='+viewVersion);imports.push(path);await evaluate('bank-check-view-main');},
  async fetch(path,init={}){
   const call={path:String(path),method:init.method??'GET',headers:JSON.parse(JSON.stringify(init.headers)),body:init.body};calls.push(call);
   const actionPath=screen.name==='sales-invoice-view'?'/api/sales/invoices/'+id:screen.name==='customer-payment-view'?'/api/sales/customer-payments/'+id:null;
   const action=actionPath&&[actionPath+'/pdf',actionPath+'/email'].includes(call.path);
   assert.ok(allowed.includes(call.path)||action,'Only the selected synthetic view API may be requested');
   const data=action?call.path.endsWith('/email')?{recipient:'synthetic@example.invalid'}:{error:{message:'Synthetic PDF intentionally not generated'}}:detail(screen.name,call.path,id,kind);
   return{ok:!call.path.endsWith('/pdf'),async json(){return data;}};
  }
 });
 await evaluate(screen.name);
 return{document,calls,reads,timers,navigation,prints,imports,historyChanges};
}

for(const screen of screens){
 test(screen.name+' rejects malformed, duplicate and unsafe IDs before credentials, imports, API, print or actions',async()=>{
  for(const [index,query]of invalidQueries.entries()){
   const f=await execute(screen,query+(query?'&':'?')+'print=1');
   assert.equal(f.calls.length,0,'Query '+index);assert.equal(f.reads.length,0,'Query '+index);
   assert.equal(f.imports.length,0);assert.equal(f.timers.length,0);assert.equal(f.prints.length,0);
   assert.equal(f.navigation.length,0);assert.equal(f.historyChanges.length,0);
   assert.match(f.document.getElementById('error').textContent,/identificador.*no es válido/);
   assert.equal(f.document.getElementById(screen.content).hidden,true);
   if(screen.edit)assert.equal(f.document.getElementById('edit').hidden,true);
   for(const button of screen.disabled)assert.equal(f.document.getElementById(button).disabled,true,button);
   for(const node of f.document.nodes)assert.notEqual(typeof node.onclick,'function');
  }
 });
 test(screen.name+' preserves canonical safe string identity, original GET contracts and successful rendering',async()=>{
  for(const queryId of['1','42','9007199254740991','%34%32']){
   const id=decodeURIComponent(queryId),f=await execute(screen,'?id='+queryId);
   assert.deepEqual(f.calls.map(call=>call.path),expectedPaths(screen,id));
   for(const call of f.calls){assert.equal(call.method,'GET');assert.equal(call.body,undefined);assert.equal(call.headers.Authorization,'Bearer synthetic-view-token');assert.equal(call.headers['X-Device-Token'],'synthetic-view-device');}
   assert.equal(f.document.getElementById(screen.output).textContent,screen.value);
   assert.equal(f.document.getElementById(screen.content).hidden,false);
   assert.equal(f.document.getElementById('error').textContent,'');
   assert.equal(f.prints.length,0);assert.equal(f.navigation.length,0);
   if(screen.edit)assert.match(f.document.getElementById('edit').href,new RegExp('(?:\\?|&)id='+id+'$'));
   assert.equal(f.imports.length,screen.name==='bank-check-view'?1:0);
  }
 });
}

test('bank-check wrapper validates before changing print history and retains one automatic print after main import',async()=>{
 const f=await execute(screens[0],'?id=%34%32&print=1');
 assert.equal(f.imports.length,1);assert.deepEqual(f.historyChanges,['/bank-check-view.html?id=42']);
 assert.equal(f.timers.length,1);assert.equal(f.timers[0].delay,2000);f.timers[0].callback();assert.equal(f.prints.length,1);
 const direct=await execute(screens[1],'?id=42&print=1');
 assert.equal(direct.timers.length,1);assert.equal(direct.timers[0].delay,500);direct.timers[0].callback();assert.equal(direct.prints.length,1);
});

test('customer payment valid PDF action keeps the checked canonical ID and JWT without producing a real export',async()=>{
 for(const id of['42','9007199254740991']){
  const f=await execute(screens[2],'?id='+id);
  await f.document.getElementById('downloadPdf').onclick();
  assert.equal(f.calls.at(-1).path,'/api/sales/customer-payments/'+id+'/pdf');
  assert.equal(f.calls.at(-1).headers.Authorization,'Bearer synthetic-view-token');
  assert.match(f.document.getElementById('actionMessage').textContent,/Synthetic PDF/);
 }
});

test('invoice valid PDF and email actions use only the checked ID and preserve GET versus POST body contracts',async()=>{
 for(const id of['42','9007199254740991']){
  const f=await execute(screens[3],'?id='+id);
  await f.document.getElementById('print').onclick();
  assert.equal(f.calls.at(-1).path,'/api/sales/invoices/'+id+'/pdf');assert.equal(f.calls.at(-1).method,'GET');
  f.document.getElementById('sendEmail').onclick();assert.equal(f.document.getElementById('emailDialog').open,true);
  await f.document.getElementById('confirmEmail').onclick();
  assert.equal(f.calls.at(-1).path,'/api/sales/invoices/'+id+'/email');assert.equal(f.calls.at(-1).method,'POST');assert.equal(f.calls.at(-1).body,'{}');
  assert.equal(f.calls.at(-1).headers.Authorization,'Bearer synthetic-view-token');assert.equal(f.calls.at(-1).headers['Content-Type'],'application/json');
  assert.equal(f.document.getElementById('emailDialog').open,false);
 }
});

test('sales notes retain CREDIT/DEBIT context and encoded edit navigation for valid IDs',async()=>{
 for(const kind of['CREDIT','DEBIT']){
  const f=await execute(screens[4],'?kind='+kind+'&id=%34%32');
  assert.deepEqual(f.calls.map(call=>call.path),expectedPaths(screens[4],'42',kind));
  assert.equal(f.document.getElementById('edit').href,'/sales-note-entry.html?kind='+kind+'&id=42');
  f.document.getElementById('print').onclick();assert.equal(f.prints.length,1);
 }
});

test('all four HTML entries and bank-check dynamic main import use fresh versions while shared P94/media imports remain intact',()=>{
 for(const screen of screens.filter(screen=>!screen.page)){
  const scripts=[...screen.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(scripts.filter(src=>src.split('?')[0]==='/'+screen.name+'.js'),['/'+screen.name+'.js?v='+viewVersion]);
 }
 for(const source of sources.values())assert.ok(source.includes("import {readRouteId} from './route-id.js?v="+validatorVersion+"';"));
 assert.ok(sources.get('bank-check-view').includes("import('./bank-check-view-main.js?v="+viewVersion+"')"));
 for(const name of['sales-invoice-view','sales-note-view'])assert.ok(sources.get(name).includes("from './html-safety.js?v=20261102-a03-media'"));
 assert.ok(sources.get('sales-invoice-view').includes("from './frontend-performance.js?v=20261023-second-pass-v3'"));
});
