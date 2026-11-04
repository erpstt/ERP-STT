import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

// Evaluate isolated real UI methods with synthetic state. Never mount Vue or call a server.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function method(name){
 const start=source.search(new RegExp('^    (?:async )?'+name+'\\s*\\(','m'));
 assert.ok(start>=0,'Missing UI method '+name);
 const next=/\n    (?:async )?[A-Za-z_$][\w$]*\s*\(/g;next.lastIndex=start+4;
 const end=next.exec(source);assert.ok(end,'Missing method boundary for '+name);
 const declaration=source.slice(start,end.index).trim().replace(/,\s*$/,'');
 return vm.runInNewContext('({'+declaration+'})',{
  document:{querySelectorAll:()=>[]},
  alphabeticalCollator:new Intl.Collator('es',{sensitivity:'base',numeric:true})
 })[name];
}
function catalog(slug){
 const line=source.split('\n').find(line=>line.includes("slug:'"+slug+"'"));
 assert.ok(line,'Missing catalog '+slug);
 return JSON.parse(JSON.stringify(vm.runInNewContext('('+line.trim().replace(/,$/,'')+')',{erpModuleNames:[]})));
}
const methods=Object.fromEntries(['canCurrentAction','openRecordForm','submitRecord','loadReferenceOptions','filteredReferenceOptions'].map(name=>[name,method(name)]));
function state(c,id=null){
 const calls=[],s={activeCatalog:c,activeCompany:{subsidiaryId:7},activeCapability:{canView:true,canCreate:true,canEdit:true,canDelete:true},roleAccess:{loaded:true,isAdmin:false},referenceOptions:{},rows:[],calls,
 recordDialog:{open:false,mode:'form',id,values:{}},
 api:async(path,options)=>{calls.push({path,options});return path.startsWith('/api/ai/')&&options?{}:[];},
 $nextTick:async()=>{},recordLabel:()=>'',autorentPercentageDisplay:()=>'',enhanceLogoInput:()=>{},catalogPath:()=>'/api/ai/'+c.slug,loadCatalog:async()=>{},
 referenceChoiceLabel:(_f,o)=>String(o.name??o.subsidiary_id),
 ...Object.fromEntries(['validateEntityForm','validateSubsidiaryForm','validateChartAccountSubsidiaries','validateUserSubsidiaries','validateChartAccountReferences','validateAutorentConfiguration','normalizeBankStatementPayload','normalizeEntityBankPayload'].map(name=>[name,()=>{}]))};
 s.loadReferenceOptions=methods.loadReferenceOptions.bind(s);return s;
}

test('conversation owner is supplied by the server and never loads the users catalog',async()=>{
 const c=catalog('ai-conversations'),owner=c.fields.find(f=>f.key==='user_id');
 assert.equal(owner.readOnly,true);assert.equal(owner.hiddenForm,true);assert.equal(owner.reference,undefined);
 const s=state(c);await methods.loadReferenceOptions.call(s);
 assert.deepEqual(s.calls.map(c=>c.path),['/api/ai/ai-agents']);
});
test('new and edited conversation forms discard client owner IDs without inferring an identity',async()=>{
 for(const row of [null,{conversation_id:17,user_id:999,agent_id:2,started_at:'2026-11-03T10:00:00Z'}]){
  const s=state(catalog('ai-conversations'));await methods.openRecordForm.call(s,row);
  assert.equal(s.recordDialog.open,true);assert.equal(s.recordDialog.id,row?.conversation_id??null);
  assert.equal(Object.hasOwn(s.recordDialog.values,'user_id'),false);
  assert.ok(s.calls.every(c=>c.path==='/api/ai/ai-agents'));
 }
});
test('conversation POST and PATCH omit a tampered owner even for administrators',async()=>{
 for(const id of [null,17])for(const isAdmin of [false,true]){
  const s=state(catalog('ai-conversations'),id);s.roleAccess.isAdmin=isAdmin;s.recordDialog.values={user_id:999,agent_id:2,started_at:'2026-11-03T10:00'};
  await methods.submitRecord.call(s);assert.equal(s.dialogError,'');assert.equal(s.calls.length,1);
  const call=s.calls[0],body=JSON.parse(call.options.body);
  assert.equal(call.options.method,id?'PATCH':'POST');assert.equal(Object.hasOwn(body,'user_id'),false);
  assert.equal(body.agent_id,2);assert.equal(body.started_at,'2026-11-03T10:00');
 }
});
test('prediction form and company choices follow only the active subsidiary',async()=>{
 const c=catalog('ai-predictions'),field=c.fields.find(f=>f.key==='subsidiary_id');
 assert.equal(field.readOnly,true);assert.equal(field.activeSubsidiaryOnly,true);
 for(const row of [null,{prediction_id:17,subsidiary_id:999}]){
  const s=state(c);await methods.openRecordForm.call(s,row);assert.equal(s.recordDialog.values.subsidiary_id,7);
  s.referenceOptions={'organization/subsidiaries':[{subsidiary_id:7},{subsidiary_id:999}]};
  assert.deepEqual(Array.from(methods.filteredReferenceOptions.call(s,field),o=>o.subsidiary_id),[7]);
  s.activeCompany=null;assert.equal(methods.filteredReferenceOptions.call(s,field).length,0);
 }
});
test('prediction POST and PATCH replace a tampered subsidiary with the active context',async()=>{
 for(const id of [null,17]){
  const s=state(catalog('ai-predictions'),id);s.recordDialog.values={subsidiary_id:999,prediction_type:'SYNTHETIC',target_entity_id:1,value_predicted:10,confidence:75,execution_date:'2026-11-03'};
  await methods.submitRecord.call(s);assert.equal(s.dialogError,'');assert.equal(s.calls.length,1);
  assert.equal(JSON.parse(s.calls[0].options.body).subsidiary_id,7);
 }
});
test('shared agents and prompts retain explicit non-administrative CRUD capabilities',async()=>{
 for(const slug of ['ai-agents','ai-prompts']){
  const s=state(catalog(slug));for(const action of ['view','create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),true);
  s.activeCapability={canView:true,canCreate:false,canEdit:false,canDelete:false};
  for(const action of ['create','edit','delete'])assert.equal(methods.canCurrentAction.call(s,action),false);
  s.activeCapability={canView:true,canCreate:true,canEdit:true,canDelete:true};
  s.recordDialog.values={agent_id:2,agent_name:'SYNTHETIC',system_prompt:'Synthetic instruction',model_version:'synthetic'};
  await methods.submitRecord.call(s);assert.equal(s.dialogError,'');
  assert.equal(JSON.parse(s.calls[0].options.body).system_prompt,'Synthetic instruction');
 }
});
