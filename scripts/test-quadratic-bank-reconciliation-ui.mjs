import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1680,height:1100},acceptDownloads:true});
page.setDefaultTimeout(8000);
const baseUrl=process.env.TEST_BASE_URL||'http://localhost:4173';
let ui=page;
const errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
  localStorage.setItem('nexo_token','test-token');
  localStorage.setItem('nexo_device_token','test-device');
  localStorage.setItem('nexo_company','1');
});

const matrix={
  bankBase:{startBalance:1000,receipts:100,disbursements:40,endBalance:1060},
  bankAdjustments:{startBalance:0,receipts:0,disbursements:0,endBalance:0},
  bankAdjusted:{startBalance:1000,receipts:100,disbursements:40,endBalance:1060},
  bookBase:{startBalance:1000,receipts:95,disbursements:40,endBalance:1055},
  bookAdjustments:{startBalance:0,receipts:0,disbursements:0,endBalance:0},
  bookAdjusted:{startBalance:1000,receipts:95,disbursements:40,endBalance:1055},
  differences:{startBalance:0,receipts:5,disbursements:0,endBalance:5},
  balanced:false
};
const detail={
  header:{id:11,subsidiaryId:1,subsidiaryName:'EMPRESA DE PRUEBAS',bankAccountId:7,accountNumber:'001-7788',bankName:'Banco Central',currencyCode:'JMD',currencySymbol:'J$',periodYear:2026,periodMonth:10,bankStartBalance:1000,bankTotalReceipts:100,bankTotalDisbursements:40,bankEndBalance:1060,status:'draft'},
  matrix,
  continuity:{required:true,ok:true,previousReconciliationId:10,expectedStartBalance:1000,actualStartBalance:1000,difference:0},
  items:[],matches:[],
  statementLines:[{id:301,date:'2026-10-03',reference:'DEP-001',description:'Depósito extracto',amount:100,matchId:null}],
  bookTransactions:[{id:401,date:'2026-10-03',reference:'DEP-001',description:'Depósito ERP',amount:100,matchId:null}],
  permissions:{manage:true,approve:true}
};
const options={
  subsidiary:{id:1,name:'EMPRESA DE PRUEBAS'},
  accounts:[{id:7,name:'Banco Central - 001-7788',number:'001-7788',bankName:'Banco Central',subsidiaryId:1,currencyCode:'JMD',currencySymbol:'J$'}],
  permissions:{view:true,manage:true,approve:true},
  reconciliations:[{id:11,bankAccountId:7,subsidiaryId:1,periodYear:2026,periodMonth:10,status:'draft',updatedAt:'2026-10-02T12:00:00Z'}]
};

function makeBalanced(){
  matrix.bookAdjustments={startBalance:0,receipts:5,disbursements:0,endBalance:5};
  matrix.bookAdjusted={startBalance:1000,receipts:100,disbursements:40,endBalance:1060};
  matrix.differences={startBalance:0,receipts:0,disbursements:0,endBalance:0};
  matrix.balanced=true;
}

