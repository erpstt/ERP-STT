import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

// Evaluate only real catalog declarations/methods: no Vue mount, network or jobs.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function method(name){
 const start=source.search(new RegExp('^    (?:async )?'+name+'\\s*\\(','m'));
 assert.ok(start>=0,'Missing UI method '+name);
 const next=/\n    (?:async )?[A-Za-z_$][\w$]*\s*\(/g;next.lastIndex=start+4;
 const end=next.exec(source);assert.ok(end,'Missing method boundary for '+name);
 const declaration=source.slice(start,end.index).trim().replace(/,\s*$/,'');
 return vm.runInNewContext('({'+declaration+'})')[name];
}
const methods=Object.fromEntries(['canCurrentAction','openRecordForm','submitRecord','confirmDelete'].map(name=>[name,method(name)]));
function catalog(slug){
 const line=source.split('\n').find(line=>line.includes("slug:'"+slug+"'"));
 assert.ok(line,'Missing catalog '+slug);
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+line.trim().replace(/,$/,'')+')')));
}
const capabilities={canView:true,canCreate:true,canEdit:true,canDelete:true};
function state(activeCatalog,id=null){
 const calls=[];
 return {activeCatalog,activeCapability:{...capabilities},roleAccess:{loaded:true,isAdmin:true},calls,
  recordDialog:{open:false,mode:'form',id,values:{total_amount:100,status_id:1}},
  api:async(...args)=>{calls.push(['api',...args]);return{};},
  openWorkspace:(...args)=>calls.push(['workspace',...args]),
  loadCatalog:async()=>calls.push(['loadCatalog']),
  loadReferenceOptions:async()=>calls.push(['references']),
  $nextTick:async()=>calls.push(['nextTick']),
  catalogPath:()=>'/api/transaction-engine/'+activeCatalog.slug};
}

for(const slug of ['transactions','transaction-lines']){
 test(slug+' advertises consultation only even with full or administrative capabilities',()=>{
  const c=catalog(slug);assert.equal(c.transactionEngineReadOnly,true);
  for(const key of ['allowCreate','allowEdit','allowDelete'])assert.equal(c[key],false);
  for(const capability of [{...capabilities},null]){
   const s=state(c);s.activeCapability=capability;
   assert.equal(methods.canCurrentAction.call(s,'view'),true);
   for(const action of ['create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);
  }
  const denied=state(c);denied.roleAccess.isAdmin=false;denied.activeCapability={canView:false};
  assert.equal(methods.canCurrentAction.call(denied,'view'),false);
 });
 test(slug+' blocks direct create/edit/submit/delete handlers before IO or dialog mutation',async()=>{
  const c=catalog(slug);
  for(const [name,args,id,errorKey]of [
   ['openRecordForm',[null],null,'tableError'],
   ['openRecordForm',[{[c.primaryKey]:17}],17,'tableError'],
   ['submitRecord',[],null,'dialogError'],
   ['submitRecord',[],17,'dialogError'],
   ['confirmDelete',[],17,'dialogError']
  ]){
   const s=state(c,id),before=JSON.stringify(s.recordDialog);
   await methods[name].apply(s,args);
   assert.match(s[errorKey]||'',/Gestione la transacción desde su documento de origen\./,name);
   assert.equal(JSON.stringify(s.recordDialog),before,name+' changed the dialog');
   assert.deepEqual(s.calls,[],name+' reached IO');
  }
 });
}
test('read-only guard does not disable unrelated catalog permissions',()=>{
 const s=state({slug:'synthetic-unrelated',apiRoot:'synthetic'});
 for(const action of ['view','create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),true);
 s.activeCapability={canView:true,canCreate:false,canEdit:false,canDelete:false};
 assert.equal(methods.canCurrentAction.call(s,'view'),true);
 for(const action of ['create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);
});
