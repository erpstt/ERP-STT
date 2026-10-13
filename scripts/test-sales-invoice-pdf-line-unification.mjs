import assert from 'node:assert/strict';
import {
  buildSalesInvoicePdfHtml,
  prepareSalesInvoicePdfViewModel
} from '../dist/modules/notifications/sales-invoice-delivery.service.js';

const lines=[
  {product:'Soporte',description:'Soporte regional',serviceCountry:'Costa Rica',quantity:2,unitPrice:50.002,amount:100.004,taxCodeId:10,taxCode:'IVA13',taxRate:13,taxAmount:13.00052,grossAmount:113.00452},
  {product:'Licencia',description:'Licencia anual',serviceCountry:'Panamá',quantity:1,unitPrice:199.996,amount:199.996,taxCodeId:10,taxCode:'IVA13',taxRate:13,taxAmount:25.99948,grossAmount:225.99548},
  {product:'Servicio especial',description:'Servicio separado',serviceCountry:'Costa Rica',quantity:1,unitPrice:20,amount:20,taxCodeId:11,taxCode:'IVA13-ESPECIAL',taxRate:13,taxAmount:2.6,grossAmount:22.6},
  {product:'Servicio reducido',description:'Tarifa distinta',serviceCountry:'Costa Rica',quantity:1,unitPrice:10,amount:10,taxCodeId:10,taxCode:'IVA13',taxRate:5,taxAmount:.5,grossAmount:10.5},
  {product:'Exento',description:'Servicio exento',serviceCountry:'Costa Rica',quantity:1,unitPrice:50.005,amount:50.005,taxCodeId:null,taxCode:'Sin impuesto',taxRate:0,taxAmount:0,grossAmount:50.005}
];

const baseDocument={
  id:77,
  number:'FAC-2026-077',
  issueDate:'2026-10-01',
  dueDate:'2026-10-31',
  memo:'Detalle contractual adjunto',
  total:422.105,
  receivable:422.105,
  company:{name:'Empresa de Pruebas',address:'San José'},
  customer:{name:'Cliente regional',email:'facturas@example.invalid',address:'Costa Rica',taxId:'3-101-123456'},
  currency:{code:'USD',name:'Dólar estadounidense',symbol:'$'},
  paymentTerm:'Neto 30',
  withholdingTotal:0,
  supports:[],
  lines
};

const originalSnapshot=structuredClone(baseDocument);
const normal=prepareSalesInvoicePdfViewModel({...baseDocument,unifyLinesPdf:false});
assert.equal(normal.lines.length,lines.length,'El modo normal debe conservar todas las líneas.');
assert.deepEqual(normal.lines,lines,'El modo normal debe conservar campos, valores y orden.');
assert.notEqual(normal.lines,lines,'El mapper no debe reutilizar la colección original.');
assert.notEqual(normal.lines[0],lines[0],'El mapper no debe reutilizar objetos de línea.');
normal.lines[0].product='Cambio solo en presentación';
assert.equal(lines[0].product,'Soporte','Modificar el ViewModel no puede alterar las líneas originales.');
assert.deepEqual(baseDocument,originalSnapshot,'El documento original debe permanecer intacto.');

const unified=prepareSalesInvoicePdfViewModel({...baseDocument,unifyLinesPdf:true});
assert.equal(unified.lines.length,4,'Debe generar un grupo por código de impuesto y tasa.');
assert.deepEqual(unified.lines.map(line=>[line.taxCodeId,line.taxRate]),[[10,13],[11,13],[10,5],[null,0]],'Debe mantener el orden de aparición de los grupos y separar tasas distintas.');

const iva13=unified.lines[0];
assert.equal(iva13.quantity,1);
assert.equal(iva13.amount,300);
assert.equal(iva13.unitPrice,iva13.amount);
assert.equal(iva13.taxAmount,39);
assert.equal(iva13.grossAmount,339);
assert.equal(iva13.description,'Bienes y servicios según detalle de la factura');
assert.equal(iva13.serviceCountry,'Varios / según detalle');
assert.equal(unified.lines[1].serviceCountry,'Costa Rica','Debe conservar el país cuando es único en el grupo.');

assert.equal(unified.subtotal,380.01,'El subtotal presentado debe quedar redondeado al centavo.');
assert.equal(unified.tax,42.1,'El impuesto presentado debe reconciliar con el total.');
assert.equal(unified.total,422.11,'El total presentado debe coincidir con el total real redondeado.');
assert.equal(Math.round(unified.lines.reduce((sum,line)=>sum+line.amount,0)*100),Math.round(unified.subtotal*100));
assert.equal(Math.round(unified.lines.reduce((sum,line)=>sum+line.taxAmount,0)*100),Math.round(unified.tax*100));
assert.equal(Math.round(unified.lines.reduce((sum,line)=>sum+line.grossAmount,0)*100),Math.round(unified.total*100));
assert.ok(unified.lines.every(line=>Math.round((line.amount+line.taxAmount)*100)===Math.round(line.grossAmount*100)),'Cada grupo debe cuadrar subtotal + impuesto = total.');
assert.deepEqual(baseDocument,originalSnapshot,'La consolidación no puede alterar el DTO ni sus líneas.');

