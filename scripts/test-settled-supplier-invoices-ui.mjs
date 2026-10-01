import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class FakeClassList{toggle(){} add(){} remove(){}}
class FakeElement{
  constructor(){this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.open=false;this.textContent='';this.innerHTML='';this.classList=new FakeClassList();}
  querySelectorAll(){return[]}
  append(){}
  remove(){}
}
const ids=['generate','downloadPdf','downloadExcel','message','periodMonth','settlementType','groupBySettlementType','pageSize','supplierOptions','supplierSummary','clearSuppliers','summary','overappliedWarning','reportGroups','resultCount','pageCaption','previousPage','nextPage','periodCaption','filters','supplierPicker','subsidiary'];
const elements=Object.fromEntries(ids.map(id=>[id,new FakeElement()]));
elements.settlementType.value='ALL';elements.groupBySettlementType.checked=true;elements.pageSize.value='50';

const options={subsidiary:{id:1,name:'EMPRESA DE PRUEBAS',currency:'JMD',symbol:'J$'},suppliers:[{id:9,name:'Proveedor Uno',number:'PRO-009',taxId:'9001',active:true}]};
const report={
  header:{subsidiary:'EMPRESA DE PRUEBAS',currency:'JMD',symbol:'J$',periodMonth:'2026-09'},
  summary:{invoiceCount:1,invoiceAmount:1000,invoiceWithholdingAmount:20,payableAmount:980,settlementBaseAmount:1030,paymentAppliedAmount:930,cashAmount:800,advanceAmount:100,withholdingAmount:30,otherFundingAmount:0,creditNoteAmount:100,debitNoteAmount:50,netAppliedAmount:980,averageDpo:22,overappliedCount:0,overappliedAmount:0},
  rows:[{invoiceId:7,invoiceNumber:'FAC-PRO-0007',supplierName:'Proveedor Uno',supplierTaxId:'9001',supplierNumber:'PRO-009',issueDate:'2026-09-01',dueDate:'2026-09-15',invoiceAmount:1000,invoiceWithholdingAmount:20,payableAmount:980,currency:'JMD',symbol:'J$',settlementDate:'2026-09-23',settlementType:'MIXED',settlementTypeLabel:'Mixto',settlementReferences:'PAG-PRO-1 · NC-PRO-1',paymentAmount:930,creditNoteAmount:100,debitNoteAmount:50,cashAmount:800,advanceAmount:100,withholdingAmount:30,otherFundingAmount:0,netAppliedAmount:980,overappliedAmount:0,daysToPay:22,applications:[{date:'2026-09-23',type:'PAYMENT',typeLabel:'Pago a proveedor',reference:'PAG-PRO-1',secondaryReference:'TRX-88',method:'Banco',amount:930,cashAmount:800,advanceAmount:100,withholdingAmount:30,otherFundingAmount:0}]}],
  total:1,page:1,pageSize:50
};
const calls=[];
const context={
  console,Date,Intl,Number,String,Math,Set,Error,JSON,URL,setTimeout,clearTimeout,
  localStorage:{getItem:key=>key==='nexo_token'?'test-token':key==='nexo_device_token'?'test-device':null},
  sessionStorage:{getItem:()=>null},location:{assign:()=>assert.fail('No debe redirigir con una sesión disponible.')},
  document:{body:{classList:new FakeClassList(),append(){}},getElementById:id=>elements[id],createElement:()=>new FakeElement()},
  fetch:async(path,init={})=>{calls.push({path,init});const payload=String(path).endsWith('/options')?options:report;return{ok:true,headers:{get:()=>null},text:async()=>JSON.stringify(payload)};}
};
vm.createContext(context);
vm.runInContext(await readFile(new URL('../public/settled-supplier-invoices.js',import.meta.url),'utf8'),context,{filename:'settled-supplier-invoices.js'});
await new Promise(resolve=>setTimeout(resolve,30));

assert.deepEqual(calls.map(call=>call.path),['/api/v1/reports/purchases/settled-invoices/options','/api/v1/reports/purchases/settled-invoices']);
assert.equal(elements.subsidiary.value,'EMPRESA DE PRUEBAS');
assert.match(elements.summary.innerHTML,/Factura J\$ 1[\s.]?000,00 − retención en origen J\$ 20,00 \+ ND J\$ 50,00/);
assert.match(elements.summary.innerHTML,/Días promedio para pagar/);
assert.match(elements.reportGroups.innerHTML,/FAC-PRO-0007/);
assert.match(elements.reportGroups.innerHTML,/Proveedor Uno/);
assert.match(elements.reportGroups.innerHTML,/Ret\. origen −J\$ 20,00/);
assert.match(elements.reportGroups.innerHTML,/PAG-PRO-1/);
assert.equal(elements.resultCount.textContent,'1 registro');
console.log('OK: la vista de facturas de proveedor liquidadas concilia y presenta el detalle esperado.');
