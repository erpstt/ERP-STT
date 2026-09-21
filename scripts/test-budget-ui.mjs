import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const header={id:1,anio:2026,nombre_version:'Prueba',estado:'BORRADOR',tipo_control:'HARD_LOCK',revision:1};
 const accounts=[{id:10,number:'5101',name:'Servicios',category:'Costo'},{id:11,number:'4101',name:'Ventas',category:'Ingreso'},{id:12,number:'6101',name:'Oficina',category:'Gasto'}];
 let lines=[],saved,prior=[],deleted=false;const actions=[];
 await page.route('http://budget.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.startsWith('/api/')){
   let data={};const action=path.split('/').pop();
   if(action==='options')data={userId:1,subsidiary:{name:'Empresa de pruebas',currency:'JMD'},permissions:{manage:true,approve:true,transfer:true,override:true},headers:[...(deleted?[]:[header]),...prior],accounts,centers:[{id:20,name:'Proyecto A'}]};
   else if(action==='execution-report')data={header,rows:lines.map((l,i)=>({line_id:i+1,account_id:l.accountId,center_id:l.centerId,month:l.month+'-01',initial:l.amount,modifications:0,committed:0,executed:0,available:l.amount,account:'5101',name:'Servicios',center:'Proyecto A',percentage:0,status:'NORMAL'})),transfers:[],overrides:[],events:[]};
   else if(action==='action'){const p=route.request().postDataJSON();actions.push(p);if(p.action==='delete'){deleted=true;lines=[];data={deleted:true};}else{header.estado=p.action==='approve'?'APROBADO':'CERRADO';data=header;}}
   else if(action==='headers'){const p=route.request().postDataJSON();if(p.categories)header.categorias=p.categories;header.nombre_version=p.name;header.anio=p.year;header.tipo_control=p.control;if(!p.id){lines=[];deleted=false;header.estado='BORRADOR';}header.revision++;for(const a of accounts.filter(a=>p.categories?.includes(a.category))){if(!lines.some(l=>String(l.accountId)===String(a.id)))for(let i=1;i<=12;i++)lines.push({accountId:a.id,centerId:'',month:`${p.year}-${String(i).padStart(2,'0')}`,amount:0});}data=header;}
   else if(action==='lines'){saved=route.request().postDataJSON();lines=saved.lines;header.revision++;data=header;}
   return route.fulfill({json:data});
  }
  const file=path==='/'?'budget.html':path.slice(1);
  assert.ok(['budget.html','budget.css','budget.js','budget-feedback.js','budget-xlsx.js'].includes(file));
  return route.fulfill({body:await readFile(new URL('../public/'+file,import.meta.url)),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});
 });
 await page.goto('http://budget.test/');
 await page.locator('[data-tab=builder]').click();await page.locator('#add').click();
 await page.locator('[data-field=accountId]').selectOption('10');assert.equal(await page.locator('[data-field=centerId]').count(),0);
 await page.locator('[data-annual]').fill('100');await page.locator('[data-annual]').press('Tab');
 const months=await page.locator('[data-month]').evaluateAll(es=>es.map(e=>Number(e.value)));
 assert.equal(months.length,12);assert.ok(Math.abs(months.reduce((a,b)=>a+b,0)-100)<1e-8);
 await page.locator('#save').click();await page.locator('#message').filter({hasText:'Matriz guardada'}).waitFor();
 assert.equal(saved.lines.length,12);assert.equal(saved.lines[0].centerId,undefined);
 await page.locator('[data-tab=dashboard]').click();assert.equal(await page.locator('#execution tr').count(),12);
 await page.locator('#month').selectOption('2026-01');assert.equal(await page.locator('#execution tr').count(),1);
 await page.locator('[data-tab=builder]').click();
 const downloadPromise=page.waitForEvent('download');await page.locator('#templateExcel').click();const download=await downloadPromise;assert.ok(download.suggestedFilename().endsWith('.xlsx'));
 const {readSheet}=await import('read-excel-file/node');const sheet=await readSheet(await download.path(),1);assert.equal(sheet.length,13);assert.equal(sheet[1][0],'5101');assert.equal(sheet[1][3],'2026-01');assert.equal(sheet[0].length,5);
 await page.locator('#new').click();assert.equal(await page.locator('#newCategories input').count(),3);await page.locator('#newCategories input[value=Ingreso]').check();await page.locator('#newCategories input[value=Costo]').uncheck();await page.locator('#newCategories input[value=Gasto]').uncheck();await page.locator('#name').fill('Ingresos automáticos');await page.locator('#headerForm button.primary').click();await page.locator('#headerDialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('[data-field=accountId]')?.value==='11');assert.deepEqual(header.categorias,['Ingreso']);assert.equal(await page.locator('#matrix tr').count(),1);await page.locator('#categories input[value=Costo]').check();await page.locator('#loadAccounts').click();await page.waitForFunction(()=>document.querySelectorAll('#matrix tr').length===2);assert.equal(lines.filter(l=>String(l.accountId)==='11').length,12);
 await page.locator('#approve').click();await page.locator('#budgetConfirm').waitFor({state:'visible'});assert.match(await page.locator('#budgetConfirmImpact').innerText(),/No hay otra versi/);await page.locator('#budgetConfirmCancel').click();assert.equal(actions.length,0);
 prior=[{...header,id:99,estado:'APROBADO',nombre_version:'Presupuesto original'}];await page.locator('#refresh').click();await page.waitForTimeout(100);await page.locator('#approve').click();assert.match(await page.locator('#budgetConfirmImpact').innerText(),/Presupuesto original/);assert.match(await page.locator('#budgetConfirmImpact').innerText(),/presupuesto general/);await page.locator('#budgetConfirmAccept').click();await page.locator('#budgetConfirm').waitFor({state:'hidden'});assert.deepEqual(actions,[{id:1,action:'approve'}]);await page.locator('#close').click();assert.match(await page.locator('#budgetConfirmImpact').innerText(),/no desactiva su control/);await page.locator('#budgetConfirmCancel').click();
 assert.equal(await page.locator('#deleteBudget').isVisible(),false);prior=[];
 await page.locator('#new').click();await page.locator('#name').fill('Borrador eliminable');await page.locator('#headerForm button.primary').click();await page.locator('#headerDialog').waitFor({state:'hidden'});
 await page.locator('#editBudget').click();assert.equal(await page.locator('#name').inputValue(),'Borrador eliminable');assert.equal(await page.locator('#year').isDisabled(),true);await page.locator('#name').fill('Borrador editado');await page.locator('#control').selectOption('WARNING');await page.locator('#headerForm button.primary').click();await page.locator('#headerDialog').waitFor({state:'hidden'});assert.equal(header.nombre_version,'Borrador editado');assert.equal(header.tipo_control,'WARNING');assert.ok(lines.length);
 await page.locator('#deleteBudget').click();assert.match(await page.locator('#deleteBudgetSummary').innerText(),/Borrador editado/);await page.locator('#cancelDeleteBudget').click();assert.equal(deleted,false);await page.locator('#deleteBudget').click();await page.locator('#confirmDeleteBudget').click();await page.locator('#empty').waitFor({state:'visible'});assert.equal(deleted,true);assert.equal(await page.locator('#state').innerText(),'');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({matrix:true,annualDistribution:true,save:true,dashboard:true,monthFilter:true,mobile:true,newCategorySelection:true,automaticRows:true,excelDownload:true,confirmationCancel:true,confirmationReplacement:true,confirmationApproval:true,editDraft:true,deleteCancel:true,deleteDraft:true,emptyAfterDelete:true}));
}finally{await browser.close();}
