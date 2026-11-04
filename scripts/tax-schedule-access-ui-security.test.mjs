import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

assert.deepEqual(process.argv.slice(2), [], 'This VM fixture accepts no destinations or credentials');
const version='20261104-tax-schedule-access';
const uuid='12345678-1234-1234-1234-123456789abc';
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
const permissions=actions=>Object.fromEntries(['view','create','edit','delete'].map(action=>[action,actions.includes(action)]));

class Element{
 constructor(id='',tag='INPUT'){this.id=id;this.tagName=tag.toUpperCase();this.value='';this.textContent='';this.innerHTML='';this.className='';this.disabled=false;this.hidden=false;this.checked=false;this.readOnly=false;this.dataset={};this.children=new Map();this.listeners={};this.elements=[];this.open=false;this.attributes={};this.classList={toggle:()=>{},add:()=>{},remove:()=>{}};}
 setAttribute(key,value){this.attributes[key]=String(value);}
 addEventListener(name,listener){this.listeners[name]=listener;}
 querySelector(selector){if(!this.children.has(selector))this.children.set(selector,new Element(this.id+selector,selector.includes('submit')?'BUTTON':'DIV'));return this.children.get(selector);}
 reset(){}
 showModal(){this.open=true;}
 close(){this.open=false;}
 focus(){}
 remove(){}
 setRangeText(value){this.value+=value;}
}

async function fixture(kind,actions,{denied=false}={}){
 const file=kind==='tax'?'tax-obligations':'scheduled-reports';
 const [source,html]=await Promise.all([readFile(new URL('../public/'+file+'.js',import.meta.url),'utf8'),readFile(new URL('../public/'+file+'.html',import.meta.url),'utf8')]);
 const elements=new Map();
 for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi))elements.set(match[2],new Element(match[2],match[1]));
 const get=id=>{assert.ok(elements.has(id),'Actual HTML must contain '+id);return elements.get(id);};
 const calls=[],downloads=[],storageCalls=[];const caps=permissions(actions);
 const obligation={id:uuid,countryId:1,countryName:'Synthetic country',code:'DEMO',name:'Synthetic obligation',frequency:'monthly',description:'Synthetic',isActive:true};
 const schedule={id:1,revision:7,name:'Synthetic schedule',report_kind:'AR',format:'CSV',frequency:'WEEKLY',weekday:1,month_day:1,send_time:'08:00:00',cutoff_rule:'SEND_DATE',recipients:['synthetic@example.invalid'],active:true,next_run_at:'2026-11-04T08:00:00Z',period_mode:'YEAR_TO_DATE',report_options:{}};
 const taxOptions={permissions:{manage:true,...caps},countries:[{id:1,name:'Synthetic country'}],placeholders:[{token:'{{empresa}}',label:'Company'}]};
 const scheduleList={permissions:caps,company:{id:1,name:'Synthetic company'},transport:{configured:false,enabled:false},reports:[{code:'AR',name:'Synthetic receivables',category:'Synthetic'}],books:[],banks:[],schedules:[schedule],history:[]};
 const tabs=new Element('tabs','DIV');
 const document={
  getElementById:get,
  querySelector(selector){if(selector==='.config-tabs')return tabs;if(selector==='dialog[open] .dialogError')return [...elements.values()].find(element=>element.tagName==='DIALOG'&&element.open)?.querySelector('.dialogError')??null;return null;},
  querySelectorAll(selector){if(selector==='button, select, input, textarea')return [...elements.values()].filter(element=>['BUTTON','SELECT','INPUT','TEXTAREA'].includes(element.tagName));if(selector==='dialog')return [...elements.values()].filter(element=>element.tagName==='DIALOG');if(selector==='.dialogError')return [...elements.values()].filter(element=>element.tagName==='DIALOG').map(element=>element.querySelector('.dialogError'));return[];},
  createElement(tag){const element=new Element('',tag);element.click=()=>downloads.push({href:element.href,fileName:element.download});return element;},
  body:{append(){}},
 };
 if(kind==='tax'){
  get('obligationForm').elements=['obligationCountry','obligationCode','obligationName','obligationFrequency','obligationDescription','obligationActive','cancelObligation'].map(get);
  get('obligationForm').elements.push(get('obligationForm').querySelector('[type="submit"]'));
  get('templateKind').value='reminder';
 }else{
  Object.entries({report:'AR',format:'CSV',frequency:'WEEKLY',weekday:'1',monthDay:'1',time:'08:00',cutoff:'SEND_DATE',recipients:'synthetic@example.invalid',name:'Synthetic schedule',periodMode:'YEAR_TO_DATE'}).forEach(([id,value])=>get(id).value=value);
  get('active').checked=true;
 }
 const storage={getItem(key){storageCalls.push(key);return key==='nexo_token'?'p147-synthetic-token':key==='nexo_device_token'?'p147-synthetic-device-with-enough-entropy':null;},setItem(key){storageCalls.push(key);}};
 class FixtureURL extends URL{static createObjectURL(){return'blob:synthetic';}static revokeObjectURL(){}}
 const context=vm.createContext({document,localStorage:storage,sessionStorage:storage,console,URL:FixtureURL,Blob,Uint8Array,Intl,Date,atob,setTimeout:()=>0,
  fetch:async(url,options)=>{
   assert.equal(typeof url,'string');assert.ok(url.startsWith(kind==='tax'?'/api/tax-obligations/':'/api/reports/schedules/'));
   const headers=options.headers;assert.equal(headers.Authorization,'Bearer p147-synthetic-token');assert.equal(headers['X-Device-Token'],'p147-synthetic-device-with-enough-entropy');
   const action=url.split('/').at(-1),payload=JSON.parse(options.body);calls.push({action,payload});
   if(denied)return Response.json({error:{message:'Synthetic access denied'}},{status:403});
   if(kind==='tax')return Response.json(action==='options'?taxOptions:action==='list'?{obligations:[obligation],templates:[]}:{success:true});
   return Response.json(action==='list'?scheduleList:action==='preview'?{file:{fileName:'synthetic.csv',mimeType:'text/csv',base64:Buffer.from('synthetic').toString('base64')},cutoff:'2026-11-04'}:{success:true});
  },
 });
 let code=source;
 if(kind==='tax'){
  assert.equal((code.match(/void initialize\(\);/g)||[]).length,1);code=code.replace('void initialize();','await initialize();');
  code+='\nglobalThis.hooks={api,perform,openObligation,saveObligation,saveTemplate,state};';
 }else code+='\nglobalThis.hooks={api,act,openEditor,state:()=>state};';
 await new vm.Script('(async()=>{'+code+'\n})()', {filename:file+'.js'}).runInContext(context);
 await settle();
 return{get,calls,downloads,storageCalls,hooks:context.hooks,obligation,schedule,caps,context};
}

