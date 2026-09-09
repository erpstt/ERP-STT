import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadSubsidiaryApprovers} from '../public/subsidiary-approvers.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('uses the dedicated directory when available',async()=>{
  const options=[{approver_id:'user:2',name:'User',is_active:true}];
  assert.equal(await loadSubsidiaryApprovers(async path=>{assert.equal(path,'/api/organization/approver-options');return options;}),options);
});
test('the subsidiaries list loads with an older server and both approver fields resolve',async()=>{
  let component;
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  vm.runInNewContext(source,{loadSubsidiaryApprovers,document:{createElement:()=>({}),head:{append(){}}},createApp:options=>{component=options;return{mount(){}};}});
  const reference='organization/approver-options',rows=[{subsidiary_id:1,name:'Subsidiaria',project_approver:'employee:7',administrative_approver:'user:9'}];
  const app={...component.methods,activeCatalog:{slug:'subsidiaries',apiRoot:'organization',fields:[{reference},{reference}]},referenceOptions:{},rows:[],tableError:'',api:async path=>{
    if(path==='/api/organization/subsidiaries')return rows;
    if(path==='/api/organization/approver-options')throw Error('El catálogo de Organización no existe.');
    if(path==='/api/entities/employees')return[{employee_id:7,first_name:'Ana',last_name:'Prueba',employee_number:'EMP-7',is_active:true}];
    if(path==='/api/security/users')return[{user_id:9,first_name:'Luis',last_name:'Prueba',email:'test@example.invalid',is_active:true,password_hash:'must-not-copy'}];
    throw Error(path);
  }};
  await app.loadCatalog();
  assert.equal(app.tableError,'');assert.equal(app.tableLoading,false);assert.equal(app.rows,rows);
  assert.match(app.displayValue({reference},rows[0].project_approver),/Ana Prueba/);
  assert.match(app.displayValue({reference},rows[0].administrative_approver),/Luis Prueba/);
  assert.ok(app.referenceOptions[reference].every(row=>!('password_hash' in row)));
});
test('permission and connection errors are not hidden by the compatibility path',async()=>{
  for(const message of ['Acceso denegado','Failed to fetch']) {
    let calls=0;
    await assert.rejects(loadSubsidiaryApprovers(async()=>{calls++;throw Error(message);}),{message});
    assert.equal(calls,1);
  }
});