await page.route('**/api/v1/bank-reconciliations/quadratic**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
  requests.push({path,method,payload:request.postDataJSON?.()||null});
  if(path.endsWith('/options'))return route.fulfill({json:options});
  if(path==='/api/v1/bank-reconciliations/quadratic'&&method==='GET')return route.fulfill({json:{rows:options.reconciliations,total:1}});
  if(path.endsWith('/matrix'))return route.fulfill({json:{header:detail.header,matrix,continuity:detail.continuity}});
  if(path.endsWith('/items')&&method==='POST'){
    const payload=request.postDataJSON();detail.items=[{id:501,...payload,adjustmentSide:'BOOK'}];makeBalanced();return route.fulfill({status:201,json:{success:true,id:501,matrix}});
  }
  if(path.endsWith('/auto-match')&&method==='POST'){
    detail.matches=[{id:601,statementLineId:301,bankTransactionId:401,matchType:'AUTOMATIC'}];detail.statementLines[0].matchId=601;detail.bookTransactions[0].matchId=601;return route.fulfill({json:{success:true,matched:1}});
  }
  if(path.endsWith('/matches')&&method==='POST'){
    const payload=request.postDataJSON();detail.matches=[{id:602,statementLineId:payload.statementLineId,bankTransactionId:payload.bookTransactionId,matchType:'MANUAL'}];detail.statementLines[0].matchId=602;detail.bookTransactions[0].matchId=602;return route.fulfill({status:201,json:{success:true,id:602}});
  }
  if(path.endsWith('/transition')&&method==='POST'){detail.header.status='in_review';return route.fulfill({json:{success:true,status:'in_review',result:detail}});}
  if(path.endsWith('/approve')&&method==='POST'){detail.header.status='approved';return route.fulfill({json:{success:true,status:'approved',result:detail}});}
  if(path.endsWith('/close')&&method==='POST'){detail.header.status='closed';return route.fulfill({json:{success:true,status:'closed',result:detail}});}
  if(path.endsWith('/pdf'))return route.fulfill({body:Buffer.from('%PDF-1.4 test'),headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="prueba-efectivo.pdf"'}});
  if(path.endsWith('/xlsx'))return route.fulfill({body:Buffer.from('PK test'),headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':'attachment; filename="prueba-efectivo.xlsx"'}});
  if(/\/quadratic\/11$/.test(path)&&method==='GET')return route.fulfill({json:detail});
  if(path==='/api/v1/bank-reconciliations/quadratic'&&method==='POST')return route.fulfill({status:200,json:{success:true,id:11,result:detail}});
  return route.fulfill({status:404,json:{message:`Ruta simulada no disponible: ${method} ${path}`}});
});

try{
  await page.goto(baseUrl);
  await page.setContent(`<iframe id="workspace" src="${baseUrl}/quadratic-bank-reconciliation.html" style="width:100%;height:1080px;border:0"></iframe>`);
  ui=page.frameLocator('#workspace');
  await ui.locator('#bankAccount option[value="7"]').waitFor({state:'attached'});
  assert.equal(await ui.locator('#subsidiary').inputValue(),'EMPRESA DE PRUEBAS');
  assert.match(await ui.locator('#bankAccount option[value="7"]').textContent(),/Banco Central/);
  await ui.locator('#periodYear').selectOption('2026');
  await ui.locator('#periodMonth').selectOption('10');
  await ui.locator('#openPeriod').click();
  await ui.locator('#statusBadge',{hasText:'Borrador'}).waitFor();
  assert.equal(await ui.locator('#bankStartBalance').inputValue(),'1000,00');
  assert.match(await ui.locator('#differenceReceipts').textContent(),/5,00/);
  assert.match(await ui.locator('#continuityNotice').textContent(),/Continuidad validada/);
  assert.equal(await ui.locator('#approve').isHidden(),true);

  await ui.locator('[data-panel="items"]').click();
  await ui.locator('#newItem').click();
  await ui.locator('#itemType').selectOption('UNRECORDED_BANK_CREDIT');
  await ui.locator('#itemAmount').fill('5,00');
  assert.equal(await ui.locator('#impactReceipts').inputValue(),'5,00');
  assert.equal(await ui.locator('#impactEnd').inputValue(),'5,00');
  await ui.locator('#itemDescription').fill('Abono bancario pendiente de registro');
  await ui.locator('#itemReference').fill('ABO-001');
  await ui.locator('#saveItem').click();
  await ui.locator('#itemDialog').waitFor({state:'hidden'});
  await ui.locator('[data-panel="matrix"]').click();
  await ui.locator('#balanceState',{hasText:'Cuatro columnas en cero'}).waitFor();
  assert.match(await ui.locator('#differenceEnd').textContent(),/0,00/);
  const itemRequest=requests.find(row=>row.path.endsWith('/items')&&row.method==='POST');
  assert.equal(itemRequest.payload.itemType,'UNRECORDED_BANK_CREDIT');
  assert.equal(itemRequest.payload.impactReceipts,5);

  await ui.locator('[data-panel="matching"]').click();
  await ui.locator('#autoMatch').click();
  await ui.locator('#matchedCount',{hasText:'1 conciliado'}).waitFor();
  assert.equal(requests.find(row=>row.path.endsWith('/auto-match')).payload.toleranceDays,3);

  await ui.locator('[data-panel="matrix"]').click();
  await ui.locator('#sendReview').click();
  await ui.locator('#confirmAction').click();
  await ui.locator('#statusBadge',{hasText:'En revisión'}).waitFor();
  assert.equal(await ui.locator('#approve').isEnabled(),true);
  await ui.locator('#approve').click();
  await ui.locator('#confirmAction').click();
  await ui.locator('#statusBadge',{hasText:'Aprobada'}).waitFor();
  assert.equal(await ui.locator('#closeReconciliation').isEnabled(),true);
  await ui.locator('#closeReconciliation').click();
  await ui.locator('#confirmAction').click();
  await ui.locator('#statusBadge',{hasText:'Cerrada'}).waitFor();
  assert.equal(await ui.locator('#bankStartBalance').isDisabled(),true);

  const pdfDownload=page.waitForEvent('download');await ui.locator('#downloadPdf').click();assert.equal((await pdfDownload).suggestedFilename(),'prueba-efectivo.pdf');
  const excelDownload=page.waitForEvent('download');await ui.locator('#downloadExcel').click();assert.equal((await excelDownload).suggestedFilename(),'prueba-efectivo.xlsx');
  assert.deepEqual(errors,[]);
  if(process.env.QUADRATIC_SCREENSHOT)await page.screenshot({path:process.env.QUADRATIC_SCREENSHOT,fullPage:true});
  console.log(JSON.stringify({optionsAndActiveSubsidiary:true,existingPeriodLoad:true,fourDifferences:true,continuity:true,itemDefaults:true,zeroOnlyWorkflow:true,closedImmutability:true,autoMatch:true,directPdf:true,directExcel:true,noPageErrors:true}));
}catch(error){
  console.error(JSON.stringify({url:page.url(),title:await page.title().catch(()=>''),heading:await ui.locator('h1').textContent().catch(()=>null),message:await ui.locator('#message').textContent().catch(()=>null),pageErrors:errors,apiRequests:requests.slice(0,8)},null,2));
  throw error;
}finally{
  await browser.close();
}
