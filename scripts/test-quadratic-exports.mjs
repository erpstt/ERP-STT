import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildQuadraticReconciliationExcel,buildQuadraticReconciliationPdf} from '../dist/modules/banking-catalogs/quadratic-reconciliation.service.js';

const detail={
  header:{id:99,subsidiaryName:'EMPRESA DE PRUEBAS',subsidiaryLegalName:'Empresa de Pruebas, S.A.',taxId:'ID-123',bankName:'Banco Central',bankAccountNumber:'001-7788',ledgerAccountNumber:'110101',ledgerAccountName:'Bancos moneda local',currencyCode:'JMD',currencySymbol:'J$',periodYear:2026,periodMonth:10,status:'approved',reconciledByName:'Contador de prueba',approvedByName:'Aprobador de prueba'},
  matrix:{
    bankBase:{startBalance:1000,receipts:100,disbursements:40,endBalance:1060},
    bankAdjustments:{startBalance:0,receipts:0,disbursements:0,endBalance:0},
    bankAdjusted:{startBalance:1000,receipts:100,disbursements:40,endBalance:1060},
    bookBase:{startBalance:1000,receipts:95,disbursements:40,endBalance:1055},
    bookAdjustments:{startBalance:0,receipts:5,disbursements:0,endBalance:5},
    bookAdjusted:{startBalance:1000,receipts:100,disbursements:40,endBalance:1060},
    differences:{startBalance:0,receipts:0,disbursements:0,endBalance:0},balanced:true
  },
  continuity:{required:true,ok:true,expectedStartBalance:1000,actualStartBalance:1000,difference:0},
  items:[{id:1,itemType:'UNRECORDED_BANK_CREDIT',adjustmentSide:'BOOK',description:'Abono bancario no registrado',referenceNumber:'ABO-001',transactionDate:'2026-10-10',amount:5,impactStartBalance:0,impactReceipts:5,impactDisbursements:0,impactEndBalance:5}],
  statementLines:[{id:2,date:'2026-10-03',reference:'DEP-001',amount:100}],
  bookTransactions:[{id:3,date:'2026-10-03',reference:'DEP-001',amount:100}],
  matches:[{id:4,statementLineId:2,bankTransactionId:3,matchMethod:'AUTOMATIC',statementReference:'DEP-001',bookReference:'DEP-001',statementDate:'2026-10-03',bookDate:'2026-10-03',statementAmount:100,bookAmount:100,difference:0}]
};

const [pdf,excel]=await Promise.all([buildQuadraticReconciliationPdf(detail),buildQuadraticReconciliationExcel(detail)]);
assert.equal(pdf.mimeType,'application/pdf');
assert.equal(pdf.buffer.subarray(0,4).toString(),'%PDF');
assert.ok(pdf.buffer.length>10_000,'El PDF debe contener una composición completa.');
assert.match(pdf.fileName,/conciliacion-cuadratica-001-7788-2026-10\.pdf/);
assert.equal(excel.mimeType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
assert.equal(excel.buffer.subarray(0,2).toString(),'PK');
assert.ok(excel.buffer.length>10_000,'El Excel debe contener hojas y formato profesional.');
const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(excel.buffer);
assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['Prueba de efectivo','Partidas de conciliación','Punteo']);
assert.match(String(workbook.getWorksheet('Prueba de efectivo').getCell('A1').value),/CONCILIACIÓN CUADRÁTICA/);
assert.equal(workbook.getWorksheet('Prueba de efectivo').getCell('B14').value,0);
assert.match(String(workbook.getWorksheet('Partidas de conciliación').getCell('A4').value),/Crédito bancario/);
console.log(JSON.stringify({professionalPdf:true,pdfBytes:pdf.buffer.length,professionalExcel:true,excelBytes:excel.buffer.length,sheets:workbook.worksheets.map(sheet=>sheet.name)}));
