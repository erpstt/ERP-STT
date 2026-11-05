import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {assertIsolatedTestArgs} from './lib/migration-preview.mjs';
assertIsolatedTestArgs();
let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw Error('Network forbidden in export fixture');};
const {buildSettledSupplierInvoiceExcel}=await import('../dist/modules/reports/settled-supplier-invoices-report.service.js');

function invoice(overrides={}){
 return {invoiceId:1,invoiceNumber:'SYN-INV-001',supplierName:'Synthetic Supplier',supplierTaxId:'SYN-TAX',
  dueDate:'2026-09-15',issueDate:'2026-09-01',invoiceAmount:100,payableAmount:100,invoiceWithholdingAmount:0,
  settlementBaseAmount:100,currency:'JMD',symbol:'J$',exchangeRate:1,exchangeDifferenceAmount:0,
  settlementDate:'2026-09-23',settlementType:'PAYMENT',settlementTypeLabel:'Pago a proveedor',settlementReferences:'SYN-PAY-001',
  paymentAmount:100,cashAmount:80,advanceAmount:15,withholdingAmount:5,otherFundingAmount:0,
  creditNoteAmount:0,debitNoteAmount:0,appliedAmount:100,overappliedAmount:0,daysToPay:22,
  localInvoiceAmount:100,localPayableAmount:100,localSettlementBaseAmount:100,localAppliedAmount:100,localOverappliedAmount:0,
  applications:[{date:'2026-09-23',type:'PAYMENT',typeLabel:'Pago a proveedor',reference:'SYN-PAY-001',
   secondaryReference:'SYN-BANK',method:'Transferencia',amount:100,cashAmount:80,advanceAmount:15,withholdingAmount:5,otherFundingAmount:0}],...overrides};
}
function report(rows=[],grouped=true){
 const sum=key=>rows.reduce((value,row)=>value+Number(row[key]||0),0);
 return {header:{subsidiaryId:1,subsidiary:'SYNTHETIC COMPANY',legalName:'Synthetic Company Ltd',taxId:'SYN-001',
   currency:'JMD',symbol:'J$',periodMonth:'2026-09',periodStart:'2026-09-01',periodEnd:'2026-09-30',
   settlementType:'ALL',groupBySettlementType:grouped,generatedAt:'2026-10-01T00:00:00Z'},
  summary:{invoiceCount:rows.length,invoiceAmount:sum('invoiceAmount'),payableAmount:sum('payableAmount'),
   invoiceWithholdingAmount:sum('invoiceWithholdingAmount'),settlementBaseAmount:sum('settlementBaseAmount'),
   paymentAppliedAmount:sum('paymentAmount'),cashAmount:sum('cashAmount'),advanceAmount:sum('advanceAmount'),
   withholdingAmount:sum('withholdingAmount'),otherFundingAmount:0,creditNoteAmount:sum('creditNoteAmount'),
   debitNoteAmount:sum('debitNoteAmount'),appliedAmount:sum('appliedAmount'),exchangeDifferenceAmount:sum('exchangeDifferenceAmount'),
   paymentCount:rows.filter(row=>row.settlementType==='PAYMENT').length,creditNoteCount:rows.filter(row=>row.settlementType==='CREDIT_NOTE').length,
   mixedCount:rows.filter(row=>row.settlementType==='MIXED').length,overappliedCount:0,overappliedAmount:0,averageDpo:rows.length?22:0},
  rows,total:rows.length,page:1,pageSize:50};
}
async function workbook(value){
 const file=await buildSettledSupplierInvoiceExcel(value);
 assert.equal(file.fileName,'facturas-proveedor-liquidadas-2026-09.xlsx');
 assert.equal(file.mimeType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 assert.equal(file.buffer.subarray(0,2).toString(),'PK');
 const book=new ExcelJS.Workbook();await book.xlsx.load(file.buffer);
 assert.equal(book.worksheets.length,2);assert.equal(networkCalls,0);return book;
}
function findInvoice(sheet,id){let found;sheet.eachRow(row=>{if(row.getCell(2).value===id)found=row;});assert.ok(found,`Missing ${id}`);return found;}

test('settled invoices XLSX preserves payment, credit, mixed groups, exact values, dates, and funding detail',async()=>{
 const rows=[invoice(),invoice({invoiceId:2,invoiceNumber:'SYN-CREDIT',settlementType:'CREDIT_NOTE',settlementTypeLabel:'Nota de Crédito',
  paymentAmount:0,cashAmount:0,advanceAmount:0,withholdingAmount:0,creditNoteAmount:100,applications:[]}),
  invoice({invoiceId:3,invoiceNumber:'SYN-MIXED',settlementType:'MIXED',settlementTypeLabel:'Mixto',
   debitNoteAmount:20,settlementBaseAmount:120,paymentAmount:80,cashAmount:80,advanceAmount:0,withholdingAmount:0,
   creditNoteAmount:40,appliedAmount:120,applications:[]})];
 const book=await workbook(report(rows)),sheet=book.worksheets[0],row=findInvoice(sheet,'SYN-INV-001');
 assert.equal(row.getCell(3).value,'Synthetic Supplier');
 for(const[column,value]of [[8,1],[9,100],[10,100],[14,100],[15,80],[16,15],[17,5],[19,100],[21,0],[22,22]])assert.equal(row.getCell(column).value,value);
 assert.ok(row.getCell(5).value instanceof Date);assert.equal(row.getCell(5).value.toISOString().slice(0,10),'2026-09-15');
 assert.equal(findInvoice(sheet,'SYN-CREDIT').getCell(18).value,100);
 assert.equal(findInvoice(sheet,'SYN-MIXED').getCell(11).value,20);
 assert.equal(findInvoice(sheet,'SYN-MIXED').getCell(12).value,120);
 let detail;book.worksheets[1].eachRow(row=>{if(row.getCell(1).value==='SYN-INV-001')detail=row;});
 assert.ok(detail);assert.equal(detail.getCell(4).value,'SYN-PAY-001');assert.equal(detail.getCell(5).value,'SYN-BANK');
 assert.deepEqual([7,8,9,10].map(column=>detail.getCell(column).value),[100,80,15,5]);
});

test('foreign original amounts and functional exchange difference remain distinct numeric XLSX values',async()=>{
 const book=await workbook(report([invoice({currency:'USD',symbol:'US$',exchangeRate:160.123456,exchangeDifferenceAmount:1000.123456})],false));
 const row=findInvoice(book.worksheets[0],'SYN-INV-001');
 assert.equal(row.getCell(7).value,'USD');assert.equal(row.getCell(8).value,160.123456);
 assert.equal(row.getCell(9).value,100);assert.equal(row.getCell(21).value,1000.123456);
 assert.match(row.getCell(9).numFmt,/US\$/);assert.match(row.getCell(21).numFmt,/J\$/);
});

test('empty month still exports a valid workbook without fabricated invoice or network activity',async()=>{
 const book=await workbook(report());let invoiceRows=0;
 book.worksheets[0].eachRow(row=>{if(typeof row.getCell(2).value==='string'&&row.getCell(2).value.startsWith('SYN-INV-'))invoiceRows++;});
 assert.equal(invoiceRows,0);assert.ok(book.worksheets[0].rowCount>0);assert.equal(networkCalls,0);
});
