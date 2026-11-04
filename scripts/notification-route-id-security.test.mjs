import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';

assertIsolatedTestArgs();
const screens={
 customer:{script:'customer-statement-notifications.js',page:'customer-statement-notifications.html',base:'/api/entities/customers/'},
 payment:{script:'payment-notifications.js',page:'supplier-payment-view.html',base:'/api/purchasing/supplier-payments/'}
};
for(const screen of Object.values(screens)){
 [screen.source,screen.html]=await Promise.all([screen.script,screen.page].map(file=>readFile(new URL('../public/'+file,import.meta.url),'utf8')));
}

class Element{
 constructor(document,id=''){this.document=document;this.id=id;this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.open=false;this.listeners=new Map();this.button=null;}
 set innerHTML(value){this.markup=value;this.document.parse(value);}
 get innerHTML(){return this.markup??'';}
 addEventListener(type,callback){const callbacks=this.listeners.get(type)??[];callbacks.push(callback);this.listeners.set(type,callbacks);}
 querySelector(selector){assert.equal(selector,'button');return this.button??=new Element(this.document);}
 showModal(){this.open=true;}
 close(){this.open=false;}
 click(){if(!this.disabled)return this.trigger('click');}
 async trigger(type,extra={}){
  const event={currentTarget:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};
  if(typeof this['on'+type]==='function')await this['on'+type](event);
  for(const callback of this.listeners.get(type)??[])await callback(event);
  return event;
 }
}
class Document{
 constructor(html){this.elements=new Map();this.downloads=[];this.parse(html);}
 parse(html){
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)){
   const id=/\bid="([^"]+)"/.exec(match[2])?.[1];if(!id)continue;
   const element=new Element(this,id);element.value=/\bvalue="([^"]*)"/.exec(match[2])?.[1]??'';
   element.disabled=/\bdisabled(?:\s|=|$)/.test(match[2]);this.elements.set(id,element);
  }
 }
 getElementById(id){return this.elements.get(id)??null;}
 createElement(tag){assert.equal(tag,'a');const element=new Element(this);element.click=()=>this.downloads.push({href:element.href,download:element.download});return element;}
}

async function screen(kind,search){
 const definition=screens[kind],document=new Document(definition.html),calls=[],storageReads=[],timers=new Map(),events=new Map();let timerId=0;
 const storage={getItem(key){storageReads.push(key);return key==='nexo_token'?'synthetic-notification-token':key==='nexo_device_token'?'synthetic-notification-device':null;}};
 const id=new URLSearchParams(search).get('id');
 class LocalURL extends URL{static createObjectURL(){return 'blob:synthetic-notification-pdf';}static revokeObjectURL(){}}
 const context=vm.createContext({
  document,location:{search},URLSearchParams,URL:LocalURL,Intl,Date,Blob,Uint8Array,
  atob:value=>Buffer.from(value,'base64').toString('binary'),
  crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000090'},
  localStorage:storage,sessionStorage:storage,
  setTimeout(callback,delay){const key=++timerId;timers.set(key,{callback,delay});return key;},clearTimeout(key){timers.delete(key);},
  addEventListener(type,callback){events.set(type,callback);},
  async fetch(path,init){
   // A closed in-memory API stub. No browser, server, network or real token is used.
   const call={path:String(path),method:init.method,headers:JSON.parse(JSON.stringify(init.headers)),body:JSON.parse(init.body)};calls.push(call);
   const base=definition.base+id+(kind==='customer'?'/statement/':'/notifications/');
   assert.ok(call.path.startsWith(base),'Only the selected notification route may be requested');
   const action=call.path.slice(base.length);let result;
   if(kind==='customer'){
    if(action==='get')result={statement:{cliente_nombre:'Synthetic customer',email:'customer@example.invalid',saldo_total:25,moneda:'CRC',fecha_corte:'2026-10-31'},transport:{enabled:true},access:{canDownload:true,canSend:true},history:[]};
    else if(action==='send')result={estado:'PENDIENTE'};
    else if(action==='pdf')result={base64:'U1lOVEhFVElDLVBERg==',fileName:'synthetic-statement.pdf'};
    else assert.fail('Unexpected statement action');
   }else{
    if(action==='history')result={transport:{enabled:true},canResend:true,logs:[{estado:'ENVIADO',destinatario:'supplier@example.invalid',created_at:'2026-10-31T12:00:00Z',enviado_at:'2026-10-31T12:01:00Z',history:[]}]};
    else if(action==='resend')result={estado:'PENDIENTE'};
    else assert.fail('Unexpected payment notification action');
   }
   return{ok:true,async json(){return result;}};
  }
 });
 const runtime=await vm.runInContext('(async()=>{\n'+definition.source+'\nreturn {api,load};\n})()',context,{timeout:1000,filename:definition.script});
 // payment-notifications intentionally starts its first load without awaiting it.
 for(let count=0;count<10;count++)await Promise.resolve();
 return{runtime,document,calls,storageReads,timers,events};
}

