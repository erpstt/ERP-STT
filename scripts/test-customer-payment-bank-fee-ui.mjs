import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser=await chromium.launch({
  headless:true,
  executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const invoiceAmount=35916.70;
const bankFeeAmount=29.61;
const bankNetAmount=35887.09;
let savedPayload=null;

const common={
  subsidiary:{id:1,name:'EMPRESA DE PRUEBAS',currencyId:1},
  location:{id:1,name:'Jamaica'},
  customers:[{id:1,name:'Cliente comisión bancaria'}],
  accounts:[{id:1,bank:'JN Bank Limited',number:'20000006419',currencyId:1,currency:'JMD',balance:100000}],
  bankFeeAccount:{id:91,number:'629001',name:'Comisiones bancarias'},
  periods:[{id:1,name:'octubre 2026',start:'2026-10-01',end:'2026-10-31'}],
  rates:[],
  advances:[]
};
const invoice={
  id:10,number:'FAC_VEN-00000669',customerId:1,date:'2026-10-01',dueDate:'2026-10-31',
  currencyId:1,currency:'JMD',total:invoiceAmount,receivable:invoiceAmount,
  debitNotes:0,creditNotes:0,paid:0,currentApplied:0,balance:invoiceAmount,editableBalance:invoiceAmount
};
const existingDetail={
  header:{
    payment_id:27,payment_number:'COB_CLI-00000027',customer_id:1,currency_id:1,
    bank_account_id:1,payment_date:'2026-10-20',exchange_rate:1,
    bank_reference:'TRF-CLIENTE-27',memo:'Cobro con comisión bancaria',amount_received:bankNetAmount
  },
  applications:[{
    application_id:30,payment_id:27,invoice_id:10,amount:invoiceAmount,
    application_date:'2026-10-20',invoiceNumber:invoice.number,invoiceTotal:invoiceAmount
  }],
  advances:[],
  bankFee:{
    amount:bankFeeAmount,accountId:91,accountNumber:'629001',accountName:'Comisiones bancarias'
  },
  impact:[]
};

const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
const amountPattern=value=>{
  const [whole,decimals]=Number(value).toFixed(2).split('.');
  const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,'[\\s.]?');
  return new RegExp(`${grouped}[,.]${decimals}`);
};

try{
  const page=await browser.newPage({viewport:{width:1580,height:1050}});
  page.setDefaultTimeout(15000);
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('nexo_token','customer-payment-bank-fee-token');
    localStorage.setItem('nexo_device_token','customer-payment-bank-fee-device-123456');
  });
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==='/api/sales/customer-payments/options'){
      const editing=url.searchParams.get('paymentId');
      return route.fulfill({json:{...common,invoices:editing?[{...invoice,currentApplied:invoiceAmount,balance:0,editableBalance:invoiceAmount}]:[invoice]}});
    }
    if(path==='/api/sales/customer-payments/report')return route.fulfill({json:{rows:[{
      id:27,date:'2026-10-20',number:'COB_CLI-00000027',customer:'Cliente comisión bancaria',
      bank:'JN Bank Limited',account:'20000006419',reference:'TRF-CLIENTE-27',currency:'JMD',
      amount:bankNetAmount,grossTotal:invoiceAmount,bankFeeTotal:bankFeeAmount,advanceTotal:0,status:'APROBADO'
    }]}});
    if(path==='/api/sales/customer-payments/27'&&request.method()==='GET')return route.fulfill({json:existingDetail});
    if(path==='/api/sales/customer-payments/save'&&request.method()==='POST'){
      savedPayload=request.postDataJSON();
      return route.fulfill({status:201,json:{
        id:28,number:'COB_CLI-00000028',grossTotal:invoiceAmount,advanceTotal:0,
        withholdingTotal:0,bankFeeTotal:bankFeeAmount,cashTotal:bankNetAmount
      }});
    }
    return route.fulfill({json:[]});
  });

  await page.goto('http://localhost:3000/',{waitUntil:'domcontentloaded'});
  await page.setContent('<iframe id="payment" src="http://localhost:3000/customer-payments.html" style="width:1540px;height:1000px;border:0"></iframe>');
  const app=page.frameLocator('#payment');
  await app.getByText('COB_CLI-00000027',{exact:true}).waitFor();

  // La edición debe restaurar la comisión y conservar la aplicación bruta.
  await app.locator('[data-edit="27"]').click();
  await app.locator('#modal:not([hidden])').waitFor();
  assert.equal(await app.locator('#bankFeeEnabled').isChecked(),true,'La edición no restauró la opción de comisión bancaria.');
  assert.equal(await app.locator('#bankFeeFields').isHidden(),false,'La edición no mostró los campos de comisión bancaria.');
  assert.equal(Number(await app.locator('#bankFeeAmount').inputValue()),bankFeeAmount);
  assert.match(await app.locator('#bankFeeAccount').inputValue(),/629001.*Comisiones bancarias/i);
  assert.match(normalize(await app.locator('#total').innerText()),amountPattern(invoiceAmount));
  assert.match(normalize(await app.locator('#bankFeeTotal').innerText()),amountPattern(bankFeeAmount));
  assert.match(normalize(await app.locator('#cashTotal').innerText()),amountPattern(bankNetAmount));
  await app.locator('#close').click();

  // Nuevo cobro usando el ejemplo indicado por el usuario.
  await app.locator('#new').click();
  await app.locator('#modal:not([hidden])').waitFor();
  await app.locator('#customer').selectOption('1');
  await app.locator('#currency').selectOption('1');
  await app.locator('#account').selectOption('1');
  await app.locator('#reference').fill('TRF-CLIENTE-COMISION');
  const invoiceInput=app.locator(`#invoiceRows .apply[data-id="${invoice.id}"]`);
  await invoiceInput.fill(String(invoiceAmount));
  await app.locator('#bankFeeEnabled').check();
  assert.equal(await app.locator('#bankFeeFields').isHidden(),false);
  assert.match(await app.locator('#bankFeeAccount').inputValue(),/629001.*Comisiones bancarias/i);

  // La comisión nunca puede superar el efectivo disponible del cobro.
  await app.locator('#bankFeeAmount').fill(String(invoiceAmount+.01));
  assert.equal(await app.locator('#entry').evaluate(form=>form.checkValidity()),false,'Se permitió una comisión superior al efectivo disponible.');
  assert.equal(await app.locator('#save').isDisabled(),true,'El botón Guardar debe bloquearse ante una comisión excesiva.');

  await app.locator('#bankFeeAmount').fill(String(bankFeeAmount));
  assert.equal(await app.locator('#entry').evaluate(form=>form.checkValidity()),true);
  assert.equal(await app.locator('#save').isDisabled(),false);
  assert.match(normalize(await app.locator('#total').innerText()),amountPattern(invoiceAmount));
  assert.match(normalize(await app.locator('#bankFeeTotal').innerText()),amountPattern(bankFeeAmount));
  assert.match(normalize(await app.locator('#cashTotal').innerText()),amountPattern(bankNetAmount));
  assert.match(normalize(await app.locator('#bankFeePreview').innerText()),amountPattern(bankFeeAmount));

  // La vista previa debe explicar el asiento balanceado antes de guardar.
  await app.locator('[data-tab="impact"]').click();
  assert.match(normalize(await app.locator('#impactFeeDetail').innerText()),/629001.*Comisiones bancarias/i);
  assert.match(normalize(await app.locator('#impactFeeDetail').innerText()),amountPattern(bankFeeAmount));
  assert.match(normalize(await app.locator('#impactBank').innerText()),amountPattern(bankNetAmount));
  assert.match(normalize(await app.locator('#impact').innerText()),amountPattern(invoiceAmount));
  if(process.env.CAPTURE_UI==='1')await page.screenshot({path:'.tmp/customer-payment-bank-fee-ui.png',fullPage:true});

  await app.locator('#save').click();
  await app.locator('#modal').waitFor({state:'hidden'});
  assert.ok(savedPayload,'La UI no envió el cobro al endpoint de guardado.');
  assert.equal(Number(savedPayload.bank_fee_amount),bankFeeAmount,'El payload no incluyó la comisión bancaria.');
  assert.equal(Number(savedPayload.applications?.[0]?.amount),invoiceAmount,'La comisión alteró el valor aplicado a la factura.');
  assert.match(normalize(await app.locator('#message').innerText()),amountPattern(bankNetAmount));
  assert.match(normalize(await app.locator('#message').innerText()),amountPattern(bankFeeAmount));
  assert.deepEqual(pageErrors,[]);

  console.log(JSON.stringify({
    ui:true,bankFeeAccountVisible:true,exampleAmounts:true,excessBlocked:true,
    balancedImpactPreview:true,payloadBankFee:true,editRestored:true,noPageErrors:true
  }));
}finally{
  await browser.close();
}
