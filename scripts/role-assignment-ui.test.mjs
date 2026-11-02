import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';

test('administrador crea una asignación propia adicional sin habilitar cambios o eliminación propios', {timeout:90000}, async t=>{
 const root=resolve('public');
 const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+new URL(req.url,'http://fixture').pathname);if(!file.startsWith(root+sep))throw Error('Invalid path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,writes=[],errors=[];
 const targetUrl=process.env.ROLE_ASSIGNMENT_UI_URL||origin+'/index.html',allowedOrigin=new URL(targetUrl).origin;
 const ownUser={user_id:4,first_name:'Synthetic',last_name:'Administrator',email:'synthetic-admin@example.invalid'},ownActions={canEdit:false,canDelete:false};
 const adminRole={role_id:5,role_name:'Administrador'},extraRole={role_id:1,role_name:'Contador de Subsidiaria'};
 const original={id:9,user_id:4,role_id:5,_revision:'ORIGINAL',_actions:ownActions},rows=[original];
 let central=true;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==allowedOrigin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const payload=request.method()==='GET'?null:request.postDataJSON();let json=[];
  if(url.pathname==='/api/security/master/options')json={canView:true,canCreate:central,canEdit:central,canDelete:central,references:{'security/users':[ownUser],'security/roles':[adminRole,extraRole],'core/timezones':[]}};
  else if(url.pathname==='/api/security/user-roles'&&request.method()==='POST'){
   assert.equal(request.headers().authorization,'Bearer synthetic-role-assignment');assert.equal(request.headers()['x-device-token'],'synthetic-role-device');
   assert.equal(central,true);assert.deepEqual(payload,{user_id:4,role_id:1});writes.push({method:request.method(),path:url.pathname,payload});
   const created={id:10,...payload,_revision:'ADDITIONAL',_actions:ownActions};rows.push(created);json=created;
  }else if(url.pathname==='/api/security/user-roles')json=rows;
  else if(url.pathname==='/api/security/turnstile/config'||url.pathname==='/api/auth/turnstile-config')json={enabled:false};
  else if(url.pathname==='/api/audit/record-actor'||url.pathname==='/api/health')json={};
  else if(!['GET','HEAD'].includes(request.method()))throw Error('Unexpected write '+request.method()+' '+url.pathname);
  await route.fulfill({json});
 });
 await page.goto(targetUrl);
 await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
 await page.evaluate(async()=>{
  localStorage.setItem('nexo_token','synthetic-role-assignment');localStorage.setItem('nexo_device_token','synthetic-role-device');
  const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
  v.sessionReady=true;v.authenticated=true;v.selectingRole=false;v.selectingCompany=false;v.activeCompany={subsidiaryId:1,name:'Synthetic'};v.activeRole={roleId:5,name:'Administrador'};v.roleAccess={loaded:true,isAdmin:true,grants:{},modules:[]};v.closeWorkspace();v.currentModule='Seguridad';v.currentSection='Roles por usuario';await v.loadCatalog();await v.openRecordForm();
 });
 const dialog=page.getByRole('dialog',{name:'Crear asignación'});await dialog.waitFor();
 await dialog.locator('[data-field-key="user_id"] select').selectOption('4');
 await dialog.locator('[data-field-key="role_id"] select').selectOption('1');
 await dialog.getByRole('button',{name:'Crear registro',exact:true}).click();
 await page.waitForFunction(()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return!v.recordDialog.open&&v.rows.length===2;});
 assert.equal(writes.length,1);assert.deepEqual(rows[0],original);
 assert.equal(await page.locator('.icon-action.edit:visible').count(),0);assert.equal(await page.locator('.icon-action.delete:visible').count(),0);
 const blockedOwnEdit=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;await v.openRecordForm(v.rows[0]);return{open:v.recordDialog.open,error:v.tableError};});
 assert.equal(blockedOwnEdit.open,false);assert.match(blockedOwnEdit.error,/no autorizado/);
 central=false;
 const denied=await page.evaluate(async()=>{const v=document.getElementById('app').__vue_app__._container._vnode.component.proxy;v.activeRole={roleId:1,name:'Contador de Subsidiaria'};v.roleAccess={loaded:true,isAdmin:false,grants:{'security:user-roles':{canView:true,canCreate:false,canEdit:false,canDelete:false}},modules:[]};await v.loadCatalog();await v.openRecordForm();v.recordDialog.values={user_id:4,role_id:1};await v.submitRecord();return{canCreate:v.activeCatalog.allowCreate,error:v.dialogError};});
 assert.equal(denied.canCreate,false);assert.match(denied.error,/permiso explícito/);assert.equal(writes.length,1);assert.deepEqual(errors,[]);
});