const invalidQueries=[
 '', '?id=', '?id=1&id=2',
 ...['../2','..\\2','1/2','1\\2','1?next=/other','1#fragment','%2e%2e%2f2','-1','0','00','01','+1','1.0','1e3','0x10','base36','z1','NaN','Infinity','١','１２',' 1','1 ','1\n','9007199254740992','9223372036854775807','9'.repeat(10000)].map(id=>'?'+new URLSearchParams({id})),
 '?id=%2e%2e%2f2','?id=1%2f2','?id=1%5c2','?id=1%3fother','?id=1%23fragment','?id=%252fother','?id=%00'
];
for(const kind of Object.keys(screens))test(kind+' rejects malformed, ambiguous and unsafe IDs before initialization or credential reads',async()=>{
 for(const [index,search]of invalidQueries.entries()){
  const f=await screen(kind,search);
  assert.equal(f.calls.length,0,'Invalid case '+index+' must not fetch');
  assert.equal(f.storageReads.length,0,'Invalid case '+index+' must not read a token');
  assert.equal(f.timers.size,0);assert.equal(f.events.size,0);
  const message=f.document.getElementById(kind==='customer'?'message':'paymentNotifications');
  assert.match(message.textContent,/identificador.*no es válido/);
  assert.doesNotMatch(message.textContent,/synthetic-notification-token/);
  // Even direct attempts at load/API cannot bypass the route guard.
  await assert.rejects(()=>f.runtime.api(kind==='customer'?'send':'resend',{}),/identificador.*no es válido/);
  await f.runtime.load().catch(()=>{});
  if(kind==='customer'){
   for(const id of['refresh','pdf','compose','cutoff','note','confirmSend'])assert.equal(f.document.getElementById(id).disabled,true);
   const submission=await f.document.getElementById('sendForm').trigger('submit');assert.equal(submission.defaultPrevented,true);
  }else assert.equal(f.document.getElementById('resendNotification'),null);
  assert.equal(f.calls.length,0);assert.equal(f.storageReads.length,0);
  assert.equal(f.calls.filter(call=>call.headers.Authorization?.startsWith('Bearer ')).length,0);
 }
});

test('valid customer IDs retain get/send/PDF routes, body fields and confirmation behavior without numeric rounding',async()=>{
 for(const queryId of['1','42','9007199254740991','%34%32']){
  const id=decodeURIComponent(queryId),f=await screen('customer','?id='+queryId+'&cutoff=2026-10-31&subsidiaryId=2&compose=1');
  assert.equal(f.document.getElementById('confirmation').open,true);
  f.document.getElementById('note').value='Synthetic statement note';
  const submission=await f.document.getElementById('sendForm').trigger('submit');assert.equal(submission.defaultPrevented,true);
  await f.document.getElementById('pdf').trigger('click');
  assert.deepEqual(f.calls.map(call=>call.path),['get','send','get','pdf'].map(action=>'/api/entities/customers/'+id+'/statement/'+action));
  assert.deepEqual(f.calls.map(call=>call.body),[
   {cutoff:'2026-10-31',subsidiaryId:'2'},
   {cutoff:'2026-10-31',subsidiaryId:'2',note:'Synthetic statement note',requestId:'00000000-0000-4000-8000-000000000090'},
   {cutoff:'2026-10-31',subsidiaryId:'2'},
   {cutoff:'2026-10-31',subsidiaryId:'2'}
  ]);
  assert.ok(f.calls.every(call=>call.method==='POST'&&call.headers.Authorization==='Bearer synthetic-notification-token'&&call.headers['X-Device-Token']==='synthetic-notification-device'&&call.headers['Content-Type']==='application/json'));
  assert.deepEqual(f.document.downloads,[{href:'blob:synthetic-notification-pdf',download:'synthetic-statement.pdf'}]);
 }
});

test('valid payment IDs retain notification history/resend paths and recipient body',async()=>{
 for(const queryId of['1','42','9007199254740991','%34%32']){
  const id=decodeURIComponent(queryId),f=await screen('payment','?id='+queryId);
  f.document.getElementById('notificationEmail').value='corrected-supplier@example.invalid';
  const submission=await f.document.getElementById('resendNotification').trigger('submit');assert.equal(submission.defaultPrevented,true);
  assert.deepEqual(f.calls.map(call=>call.path),['history','resend','history'].map(action=>'/api/purchasing/supplier-payments/'+id+'/notifications/'+action));
  assert.deepEqual(f.calls.map(call=>call.body),[{}, {email:'corrected-supplier@example.invalid'},{}]);
  assert.ok(f.calls.every(call=>call.method==='POST'&&call.headers.Authorization==='Bearer synthetic-notification-token'&&call.headers['X-Device-Token']==='synthetic-notification-device'&&call.headers['Content-Type']==='application/json'));
 }
});

test('both standalone pages reference the guarded notification assets with the new immutable-cache version',()=>{
 for(const definition of Object.values(screens)){
  const references=[...definition.html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]).filter(src=>src.split('?')[0]==='/'+definition.script);
  assert.deepEqual(references,['/'+definition.script+'?v=20261103-notification-id-guard']);
 }
});