test('both dedicated HTML scripts carry the exact own cache version',async()=>{
 for(const file of['tax-obligations','scheduled-reports']){
  const html=await readFile(new URL('../public/'+file+'.html',import.meta.url),'utf8');assert.ok(html.includes('/'+file+'.js?v='+version));
 }
});

test('tax reader keeps viewing and preview, hides every mutation and forged actions perform zero fetches',async()=>{
 const f=await fixture('tax',['view']);assert.deepEqual(f.calls.map(call=>call.action),['options','list']);
 assert.equal(f.get('newObligation').hidden,true);assert.equal(f.get('saveTemplate').hidden,true);assert.equal(f.get('templateSubject').readOnly,true);
 f.hooks.openObligation(uuid);assert.equal(f.get('obligationDialog').open,true);assert.equal(f.get('obligationDialogTitle').textContent,'Ver obligación');assert.equal(f.get('obligationForm').querySelector('[type="submit"]').hidden,true);assert.equal(f.get('requestObligationDelete').hidden,true);
 const before=f.calls.length;
 for(const [action,payload]of[['save',{}],['save',{id:uuid}],['delete',{id:uuid}],['save-template',{}],['unknown',{}]])await assert.rejects(()=>f.hooks.api(action,payload));
 f.get('obligationForm').onsubmit({preventDefault(){}});f.get('requestObligationDelete').onclick();f.get('confirmObligationDelete').onclick();await settle();
 assert.equal(f.calls.length,before);assert.equal(f.get('deleteObligationDialog').open,false);assert.ok(f.get('templatePreview').srcdoc.includes('GENTIA'));
 assert.equal(f.get('templateActive').disabled,true,'busy finally must preserve denied controls');
});

