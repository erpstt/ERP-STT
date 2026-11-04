import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

// Isolated real shell methods and template conditions. No Vue mount, server, API or jobs.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const targets=['audit-logs','change-logs','event-logs','activity-logs','deleted-records'];
const full={canView:true,canCreate:true,canEdit:true,canDelete:true};
function method(name){
 const start=source.search(new RegExp('^    (?:async )?'+name+'\\s*\\(','m'));
 assert.ok(start>=0,'Missing UI method '+name);
 const next=/\n    (?:async )?[A-Za-z_$][\w$]*\s*\(/g;next.lastIndex=start+4;
 const end=next.exec(source);assert.ok(end,'Missing method boundary '+name);
 return vm.runInNewContext('({'+source.slice(start,end.index).trim().replace(/,\s*$/,'')+'})',{
  cancelRateCatalogLoad:()=>{},document:{querySelectorAll:()=>[]}
 })[name];
}
const names=['canCurrentAction','canOpenAuditReport','loadCatalog','openRecordForm','submitRecord','requestDelete','confirmDelete','openRecordAudit','openRecordView','sectionCapability','hasSectionAccess','navigateChild'];
const methods=Object.fromEntries(names.map(name=>[name,method(name)]));
function catalog(slug){
 const line=source.split('\n').find(line=>line.includes("slug:'"+slug+"',")&&line.includes("apiRoot:'audit'"));
 assert.ok(line,'Missing audit catalog '+slug);
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+line.trim().replace(/,$/,'')+')')));
}
function state(c=catalog('audit-logs')){
 const calls=[],s={activeCatalog:c,activeCapability:{...full},roleAccess:{loaded:true,isAdmin:false,modules:[{name:'Auditoría',resources:[...targets.map(slug=>({key:'audit:'+slug,optionName:catalog(slug).title})),{key:'audit:change-report',optionName:'Transacciones modificadas y eliminadas'}]}],grants:Object.fromEntries([...targets.map(slug=>['audit:'+slug,{canView:true}]),['audit:change-report',{canView:false}]])},calls,
  rows:[{snapshot:'Synthetic old row'}],referenceOptions:{private:[{snapshot:'Synthetic old reference'}]},
  recordDialog:{open:true,mode:'view',id:17,values:{snapshot:'Synthetic old dialog'}},dialogError:'Old dialog error',tableError:'Old error',tableWarning:'Old warning',tableNotice:'Old notice',tableLoading:true,
  api:async(...args)=>{calls.push(['api',...args]);assert.fail('Restricted catalog must not call APIs');},
  closeWorkspace:()=>calls.push(['closeWorkspace']),openWorkspace:(...args)=>calls.push(['workspace',...args]),
  recordLabel:()=> 'Synthetic record',loadReferenceOptions:async()=>calls.push(['references'])};
 for(const name of ['canOpenAuditReport','loadCatalog','sectionCapability','hasSectionAccess'])s[name]=methods[name].bind(s);
 return s;
}
function condition(expression,s){return vm.runInNewContext(expression,{...s,canOpenAuditReport:s.canOpenAuditReport});}

