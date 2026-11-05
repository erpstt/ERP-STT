import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const version='20261105-banking-functional',sharedVersion='20261103-route-id-guard';
const validator=(await readFile(new URL('../public/route-id.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const safety=(await readFile(new URL('../public/html-safety.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const bankUi=(await readFile(new URL('../public/bank-ui.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const names=['bank-check-entry','bank-check-entry-main','bank-deposit-entry','bank-deposit-edit','bank-deposit-layout'];
const sources=new Map(await Promise.all(names.map(async name=>[name,await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8')])));
const html=new Map(await Promise.all(['bank-check-entry','bank-deposit-entry'].map(async name=>[name,await readFile(new URL('../public/'+name+'.html',import.meta.url),'utf8')])));
const invalid=['?id=','?id=1&id=2','?id=42&id=42',...['0','01','-1','+1','1.0','1e3','0x10','../2','1/2','1\\2','1?other=2','1#fragment',' 1','1 ','1\n','١','１２','9007199254740992','9223372036854775807','9'.repeat(10000)].map(id=>'?'+new URLSearchParams({id})),'?id=%2e%2e%2f2','?id=%00'];
const voidTags=new Set(['input','meta','link','br','hr','img','source','wbr']);
class Element{
 constructor(document,tag,attributes={}){this.document=document;this.tagName=tag.toUpperCase();this.attrs=attributes;this.children=[];this.parentElement=null;this.dataset={};this.listeners=[];this.style={};this.textContent='';this.markup='';this.hidden=Object.hasOwn(attributes,'hidden');this.disabled=Object.hasOwn(attributes,'disabled');this.className=attributes.class??'';
  for(const[key,value]of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=value;
  this._value=attributes.value;this.id=attributes.id??'';this.classList={toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/));on?set.add(name):set.delete(name);this.className=[...set].join(' ');}};
 }
 set id(value){this._id=value;if(value)this.document.ids.set(value,this);}get id(){return this._id;}
 set value(value){this._value=String(value??'');}get value(){return this._value??(this.tagName==='SELECT'?this.options[0]?.value??'':this.tagName==='OPTION'?this.textContent:'');}
 set innerHTML(value){this.markup=String(value);this.children=[];this.document.parse(this.markup,this);if(this.tagName==='SELECT')this._value=undefined;}get innerHTML(){return this.markup;}
 get options(){return this.querySelectorAll('option');}get rows(){return this.children.filter(node=>node.tagName==='TR');}get lastElementChild(){return this.children.at(-1);}get firstChild(){return this.childNodes?.[0]??{textContent:''};}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}appendChild(node){this.append(node);return node;}
 insertBefore(node,target){node.remove();node.parentElement=this;this.children.splice(Math.max(0,this.children.indexOf(target)),0,node);}
 after(node){const parent=this.parentElement;if(parent)parent.insertBefore(node,parent.children[parent.children.indexOf(this)+1]);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
 removeAttribute(name){delete this.attrs[name];delete this[name];}setAttribute(name,value){this.attrs[name]=String(value);this[name]=String(value);}
 matches(selector){
  const attr=/^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/.exec(selector);
  if(attr)return Object.hasOwn(this.attrs,attr[1])&&(attr[2]===undefined||this.attrs[attr[1]]===attr[2]);
  if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));return this.tagName===selector.toUpperCase();
 }
 querySelectorAll(selector){if(selector.includes(','))return selector.split(',').flatMap(part=>this.querySelectorAll(part.trim()));const parts=selector.split(/\s+/),out=[];const visit=node=>{for(const child of node.children){if(child.matches(parts.at(-1))){let parent=child.parentElement,index=parts.length-2;while(index>=0&&parent){if(parent.matches(parts[index]))index--;parent=parent.parentElement;}if(index<0)out.push(child);}visit(child);}};visit(this);return out;}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
 addEventListener(type,callback,capture){this.listeners.push({type,callback,capture});}
 dispatchEvent(event){for(const listener of this.listeners.filter(item=>item.type===event.type&&item.capture))listener.callback(event);const result=this['on'+event.type]?.(event);for(const listener of this.listeners.filter(item=>item.type===event.type&&!item.capture))listener.callback(event);return result;}
 click(){if(!this.disabled)return this.dispatchEvent({type:'click',preventDefault(){},stopImmediatePropagation(){}});}
}
class Document{
 constructor(source){this.ids=new Map();this.listeners=[];this.root=new Element(this,'root');this.parse(source,this.root);}
 addEventListener(type,callback,capture){this.listeners.push({type,callback,capture});}
 parse(source,root){const stack=[root];for(const token of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi)){
  if(!token[1]){if(token[3]){const parent=stack.at(-1);parent.textContent+=token[3];(parent.childNodes??=[]).push({nodeType:3,textContent:token[3]});}continue;}
  const tag=token[1].toLowerCase();if(token[0].startsWith('</')){for(let i=stack.length-1;i>0;i--)if(stack[i].tagName===tag.toUpperCase()){stack.length=i;break;}continue;}
  const attrs={};for(const attr of token[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[attr[1]]=attr[2]??attr[3]??attr[4]??'';
  const node=new Element(this,tag,attrs);stack.at(-1).append(node);(stack.at(-1).childNodes??=[]).push(node);if(!voidTags.has(tag))stack.push(node);
 }}
 getElementById(id){return this.ids.get(id)??null;}createElement(tag){return new Element(this,tag);}
 querySelectorAll(selector){if(selector.includes(','))return selector.split(',').flatMap(part=>this.root.querySelectorAll(part.trim()));return this.root.querySelectorAll(selector);}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
}
const periods=[{fiscal_period_id:1,period_name:'Synthetic open',start_date:'2000-01-01',end_date:'2100-12-31',subsidiary_id:1,is_closed:false,is_inactive:false,gl_closed:false}];
const account={id:5,bankId:1,bankName:'Synthetic bank',number:'SYN-5',currencyId:1,currencyCode:'CRC',ledgerAccountId:7,balance:100};
const common={
 '/api/accounting/chart-accounts':[{account_id:7,account_number:'101',account_name:'Synthetic',accepts_entries:true,subsidiary_id:1}],
 '/api/core/currencies':[{currency_id:1,currency_code:'CRC',name:'Colón'}],
 '/api/configuration/payment-methods':[{payment_method_id:1,method_name:'Synthetic transfer'}],
 '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Synthetic company',currency_id:1}],
 '/api/organization/locations':[{location_id:1,name:'Synthetic location',subsidiary_id:1}],
 '/api/banking/banks':[{bank_id:1,bank_name:'Synthetic bank'}],
 '/api/banking/bank-accounts':[{bank_account_id:5,bank_id:1,account_number:'SYN-5',currency_id:1,account_id:7,balance:100,subsidiary_id:1}],
 '/api/organization/accounting-periods':periods,'/api/banking/checks/periods':periods
};
const fixed=new Set([...Object.keys(common),'/api/banking/checks/options','/api/banking/deposits/options','/api/configuration/exchange-rates','/api/organization/departments','/api/organization/cost-centers','/api/organization/classes','/api/organization/financial-creditors','/api/organization/related-companies','/api/entities/customers','/api/entities/suppliers','/api/entities/employees','/api/core/countries']);
async function execute(name,search='',{denyDetail=false,denyWrite=false}={}){
 const page=name.startsWith('bank-check')?'bank-check-entry':'bank-deposit-entry';
 const document=new Document(html.get(page)),calls=[],reads=[],imports=[],navigation=[],observers=[],fileReads=[];
 const id=new URLSearchParams(search).get('id');let context;
 const storage={getItem(key){reads.push(key);return key==='nexo_token'?'synthetic-bank-token':key==='nexo_device_token'?'synthetic-bank-device':key==='nexo_company'?'1':null;}};
 const location={search,replace:path=>navigation.push(path),assign:path=>navigation.push(path),reload:()=>navigation.push('reload')};
 const evaluate=async module=>{
  let code=sources.get(module);assert.ok(code,'Only known local modules may execute');
  const deps=[...code.matchAll(/^import[^\r\n]*from\s*'([^']+)';/gm)].map(match=>match[1]);assert.ok(deps.every(path=>new Set(['./html-safety.js?v=20261101-a03-1','./route-id.js?v='+sharedVersion,'./bank-ui.js?v='+version]).has(path)));
  code=code.replace(/^import[^\r\n]*\r?\n/gm,'').replace(/export async function loadDepositEdit/,'async function loadDepositEdit').replace(/await import\(/g,'await loadModule(');
  const tail=module==='bank-deposit-edit'?'\nreturn {loadDepositEdit};':'';
  return vm.runInContext('(async()=>{"use strict";\n'+validator+'\n'+safety+'\n'+bankUi+'\n'+code+tail+'\n})()',context,{timeout:1500,filename:module+'.js'});
 };
 const sandbox={document,location,URL,URLSearchParams,Response,Intl,Date,Map,Set,Math,AbortController,addEventListener(){},Node:{TEXT_NODE:3},crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},
  localStorage:storage,sessionStorage:storage,console:{warn(){}},queueMicrotask,
  Event:class{constructor(type){this.type=type;}preventDefault(){}stopImmediatePropagation(){}},
  MutationObserver:class{constructor(callback){this.callback=callback;}observe(target){observers.push(target);}},
  FileReader:class{readAsDataURL(file){fileReads.push(file);this.result='data:'+(file.type||'application/octet-stream')+';base64,QQ==';this.onload();}},
  async loadModule(path){const mapping={['./bank-check-entry-main.js?v='+version]:'bank-check-entry-main',['./bank-deposit-edit.js?v='+version]:'bank-deposit-edit',['./bank-deposit-layout.js?v='+version]:'bank-deposit-layout'};assert.ok(mapping[path],'Unknown dynamic module');imports.push(path);return evaluate(mapping[path]);},
  async fetch(path,init={}){
   path=String(path);const method=init.method??'GET';assert.ok(fixed.has(path)||path==='/api/banking/checks/'+id||path==='/api/banking/deposits/'+id||['/api/banking/checks','/api/banking/deposit-entry','/api/accounting/journal-supports'].includes(path),'Unexpected synthetic API '+path);
   const call={path,method,headers:{...init.headers},body:init.body?JSON.parse(init.body):null};calls.push(call);assert.equal(call.headers.Authorization,'Bearer synthetic-bank-token');assert.equal(call.headers['X-Device-Token'],'synthetic-bank-device');
   if(denyDetail&&method==='GET'&&[('/api/banking/checks/'+id),('/api/banking/deposits/'+id)].includes(path))return Response.json({error:{message:'Synthetic access denied'}},{status:403});
   if(method!=='GET')return Response.json(denyWrite?{error:{message:'Synthetic write denied'}}:{journalId:8,transactionNumber:'SYN-BANK',total:25},{status:denyWrite?403:200});
   if(path==='/api/banking/checks/options'||path==='/api/banking/deposits/options')return Response.json({subsidiary:{id:1,name:'Synthetic company',currencyId:1},location:{id:1,name:'Synthetic location'},accounts:[account],periods,access:{canView:true,canCreate:true,canEdit:true,canDelete:true}});
   if(path==='/api/banking/checks/'+id)return Response.json({header:{check_number:'SYN-CHECK',payment_type:'CHEQUE',payment_date:'2026-11-04',fiscal_period_id:1,bank_account_id:5,bank_reference:'SYN-REF'},lines:[]});
   if(path==='/api/banking/deposits/'+id)return Response.json({deposit:{deposit_number:'SYN-DEPOSIT',deposit_date:'2026-11-04',fiscal_period_id:1,bank_account_id:5,bank_reference:'SYN-REF'},lines:[]});
   return Response.json(common[path]??[]);
  }};
 sandbox.window=sandbox;context=vm.createContext(sandbox);
 let result,error;try{result=await evaluate(name);}catch(cause){error=cause;}
 return{document,calls,reads,imports,navigation,observers,fileReads,result,error,async loadEdit(){return result.loadDepositEdit();},context};
}
function complete(f,isCheck){
 const $=id=>f.document.getElementById(id);if(!$('lines').rows.length)$('addLine').click();
 $('bank').value='1';$('bank').dispatchEvent({type:'change'});$('bankAccount').value='5';$('bankAccount').dispatchEvent({type:'change'});
 if(isCheck){$('type').value='CHEQUE';$('type').dispatchEvent({type:'change'});$('reference').value='SYN-REF';}
 const row=$('lines').rows[0],key=isCheck?'data-k':'data-key';row.querySelector('['+key+'=account_id]').value='7';row.querySelector('['+key+'=amount]').value='25';
 if(!isCheck)row.querySelector('[data-key=payment_method_id]').value='1';
 return $('save').click();
}
for(const name of names.filter(name=>name!=='bank-deposit-layout')){
 test(name+' present invalid optional IDs stop credentials, API, dynamic imports, observers and actions',async()=>{
  for(const search of invalid){const f=await execute(name,search);assert.equal(f.error,undefined);if(name==='bank-deposit-edit')assert.equal(await f.loadEdit(),false);
   assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);assert.equal(f.imports.length,0);assert.equal(f.observers.length,0);assert.equal(f.navigation.length,0);
   assert.match(f.document.getElementById('error').textContent,/identificador.*no es válido/);
   for(const control of f.document.querySelectorAll('input,select,textarea,button')){assert.equal(control.disabled,true);assert.equal(control.listeners.length,0);for(const property of['onclick','onchange','oninput'])assert.notEqual(typeof control[property],'function');}
  }
 });
}
for(const name of['bank-check-entry','bank-check-entry-main','bank-deposit-entry']){
 test(name+' absent ID preserves create initialization, public credential headers and P118 support feedback',async()=>{
  const f=await execute(name);assert.equal(f.error,undefined,f.error?.stack);assert.ok(f.calls.length>0);assert.ok(f.calls.every(call=>call.method==='GET'));
  assert.equal(typeof f.document.getElementById('save').onclick,'function');assert.equal(f.document.getElementById('lines').rows.length,1);
  assert.equal(f.calls.some(call=>/\/api\/banking\/(checks|deposits)\/null$/.test(call.path)),false);
  const $=id=>f.document.getElementById(id);$('supportLinkUrl').value='http://synthetic.invalid/';$('addSupportLink').click();assert.match($('error').textContent,/https:\/\//);
  const before=f.calls.length;for(const file of[{name:'empty.bin',size:0,type:''},{name:'oversized.bin',size:5242881,type:''}]){await $('supportFiles').onchange({target:{files:[file],value:''}});assert.equal(f.fileReads.length,0);assert.match($('error').textContent,/5 MB/);assert.equal(f.calls.length,before);}
 });
}
test('standalone deposit edit with absent ID remains a no-op without credential or API access',async()=>{
 const f=await execute('bank-deposit-edit');assert.equal(await f.loadEdit(),false);assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);assert.equal(f.imports.length,0);
});
for(const name of['bank-check-entry','bank-deposit-entry']){
 test(name+' valid IDs retain exact edit identity, initialized options and PUT route while create stays POST',async()=>{
  for(const queryId of['42','%34%32','9007199254740991']){
   const id=decodeURIComponent(queryId),f=await execute(name,'?id='+queryId);assert.equal(f.error,undefined,f.error?.stack);
   assert.ok(f.calls.some(call=>call.path==='/api/banking/'+(name.startsWith('bank-check')?'checks/':'deposits/')+id));
   await complete(f,name.startsWith('bank-check'));const write=f.calls.find(call=>call.method==='PUT');assert.ok(write);assert.equal(write.path,'/api/banking/'+(name.startsWith('bank-check')?'checks/':'deposits/')+id);
  }
  const created=await execute(name);await complete(created,name.startsWith('bank-check'));assert.equal(created.calls.find(call=>call.method==='POST').path,name.startsWith('bank-check')?'/api/banking/checks':'/api/banking/deposit-entry');
 });
}
test('standalone edit validates before IO and preserves authorized detail loading for canonical ID',async()=>{
 const f=await execute('bank-deposit-edit','?id=42');
 // A legitimate standalone caller supplies the field normally named by the
 // layout module. Invalid standalone IDs above require no such preparation.
 f.document.querySelectorAll('.deposit-header input').find(input=>input.value==='Se asignará al guardar').id='bankReference';
 assert.equal(await f.loadEdit(),true);assert.deepEqual(f.calls.map(call=>call.path),['/api/banking/deposits/42','/api/accounting/chart-accounts']);
 const denied=await execute('bank-deposit-entry','?id=42',{denyDetail:true});assert.equal(denied.document.getElementById('save').disabled,true);assert.match(denied.document.getElementById('error').textContent,/Synthetic access denied/);assert.ok(denied.calls.every(call=>call.method==='GET'));
});
test('valid create and edit keep provider write denial and never display a successful transaction',async()=>{
 for(const name of['bank-check-entry','bank-deposit-entry'])for(const search of['','?id=42']){
  const f=await execute(name,search,{denyWrite:true});assert.equal(f.error,undefined);await complete(f,name.startsWith('bank-check'));assert.match(f.document.getElementById('error').textContent,/Synthetic write denied/);assert.equal(f.document.getElementById('successModal').hidden,true);
 }
});
test('fresh own HTML/main/edit versions preserve shared P94 and P118 feedback source',()=>{
 for(const [name,page]of html){assert.ok(page.includes('/'+name+'.js?v='+version));assert.ok(sources.get(name).includes("from './route-id.js?v="+sharedVersion+"'"));}
 assert.ok(sources.get('bank-check-entry').includes("import('./bank-check-entry-main.js?v="+version+"')"));
 assert.ok(sources.get('bank-deposit-entry').includes("import('./bank-deposit-edit.js?v="+version+"')"));
 for(const name of['bank-check-entry-main','bank-deposit-entry']){assert.ok(sources.get(name).includes("mime_type:file.type||'application/octet-stream'"));assert.ok(sources.get(name).includes('!file.size||file.size>5242880'));assert.ok(sources.get(name).includes("url.protocol!=='https:'"));}
});