test('tax create-only submits a genuine create without an id and cannot edit/delete/template-save',async()=>{
 const f=await fixture('tax',['view','create']);assert.equal(f.get('newObligation').hidden,false);f.get('newObligation').onclick();
 assert.equal(f.get('obligationForm').querySelector('[type="submit"]').hidden,false);
 Object.entries({obligationCountry:'1',obligationCode:'DEMO',obligationName:'Synthetic created obligation',obligationFrequency:'monthly',obligationDescription:'Synthetic'}).forEach(([id,value])=>f.get(id).value=value);
 f.get('obligationForm').onsubmit({preventDefault(){}});await settle();
 const saved=f.calls.find(call=>call.action==='save');assert.ok(saved);assert.equal(Object.hasOwn(saved.payload,'id'),false);assert.equal(saved.payload.countryId,1);
 f.hooks.openObligation(uuid);assert.equal(f.get('obligationForm').querySelector('[type="submit"]').hidden,true);assert.equal(f.get('saveTemplate').hidden,true);assert.equal(f.get('requestObligationDelete').hidden,true);
});

test('tax edit-only keeps editing and template-upsert while create/delete stay denied',async()=>{
 const f=await fixture('tax',['view','edit']);assert.equal(f.get('newObligation').hidden,true);assert.equal(f.get('saveTemplate').hidden,false);
 f.hooks.openObligation(uuid);assert.equal(f.get('obligationForm').querySelector('[type="submit"]').hidden,false);assert.equal(f.get('requestObligationDelete').hidden,true);
 f.get('obligationForm').onsubmit({preventDefault(){}});await settle();assert.equal(f.calls.find(call=>call.action==='save')?.payload.id,uuid);
 f.get('templateSubject').value='Synthetic subject';f.get('templateBody').value='Synthetic template body';f.get('templateForm').onsubmit({preventDefault(){}});await settle();assert.ok(f.calls.some(call=>call.action==='save-template'));
 const before=f.calls.length;await assert.rejects(()=>f.hooks.api('save',{}));await assert.rejects(()=>f.hooks.api('delete',{id:uuid}));assert.equal(f.calls.length,before);
});

test('tax delete-only can remove an existing item without gaining edit/create/template rights',async()=>{
 const f=await fixture('tax',['view','delete']);f.hooks.openObligation(uuid);assert.equal(f.get('requestObligationDelete').hidden,false);assert.equal(f.get('obligationForm').querySelector('[type="submit"]').hidden,true);
 f.get('requestObligationDelete').onclick();assert.equal(f.get('deleteObligationDialog').open,true);f.get('confirmObligationDelete').onclick();await settle();
 assert.deepEqual(plain(f.calls.find(call=>call.action==='delete').payload),{id:uuid});assert.equal(f.get('newObligation').hidden,true);assert.equal(f.get('saveTemplate').hidden,true);
});

test('tax missing view closes the workspace without loading catalog data',async()=>{
 const f=await fixture('tax',[]);assert.deepEqual(f.calls.map(call=>call.action),['options']);assert.equal(f.get('workspace').hidden,true);assert.equal(f.get('accessDenied').hidden,false);
 f.hooks.openObligation(uuid);assert.equal(f.get('obligationDialog').open,false);
});

test('schedule reader keeps details and synthetic preview while forged mutations and finally remain closed',async()=>{
 const f=await fixture('schedule',['view']);assert.equal(f.get('new').hidden,true);assert.match(f.get('schedules').innerHTML,/>Ver<\/button>/);assert.ok(!f.get('schedules').innerHTML.includes('data-toggle'));assert.ok(!f.get('schedules').innerHTML.includes('data-delete'));
 f.hooks.openEditor(f.schedule);assert.equal(f.get('editorTitle').textContent,'Ver programación');assert.equal(f.get('save').disabled,true);assert.equal(f.get('save').hidden,true);assert.equal(f.get('preview').disabled,false);assert.equal(f.get('deleteConfirm').disabled,true);
 const before=f.calls.length;
 for(const[action,payload]of[['save',{}],['save',{id:1}],['toggle',{id:1}],['delete',{id:1}],['unknown',{}]])await assert.rejects(()=>f.hooks.api(action,payload));
 f.get('form').onsubmit({preventDefault(){}});await settle();
 f.get('schedules').onclick({target:{closest:()=>({dataset:{toggle:'1'}})}});await settle();
 f.get('schedules').onclick({target:{closest:()=>({dataset:{delete:'1'}})}});await settle();
 assert.equal(f.calls.length,before);assert.equal(f.get('deleteDialog').open,false);assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,true);assert.equal(f.get('preview').disabled,false);
 f.get('preview').onclick();await settle();assert.equal(f.calls.at(-1).action,'preview');assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].fileName,'synthetic.csv');
 assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,true);
});

