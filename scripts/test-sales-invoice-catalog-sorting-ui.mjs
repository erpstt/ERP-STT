import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const invoices=[
  {invoice_id:30,invoice_number:'FAC-00000030',transaction_id:300,customer_id:3,so_id:30,subsidiary_id:3,due_date:'2026-12-15',total_amount:1250.5},
  {invoice_id:2,invoice_number:'FAC-00000002',transaction_id:20,customer_id:1,so_id:2,subsidiary_id:1,due_date:'2026-10-05',total_amount:9.75},
  {invoice_id:10,invoice_number:'FAC-00000010',transaction_id:100,customer_id:2,so_id:10,subsidiary_id:2,due_date:'2026-11-20',total_amount:100.25}
];

const fixtures={
  '/api/security/turnstile/config':{enabled:false},
  '/api/auth/roles':[{roleId:1,name:'Administrador'}],
  '/api/auth/select-role':{roleId:1,name:'Administrador'},
  '/api/security/my-role-access':{isAdmin:true,grants:[],modules:[]},
  '/api/auth/companies':[{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'}],
  '/api/auth/select-company':{subsidiaryId:1,name:'Empresa Alfa',legalName:'Empresa Alfa',currencyCode:'JMD'},
  '/api/sales/invoices':invoices,
  '/api/transaction-engine/transactions':[
    {transaction_id:300,tran_number:'TR-00000300'},
    {transaction_id:20,tran_number:'TR-00000020'},
    {transaction_id:100,tran_number:'TR-00000100'}
  ],
  '/api/entities/customers':[
    {customer_id:1,company_name:'Cliente Alfa'},
    {customer_id:2,company_name:'Cliente Medio'},
    {customer_id:3,company_name:'Cliente Zeta'}
  ],
  '/api/sales/sales-orders':[
    {so_id:30,so_number:'OV-00000030'},
    {so_id:2,so_number:'OV-00000002'},
    {so_id:10,so_number:'OV-00000010'}
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
  const payload=btoa(JSON.stringify({email:'sorting-test@example.test',exp:Math.floor(Date.now()/1000)+3600}))
    .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('nexo_token',`e30.${payload}.test`);
  localStorage.setItem('nexo_role','1');
  localStorage.setItem('nexo_company','1');
});

const expected={
  invoice_id:{asc:['#2','#10','#30'],desc:['#30','#10','#2']},
  invoice_number:{asc:['FAC-00000002','FAC-00000010','FAC-00000030'],desc:['FAC-00000030','FAC-00000010','FAC-00000002']},
  transaction_id:{asc:['TR-00000020','TR-00000100','TR-00000300'],desc:['TR-00000300','TR-00000100','TR-00000020']},
  customer_id:{asc:['Cliente Alfa','Cliente Medio','Cliente Zeta'],desc:['Cliente Zeta','Cliente Medio','Cliente Alfa']},
  so_id:{asc:['OV-00000002','OV-00000010','OV-00000030'],desc:['OV-00000030','OV-00000010','OV-00000002']},
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
  assert.deepEqual(await displayedValues(key),values,`${key} no quedó en orden ${direction}.`);
}

try{
  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.locator('.workspace').waitFor();
  await page.locator('.nav-link').filter({hasText:'Ventas'}).click();
  await page.locator('.nav-children a').filter({hasText:'Facturas de venta'}).click();
  await page.getByRole('heading',{name:'Facturas de venta',exact:true}).waitFor();
  await page.locator('tbody tr').first().waitFor();

  const sortButtons=page.locator('.catalog-sort-button');
  assert.equal(await sortButtons.count(),Object.keys(expected).length,'Todas las columnas de datos, incluido ID interno, deben poder ordenarse.');
  assert.equal(await page.locator('.actions-heading .catalog-sort-button').count(),0,'La columna Acciones no debe ofrecer ordenamiento.');

  for(const[key,values]of Object.entries(expected)){
    await verifyDirection(key,'asc',values.asc);
    await verifyDirection(key,'desc',values.desc);
  }

  await page.locator('input[aria-label="Buscar registros"]').fill('Cliente');
  assert.equal(await page.locator('tbody tr').count(),3,'El ordenamiento debe conservar el filtro de búsqueda.');
  await page.locator('.catalog-sort-button[data-sort-key="customer_id"]').click();
  assert.deepEqual(await displayedValues('customer_id'),expected.customer_id.asc,'Cambiar de columna debe comenzar nuevamente en ascendente.');

  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({
    allInvoiceColumnsSortable:true,
    ascendingDescending:true,
    naturalNumericOrder:true,
    referencesUseDisplayedLabels:true,
    searchPreserved:true,
    accessibleSortState:true
  }));
}finally{
  await browser.close();
}
