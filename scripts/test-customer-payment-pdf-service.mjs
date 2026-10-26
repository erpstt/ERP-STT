import assert from 'node:assert/strict';
import {
  buildCustomerPaymentPdfHtml,
  renderCustomerPaymentPdf
} from '../dist/modules/sales-catalogs/customer-payment-pdf.service.js';

const paymentNumber='COB_CLI-20261026194153919';
const detail={
  header:{
    payment_id:27,
    payment_number:paymentNumber,
    payment_date:'2026-10-22',
    subsidiary:'<script>alert("empresa")</script> S.T.T. HOLDINGS LIMITED',
    customer:'<img src=x onerror=alert("cliente")> EQUUS GLOBAL EXPANSION INC',
    bank:'JN Bank Limited',
    account:'2094351444',
    currency:'USD',
    exchange_rate:159.6451,
    bank_reference:'144410202601',
    memo:'Cobro de octubre <script>alert("nota")</script>',
    amount_received:35916.70,
    location:'Jamaica',
    status:'APROBADO'
  },
  applications:[
    {invoiceNumber:'FAC-00000672',invoiceTotal:8259.18,amount:8259.18},
    {invoiceNumber:'FAC-00000669',invoiceTotal:27657.52,amount:27657.52}
  ],
  advances:[],
  bankFee:{
    amount:29.61,
    expenseAccountNumber:'631002',
    expenseAccountName:'Comisiones y Gastos Bancarios'
  },
  impact:[
    {accountNumber:'111005',accountName:'Bancos Cuentas Corrientes Moneda Extranjera',debit:35887.09,credit:0},
    {accountNumber:'113001',accountName:'Cuentas por Cobrar Clientes',debit:0,credit:35916.70},
    {accountNumber:'631002',accountName:'Comisiones y Gastos Bancarios',debit:29.61,credit:0}
  ]
};

const html=buildCustomerPaymentPdfHtml(detail);
for(const content of[
  '@page{size:A4 portrait',
  'COMPROBANTE DE COBRO',
  paymentNumber,
  'Facturas aplicadas',
  'Impacto contable',
  'ASIENTO CUADRADO',
  'USD 35 916,70',
  'USD 29,61',
  'USD 35 887,09',
  '631002 · Comisiones y Gastos Bancarios'
])assert.ok(html.includes(content),`Falta contenido profesional o financiero: ${content}`);

assert.ok(html.includes('&lt;script&gt;alert(&quot;empresa&quot;)&lt;/script&gt;'));
assert.ok(html.includes('&lt;img src=x onerror=alert(&quot;cliente&quot;)&gt;'));
assert.ok(!html.includes('<script>alert("empresa")</script>'));
assert.ok(!html.includes('<img src=x onerror=alert("cliente")>'));
assert.ok(!html.includes('<script>alert("nota")</script>'));

const file=await renderCustomerPaymentPdf(detail),bytes=Buffer.from(file.base64,'base64');
assert.equal(file.fileName,`comprobante-cobro-${paymentNumber}.pdf`);
assert.equal(file.mimeType,'application/pdf');
assert.equal(bytes.subarray(0,4).toString(),'%PDF');
assert.ok(bytes.length>20_000,'El PDF renderizado parece incompleto.');

console.log(JSON.stringify({
  professionalHtml:true,
  appliedTotal:true,
  bankFee:true,
  netBankAmount:true,
  balancedJournal:true,
  escapedContent:true,
  realPdf:true,
  pdfBytes:bytes.length,
  fileName:file.fileName
}));