test('schedule create-only sends no id and never enables edit/toggle/delete after finally',async()=>{
 const f=await fixture('schedule',['view','create']);assert.equal(f.get('new').hidden,false);f.get('new').onclick();assert.equal(f.get('save').disabled,false);
 f.get('form').onsubmit({preventDefault(){}});await settle();const saved=f.calls.find(call=>call.action==='save');assert.ok(saved);assert.equal(Object.hasOwn(saved.payload,'id'),false);assert.equal(saved.payload.report,'AR');assert.equal(saved.payload.format,'CSV');assert.deepEqual(saved.payload.recipients,['synthetic@example.invalid']);
 f.hooks.openEditor(f.schedule);assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,true);assert.ok(!f.get('schedules').innerHTML.includes('data-toggle'));
});

test('schedule edit-only preserves revision/toggle and denies new/delete',async()=>{
 const f=await fixture('schedule',['view','edit']);assert.equal(f.get('new').hidden,true);assert.ok(f.get('schedules').innerHTML.includes('data-toggle'));assert.ok(!f.get('schedules').innerHTML.includes('data-delete'));
 f.hooks.openEditor(f.schedule);assert.equal(f.get('save').disabled,false);f.get('form').onsubmit({preventDefault(){}});await settle();assert.equal(f.calls.find(call=>call.action==='save').payload.revision,7);
 f.get('schedules').onclick({target:{closest:()=>({dataset:{toggle:'1'}})}});await settle();assert.deepEqual(plain(f.calls.find(call=>call.action==='toggle').payload),{id:1,revision:7,active:false});
 assert.equal(f.get('deleteConfirm').disabled,true);const before=f.calls.length;await assert.rejects(()=>f.hooks.api('save',{}));await assert.rejects(()=>f.hooks.api('delete',{id:1}));assert.equal(f.calls.length,before);
});

test('schedule delete-only retains deletion revision without gaining save/toggle or create',async()=>{
 const f=await fixture('schedule',['view','delete']);assert.equal(f.get('new').hidden,true);assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,false);
 f.get('schedules').onclick({target:{closest:()=>({dataset:{delete:'1'}})}});assert.equal(f.get('deleteDialog').open,true);f.get('deleteConfirm').onclick();await settle();
 assert.deepEqual(plain(f.calls.find(call=>call.action==='delete').payload),{id:1,revision:7});assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,false);assert.ok(!f.get('schedules').innerHTML.includes('data-toggle'));
});

test('failed schedule initialization and failed operations never enable denied controls',async()=>{
 const denied=await fixture('schedule',[],{denied:true});assert.equal(denied.calls.length,1);assert.equal(denied.get('save').disabled,true);assert.equal(denied.get('preview').disabled,true);assert.equal(denied.get('deleteConfirm').disabled,true);
 const f=await fixture('schedule',['view']);await f.hooks.act(async()=>{throw Error('Synthetic failure');});assert.equal(f.get('save').disabled,true);assert.equal(f.get('deleteConfirm').disabled,true);assert.equal(f.get('preview').disabled,false);
});

test('action bits without view never expose UI mutations or permit forged API calls',async()=>{
 const actions=['create','edit','delete'];const tax=await fixture('tax',actions),schedule=await fixture('schedule',actions);
 assert.equal(tax.get('workspace').hidden,true);assert.equal(schedule.get('new').hidden,true);assert.equal(schedule.get('save').disabled,true);assert.equal(schedule.get('deleteConfirm').disabled,true);
 const beforeTax=tax.calls.length,beforeSchedule=schedule.calls.length;
 await assert.rejects(()=>tax.hooks.api('save',{}));await assert.rejects(()=>schedule.hooks.api('save',{}));assert.equal(tax.calls.length,beforeTax);assert.equal(schedule.calls.length,beforeSchedule);
});

test('administrator-capable UI preserves all existing action controls',async()=>{
 const all=['view','create','edit','delete'];const tax=await fixture('tax',all),schedule=await fixture('schedule',all);
 assert.equal(tax.get('newObligation').hidden,false);tax.hooks.openObligation(uuid);assert.equal(tax.get('requestObligationDelete').hidden,false);assert.equal(tax.get('saveTemplate').hidden,false);
 assert.equal(schedule.get('new').hidden,false);assert.ok(schedule.get('schedules').innerHTML.includes('data-toggle'));assert.ok(schedule.get('schedules').innerHTML.includes('data-delete'));schedule.hooks.openEditor(schedule.schedule);assert.equal(schedule.get('save').disabled,false);assert.equal(schedule.get('deleteConfirm').disabled,false);
});
