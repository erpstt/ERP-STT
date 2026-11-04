import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

// Real isolated UI methods and workflow bootstrap; no Vue mount, network or jobs.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const workflowSource=await readFile(new URL('../public/purchase-documents.js',import.meta.url),'utf8');
function method(name){
 const start=source.search(new RegExp('^    (?:async )?'+name+'\\s*\\(','m'));
 assert.ok(start>=0,'Missing UI method '+name);
 const next=/\n    (?:async )?[A-Za-z_$][\w$]*\s*\(/g;next.lastIndex=start+4;
 const end=next.exec(source);assert.ok(end,'Missing method boundary for '+name);
 const declaration=source.slice(start,end.index).trim().replace(/,\s*$/,'');
 return vm.runInNewContext('({'+declaration+'})')[name];
}
const methods=Object.fromEntries(['canCurrentAction','openRecordForm','submitRecord','confirmDelete','sectionCapability','hasSectionAccess','navigateChild'].map(name=>[name,method(name)]));
const targets=[['requisitions','Solicitudes de compra','REQUISITION'],['quotes','Cotizaciones de proveedores','QUOTE']];
const full={canView:true,canCreate:true,canEdit:true,canDelete:true};
function catalog(slug){
 const line=source.split('\n').find(line=>line.includes("slug:'"+slug+"',")&&line.includes("apiRoot:'purchasing'"));
 assert.ok(line,'Missing catalog '+slug);
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+line.trim().replace(/,$/,'')+')')));
}
function state(activeCatalog,id=null){
 const calls=[],s={activeCatalog,activeCapability:{...full},roleAccess:{loaded:true,isAdmin:false,modules:[{name:'Compras',resources:targets.map(([slug,optionName])=>({key:'purchasing:'+slug,optionName}))}],grants:Object.fromEntries(targets.map(([slug])=>['purchasing:'+slug,{...full}]))},calls,
  recordDialog:{open:false,mode:'form',id,values:{transaction_id:100,status_id:1}},
  api:async(...args)=>{calls.push(['api',...args]);return{};},
  closeWorkspace:()=>calls.push(['closeWorkspace']),
  openWorkspace:(...args)=>calls.push(['workspace',...args]),
  loadCatalog:async()=>calls.push(['loadCatalog']),
  loadReferenceOptions:async()=>calls.push(['references']),
  $nextTick:async()=>calls.push(['nextTick']),
  catalogPath:()=>'/api/purchasing/'+activeCatalog.slug};
 for(const name of ['sectionCapability','hasSectionAccess'])s[name]=methods[name].bind(s);
 return s;
}
for(const [slug]of targets){
 test(slug+' generic catalog is consultation only even with administrative capabilities',()=>{
  const c=catalog(slug);assert.equal(c.purchaseLegacyReadOnly,true);
  for(const key of ['allowCreate','allowEdit','allowDelete'])assert.equal(c[key],false);
  for(const isAdmin of [false,true])for(const capability of [{...full},null]){
   const s=state(c);s.roleAccess.isAdmin=isAdmin;s.activeCapability=capability;
   assert.equal(methods.canCurrentAction.call(s,'view'),true);
   for(const action of ['create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);
  }
  const s=state(c);s.activeCapability={canView:false};
  assert.equal(methods.canCurrentAction.call(s,'view'),false);
 });
 test(slug+' generic create/edit/submit/delete handlers stop before IO or dialog changes',async()=>{
  const c=catalog(slug);
  for(const isAdmin of [false,true])for(const [name,args,id,errorKey]of [
   ['openRecordForm',[null],null,'tableError'],
   ['openRecordForm',[{[c.primaryKey]:17}],17,'tableError'],
   ['submitRecord',[],null,'dialogError'],
   ['submitRecord',[],17,'dialogError'],
   ['confirmDelete',[],17,'dialogError']
  ]){
   const s=state(c,id);s.roleAccess.isAdmin=isAdmin;const before=JSON.stringify(s.recordDialog);
   await methods[name].apply(s,args);
   assert.match(s[errorKey]||'',/Utilice el formulario de solicitudes o cotizaciones de Compras\./,name);
   assert.equal(JSON.stringify(s.recordDialog),before,name+' changed dialog state');
   assert.deepEqual(s.calls,[],name+' reached IO');
  }
 });
}
test('purchase navigation retains operational workspaces and explicit role capabilities',()=>{
 for(const [slug,section,type]of targets)for(const capabilities of [full,{canView:true,canCreate:false,canEdit:false,canDelete:false}]){
  const s=state(catalog(slug));s.roleAccess.grants['purchasing:'+slug]={...capabilities};
  assert.deepEqual(methods.sectionCapability.call(s,'Compras',section),capabilities);
  methods.navigateChild.call(s,'Compras',section);
  assert.deepEqual(s.calls,[['closeWorkspace'],['workspace','/purchase-documents.html?type='+type]]);
  assert.equal(s.currentModule,'Compras');assert.equal(s.currentSection,section);
  assert.deepEqual(s.roleAccess.grants['purchasing:'+slug],capabilities);
 }
});
test('operational navigation still rejects roles without the section view permission',()=>{
 for(const [slug,section]of targets){
  const s=state(catalog(slug));s.roleAccess.grants['purchasing:'+slug]={canView:false,canCreate:true,canEdit:true,canDelete:true};
  methods.navigateChild.call(s,'Compras',section);
  assert.deepEqual(s.calls,[['closeWorkspace']]);assert.match(s.tableError,/no tiene acceso/);
 }
});
test('operational create controls continue to use their workflow access response independently of generic catalog flags',async()=>{
 const bootstrap=workflowSource.match(/^const now=new Date\(\),first=.*$/m)?.[0];assert.ok(bootstrap,'Missing real workflow bootstrap');
 for(const [,slug,type]of targets)for(const canCreate of [false,true]){
  const elements=new Map(),calls=[],access={canView:true,canCreate,canEdit:true};
  const context={type,access:{},purchaseLegacyReadOnly:true,catalog:{allowCreate:false,allowEdit:false,allowDelete:false},
   $:id=>{if(!elements.has(id))elements.set(id,{hidden:false,value:'',textContent:''});return elements.get(id);},
   api:async path=>{calls.push(path);return access;},loadOptions:async()=>calls.push('options'),load:async()=>calls.push('report'),
   URLSearchParams,location:{search:'?type='+type},open:async()=>assert.fail('Unexpected automatic create'),copySource:async()=>assert.fail('Unexpected source copy')};
  await vm.runInNewContext('(async()=>{'+bootstrap+'})()',context);
  assert.equal(elements.get('new').hidden,!canCreate);
  assert.deepEqual(calls,['/api/purchasing/workflow/access?type='+type,'options','report']);
  assert.equal(context.access.canEdit,true,slug);
 }
});
test('generic read-only guard preserves unrelated catalog action permissions',()=>{
 const s=state({slug:'synthetic-unrelated',apiRoot:'synthetic'});
 for(const action of ['view','create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),true);
 s.activeCapability={canView:true,canCreate:false,canEdit:false,canDelete:false};
 assert.equal(methods.canCurrentAction.call(s,'view'),true);
 for(const action of ['create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);
});
