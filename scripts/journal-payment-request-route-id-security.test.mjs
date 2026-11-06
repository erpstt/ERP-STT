import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
const versions={'journal-entry':'20261104-journal-payment-route-id-guard','payment-requests':'20261105-payment-request-search'};
const validator=(await readFile(new URL('../public/route-id.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const safety=(await readFile(new URL('../public/html-safety.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const searchSpecifier='./payment-request-search.js?v=20261105-payment-request-search';
const searchSource=(await readFile(new URL('../public/payment-request-search.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const searchModule=new vm.Script('(function(){\n'+searchSource+'\nreturn{enhancePaymentRequestSelect};\n})()',{filename:'payment-request-search.js'});
const screens=await Promise.all(['journal-entry','payment-requests'].map(async name=>({name,source:await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8'),html:await readFile(new URL('../public/'+name+'.html',import.meta.url),'utf8')})));
const voidTags=new Set(['input','meta','link','br','hr','img','source','wbr']);
class Element{
 constructor(document,tag,attributes={}){this.document=document;this.tagName=tag.toUpperCase();this.attrs=attributes;this.children=[];this.parentElement=null;this.dataset={};this.listeners=[];this.style={};this.textContent='';this.markup='';this.hidden=Object.hasOwn(attributes,'hidden');this.disabled=Object.hasOwn(attributes,'disabled');this.className=attributes.class??'';
  for(const[key,value]of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=value;
  this._value=attributes.value;this.id=attributes.id??'';this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/),...names])].join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/));on?set.add(name):set.delete(name);this.className=[...set].join(' ');}};
 }
 set id(value){this._id=value;if(value)this.document.ids.set(value,this);}get id(){return this._id;}
 set value(value){this._value=String(value??'');}get value(){return this._value??(this.tagName==='SELECT'?this.options[0]?.value??'':this.tagName==='OPTION'?this.textContent:'');}
 set innerHTML(value){this.markup=String(value);this.children=[];this.document.parse(this.markup,this);if(this.tagName==='SELECT')this._value=undefined;}get innerHTML(){return this.markup;}
 get options(){return this.querySelectorAll('option');}get rows(){return this.children.filter(node=>node.tagName==='TR');}get lastElementChild(){return this.children.at(-1);}get firstChild(){return this.childNodes?.[0]??{textContent:''};}
 prepend(node){node.parentElement=this;this.children.unshift(node);}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 scrollIntoView(){}focus(){}setCustomValidity(){}showModal(){this.open=true;}close(){this.open=false;}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}appendChild(node){this.append(node);return node;}
 insertBefore(node,target){node.remove();node.parentElement=this;this.children.splice(Math.max(0,this.children.indexOf(target)),0,node);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
 removeAttribute(name){delete this.attrs[name];delete this[name];}setAttribute(name,value){this.attrs[name]=String(value);this[name]=String(value);}
 matches(selector){
  const attr=/^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/.exec(selector);
  if(attr)return Object.hasOwn(this.attrs,attr[1])&&(attr[2]===undefined||this.attrs[attr[1]]===attr[2]);
  if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.className.split(/\s+/).includes(selector.slice(1));return this.tagName===selector.toUpperCase();
 }
 querySelectorAll(selector){const parts=selector.split(/\s+/),out=[];const visit=node=>{for(const child of node.children){if(child.matches(parts.at(-1))){let parent=child.parentElement,index=parts.length-2;while(index>=0&&parent){if(parent.matches(parts[index]))index--;parent=parent.parentElement;}if(index<0)out.push(child);}visit(child);}};visit(this);return out;}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
 addEventListener(type,callback,capture){this.listeners.push({type,callback,capture});}
 dispatchEvent(event){event.target??=this;event.currentTarget=this;for(const listener of this.listeners.filter(item=>item.type===event.type&&item.capture))listener.callback(event);const result=this['on'+event.type]?.(event);for(const listener of this.listeners.filter(item=>item.type===event.type&&!item.capture))listener.callback(event);return result;}
 click(){if(!this.disabled)return this.dispatchEvent({type:'click',preventDefault(){},stopImmediatePropagation(){}});}
}
class Document{
 constructor(source){this.ids=new Map();this.root=new Element(this,'root');this.parse(source,this.root);this.body=this.querySelector('body');this.head=this.querySelector('head');}
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
const invalid=['?id=','?id=42&id=42','?id=1&id=2',...['0','01','-1','+1','1.0','1e3','0x10','../2','1/2','1\\2','1?x=2','1#fragment',' 1','1 ','1\n','١','１２','9007199254740992','9223372036854775807','9'.repeat(10000)].map(id=>'?'+new URLSearchParams({id})),'?id=%00'];
const period={fiscal_period_id:1,period_name:'Synthetic open',subsidiary_id:1,start_date:'2000-01-01',end_date:'2100-12-31',is_closed:false};
const header={transactionTypes:[{name:'Asiento diario',abbreviation:'ASI_DIA'}],subsidiaries:[{subsidiary_id:1,name:'Synthetic company',currency_id:1}],locations:[{location_id:1,name:'Synthetic location',subsidiary_id:1}],currencies:[{currency_id:1,currency_code:'CRC',name:'Colón'}],periods:[period],rates:[]};
const journalLines={accounts:[{account_id:7,account_number:'101',account_name:'Synthetic',subsidiary_id:1,accepts_entries:true}],taxes:[],taxTypes:[],departments:[],classes:[],costs:[],creditors:[],related:[],customers:[],suppliers:[],employees:[],countries:[]};
const options={company:'Synthetic company',currencies:[{id:1,name:'CRC'}],users:[{id:1,name:'Synthetic'}],suppliers:[],customers:[],employees:[],otherNames:[],taxAgencies:[],departments:[],costCenters:[],classes:[],accounts:[],banks:[],rates:[],beneficiaryBankAccounts:[],baseCurrencyId:1,userId:1};
async function execute(screen,search='',{handoff=null,activeCompany='1',deny=false,noView=false}={}){
 const document=new Document(screen.html),calls=[],reads=[],writes=[],removes=[],timers=[],navigation=[],observers=[],actors=[],moduleImports=[];
 const values=new Map(handoff===null?[]:[['nexo_edit_journal',handoff]]),params=new URLSearchParams(search),id=params.get('id')??handoff;
 const storage=area=>({getItem(key){reads.push({area,key});return values.has(key)?values.get(key):key==='nexo_token'?'synthetic-p135-token':key==='nexo_device_token'?'synthetic-p135-device':key==='nexo_company'?activeCompany:null;},setItem(key,value){writes.push({area,key,value});values.set(key,String(value));},removeItem(key){removes.push({area,key});values.delete(key);}});
 class Option extends Element{constructor(text,value){super(document,'option',{value:String(value)});this.textContent=text;}}
 let uuidCounter=0;
 const sandbox={document,URL,URLSearchParams,Date,Intl,Map,Set,Math,AbortController,Option,crypto:{randomUUID:()=> '11111111-1111-4111-8111-'+String(++uuidCounter).padStart(12,'0')},
  location:{search,assign:path=>navigation.push(path),replace:path=>navigation.push(path)},localStorage:storage('local'),sessionStorage:storage('session'),
  Event:class{constructor(type){this.type=type;}preventDefault(){}stopImmediatePropagation(){}},MutationObserver:class{constructor(callback){}observe(target){observers.push(target);}},
  NexoRecordAudit:{show:(...args)=>actors.push(args)},scrollTo(){},setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},clearTimeout(){},
  async fetch(path,init={}){
   path=String(path);const method=init.method??'GET',body=init.body?JSON.parse(init.body):null,call={path,method,body,headers:{...init.headers}};calls.push(call);
   assert.equal(call.headers.Authorization,'Bearer synthetic-p135-token');assert.equal(call.headers['X-Device-Token'],'synthetic-p135-device');
   let payload;
   if(screen.name==='journal-entry'){
    assert.ok(path.startsWith('/api/accounting/'),'Only synthetic accounting endpoints are permitted');
    if(path.includes('/journal-entry/options?'))payload=path.includes('section=header')?header:journalLines;
    else if(path.endsWith('/supports'))payload=[];
    else if(path==='/api/accounting/journals')payload=[{journal_id:8,journal_number:'SYN-JOURNAL'}];
    else if(method==='POST'||method==='PUT')payload={journalId:8};
    else{assert.equal(path,'/api/accounting/journal-entry/'+id);payload={journal:{journal_id:id,journal_number:'SYN-JOURNAL',journal_type:'Asiento diario',journal_date:'2026-11-04',fiscal_period_id:1,currency_id:1,exchange_rate:1},lines:[]};}
    return{ok:!deny,async json(){return deny?{error:{message:'Synthetic journal access denied'}}:payload;}};
   }
   assert.ok(path.startsWith('/api/treasury/payment-requests/'),'Only synthetic treasury endpoints are permitted');
   const action=path.split('/').at(-1);
   if(action==='access')payload={canView:!deny&&!noView,canCreate:!deny,canEdit:!deny};
   else if(action==='options')payload=options;else if(action==='report'||action==='supports')payload=[];
   else if(action==='detail')payload={header:{id:body.id,numero:'SYN-REQUEST',estado:'BORRADOR',tipo_solicitud:'OTROS',id_moneda:1,id_solicitante:1,fecha_solicitud:'2026-11-04',fecha_pago_programada:'2026-11-04',concepto:'Synthetic',total:0},lines:[],events:[],actions:{canEdit:false}};
   else assert.fail('Unexpected payment action '+action);
   return{ok:true,async json(){return payload;}};
  }};
 sandbox.window=sandbox;
 const imports=[...screen.source.matchAll(/^import[^\r\n]*from\s*'([^']+)';/gm)].map(match=>match[1]);assert.ok(imports.every(path=>/^\.\/(html-safety|route-id)\.js\?v=/.test(path)));
 const dynamicImports=[...screen.source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map(match=>match[1]);
 assert.deepEqual(dynamicImports,screen.name==='payment-requests'?[searchSpecifier]:[],'Only the reviewed pure search helper may load dynamically');
 const code=screen.source.replace(/^import[^\r\n]*\r?\n/gm,'').replaceAll("import('"+searchSpecifier+"')","importPaymentSearch('"+searchSpecifier+"')"),context=vm.createContext(sandbox);let error,searchNamespace;
 sandbox.importPaymentSearch=async specifier=>{assert.equal(specifier,searchSpecifier);moduleImports.push(specifier);return searchNamespace??=searchModule.runInContext(context,{timeout:1000});};
 try{await vm.runInContext('(async()=>{"use strict";\n'+validator+'\n'+safety+'\n'+code+'\n})()',context,{timeout:1500,filename:screen.name+'.js'});}catch(cause){error=cause;}
 for(let turn=0;turn<30;turn++)await Promise.resolve();
 return{document,calls,reads,writes,removes,timers,navigation,observers,actors,moduleImports,values,error};
}
function closed(screen,f){assert.equal(f.calls.length,0);assert.equal(f.moduleImports.length,0);assert.equal(f.timers.length,0);assert.equal(f.observers.length,0);assert.equal(f.actors.length,0);assert.equal(f.navigation.length,0);assert.equal(f.error,undefined);assert.match(f.document.getElementById(screen.name==='journal-entry'?'error':'message').textContent,/identificador.*no es válido/);for(const control of f.document.querySelectorAll('input,select,textarea,button')){assert.equal(control.disabled,true);assert.equal(control.listeners.length,0);for(const event of['onclick','onchange','onsubmit'])assert.notEqual(typeof control[event],'function');}}
for(const screen of screens){
 test(screen.name+' invalid present IDs reject before session, credentials, APIs, listeners and fallback',async()=>{
  for(const search of invalid){const f=await execute(screen,search,{handoff:'42'});closed(screen,f);assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);assert.equal(f.removes.length,0);}
 });
 test(screen.name+' absent ID preserves normal initialization and existing permission contracts',async()=>{
  const f=await execute(screen);assert.equal(f.error,undefined,f.error?.stack);assert.ok(f.calls.length>0);assert.deepEqual(f.moduleImports,screen.name==='payment-requests'?[searchSpecifier]:[]);
  if(screen.name==='journal-entry'){assert.equal(f.document.getElementById('save').disabled,false,f.document.getElementById('journalLoadMessage').textContent);assert.equal(f.document.getElementById('lines').rows.length,2);assert.ok(f.calls.every(call=>!call.path.includes('&id=')));}
  else assert.deepEqual(f.calls.map(call=>call.path),['/api/treasury/payment-requests/access','/api/treasury/payment-requests/options','/api/treasury/payment-requests/report']);
 });
 test(screen.name+' valid direct IDs retain canonical string identity and detail loading',async()=>{
  for(const queryId of['42','%34%32','9007199254740991']){const id=decodeURIComponent(queryId),f=await execute(screen,'?id='+queryId,{handoff:'INVALID-UNREAD'});assert.equal(f.error,undefined,f.error?.stack);assert.deepEqual(f.moduleImports,screen.name==="payment-requests"?[searchSpecifier]:[]);assert.equal(f.reads.some(read=>read.key==='nexo_edit_journal'),false);
   if(screen.name==='journal-entry'){assert.ok(f.calls.some(call=>call.path==='/api/accounting/journal-entry/'+id));assert.equal(f.values.get('nexo_edit_journal'),id);assert.equal(f.document.getElementById('save').disabled,false);}
   else{assert.deepEqual(f.calls.filter(call=>call.path.endsWith('/detail')).map(call=>call.body),[{id}]);assert.equal(f.document.getElementById('title').textContent,'SYN-REQUEST · BORRADOR');}
  }
 });
}
test('journal persistent handoff is validated before credentials and retained across legitimate editing',async()=>{
 for(const id of['42','9007199254740991']){const f=await execute(screens[0],'',{handoff:id});assert.equal(f.reads[0].key,'nexo_edit_journal');assert.equal(f.values.get('nexo_edit_journal'),id);assert.equal(f.removes.some(item=>item.key==='nexo_edit_journal'),false);assert.ok(f.calls.some(call=>call.path==='/api/accounting/journal-entry/'+id));}
 for(const handoff of['','01','../2','9007199254740992']){const f=await execute(screens[0],'',{handoff});closed(screens[0],f);assert.deepEqual(f.reads,[{area:'session',key:'nexo_edit_journal'}]);assert.deepEqual(f.removes,[{area:'session',key:'nexo_edit_journal'}]);}
});
test('journal actual create and edit save handlers retain POST/PUT without generating real entries',async()=>{
 for(const search of['','?id=42','?id=9007199254740991']){const f=await execute(screens[0],search),$=id=>f.document.getElementById(id);if(!$('lines').rows.length){$('addLine').click();$('addLine').click();}
  for(const[index,row]of $('lines').rows.entries()){row.querySelector('[data-key=account_id]').value='7';row.querySelector('[data-key=debit]').value=index===0?'10':'0';row.querySelector('[data-key=credit]').value=index===1?'10':'0';}
  await $('save').click();const call=f.calls.find(call=>['POST','PUT'].includes(call.method)&&call.path.includes('/journal-entry'));assert.ok(call,$('error').textContent);assert.equal(call.method,search?'PUT':'POST');assert.equal(call.path,'/api/accounting/journal-entry'+(search?'/'+new URLSearchParams(search).get('id'):''));assert.equal($('successModal').hidden,false);
 }
});
test('request company aliases reject invalid, duplicated or conflicting values before any storage or API',async()=>{
 const queries=['?subsidiaryId=1&subsidiaryId=1','?company=1&company=2','?subsidiaryId=1&company=2',...['','01','../2','9007199254740992'].flatMap(id=>['?'+new URLSearchParams({subsidiaryId:id}),'?'+new URLSearchParams({company:id})])];
 for(const search of queries){const f=await execute(screens[1],search);closed(screens[1],f);assert.equal(f.reads.length,0);}
});
test('valid company aliases preserve active-company restriction before tokens and authenticated bootstrap',async()=>{
 for(const suffix of['company=1','subsidiaryId=1','company=1&subsidiaryId=1']){const f=await execute(screens[1],'?id=42&'+suffix);assert.equal(f.error,undefined);assert.equal(f.reads[0].key,'nexo_company');assert.ok(f.calls.some(call=>call.path.endsWith('/detail')));}
 const wrong=await execute(screens[1],'?id=42&company=2');assert.equal(wrong.calls.length,0);assert.equal(wrong.moduleImports.length,0);assert.deepEqual(wrong.reads,[{area:'local',key:'nexo_company'}]);assert.match(wrong.document.getElementById('message').textContent,/empresa indicada no está activa/);assert.equal(wrong.document.getElementById('new').hidden,true);
});
test('original permission denials stop journal readiness and payment request detail access',async()=>{
 const journal=await execute(screens[0],'?id=42',{deny:true});assert.equal(journal.document.getElementById('save').disabled,true);assert.ok(journal.calls.every(call=>call.method==='GET'));
 const request=await execute(screens[1],'?id=42',{deny:true});assert.deepEqual(request.calls.map(call=>call.path),['/api/treasury/payment-requests/access']);
 const noView=await execute(screens[1],'?id=42',{noView:true});assert.equal(noView.calls.some(call=>call.path.endsWith('/detail')||call.path.endsWith('/supports')),false);
});
test('own HTML cache references are fresh while P94 validator imports and P118 attachment handlers remain present',()=>{
 for(const screen of screens){assert.ok(screen.html.includes('/'+screen.name+'.js?v='+versions[screen.name]));assert.ok(screen.source.includes("from './route-id.js?v=20261103-route-id-guard'"));}
 const journal=screens[0].source;assert.ok(journal.includes("mime_type:file.type||'application/octet-stream'"));assert.ok(journal.includes('file.size===0||file.size>5242880'));assert.ok(journal.includes("url.protocol!=='https:'"));
});
