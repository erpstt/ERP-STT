import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';
import {readFile} from 'node:fs/promises';
import {readSheet} from 'read-excel-file/node';
import {parseBudgetCsv} from '../dist/modules/budget/budget.service.js';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({acceptDownloads:true}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 const header={id:1,anio:2026,nombre_version:'Matriz vacía',estado:'BORRADOR',tipo_control:'WARNING',revision:1,categorias:['Costo','Gasto']};
 await page.route('**/test-budget-container',route=>route.fulfill({contentType:'text/html',body:'<iframe src="/apps/budget/builder" style="width:100%;height:950px"></iframe>'}));
 await page.route('**/api/v1/budget/**',route=>{
  const action=new URL(route.request().url()).pathname.split('/').pop();
  if(!['options','execution-report'].includes(action))writes.push(action);
  return route.fulfill({json:action==='options'?{userId:1,subsidiary:{id:3,name:'Empresa de pruebas',currency:'JMD'},permissions:{manage:true,approve:true,transfer:true,override:true},headers:[header],accounts:[{id:1,number:'410001',name:'Ventas',category:'Ingreso'},{id:2,number:'510001',name:'Costos',category:'Costo'},{id:3,number:'610001',name:'Gastos',category:'Gasto'}],centers:[]}:{header,rows:[],transfers:[],overrides:[],events:[]}});
 });
 await page.goto('http://localhost:3000/test-budget-container');
 const frame=page.frameLocator('iframe');await frame.locator('#template').waitFor({state:'visible'});
 assert.equal(await frame.locator('#matrix tr').count(),0);
 const csvEvent=page.waitForEvent('download');await frame.locator('#template').click();const csv=await csvEvent;
 assert.equal(await csv.failure(),null);assert.equal(csv.suggestedFilename(),'plantilla_presupuesto_2026.csv');
 const csvRows=parseBudgetCsv((await readFile(await csv.path(),'utf8')).replace(/^\uFEFF/,''));assert.equal(csvRows.length,25);assert.deepEqual([...new Set(csvRows.slice(1).map(r=>r[0]))],['510001','610001']);
 const excelEvent=page.waitForEvent('download');await frame.locator('#templateExcel').click();const excel=await excelEvent;
 assert.equal(await excel.failure(),null);assert.equal(excel.suggestedFilename(),'plantilla_presupuesto_2026.xlsx');
 const excelRows=await readSheet(await excel.path(),1);assert.equal(excelRows.length,25);assert.equal(excelRows[1][4],0);
 await frame.locator('#categories input[value=Costo]').uncheck();await frame.locator('#categories input[value=Gasto]').uncheck();await frame.locator('#template').click();assert.match(await frame.locator('#templateStatus').innerText(),/Selecciona/);
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({integratedIframe:true,emptyMatrixCsv:true,emptyMatrixXlsx:true,twelveMonthsPerAccount:true,selectedCategoriesOnly:true,visibleValidation:true,noBudgetWrites:true}));
}finally{await browser.close();}
