import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium} from '@playwright/test';
import {vueArtifacts} from './build-vue-templates.mjs';

test('Otros Nombres respeta permisos, filial activa, campos bancarios y numeración del servidor', {timeout:120000}, async t => {
  const root=resolve('public'),compiled=await vueArtifacts();
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname,file=resolve(root,'.'+pathname);
      if(!file.startsWith(root+sep))throw Error('Invalid path');
      const type={'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'};
      res.setHeader('Content-Type',type[extname(file)]||'application/octet-stream');
      res.end(compiled.get('public'+pathname)??await readFile(file));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1560,height:1200}});
  const targetUrl=process.env.OTHER_NAMES_UI_URL||`http://127.0.0.1:${server.address().port}/index.html`,origin=new URL(targetUrl).origin,calls=[];
  let write=false,row={other_name_id:41,other_name_number:'ON-000001',name:'Synthetic third party',identification:'SYN-1',subsidiary_id:7,email:'third@example.invalid',phone:'2222-2222',payment_beneficiary_name:'Synthetic beneficiary',payment_bank_id:3,payment_iban:'CR05015202001026284066',payment_account_number:'000012345',comments:'Synthetic comments',is_active:true,_revision:'INITIAL'};
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin||url.pathname.endsWith('.mp4'))return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const method=request.method(),payload=request.postDataJSON();
    calls.push({path:url.pathname,method,payload});
    let json=[];
    if(url.pathname==='/api/security/turnstile/config')json={enabled:false};
    else if(url.pathname==='/api/entities/master/options'){
      assert.equal(url.searchParams.get('catalog'),'other-names');
      json={canView:true,canCreate:write,canEdit:write,canDelete:false,references:{
        'organization/subsidiaries':[{subsidiary_id:7,name:'Synthetic subsidiary'}],
        'banking/banks':[{bank_id:3,bank_name:'Synthetic beneficiary bank'}],
      }};
    }else if(url.pathname.startsWith('/api/entities/other-names')){
      if(method==='GET')json=[{...row,_actions:{canEdit:write,canDelete:false}}];
      else{row={...row,...payload,_revision:method==='POST'?'CREATED':'EDITED'};json=row;}
    }
    await route.fulfill({json});
  });
  await page.goto(targetUrl);
  await page.waitForFunction(()=>document.getElementById('app')?.__vue_app__?._container?._vnode?.component?.proxy?.sessionReady);
  const navigation=await page.evaluate(async()=>{
    const vm=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    vm.authenticated=true;vm.selectingCompany=false;vm.activeCompany={subsidiaryId:7,name:'Synthetic subsidiary'};
    vm.activeRole={roleId:1,name:'Synthetic role'};
    vm.roleAccess={loaded:true,isAdmin:false,legacy:false,grants:{},modules:[{name:'Entidades',resources:[{key:'entities:other-names',optionName:'Otros Nombres'}]}]};
    const menuExists=vm.modules.find(module=>module.name==='Entidades').children.includes('Otros Nombres');
    const deniedWithoutGrant=vm.hasSectionAccess('Entidades','Otros Nombres')===false;
    vm.roleAccess.grants={'entities:other-names':{canView:true,canCreate:false,canEdit:false,canDelete:false}};
    vm.navigateChild('Entidades','Otros Nombres');
    return {menuExists,deniedWithoutGrant};
  });
  assert.deepEqual(navigation,{menuExists:true,deniedWithoutGrant:true});
  await page.waitForFunction(()=>{const vm=document.getElementById('app').__vue_app__._container._vnode.component.proxy;return vm.activeCatalog?.slug==='other-names'&&!vm.tableLoading&&vm.rows.length===1;});
  for(const css of ['.new-record:not(.catalog-export-button)','.icon-action.edit','.icon-action.delete'])assert.equal(await page.locator(css+':visible').count(),0);
  assert.match(await page.locator('.records-view').textContent(),/ON-000001/);

  write=true;
  await page.evaluate(async()=>{
    const vm=document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    vm.roleAccess.grants['entities:other-names']={canView:true,canCreate:true,canEdit:true,canDelete:false};
    await vm.loadCatalog();await vm.openRecordForm();
  });
  const field=key=>page.locator(`.modal [data-field-key="${key}"]`);
  assert.equal(await field('other_name_number').locator('input').getAttribute('readonly'),'');
  assert.equal(await field('other_name_number').locator('input').getAttribute('placeholder'),'Se asignará automáticamente');
  assert.equal(await field('identification').locator('input').getAttribute('required'),'');
  assert.equal(await field('subsidiary_id').locator('select').isDisabled(),true);
  assert.equal(await field('subsidiary_id').locator('select').inputValue(),'7');
  assert.deepEqual(await field('subsidiary_id').locator('option').allTextContents(),['Selecciona una opción','Synthetic subsidiary']);
  assert.equal(await field('is_active').locator('input').isChecked(),true);
  assert.equal(await field('comments').locator('textarea').count(),1);
  assert.equal(await page.locator('.modal .withholding-rules-editor').count(),0);
  await field('name').locator('input').fill('Synthetic new third party');
  await field('identification').locator('input').fill('SYN-2');
  await field('email').locator('input').fill('new@example.invalid');
  await field('phone').locator('input').fill('8888-8888');
  await field('payment_beneficiary_name').locator('input').fill('Synthetic beneficiary');
  await field('payment_bank_id').locator('select').selectOption('3');
  await field('payment_iban').locator('input').fill('CR05015202001026284066');
  await field('payment_account_number').locator('input').fill('000012345');
  await field('comments').locator('textarea').fill('First line\nSecond line <script>unsafe()</script>');
  if(process.env.OTHER_NAMES_UI_SCREENSHOT)await page.screenshot({path:process.env.OTHER_NAMES_UI_SCREENSHOT,fullPage:true});
  await page.evaluate(()=>{const vm=document.getElementById('app').__vue_app__._container._vnode.component.proxy;vm.recordDialog.values.other_name_number='FORGED';vm.recordDialog.values.subsidiary_id=999;});
  await page.locator('.modal .button-primary').click();
  await page.waitForFunction(()=>!document.getElementById('app').__vue_app__._container._vnode.component.proxy.recordDialog.open);
  const created=calls.find(call=>call.path==='/api/entities/other-names'&&call.method==='POST');
  assert.ok(created);
  assert.equal(created.payload.other_name_number,undefined);
  assert.equal(created.payload.subsidiary_id,undefined);
  assert.equal(created.payload.name,'Synthetic new third party');
  assert.equal(created.payload.identification,'SYN-2');
  assert.equal(created.payload.payment_bank_id,3);
  assert.equal(created.payload.payment_account_number,'000012345');
  assert.equal(created.payload.payment_iban,'CR05015202001026284066');
  assert.equal(created.payload.comments,'First line\nSecond line <script>unsafe()</script>');
  assert.equal(await page.locator('script').evaluateAll(nodes=>nodes.some(node=>node.textContent==='unsafe()')),false);
  await page.locator('.icon-action.edit:visible').click();
  assert.equal(await field('subsidiary_id').locator('select').inputValue(),'7');
  assert.equal(await field('other_name_number').locator('input').inputValue(),'ON-000001');
  assert.equal(await field('comments').locator('textarea').inputValue(),created.payload.comments);
  await field('comments').locator('textarea').fill('Updated comments');
  await page.locator('.modal .button-primary').click();
  await page.waitForFunction(()=>!document.getElementById('app').__vue_app__._container._vnode.component.proxy.recordDialog.open);
  const edited=calls.find(call=>call.path==='/api/entities/other-names/41'&&call.method==='PATCH');
  assert.equal(edited.payload._revision,'CREATED');
  assert.equal(edited.payload.comments,'Updated comments');
  assert.equal(edited.payload.other_name_number,undefined);
  assert.equal(edited.payload.subsidiary_id,undefined);
  assert.ok(!calls.some(call=>call.path==='/api/entities/customers'||call.path==='/api/entities/suppliers'));
  assert.equal(await page.locator('.icon-action.delete:visible').count(),0);
});

test('Otros Nombres conserva traducciones equivalentes para español, inglés y portugués',async()=>{
  const dictionaries=await Promise.all(['es','en','pt'].map(async locale=>JSON.parse(await readFile(new URL(`../public/locales/${locale}.json`,import.meta.url),'utf8'))));
  const keys=Object.keys(dictionaries[0].entities).filter(key=>key.startsWith('otherName'));
  for(const dictionary of dictionaries)for(const key of keys)assert.ok(dictionary.entities[key]);
  assert.equal(dictionaries[0].entities.otherNames,'Otros Nombres');
  assert.equal(dictionaries[1].entities.otherNames,'Other Names');
  assert.equal(dictionaries[2].entities.otherNames,'Outros Nomes');
});
