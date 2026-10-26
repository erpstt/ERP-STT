import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const catalogs=[
  ['accounting-periods','Períodos contables'],
  ['fiscal-years','Años fiscales'],
  ['fiscal-calendars','Calendarios fiscales'],
  ['subsidiaries','Subsidiarias'],
  ['branches','Sucursales'],
  ['departments','Departamentos'],
  ['classes','Clases'],
  ['cost-centers','Centros de costos'],
  ['locations','Ubicaciones'],
  ['financial-creditors','Acreedores financieros'],
  ['related-companies','Compañías relacionadas']
];

const fixtures={
  '/api/security/turnstile/config':{enabled:false},
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/security/my-role-access':{isAdmin:true,grants:[],modules:[]},
  '/api/auth/companies':[{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'}],
  '/api/auth/select-company':{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'},
  '/api/organization/subsidiaries':[{subsidiary_id:1,name:'Empresa Alfa',legal_name:'Empresa Alfa',currency_id:1,secondary_currency_ids:[]}]
};

const requests=[];
const page=await browser.newPage({viewport:{width:1600,height:1000},acceptDownloads:true});
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
await page.route('**/api/**',route=>{
  const url=new URL(route.request().url()),match=url.pathname.match(/^\/api\/organization\/([^/]+)\/export$/);
  if(match){
    const slug=decodeURIComponent(match[1]),format=url.searchParams.get('format')||'';
    requests.push({slug,format,search:url.searchParams.get('search')||''});
    const xlsx=format==='xlsx',extension=xlsx?'xlsx':'csv';
    return route.fulfill({
      status:200,
      contentType:xlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset=utf-8',
      headers:{'Content-Disposition':`attachment; filename="${slug}-2026-10-26.${extension}"`},
      body:xlsx?'workbook-fixture':'codigo,nombre\r\n1,Registro de prueba'
    });
  }
  return route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify(fixtures[url.pathname]??[])
  });
});

await page.addInitScript(()=>{
  const payload=btoa(JSON.stringify({email:'organization-export-test@example.test',exp:Math.floor(Date.now()/1000)+3600}))
    .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('nexo_token',`e30.${payload}.test`);
  localStorage.setItem('nexo_role','1');
  localStorage.setItem('nexo_company','1');
  window.__organizationDownloads=[];
  const nativeClick=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download){
      window.__organizationDownloads.push({fileName:this.download,href:this.href});
      return;
    }
    return nativeClick.call(this);
  };
});

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.locator('.workspace').waitFor();
  await page.locator('.nav-link').filter({hasText:'Organización'}).click();

  for(const[slug,title]of catalogs){
    await page.locator('.nav-children a').filter({hasText:title}).click();
    await page.getByRole('heading',{name:title,exact:true}).waitFor();

    const actions=page.locator('.records-head-actions .catalog-export-actions');
    await actions.waitFor();
    assert.match(await actions.getAttribute('aria-label')||'',/Descargar/i,`${title} debe identificar accesiblemente sus descargas.`);
    assert.equal(await actions.locator('button').count(),2,`${title} debe mostrar únicamente CSV y Excel.`);

    for(const[format,label,extension]of [['csv','CSV','csv'],['xlsx','Excel','xlsx']]){
      const before=requests.length;
      const button=actions.getByRole('button',{name:new RegExp(`${label}$`,'i')});
      await button.waitFor();
      const downloadsBefore=await page.evaluate(()=>window.__organizationDownloads.length);
      try{
        await button.click();
        await page.waitForFunction(count=>window.__organizationDownloads.length>count,downloadsBefore);
      }catch(cause){
        const errorText=await page.locator('.table-message.form-error').textContent().catch(()=>null);
        throw new Error(`Falló la descarga ${label} de ${title}. Solicitudes: ${JSON.stringify(requests)}. Error visible: ${errorText||'ninguno'}. ${cause instanceof Error?cause.message:String(cause)}`);
      }
      assert.equal(requests.length,before+1,`${title} debe solicitar la descarga ${label}.`);
      assert.deepEqual(requests.at(-1),{slug,format,search:''},`${title} debe usar el endpoint y formato correctos.`);
      const download=await page.evaluate(()=>window.__organizationDownloads.at(-1));
      assert.equal(download.fileName,`${slug}-2026-10-26.${extension}`,`${title} debe conservar el nombre del archivo enviado por el servidor.`);
      assert.match(download.href,/^blob:/,`${title} debe generar la descarga desde el contenido recibido.`);
    }
  }

  assert.equal(requests.length,catalogs.length*2,'Cada catálogo debe ejecutar sus dos descargas.');
  assert.deepEqual(pageErrors,[],'La navegación y las descargas no deben producir errores de página.');
  console.log(JSON.stringify({
    organizationCatalogsCovered:catalogs.length,
    csvAvailableForAll:true,
    excelAvailableForAll:true,
    correctEndpointAndFormat:true,
    accessibleDownloadGroups:true,
    noPageErrors:true
  }));
}finally{
  await browser.close();
}
