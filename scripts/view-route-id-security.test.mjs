import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {escapeHtml} from '../public/html-safety.js';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const version='20261103-route-id-guard';
const validator=await readFile(new URL('../public/route-id.js',import.meta.url),'utf8');
const validatorCode=validator.replace(/^export /gm,'');
const screens=[
 {name:'supplier-payment-view',message:'number',button:'.print',output:'number',value:'SYN-PAY',paths:id=>['/api/purchasing/supplier-payments/access','/api/purchasing/supplier-payments/'+id]},
 {name:'purchase-document-view',message:'number',button:'.print',output:'number',value:'SYN-PUR',paths:id=>['/api/purchasing/workflow/'+id,'/api/purchasing/workflow/options']},
 {name:'sales-document-view',message:'number',button:'#print',output:'number',value:'SYN-SALE',paths:id=>['/api/sales/workflow/'+id]},
 {name:'fixed-asset-view',message:'message',button:'#print',output:'title',value:'SYN-ASSET · Synthetic',paths:id=>['/api/fixed-assets/workflow-manage/'+id]},
 {name:'bank-deposit-view',message:'error',button:'#print',output:'number',value:'SYN-DEP',paths:id=>['/api/banking/deposits/'+id,'/api/accounting/chart-accounts','/api/organization/accounting-periods']},
 {name:'bank-fee-view',message:'number',button:'#printButton',output:'number',value:'SYN-FEE',paths:id=>['/api/banking/fees/'+id]}
];
for(const screen of screens)[screen.source,screen.html]=await Promise.all(['js','html'].map(extension=>readFile(new URL('../public/'+screen.name+'.'+extension,import.meta.url),'utf8')));

const invalidQueries=[
 '', '?id=', '?id=1&id=2',
 ...['../2','..\\2','1/2','1\\2','1?other=/api','1#fragment','%2e%2e%2f2','-1','0','00','01','+1','1.0','1e3','0x10','base36','z1','NaN','Infinity','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000)].map(id=>'?'+new URLSearchParams({id})),
 '?id=%2e%2e%2f2','?id=1%2f2','?id=1%5c2','?id=1%3fother','?id=1%23fragment','?id=%252fother','?id=%00'
];

class Element{
 constructor(document,tag,attributes=''){
  this.document=document;this.tag=tag;this.id=/\bid="([^"]+)"/.exec(attributes)?.[1]??'';
  this.classes=(/\bclass="([^"]*)"/.exec(attributes)?.[1]??'').split(/\s+/);
  this.disabled=/\bdisabled(?:\s|=|$)/.test(attributes);this.hidden=/\bhidden(?:\s|=|$)/.test(attributes);this.textContent='';this.markup='';this.children=[];
 }
 set innerHTML(value){this.markup=value;this.document.parse(value);}
 get innerHTML(){return this.markup;}
 append(...nodes){this.children.push(...nodes);}
}
class Document{
 constructor(html){this.nodes=[];this.ids=new Map();this.body=new Element(this,'body');this.body.markup=html;this.parse(html);}
 parse(html){for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)){const node=new Element(this,match[1],match[2]);this.nodes.push(node);if(node.id)this.ids.set(node.id,node);}}
 getElementById(id){return this.ids.get(id)??null;}
 querySelector(selector){if(selector.startsWith('#'))return this.getElementById(selector.slice(1));if(selector.startsWith('.'))return this.nodes.find(node=>node.classes.includes(selector.slice(1)))??null;return this.nodes.find(node=>node.tag===selector)??null;}
 createElement(tag){return new Element(this,tag);}
}

function fixtureData(name,path,id){
 if(name==='supplier-payment-view')return path.endsWith('/access')?{canView:true}:{header:{payment_number:'SYN-PAY',amount_paid:25,currency:'CRC',supplier:'Synthetic'},applications:[{invoiceNumber:'SYN-INV',invoiceTotal:50,amount:25}],advances:[],impact:[]};
 if(name==='purchase-document-view')return path.endsWith('/options')?{suppliers:[],currencies:[],locations:[],sources:[],products:[],accounts:[],subsidiary:{name:'Synthetic company'}}:{header:{document_type:'QUOTE',document_number:'SYN-PUR',document_date:'2026-11-03'},lines:[]};
 if(name==='sales-document-view')return{header:{document_type:'QUOTE',document_number:'SYN-SALE',document_date:'2026-11-03'},refs:{customers:[],currencies:[],locations:[],sources:[],products:[],subsidiary:{name:'Synthetic company'}},lines:[]};
 if(name==='fixed-asset-view')return{asset:{id,number:'SYN-ASSET',name:'Synthetic',life:12,residual:0,currency:'CRC',cost:25},schedule:[],origins:[]};
 if(name==='bank-deposit-view')return path==='/api/accounting/chart-accounts'||path==='/api/organization/accounting-periods'?[]:{deposit:{deposit_number:'SYN-DEP',subsidiaryName:'Synthetic',currencyCode:'CRC',currencyName:'Colón',exchange_rate:1,deposit_date:'2026-11-03',total_amount:25},lines:[],impact:[]};
 if(name==='bank-fee-view')return{header:{fee_number:'SYN-FEE',amount:25,fee_date:'2026-11-03',expenseAccountNumber:'600',expenseAccountName:'Synthetic'},impact:[]};
 assert.fail('Unexpected synthetic view');
}

