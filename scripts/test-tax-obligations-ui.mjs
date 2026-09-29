import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const appSource=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
assert.match(appSource,/children: \['Obligaciones tributarias','Calendario tributario'\]/);
assert.match(appSource,/openWorkspace\('\/tax-obligations\.html'\)/);

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(20000);
  await page.addInitScript(()=>{
    try{
      localStorage.setItem('nexo_token','tax-obligations-ui-test');
      localStorage.setItem('nexo_device_token','tax-obligations-device-test');
    }catch{/* La vista previa usa un iframe aislado sin acceso al almacenamiento. */}
  });

  const obligations=[{id:'tax-cr-iva',countryId:1,countryName:'Costa Rica',code:'IVA_MENSUAL',name:'Declaración mensual de IVA',frequency:'monthly',description:'Declaración del impuesto al valor agregado.',isActive:true}];
  const templates=[{id:'template-reminder-cr',countryId:1,countryName:'Costa Rica',kind:'reminder',subjectTemplate:'Recordatorio {{obligacion}}',bodyTemplate:'Hola {{responsable}}, el vencimiento es {{fecha_vencimiento}}.',isActive:true}];
  let savedObligation=null,savedTemplate=null;

  await page.route('**/api/tax-obligations/**',async route=>{
    const action=new URL(route.request().url()).pathname.split('/').at(-1);
    const payload=route.request().postDataJSON?.()||{};
    if(action==='options')return route.fulfill({json:{permissions:{view:true,manage:true},countries:[{id:1,name:'Costa Rica'},{id:2,name:'Guatemala'}],placeholders:[{token:'obligacion',label:'Obligación'},{token:'responsable',label:'Responsable'},{token:'fecha_vencimiento',label:'Fecha de vencimiento'}]}});
    if(action==='list')return route.fulfill({json:{obligations:obligations.filter(row=>!payload.countryId||row.countryId===payload.countryId),templates:templates.filter(row=>!payload.countryId||row.countryId===payload.countryId)}});
    if(action==='save'){
      savedObligation=payload;
      const row={...payload,id:payload.id||'tax-cr-renta',countryName:payload.countryId===1?'Costa Rica':'Guatemala'};
      const index=obligations.findIndex(item=>item.id===row.id);if(index>=0)obligations[index]=row;else obligations.push(row);
      return route.fulfill({json:{success:true,id:row.id}});
    }
    if(action==='save-template'){
      savedTemplate=payload;
      const row={...payload,id:'template-saved',countryName:payload.countryId===1?'Costa Rica':'Guatemala'};
      const index=templates.findIndex(item=>item.countryId===row.countryId&&item.kind===row.kind);if(index>=0)templates[index]=row;else templates.push(row);
      return route.fulfill({json:{success:true,id:row.id}});
    }
    if(action==='delete')return route.fulfill({json:{success:true,id:payload.id}});
    return route.fulfill({status:404,json:{error:'Ruta de prueba no definida'}});
  });

  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.setContent('<iframe id="tax-obligations" src="http://localhost:3000/tax-obligations.html" style="width:1420px;height:980px"></iframe>');
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  const app=page.frameLocator('#tax-obligations');
  await app.getByRole('heading',{name:'Obligaciones tributarias'}).waitFor();
  assert.equal(await app.locator('#countryFilter').inputValue(),'1');
  assert.match(await app.locator('#obligationRows').innerText(),/Declaración mensual de IVA/);

  await app.getByRole('button',{name:'Nueva obligación'}).click();
  await app.locator('#obligationDialog[open]').waitFor();
  await app.locator('#obligationCode').fill('RENTA_ANUAL');
  await app.locator('#obligationName').fill('Declaración anual de renta');
  await app.locator('#obligationFrequency').selectOption('annual');
  await app.locator('#obligationDescription').fill('Impuesto sobre la renta.');
  await app.locator('#obligationForm [type="submit"]').click();
  await app.locator('#obligationDialog').waitFor({state:'hidden'});
  assert.equal(savedObligation.code,'RENTA_ANUAL');
  assert.equal(savedObligation.countryId,1);
  assert.equal(savedObligation.frequency,'annual');
  assert.match(await app.locator('#obligationRows').innerText(),/Declaración anual de renta/);
  if(process.argv.includes('--screenshot'))await page.screenshot({path:`${process.env.TEMP}/nexo-tax-obligations-catalog.png`,fullPage:true});

  await app.getByRole('tab',{name:'Plantillas de correo'}).click();
  await app.locator('#templatesPanel').waitFor({state:'visible'});
  assert.equal(await app.locator('#templateSubject').inputValue(),'Recordatorio {{obligacion}}');
  await app.locator('#templateSubject').focus();
  await app.locator('[data-placeholder="{{fecha_vencimiento}}"]') .click();
  await app.locator('#templateBody').fill('Revise la obligación {{obligacion}} antes de la fecha indicada.');
  await app.locator('#saveTemplate').click();
  assert.equal(savedTemplate.countryId,1);
  assert.equal(savedTemplate.kind,'reminder');
  assert.match(savedTemplate.subjectTemplate,/\{\{fecha_vencimiento\}\}/);
  assert.match(savedTemplate.bodyTemplate,/\{\{obligacion\}\}/);
  if(process.argv.includes('--screenshot'))await page.screenshot({path:`${process.env.TEMP}/nexo-tax-obligations-template.png`,fullPage:true});

  await app.locator('#countryFilter').selectOption('2');
  await app.getByRole('tab',{name:'Catálogo de obligaciones'}).click();
  await app.locator('#catalogEmpty').waitFor({state:'visible'});
  assert.match(await app.locator('#catalogEmpty').innerText(),/Aún no hay obligaciones/);
  await page.setViewportSize({width:430,height:820});
  await page.locator('#tax-obligations').evaluate(element=>{element.style.width='410px';element.style.height='800px';});
  assert.equal(await app.locator('html').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({fiscalNavigation:true,countryCatalog:true,createObligation:true,countryFiltering:true,editableTemplates:true,placeholderInsertion:true,localPreview:true,responsive:true,noPageErrors:true}));
}finally{await browser.close();}
