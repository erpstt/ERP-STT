import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const invoices=[
  {invoice_id:30,invoice_number:'FCP-00000030',transaction_id:300,supplier_id:3,po_id:30,subsidiary_id:3,due_date:'2026-12-15',total_amount:1250.5},
  {invoice_id:2,invoice_number:'FCP-00000002',transaction_id:20,supplier_id:1,po_id:2,subsidiary_id:1,due_date:'2026-10-05',total_amount:9.75},
  {invoice_id:10,invoice_number:'FCP-00000010',transaction_id:100,supplier_id:2,po_id:10,subsidiary_id:2,due_date:'2026-11-20',total_amount:100.25}
];

const fixtures={
  '/api/security/turnstile/config':{enabled:false},
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/security/my-role-access':{isAdmin:true,grants:[],modules:[]},
  '/api/auth/companies':[{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'}],
  '/api/auth/select-company':{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'},
  '/api/purchasing/supplier-invoices':invoices,
  '/api/transaction-engine/transactions':[
    {transaction_id:300,tran_number:'TR-00000300'},
    {transaction_id:20,tran_number:'TR-00000020'},
    {transaction_id:100,tran_number:'TR-00000100'}
  ],
  '/api/entities/suppliers':[
    {supplier_id:1,company_name:'Proveedor Alfa'},
    {supplier_id:2,company_name:'Proveedor Medio'},
    {supplier_id:3,company_name:'Proveedor Zeta'}
  ],
  '/api/purchasing/orders':[
    {po_id:30,po_number:'OC-00000030'},
    {po_id:2,po_number:'OC-00000002'},
    {po_id:10,po_number:'OC-00000010'}
  ],
  '/api/organization/subsidiaries':[
    {subsidiary_id:1,name:'Empresa Alfa',currency_id:1,secondary_currency_ids:[]},
    {subsidiary_id:2,name:'Empresa Medio',currency_id:1,secondary_currency_ids:[]},
    {subsidiary_id:3,name:'Empresa Zeta',currency_id:1,secondary_currency_ids:[]}
  ]
};

const page=await browser.newPage({viewport:{width:1600,height:1000}});
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  return route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify(fixtures[path]??[])
  });
});
await page.addInitScript(()=>{
  const payload=btoa(JSON.stringify({email:'supplier-sorting-test@example.test',exp:Math.floor(Date.now()/1000)+3600}))
    .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('nexo_token',`e30.${payload}.test`);
  localStorage.setItem('nexo_role','1');
  localStorage.setItem('nexo_company','1');
});

const expected={
  invoice_id:{asc:['#2','#10','#30'],desc:['#30','#10','#2']},
  invoice_number:{asc:['FCP-00000002','FCP-00000010','FCP-00000030'],desc:['FCP-00000030','FCP-00000010','FCP-00000002']},
  transaction_id:{asc:['TR-00000020','TR-00000100','TR-00000300'],desc:['TR-00000300','TR-00000100','TR-00000020']},
  supplier_id:{asc:['Proveedor Alfa','Proveedor Medio','Proveedor Zeta'],desc:['Proveedor Zeta','Proveedor Medio','Proveedor Alfa']},
  po_id:{asc:['OC-00000002','OC-00000010','OC-00000030'],desc:['OC-00000030','OC-00000010','OC-00000002']},
  subsidiary_id:{asc:['Empresa Alfa','Empresa Medio','Empresa Zeta'],desc:['Empresa Zeta','Empresa Medio','Empresa Alfa']},
  due_date:{asc:['2026-10-05','2026-11-20','2026-12-15'],desc:['2026-12-15','2026-11-20','2026-10-05']},
  total_amount:{asc:['9.75','100.25','1250.5'],desc:['1250.5','100.25','9.75']}
};

async function displayedValues(key){
  const button=page.locator(`.catalog-sort-button[data-sort-key="${key}"]`);
  const heading=button.locator('xpath=ancestor::th[1]');
  const column=await heading.evaluate(cell=>cell.cellIndex);
  return page.locator('tbody tr').evaluateAll((rows,index)=>rows.map(row=>row.cells[index]?.innerText.trim()),column);
}

async function verifyDirection(key,direction,values){
  const button=page.locator(`.catalog-sort-button[data-sort-key="${key}"]`);
  const heading=button.locator('xpath=ancestor::th[1]');
  await button.click();
  assert.equal(await heading.getAttribute('aria-sort'),direction==='asc'?'ascending':'descending',`${key} debe anunciar el orden ${direction}.`);
  assert.deepEqual(await displayedValues(key),values,`${key} no quedo en orden ${direction}.`);
}

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.locator('.workspace').waitFor();
  await page.locator('.nav-link').filter({hasText:'Compras'}).click();
  await page.locator('.nav-children a').filter({hasText:'Facturas de proveedores'}).click();
  await page.getByRole('heading',{name:'Facturas de proveedores',exact:true}).waitFor();
  await page.locator('tbody tr').first().waitFor();

  const sortButtons=page.locator('.catalog-sort-button');
  assert.equal(await sortButtons.count(),Object.keys(expected).length,'Todas las columnas de datos, incluido ID interno, deben poder ordenarse.');
  assert.equal(await page.locator('.actions-heading .catalog-sort-button').count(),0,'La columna Acciones no debe ofrecer ordenamiento.');

  for(const[key,values]of Object.entries(expected)){
    await verifyDirection(key,'asc',values.asc);
    await verifyDirection(key,'desc',values.desc);
  }

  await page.locator('input[aria-label="Buscar registros"]').fill('Proveedor');
  assert.equal(await page.locator('tbody tr').count(),3,'El ordenamiento debe conservar el filtro de busqueda.');
  await page.locator('.catalog-sort-button[data-sort-key="supplier_id"]').click();
  assert.deepEqual(await displayedValues('supplier_id'),expected.supplier_id.asc,'Cambiar de columna debe comenzar nuevamente en ascendente.');

  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({
    allSupplierInvoiceColumnsSortable:true,
    ascendingDescending:true,
    naturalNumericOrder:true,
    referencesUseDisplayedLabels:true,
    searchPreserved:true,
    accessibleSortState:true
  }));
}finally{
  await browser.close();
}
