import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
import {buildSupplierInvoiceFormOptions} from './lib/supplier-invoice-form-options-fixture.mjs';
assertIsolatedTestArgs();
const purchasingVersion='20261105-purchasing-functional-review',invoiceEntryVersion='20261106-supplier-invoice-form-options',version='20261104-optional-document-route-id-guard',bankVersion='20261105-banking-functional';
const mains=['sales-invoice-entry','sales-note-entry','supplier-invoice-entry','supplier-note-entry'];
const helpers=['sales-invoice-delivery-prefill','supplier-invoice-receipt-prefill'];
const sources=new Map(await Promise.all([...mains,...helpers].map(async name=>[name,await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8')])));
const pages=new Map(await Promise.all(mains.map(async name=>[name,await readFile(new URL('../public/'+name+'.html',import.meta.url),'utf8')])));
const shared=(await readFile(new URL('../public/route-id.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const safety=(await readFile(new URL('../public/html-safety.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const payable=(await readFile(new URL('../public/supplier-payable-routing.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const now=1793764800000;
const invalidIds=['','0','01','-1','+1','1.0','1e3','0x10','../2','1/2','1\\2','1?other=2','1#fragment',' 1','1 ','1\n','١','１２','9007199254740992','9223372036854775807','9'.repeat(10000)];
const invalidQueries=['?id=42&id=42','?id=1&id=2','?id=%00',...invalidIds.map(id=>'?'+new URLSearchParams({id}))];
const strip=code=>code.replace(/^import[^\r\n]*\r?\n/gm,'');

// Invalid routes execute each entire real entry module. Valid bootstrap tests
// run actual source statements through the authorization/options boundary;
// the rest of the accounting UI is covered separately, including all 27 P118
// handler cases. This projection neither recreates grants nor fabricates routes.
function bootstrap(name){
 const source=sources.get(name),parsed=ts.createSourceFile(name+'.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 assert.equal(parsed.parseDiagnostics.length,0);
 const guard=parsed.statements.find(node=>ts.isIfStatement(node)&&node.expression.getText(parsed)==='!validRoute');assert.ok(guard&&ts.isBlock(guard.elseStatement));
 const statements=[...guard.elseStatement.statements];let body;
 const snapshot=name==='sales-invoice-entry'?'id:editId,sourceId:deliveryId':name==='supplier-invoice-entry'?'id:invoiceId,sourceId:receiptRouteId,viewMode':'id:recordId,kind';
 const boundary='return {boundaryReached:true,'+snapshot+'};';
 if(name==='sales-note-entry'){
  const index=statements.findIndex(ts.isTryStatement),attempt=statements[index];assert.ok(index>=0);
  assert.match(attempt.tryBlock.statements[0].getText(parsed),/note-context/);assert.match(attempt.tryBlock.statements[1].getText(parsed),/canEdit/);
  body=statements.slice(0,index).map(node=>node.getText(parsed)).join('\n')+'\ntry{'+attempt.tryBlock.statements.slice(0,2).map(node=>node.getText(parsed)).join('\n')+'\n'+boundary+'}'+attempt.catchClause.getText(parsed);
 }else if(name==='supplier-invoice-entry'){
  const index=statements.findIndex(node=>ts.isIfStatement(node)&&node.expression.getText(parsed)==='await loadInvoiceFormOptions()'),attempt=statements[index];
  assert.ok(index>=0&&ts.isBlock(attempt.thenStatement),'Known invoice form-options boundary');
  const mounted=[...attempt.thenStatement.statements],hasBelongs=node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(parsed)==='belongs'),boundaryIndex=mounted.findIndex(node=>hasBelongs(node)||(ts.isTryStatement(node)&&node.tryBlock.statements.some(hasBelongs)));
  assert.ok(boundaryIndex>=0,'Known invoice form mount boundary');
  body=statements.slice(0,index).map(node=>node.getText(parsed)).join('\n')+'\nif('+attempt.expression.getText(parsed)+'){'+mounted.slice(0,boundaryIndex).map(node=>node.getText(parsed)).join('\n')+'\n'+boundary+'}';
 }else{
  const marker=name==='sales-invoice-entry'?'safeOptionText':name==='supplier-invoice-entry'?'belongs':'urls';
  const index=statements.findIndex(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(parsed)===marker));assert.ok(index>=0,'Known authorization boundary '+name);
  body=statements.slice(0,index).map(node=>node.getText(parsed)).join('\n')+'\n'+boundary;
 }
 return strip(source.slice(0,guard.getStart(parsed)))+'\nif(!validRoute)'+guard.thenStatement.getText(parsed)+'else{'+body+'\n}';
}
class Node{
 constructor(id=''){this.id=id;this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.dataset={};this.children=[];this.listeners=[];this.style={};this.innerHTML='';}
 append(...nodes){this.children.push(...nodes);}addEventListener(type,callback){this.listeners.push({type,callback});}
 dispatchEvent(){}focus(){}setAttribute(name,value){this[name]=value;}removeAttribute(name){delete this[name];}
}
async function execute(name,search='',{session={},deny=false,full=false,sourceFailure=false}={}){
 const nodes=new Map(),controls=[],reads=[],removes=[],events=[],calls=[],imports=[],timers=[],navigation=[],handlers=[];
 const node=id=>{if(!nodes.has(id)){const element=new Node(id);nodes.set(id,element);controls.push(element);}return nodes.get(id);};
 for(const id of['error','save','add','successModal','lines','customer','supplier','term','date','currency','memo','invoiceNumber','paymentTerm','invoiceDate','period','rate','receiptReference','cancel'])node(id);
 node('successModal').hidden=true;node('location').options=[{value:'1'}];
 const heading=new Node('heading'),reference=new Node('reference'),back=new Node('back');
 const body=new Node('body');body.append=element=>{nodes.set(element.id,element);};
 const document={body,dispatchEvent(event){events.push('dispatch:'+event.type);},getElementById:id=>id==='receiptDocumentId'?(nodes.get(id)??null):node(id),createElement:()=>new Node(),
  querySelector(selector){if(selector==='h1')return heading;if(selector==='.receipt-reference')return reference;if(selector==='main>header a'||selector==='header a')return back;throw Error('Unexpected bootstrap DOM selector '+selector);},
  querySelectorAll(selector){assert.ok(['input,select,textarea,button','main input,main select,main textarea,main button'].includes(selector));return controls;}};
 const values=new Map(Object.entries(session));
 const storage=area=>({getItem(key){reads.push({area,key});events.push('read:'+key);return values.has(key)?values.get(key):key==='nexo_token'?'synthetic-document-token':key==='nexo_device_token'?'synthetic-document-device':key==='nexo_company'?'1':null;},removeItem(key){removes.push(key);events.push('remove:'+key);values.delete(key);}});
 class FixtureDate extends Date{static now(){return now;}}
 const sandbox={document,location:{search,assign:path=>navigation.push(path)},URL,URLSearchParams,Date:FixtureDate,Map,Set,Number,
  localStorage:storage('local'),sessionStorage:storage('session'),console:{error(){}},CustomEvent:class{constructor(type){this.type=type;}},Event:class{constructor(type){this.type=type;}},
  addEventListener(type,callback){handlers.push({type,callback});},setTimeout(callback,delay){timers.push({callback,delay});},
  async loadModule(path){imports.push(path);assert.fail('A bootstrap boundary or invalid route imported a live module');},
  async fetch(path,init={}){
   path=String(path);events.push('fetch:'+path);const call={path,method:init.method??'GET',headers:{...init.headers},body:init.body};calls.push(call);
   assert.equal(call.headers.Authorization,'Bearer synthetic-document-token');assert.equal(call.headers['X-Device-Token'],'synthetic-document-device');
   assert.ok(path.startsWith('/api/'));assert.equal(call.method,'GET','Bootstrap/prefill must never write');
   let payload;
   if(path.includes('/invoice-source'))payload={header:{document_type:'DELIVERY',document_number:'SYN-DELIVERY',document_date:'2026-11-04',customer_id:1,currency_id:1},lines:[]};
   else if(path.includes('/supplier-invoice-receipt-source/'))payload={header:{document_type:'RECEIPT',location_id:1,document_number:'SYN-RECEIPT',document_id:42,document_date:'2026-11-04',supplier_id:1,currency_id:1},lines:[]};
   else if(path.includes('invoice-context')||path.includes('note-context'))payload={access:{canCreate:!deny,canEdit:!deny}};
   else if(path.includes('supplier-invoice-access')||path.includes('supplier-note-access'))payload={canView:!deny,canCreate:!deny,canEdit:!deny};
   else if(path.startsWith('/api/purchasing/supplier-invoice-form-options')){
    const id=new URL(path,'https://synthetic.invalid').searchParams.get('invoiceId');
    payload=buildSupplierInvoiceFormOptions({'/api/organization/subsidiaries':[{subsidiary_id:1}],'/api/purchasing/supplier-invoices':id===null?[]:[{invoice_id:Number(id),subsidiary_id:1}]},{invoiceId:id});
   }
   else if(path.includes('supplier-note-options'))payload={invoices:[]};else payload=[];
   return{ok:!sourceFailure,async json(){return sourceFailure?{error:{message:'Synthetic source denied'}}:payload;}};
  }};
 sandbox.window=sandbox;const context=vm.createContext(sandbox);
 const code=full||helpers.includes(name)?strip(sources.get(name)):bootstrap(name);
 let result,error;try{result=await vm.runInContext('(async()=>{"use strict";\n'+shared+'\n'+safety+'\n'+payable+'\n'+code+'\n})()',context,{timeout:1000,filename:name+'.js'});}catch(cause){error=cause;}
 return{node,controls,reads,removes,events,calls,imports,timers,navigation,handlers,result,error,values,heading};
}
const credentials=f=>f.reads.filter(read=>['nexo_token','nexo_device_token','nexo_company'].includes(read.key));
function closed(f){assert.equal(f.calls.length,0);assert.equal(credentials(f).length,0);assert.equal(f.imports.length,0);assert.equal(f.handlers.length,0);assert.equal(f.navigation.length,0);assert.match(f.node('error').textContent,/identificador.*no es válido/);for(const control of f.controls)assert.equal(control.disabled,true);}

for(const name of mains){
 test(name+' explicit malformed or duplicate id never reads session, credentials, API, prefill or actions',async()=>{
  for(const search of invalidQueries){const f=await execute(name,search,{full:true,session:{nexo_edit_supplier_invoice:'42',nexo_supplier_invoice_receipt_id:'43'}});closed(f);assert.equal(f.error,undefined);assert.equal(f.reads.length,0);assert.equal(f.removes.length,0);}
 });
 test(name+' actual authorization bootstrap preserves create and exact canonical edit query identities',async()=>{
  for(const queryId of[null,'42','%34%32','9007199254740991']){
   const search=queryId===null?'':'?id='+queryId,f=await execute(name,search);assert.equal(f.error,undefined,f.error?.stack);assert.equal(f.result?.boundaryReached,true);
   assert.equal(f.result.id,queryId===null?null:decodeURIComponent(queryId));
   if(name==='sales-invoice-entry')assert.equal(f.calls[0].path,'/api/sales/invoice-context?action='+(queryId===null?'create':'edit&id='+decodeURIComponent(queryId)));
   if(name==='sales-note-entry')assert.equal(f.calls[0].path,'/api/sales/note-context/CREDIT?action='+(queryId===null?'create':'edit&id='+decodeURIComponent(queryId)));
   if(name==='supplier-invoice-entry')assert.deepEqual(f.calls.map(call=>call.path),['/api/purchasing/supplier-invoice-access','/api/purchasing/supplier-invoice-form-options'+(queryId===null?'':'?invoiceId='+decodeURIComponent(queryId)),...(queryId===null?[]:['/api/accounting/journal-supports'])]);
   if(name==='supplier-note-entry')assert.deepEqual(f.calls.map(call=>call.path),['/api/purchasing/supplier-note-access/CREDIT','/api/purchasing/supplier-note-options/CREDIT']);
  }
 });
 test(name+' denied original permission stops its actual bootstrap before later options or imports',async()=>{
  for(const search of['','?id=42']){const f=await execute(name,search,{deny:true});assert.notEqual(f.result?.boundaryReached,true);assert.equal(f.calls.length,1);assert.equal(f.imports.length,0);assert.equal(f.node('save').disabled,true);}
 });
}
test('both notes retain CREDIT/DEBIT context and access keys without inventing permission resources',async()=>{
 for(const name of['sales-note-entry','supplier-note-entry'])for(const kind of['CREDIT','DEBIT']){const f=await execute(name,'?kind='+kind+'&id=42');assert.equal(f.result?.boundaryReached,true);assert.ok(f.calls[0].path.includes('/'+kind));}
});
test('explicit invalid source parameters stop before every session fallback and credential read in mains and standalone helpers',async()=>{
 for(const [main,helper,key]of[['sales-invoice-entry',helpers[0],'deliveryId'],['supplier-invoice-entry',helpers[1],'receiptId']]){
  const queries=[...invalidIds.map(id=>'?'+new URLSearchParams({[key]:id})),'?'+key+'=42&'+key+'=43'];
  for(const name of[main,helper])for(const query of queries){const f=await execute(name,query,{full:true,session:{nexo_edit_supplier_invoice:'42',nexo_supplier_invoice_receipt_id:'43'}});closed(f);assert.equal(f.reads.length,0);assert.equal(f.removes.length,0);if(name===helper)assert.match(f.error?.message??'',/identificador.*no es válido/);}
 }
});
test('standalone prefill helpers reject invalid primary IDs before considering a valid source or session fallback',async()=>{
 for(const [name,key]of[[helpers[0],'deliveryId'],[helpers[1],'receiptId']])for(const query of invalidQueries){
  const f=await execute(name,query+'&'+key+'=42',{session:{nexo_supplier_invoice_receipt_id:'43'}});closed(f);assert.equal(f.reads.length,0);assert.equal(f.removes.length,0);assert.match(f.error?.message??'',/identificador.*no es válido/);
 }
});
test('supplier invoice legacy and timed handoffs are canonical, single-use, selected before credentials and respect sixty seconds',async()=>{
 for(const value of['42',JSON.stringify({id:'9007199254740991',createdAt:now-60000})]){
  const f=await execute('supplier-invoice-entry','',{session:{nexo_edit_supplier_invoice:value}});assert.equal(f.result?.boundaryReached,true);assert.equal(f.values.has('nexo_edit_supplier_invoice'),false);
  assert.ok(f.events.indexOf('remove:nexo_edit_supplier_invoice')<f.events.indexOf('read:nexo_token'));assert.equal(f.reads.some(read=>read.key==='nexo_supplier_invoice_receipt_id'),false);assert.equal(f.result.id,value==='42'?'42':'9007199254740991');
 }
 for(const value of['',...invalidIds.filter(Boolean),JSON.stringify({id:'42',createdAt:now-60001}),JSON.stringify({id:'42',createdAt:now+1}),JSON.stringify({id:'01',createdAt:now}),JSON.stringify({id:'42',createdAt:'invalid'})]){
  const f=await execute('supplier-invoice-entry','',{full:true,session:{nexo_edit_supplier_invoice:value}});closed(f);assert.deepEqual(f.reads,[{area:'session',key:'nexo_edit_supplier_invoice'}]);assert.deepEqual(f.removes,['nexo_edit_supplier_invoice']);
 }
});
test('explicit query and receipt source win without consuming unrelated invalid invoice handoffs',async()=>{
 for(const search of['?id=42','?receiptId=42','?id=42&receiptId=43']){
  const f=await execute('supplier-invoice-entry',search,{session:{nexo_edit_supplier_invoice:'INVALID',nexo_supplier_invoice_receipt_id:'INVALID'}});
  assert.equal(f.result?.boundaryReached,true);assert.equal(f.reads.some(read=>read.key.startsWith('nexo_edit_supplier')||read.key==='nexo_supplier_invoice_receipt_id'),false);
 }
 const conflict=await execute('sales-invoice-entry','?id=42&deliveryId=43',{full:true});closed(conflict);
});
test('invoice view handoff retains its separate key and missing view never falls into create',async()=>{
 const valid=await execute('supplier-invoice-entry','?view=1',{session:{nexo_view_supplier_invoice:JSON.stringify({id:'42',createdAt:now})}});assert.equal(valid.result?.boundaryReached,true);assert.equal(valid.reads[0].key,'nexo_view_supplier_invoice');
 const absent=await execute('supplier-invoice-entry','?view=1',{full:true});closed(absent);
});
test('receipt fallback is validated before main credentials and standalone source API, and is consumed only after success',async()=>{
 for(const value of['42','9007199254740991']){
  const main=await execute('supplier-invoice-entry','',{session:{nexo_supplier_invoice_receipt_id:value}});assert.equal(main.result?.boundaryReached,true);
  assert.ok(main.events.indexOf('read:nexo_supplier_invoice_receipt_id')<main.events.indexOf('read:nexo_token'));
  const helper=await execute(helpers[1],'',{session:{nexo_supplier_invoice_receipt_id:value,nexo_supplier_invoice_receipt:'synthetic receipt'}});assert.equal(helper.error,undefined);assert.equal(helper.calls[0].path,'/api/purchasing/supplier-invoice-receipt-source/'+value);assert.equal(helper.values.has('nexo_supplier_invoice_receipt_id'),false);
  const failed=await execute(helpers[1],'',{sourceFailure:true,session:{nexo_supplier_invoice_receipt_id:value}});assert.equal(failed.values.get('nexo_supplier_invoice_receipt_id'),value);assert.equal(failed.node('save').disabled,true);
 }
 for(const value of['',...invalidIds.filter(Boolean)])for(const name of['supplier-invoice-entry',helpers[1]]){const f=await execute(name,'',{full:true,session:{nexo_supplier_invoice_receipt_id:value}});closed(f);assert.equal(f.reads.at(-1).key,'nexo_supplier_invoice_receipt_id');}
});
test('valid standalone source prefills retain exact canonical endpoints, headers, ID precedence and harmless empty source lines',async()=>{
 for(const [name,key,path]of[[helpers[0],'deliveryId','/api/sales/workflow/'],[helpers[1],'receiptId','/api/purchasing/supplier-invoice-receipt-source/']])for(const id of['42','%34%32','9007199254740991']){
  const f=await execute(name,'?'+key+'='+id);assert.equal(f.error,undefined,f.error?.stack);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,path+decodeURIComponent(id)+(key==='deliveryId'?'/invoice-source':''));assert.match(f.heading.textContent,/Nueva factura desde SYN-/);
 }
 const unused=await execute(helpers[1],'?id=42&receiptId=43',{session:{nexo_supplier_invoice_receipt_id:'INVALID'}});assert.equal(unused.calls.length,0);assert.equal(unused.reads.length,0);
 const absent=await execute(helpers[0]);assert.equal(absent.calls.length,0);assert.equal(absent.reads.length,0);
});
function saveAction(name){
 const parsed=ts.createSourceFile(name+'.js',sources.get(name),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),found=[];
 function visit(node){if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.name.text==='onclick'){
  const target=node.left.expression;if(ts.isCallExpression(target)&&target.expression.getText(parsed)==='$'&&target.arguments[0]?.getText(parsed)==="'save'")found.push(node.right.getText(parsed));
 }ts.forEachChild(node,visit);}visit(parsed);assert.equal(found.length,1);return found[0];
}
for(const name of mains){
 test(name+' real save handler preserves create POST and canonical edit PUT routes with synthetic transaction responses',async()=>{
  for(const id of[null,'42','9007199254740991'])for(const kind of name.includes('note')?['CREDIT','DEBIT']:['CREDIT']){
   const nodes=new Map(),calls=[],success=[];const $=key=>{if(!nodes.has(key)){const node=new Node(key);node.value='1';nodes.set(key,node);}return nodes.get(key);};
   $('unifiedPdfDescription').value='Synthetic description';$('memo').value='Synthetic memo';
   const values={service_country_id:'1',quantity:'1',unit_price:'10',amount:'10',tax_rate:'0',tax_amount:'0',gross_amount:'10',account_id:'1',product_id:'1'};
   const row={querySelectorAll(selector){assert.equal(selector,'[data-k]');return Object.entries(values).map(([key,value])=>({dataset:{k:key},value}));}};
   const context=vm.createContext({$,document:{querySelectorAll(selector){assert.equal(selector,'#lines tr');return[row];}},
    editId:id,recordId:id,invoiceId:id,deliveryId:null,kind,supportItems:[],parse:Number,parseAmount:Number,money:String,pdfPreferenceSave:Promise.resolve(),defaultUnifiedPdfDescription:'Synthetic',
    viewMode:false,invoiceFormReady:true,invoiceContextInvalid:false,checkInvoiceContext:()=>true,invoiceSaving:false,invoiceUploading:0,savedInvoiceResult:null,noteSaving:false,noteUploading:0,savedNoteResult:null,invoiceSourceReady:()=>true,syncInvoiceControls(){},syncNoteControls(){},pendingSupports:()=>false,originalInvoicePayload:'{}',journalId:8,collectInvoicePayload:()=>({synthetic:'changed'}),hasPendingSupportChanges:()=>false,validateInvoicePayload(){},invoiceAmounts:()=>({gross:10}),
    syncUnifiedPdfDescription(){},setSupportStatus(){},async syncSupports(){},showSuccess:value=>success.push(value),showSupplierSuccess:value=>success.push(value),
    async api(path,init){calls.push({path,method:init.method,body:JSON.parse(init.body)});return{journalId:8,transactionNumber:'SYNTHETIC',total:10};}});
   const action=vm.runInContext('('+saveAction(name)+')',context,{timeout:1000});await action();assert.equal(calls.length,1,$('error').textContent);
   const prefix=name==='sales-invoice-entry'?'/api/sales/invoice-entry':name==='supplier-invoice-entry'?'/api/purchasing/supplier-invoice-entry':name==='sales-note-entry'?'/api/sales/note-entry/'+kind:'/api/purchasing/supplier-note-entry/'+kind;
   assert.equal(calls[0].path,prefix+(id===null?'':'/'+id));assert.equal(calls[0].method,id===null?'POST':'PUT');
  }
 });
}
test('real invoice delivery save uses only its checked canonical source route',async()=>{
 const nodes=new Map(),calls=[],$=key=>{if(!nodes.has(key)){const node=new Node(key);node.value='Synthetic';nodes.set(key,node);}return nodes.get(key);};
 const context=vm.createContext({$,document:{querySelectorAll:()=>[]},editId:null,deliveryId:'9007199254740991',supportItems:[],parse:Number,defaultUnifiedPdfDescription:'Synthetic',syncUnifiedPdfDescription(){},showSuccess(){},
  async api(path,init){calls.push({path,method:init.method});return{};}});
 await vm.runInContext('('+saveAction('sales-invoice-entry')+')',context,{timeout:1000})();assert.deepEqual(calls,[{path:'/api/sales/workflow/9007199254740991/invoice',method:'POST'}]);
});
test('four own HTML and helper imports refresh while the real P94 validator and bank P120 caches stay intact',async()=>{
 for(const [name,page]of pages){assert.ok(page.includes('/'+name+'.js?v='+(name==='supplier-invoice-entry'?invoiceEntryVersion:name==='supplier-note-entry'?purchasingVersion:version)));assert.ok(sources.get(name).includes("from './route-id.js?v=20261103-route-id-guard'"));}
 for(const [name,helper]of[[mains[0],helpers[0]],[mains[2],helpers[1]]])assert.ok(sources.get(name).includes("import('/"+helper+".js?v="+(name==='supplier-invoice-entry'?purchasingVersion:version)+"')"));
 for(const name of['bank-check-entry','bank-deposit-entry']){const page=await readFile(new URL('../public/'+name+'.html',import.meta.url),'utf8');assert.ok(page.includes('/'+name+'.js?v='+bankVersion));}
 for(const source of sources.values())assert.doesNotMatch(source,/\/api\/(?:sales|purchasing)\/[^`]*\$\{(?:editId|recordId|deliveryId|invoiceId)\}/);
});