async function execute(screen,search){
 const document=new Document(screen.html),calls=[],reads=[],timers=[],navigation=[],prints=[];
 const id=new URLSearchParams(search).get('id'),allowed=screen.paths(id);
 const storage={getItem(key){reads.push(key);return key==='nexo_token'?'synthetic-route-id-token':key==='nexo_device_token'?'synthetic-route-id-device':null;}};
 const location={search,pathname:'/'+screen.name+'.html',assign:path=>navigation.push(path),replace:path=>navigation.push(path)};
 const window={location,print:()=>prints.push(true),close:()=>navigation.push('close')};
 const dependencies=[...screen.source.matchAll(/^import[^\r\n]*from '([^']+)';/gm)].map(match=>match[1]);
 assert.ok(dependencies.every(path=>/^\.\/(route-id|html-safety)\.js\?v=/.test(path)),'Unknown dependency must not be silently mocked');
 const code=screen.source.replace(/^import[^\r\n]*\r?\n/gm,'');
 const context=vm.createContext({document,location,window,URLSearchParams,Intl,Date,escapeHtml,print:window.print,history:{length:1,back:()=>navigation.push('back')},localStorage:storage,sessionStorage:storage,
  setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},clearTimeout(){},
  async fetch(path,init){
   const call={path:String(path),method:init.method??'GET',headers:JSON.parse(JSON.stringify(init.headers)),body:init.body};calls.push(call);
   assert.ok(allowed.includes(call.path),'Only this selected synthetic view API may be requested');
   const data=fixtureData(screen.name,call.path,id);
   return{ok:true,async json(){return data;},async text(){return JSON.stringify(data);}};
  }
 });
 // Execute the actual validator dependency in the same strict VM scope as the
 // actual view. Only ESM import declarations are supplied by the harness.
 await vm.runInContext('(async()=>{"use strict";\n'+validatorCode+'\n'+code+'\n})()',context,{timeout:1000,filename:screen.name+'.js'});
 return{document,calls,reads,timers,navigation,prints};
}

test('real shared validator accepts only one exact safe canonical positive decimal ID',()=>{
 for(const search of invalidQueries)assert.equal(vm.runInNewContext(validatorCode+'\nreadRouteId(search)',{URLSearchParams,search}),null);
 for(const [search,expected]of[['?id=1','1'],['?id=42','42'],['?id=9007199254740991','9007199254740991'],['?id=%34%32','42']])assert.equal(vm.runInNewContext(validatorCode+'\nreadRouteId(search)',{URLSearchParams,search}),expected);
 for(const search of[null,undefined,{},42])assert.equal(vm.runInNewContext(validatorCode+'\nreadRouteId(search)',{URLSearchParams,search}),null);
});

for(const screen of screens){
 test(screen.name+' invalid IDs stop credential reads, automatic loads, print and ID actions',async()=>{
  for(const [index,query]of invalidQueries.entries()){
   const search=query+(query?'&':'?')+'print=1',f=await execute(screen,search);
   assert.equal(f.calls.length,0,'Invalid query '+index+' must not fetch');assert.equal(f.reads.length,0);
   assert.equal(f.timers.length,0);assert.equal(f.navigation.length,0);assert.equal(f.prints.length,0);
   assert.match(f.document.getElementById(screen.message).textContent,/identificador.*no es válido/);
   assert.equal(f.document.querySelector(screen.button).disabled,true);
   for(const node of f.document.nodes)assert.notEqual(typeof node.onclick,'function','Invalid views must not bind document actions');
   assert.equal(f.calls.filter(call=>call.headers.Authorization?.startsWith('Bearer ')).length,0);
  }
 });
 test(screen.name+' valid IDs preserve detail/options routes and rendering with exact string identity',async()=>{
  for(const queryId of['1','42','9007199254740991','%34%32']){
   const id=decodeURIComponent(queryId),f=await execute(screen,'?id='+queryId);
   assert.deepEqual(f.calls.map(call=>call.path),screen.paths(id));
   assert.ok(f.calls.every(call=>call.method==='GET'&&call.headers.Authorization==='Bearer synthetic-route-id-token'&&call.headers['X-Device-Token']==='synthetic-route-id-device'&&call.body===undefined));
   assert.equal(f.document.getElementById(screen.output).textContent,screen.value);
   assert.equal(f.document.getElementById('error')?.textContent??'','');
   assert.ok(!f.document.body.innerHTML.includes('No fue posible abrir el documento'));
   assert.equal(f.prints.length,0);assert.equal(f.navigation.length,0);
  }
 });
}

test('six pages and their validator imports use fresh cache versions without changing process90 notification version',()=>{
 for(const screen of screens){
  assert.ok(screen.source.includes("import {readRouteId} from './route-id.js?v="+version+"';"));
  const references=[...screen.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]).filter(src=>src.split('?')[0]==='/'+screen.name+'.js');
  assert.deepEqual(references,['/'+screen.name+'.js?v='+version]);
 }
 assert.ok(screens[0].html.includes('/payment-notifications.js?v=20261103-notification-id-guard'));
});