const html=buildSalesInvoicePdfHtml({...baseDocument,unifyLinesPdf:true});
assert.match(html,/Bienes y servicios según detalle de la factura/);
assert.match(html,/IVA13 · 13%/,'El código y la tasa deben verse dentro de la celda de impuesto.');
assert.match(html,/IVA13 · 5%/,'Una tasa distinta del mismo código debe quedar visible por separado.');
assert.match(html,/IVA13-ESPECIAL · 13%/);
assert.match(html,/Sin impuesto · 0%/);
assert.match(html,/Varios \/ según detalle/);
assert.match(html,/Total factura<\/dt><dd>\$ 422,11/,'El total del HTML debe utilizar el ViewModel reconciliado.');

assert.throws(
  ()=>prepareSalesInvoicePdfViewModel({...baseDocument,total:422.12,unifyLinesPdf:true}),
  /no coinciden al centavo/,
  'No debe ocultar una diferencia real entre las líneas y el encabezado.'
);

const makeLine=(overrides={})=>({
  product:'Servicio',description:'Detalle',serviceCountry:'Costa Rica',quantity:1,unitPrice:0,
  amount:0,taxCodeId:null,taxCode:'Sin impuesto',taxRate:0,taxAmount:0,grossAmount:0,
  ...overrides
});
const documentWith=(customLines,total)=>({...baseDocument,lines:customLines,total,receivable:total,unifyLinesPdf:true});

const distinctCodes=prepareSalesInvoicePdfViewModel(documentWith([
  makeLine({taxCode:'IVA13',taxRate:13,amount:100,taxAmount:13,grossAmount:113}),
  makeLine({taxCode:'OTRO13',taxRate:13,amount:100,taxAmount:13,grossAmount:113})
],226));
assert.equal(distinctCodes.lines.length,2,'Códigos textuales distintos sin ID no deben fusionarse.');
assert.deepEqual(distinctCodes.lines.map(line=>line.taxCode),['IVA13','OTRO13']);

const fractionalGross=prepareSalesInvoicePdfViewModel(documentWith([
  makeLine({taxCodeId:1,taxCode:'T1',taxRate:1,amount:.004,taxAmount:.004,grossAmount:.008}),
  makeLine({taxCodeId:2,taxCode:'T2',taxRate:2,amount:.004,taxAmount:.003,grossAmount:.007})
],.015));
assert.deepEqual(fractionalGross.lines.map(line=>line.grossAmount),[.01,.01],'Los centavos deben distribuirse según el bruto agregado de cada grupo.');
assert.equal(fractionalGross.lines.reduce((sum,line)=>sum+line.grossAmount,0),fractionalGross.total);
assert.ok(fractionalGross.lines.every(line=>Math.round((line.amount+line.taxAmount)*100)===Math.round(line.grossAmount*100)));

assert.throws(
  ()=>prepareSalesInvoicePdfViewModel(documentWith([
    makeLine({taxCodeId:1,taxCode:'IVA13',taxRate:13,amount:100,taxAmount:13,grossAmount:114})
  ],114)),
  /subtotal, el impuesto y el importe bruto.*no coinciden/,
  'Una inconsistencia interna no se puede convertir silenciosamente en impuesto.'
);

const empty=prepareSalesInvoicePdfViewModel(documentWith([],0));
assert.deepEqual(empty,{lines:[],subtotal:0,tax:0,total:0},'Una factura vacía de importe cero debe conservar una salida estable.');
const zero=prepareSalesInvoicePdfViewModel(documentWith([
  makeLine({taxCodeId:1,taxCode:'CERO',taxRate:0})
],0));
assert.equal(zero.lines.length,1);
assert.deepEqual([zero.lines[0].amount,zero.lines[0].taxAmount,zero.lines[0].grossAmount],[0,0,0]);

const signed=prepareSalesInvoicePdfViewModel(documentWith([
  makeLine({taxCodeId:1,taxCode:'POSITIVO',amount:.003,grossAmount:.003}),
  makeLine({taxCodeId:2,taxCode:'NEGATIVO-A',amount:-.004,grossAmount:-.004}),
  makeLine({taxCodeId:3,taxCode:'NEGATIVO-B',amount:-.004,grossAmount:-.004})
],-.005));
assert.ok(signed.lines[0].amount>=0,'El redondeo no debe volver negativo un grupo positivo.');
assert.ok(signed.lines.slice(1).every(line=>line.amount<=0),'El redondeo no debe volver positivos los grupos negativos.');
assert.equal(signed.lines.reduce((sum,line)=>sum+line.grossAmount,0),signed.total);

console.log(JSON.stringify({normalLinesPreserved:true,sourceNotMutated:true,groupedByTaxCodeAndRate:true,taxCodeFallback:true,uniqueAndMultipleCountries:true,taxCodeAndRateVisible:true,centReconciliation:true,groupGrossReconciliation:true,integrityValidation:true,zeroAndEmpty:true,signedAllocation:true}));