test('all five raw catalogs deny every generic action even for administrative capabilities',()=>{
 for(const slug of targets){const c=catalog(slug);assert.equal(c.auditRawRestricted,true);for(const key of ['allowCreate','allowEdit','allowDelete','allowAudit'])assert.equal(c[key],false);
  for(const isAdmin of [false,true])for(const capability of [full,null]){const s=state(c);s.roleAccess.isAdmin=isAdmin;s.activeCapability=capability;for(const action of ['view','create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);}
 }
});
test('loading any restricted catalog clears rows, references and dialogs without IO or residue',async()=>{
 for(const slug of targets)for(const isAdmin of [false,true]){const s=state(catalog(slug));s.roleAccess.isAdmin=isAdmin;await methods.loadCatalog.call(s);
  assert.equal(s.rows.length,0);assert.equal(Object.keys(s.referenceOptions).length,0);assert.equal(s.recordDialog.open,false);assert.equal(Object.keys(s.recordDialog.values).length,0);
  for(const key of ['dialogError','tableError','tableWarning'])assert.equal(s[key],'');assert.equal(s.tableLoading,false);assert.match(s.tableNotice,/consulta directa.*restringida/i);assert.match(s.tableNotice,/permiso independiente/);assert.deepEqual(s.calls,[]);
 }
});
test('direct form, delete, view and author handlers stop before dialog changes or IO',async()=>{
 for(const slug of targets)for(const isAdmin of [false,true])for(const [name,args,errorKey]of [
  ['openRecordForm',[{id:17}],'tableError'],['submitRecord',[],'dialogError'],['requestDelete',[{id:17}],'tableError'],['confirmDelete',[],'dialogError'],['openRecordAudit',[{id:17}],'tableError'],['openRecordView',[{id:17}],'tableError']
 ]){const s=state(catalog(slug));s.roleAccess.isAdmin=isAdmin;const before=JSON.stringify(s.recordDialog);await methods[name].apply(s,args);assert.equal(JSON.stringify(s.recordDialog),before,name+' mutated dialog');assert.deepEqual(s.calls,[],name+' reached IO');assert.match(s[errorKey],/consulta directa.*restringida/i);}
});
test('report access requires its own loaded permission and cannot be inferred from raw catalog access',()=>{
 const regional=state();assert.equal(methods.canOpenAuditReport.call(regional),false);regional.roleAccess.grants['audit:change-report']={canView:true};assert.equal(methods.canOpenAuditReport.call(regional),true);
 regional.roleAccess.loaded=false;assert.equal(methods.canOpenAuditReport.call(regional),false);regional.roleAccess.isAdmin=true;assert.equal(methods.canOpenAuditReport.call(regional),false);regional.roleAccess.loaded=true;assert.equal(methods.canOpenAuditReport.call(regional),true);
});
test('the actual template hides raw rows and dialogs and offers the report action only when authorized',()=>{
 const report=html.match(/<p v-if="([^"]+)" class="table-message"><button id="openScopedAuditReport"[^>]+@click="([^"]+)"/);
 assert.ok(report,'Missing guarded report action');
 const table=html.match(/<div v-else-if="([^"]+)" class="table-scroll">/),dialog=html.match(/<div v-if="([^"]+)" class="modal-backdrop" @click.self="closeRecordDialog">/);assert.ok(table&&dialog);
 const regional=state();assert.equal(condition(report[1],regional),false);assert.equal(condition(table[1],regional),false);assert.equal(condition(dialog[1],regional),false);
 const admin=state();admin.roleAccess.isAdmin=true;assert.equal(condition(report[1],admin),true);assert.equal(condition(table[1],admin),false);assert.equal(condition(dialog[1],admin),false);
 vm.runInNewContext(report[2],{navigateChild:methods.navigateChild.bind(admin)});assert.deepEqual(admin.calls,[['closeWorkspace'],['workspace','/audit-change-report.html']]);
 assert.ok(html.includes('/app.js?v=20261103-audit-raw-restricted'));
});
test('raw navigation preserves A06 section visibility, shows the restriction and never redirects Regional to the report',async()=>{
 for(const slug of targets){const c=catalog(slug),s=state(c);const before=JSON.stringify(s.roleAccess.grants);methods.navigateChild.call(s,'Auditoría',c.title);await Promise.resolve();
  assert.equal(s.currentModule,'Auditoría');assert.equal(s.currentSection,c.title);assert.deepEqual(s.calls,[['closeWorkspace']]);assert.equal(s.rows.length,0);assert.match(s.tableNotice,/restringida/);assert.equal(JSON.stringify(s.roleAccess.grants),before);
  const denied=state(c);denied.roleAccess.grants['audit:'+slug]={canView:false};methods.navigateChild.call(denied,'Auditoría',c.title);assert.deepEqual(denied.calls,[['closeWorkspace']]);assert.match(denied.tableError,/no tiene acceso/);
 }
});
test('report navigation still enforces its own permission without automatic grants',()=>{
 const regional=state();methods.navigateChild.call(regional,'Auditoría','Transacciones modificadas y eliminadas');assert.deepEqual(regional.calls,[['closeWorkspace']]);assert.match(regional.tableError,/no tiene acceso/);
 for(const isAdmin of [false,true]){const s=state();s.roleAccess.isAdmin=isAdmin;s.roleAccess.grants['audit:change-report']={canView:true};methods.navigateChild.call(s,'Auditoría','Transacciones modificadas y eliminadas');assert.deepEqual(s.calls,[['closeWorkspace'],['workspace','/audit-change-report.html']]);}
});
test('unrelated catalog actions and normal record authorship retain their existing behavior',()=>{
 const s=state({slug:'synthetic',table:'synthetic_business',primaryKey:'id'});for(const action of ['view','create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),true);
 methods.openRecordAudit.call(s,{id:17,name:'Synthetic business'});assert.equal(s.recordDialog.mode,'audit');assert.equal(s.recordDialog.id,17);assert.equal(Object.keys(s.recordDialog.values).length,0);assert.equal(s.recordDialog.label,'Synthetic record');assert.deepEqual(s.calls,[]);
});
