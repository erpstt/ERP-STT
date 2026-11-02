import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';

test('asignar empresas usa edición y la revisión del usuario seleccionado, sin habilitar destinos protegidos', {timeout:120000}, async t=>{
 const root=resolve('public');
 const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+new URL(req.url,'http://fixture').pathname);if(!file.startsWith(root+sep))throw Error('Invalid path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1500,height:1050}}),writes=[],errors=[],unexpected=[];
 const targetUrl=process.env.USER_COMPANY_ASSIGNMENT_UI_URL||`http://127.0.0.1:${server.address().port}/index.html`,origin=new URL(targetUrl).origin;
 const subsidiaries=[{subsidiary_id:1,name:'Synthetic holding',is_active:true},{subsidiary_id:2,name:'Synthetic branch',is_active:true},{subsidiary_id:3,name:'Synthetic third company',is_active:true}];
 const rows=[
  {user_id:2,email:'target@example.invalid',first_name:'Synthetic',last_name:'Target',display_name:'Synthetic Target',is_active:true,subsidiary_count:1,subsidiary_ids:[1],_revision:'TARGET_REV_1',_actions:{canEdit:true,canDelete:false}},
  {user_id:3,email:'other@example.invalid',first_name:'Synthetic',last_name:'Other',display_name:'Synthetic Other',is_active:true,subsidiary_count:1,subsidiary_ids:[3],_revision:'OTHER_REV_1',_actions:{canEdit:true,canDelete:false}},
  {user_id:4,email:'admin@example.invalid',first_name:'Synthetic',last_name:'Administrator',display_name:'Synthetic Administrator',is_active:true,subsidiary_count:2,subsidiary_ids:[1,2],_revision:'OWN_REV',_actions:{canEdit:false,canDelete:false}},
 ];
 let editable=true;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const method=request.method(),payload=method==='GET'?null:request.postDataJSON();let json=[];
  if(url.pathname==='/api/security/master/options')json={canView:true,canCreate:false,canEdit:editable,canDelete:false,references:{'security/users':rows,'organization/subsidiaries':subsidiaries}};
  else if(url.pathname==='/api/security/user-subsidiaries/options')json=subsidiaries;
  else if(url.pathname==='/api/security/user-subsidiaries'&&method==='GET')json=rows;
  else if(/^\/api\/security\/user-subsidiaries(?:\/\d+)?$/.test(url.pathname)&&['POST','PATCH'].includes(method)){
   writes.push({method,path:url.pathname,payload,authorization:request.headers().authorization,device:request.headers()['x-device-token']});
   const row=rows.find(item=>item.user_id===Number(payload.user_id));
   if(!editable||row?._actions.canEdit!==true)return route.fulfill({status:403,json:{error:{message:'Synthetic protected target'}}});
   if(payload._revision!==row._revision)return route.fulfill({status:409,json:{error:{message:'Synthetic stale revision'}}});
   row.subsidiary_ids=[...payload.subsidiary_ids];row.subsidiary_count=row.subsidiary_ids.length;row._revision=`TARGET_REV_${writes.length+1}`;json=row;
  }else if(url.pathname==='/api/security/turnstile/config'||url.pathname==='/api/auth/turnstile-config')json={enabled:false};
  else if(url.pathname==='/api/health'||url.pathname==='/api/audit/record-actor')json={};
  else if(!['GET','HEAD'].includes(method)){unexpected.push({method,path:url.pathname});return route.fulfill({status:403,json:{error:{message:'Unexpected synthetic write'}}});}
  await route.fulfill({json});
 });
 await page.goto(targetUrl);
 await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
 await page.evaluate(async()=>{
  localStorage.setItem('nexo_token','synthetic-company-assignment');localStorage.setItem('nexo_device_token','synthetic-company-device');
  const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
  v.sessionReady=true;v.authenticated=true;v.selectingRole=false;v.selectingCompany=false;v.activeCompany={subsidiaryId:1,name:'Synthetic holding'};v.activeRole={roleId:5,name:'Administrador'};v.roleAccess={loaded:true,isAdmin:true,grants:{},modules:[]};v.closeWorkspace();v.currentModule='Seguridad';v.currentSection='Empresas por usuario';await v.loadCatalog();
 });
 const state=()=>page.evaluate(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return{open:v.recordDialog.open,id:v.recordDialog.id,values:v.recordDialog.values,error:v.dialogError,tableError:v.tableError};});
 const dialog=page.getByRole('dialog',{name:'Asignar empresas a un usuario',exact:true});
 await page.getByRole('button',{name:/Asignar empresas$/}).click();
 await dialog.locator('[data-field-key="user_id"] select').selectOption('2');
 assert.equal((await state()).id,null);assert.equal((await state()).values._revision,'TARGET_REV_1');assert.deepEqual((await state()).values.subsidiary_ids,[1]);
 await dialog.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="3"]').check();
 assert.deepEqual(rows[0].subsidiary_ids,[1],'La selección local no debe mutar las asignaciones existentes antes de guardar.');
 await dialog.getByRole('button',{name:'Guardar asignación',exact:true}).click();
 await page.waitForFunction(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return!v.recordDialog.open&&!v.tableLoading;});
 assert.equal(writes.length,1);assert.deepEqual(writes[0],{method:'POST',path:'/api/security/user-subsidiaries',payload:{user_id:2,subsidiary_ids:[1,3],_revision:'TARGET_REV_1'},authorization:'Bearer synthetic-company-assignment',device:'synthetic-company-device'});
 assert.deepEqual(rows[2].subsidiary_ids,[1,2]);

 // A different selected user must replace both the selection and concurrency token.
 await page.getByRole('button',{name:/Asignar empresas$/}).click();
 await dialog.locator('[data-field-key="user_id"] select').selectOption('3');
 assert.deepEqual((await state()).values.subsidiary_ids,[3]);assert.equal((await state()).values._revision,'OTHER_REV_1');
 await dialog.locator('[data-field-key="user_id"] select').selectOption('2');
 assert.deepEqual((await state()).values.subsidiary_ids,[1,3]);assert.equal((await state()).values._revision,'TARGET_REV_2');
 await dialog.locator('[data-field-key="user_id"] select').selectOption('');
 assert.deepEqual((await state()).values.subsidiary_ids,[]);assert.equal((await state()).values._revision??null,null);
 await dialog.locator('[data-field-key="user_id"] select').selectOption('3');
 await dialog.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="2"]').check();
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
 assert.equal(writes.length,1);assert.deepEqual(rows[1].subsidiary_ids,[3]);

 // Existing edit keeps the selected user fixed and uses the same edit action.
 await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.openRecordForm(v.rows.find(row=>row.user_id===2));});
 const editDialog=page.getByRole('dialog',{name:'Editar empresas autorizadas',exact:true});
 assert.equal(await editDialog.locator('[data-field-key="user_id"] select').isDisabled(),true);
 await editDialog.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="3"]').uncheck();
 await editDialog.locator('[data-field-key="subsidiary_ids"] input[type="checkbox"][value="2"]').check();
 await editDialog.getByRole('button',{name:'Guardar asignación',exact:true}).click();
 await page.waitForFunction(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return!v.recordDialog.open&&!v.tableLoading;});
 assert.equal(writes.length,2);assert.deepEqual(writes[1].payload,{user_id:2,subsidiary_ids:[1,2],_revision:'TARGET_REV_2'});assert.equal(writes[1].method,'PATCH');assert.equal(writes[1].path,'/api/security/user-subsidiaries/2');

 for(const userId of [4,999]){
  const blocked=await page.evaluate(async userId=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.openRecordForm();v.recordDialog.values.user_id=userId;v.handleReferenceFieldChange(v.activeCatalog.fields.find(field=>field.key==='user_id'));v.recordDialog.values.subsidiary_ids=[1];await v.submitRecord();const result={error:v.dialogError,tableError:v.tableError};v.recordDialog.open=false;return result;},userId);
  assert.match(blocked.error+' '+blocked.tableError,/permiso|no autorizado/i);assert.equal(writes.length,2);
 }
 const blockedEdit=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.recordDialog.open=false;await v.openRecordForm(v.rows.find(row=>row.user_id===4));return{open:v.recordDialog.open,error:v.tableError};});
 assert.equal(blockedEdit.open,false);assert.match(blockedEdit.error,/no autorizado/i);

 editable=false;
 const serverDenied=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.loadCatalog();await v.openRecordForm();v.recordDialog.values={user_id:2,subsidiary_ids:[1],_revision:'TARGET_REV_3'};await v.submitRecord();const result={error:v.dialogError,tableError:v.tableError,clientEdit:v.canCurrentAction('edit'),serverEdit:v.activeCatalog.allowEdit};v.recordDialog.open=false;return result;});
 assert.equal(serverDenied.clientEdit,true);assert.equal(serverDenied.serverEdit,false);assert.match(serverDenied.error+' '+serverDenied.tableError,/permiso|no autorizado/i);assert.equal(writes.length,2);
 assert.equal(await page.getByRole('button',{name:/Asignar empresas$/}).count(),0,'La autorización del servidor debe prevalecer incluso con el contexto administrador en el cliente.');
 const denied=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:1,name:'Contador de Subsidiaria'};v.roleAccess={loaded:true,isAdmin:false,grants:{'security:user-subsidiaries':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[]};await v.loadCatalog();await v.openRecordForm();v.recordDialog.values={user_id:2,subsidiary_ids:[1],_revision:'TARGET_REV_3'};await v.submitRecord();return{error:v.dialogError,tableError:v.tableError,allowCreate:v.activeCatalog.allowCreate,allowEdit:v.activeCatalog.allowEdit};});
 assert.equal(denied.allowCreate,false);assert.equal(denied.allowEdit,false);assert.match(denied.error+' '+denied.tableError,/permiso|no autorizado/i);assert.equal(writes.length,2);
 assert.equal(await page.getByRole('button',{name:/Asignar empresas$/}).count(),0);
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 await mkdir('.local-tools',{recursive:true});await page.screenshot({path:'.local-tools/user-company-assignment-save.png',fullPage:true});
});
