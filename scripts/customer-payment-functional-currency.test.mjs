import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCustomerPaymentPdfHtml} from '../dist/modules/sales-catalogs/customer-payment-pdf.service.js';
test('receipt keeps applications in USD and accounting impact in JMD',()=>{
 const html=buildCustomerPaymentPdfHtml({header:{payment_number:'TEST',currency:'USD',impact_currency:'JMD',amount_received:27866.81},applications:[{invoiceNumber:'INV',invoiceTotal:27866.81,amount:27866.81}],impact:[{accountNumber:'113001',note:'Liquidación CxC a tasa histórica · TEST',historical_exchange_rate:158.9838,credit_fx:4430371.347678,credit:27751.376946,localDebit:0,localCredit:4430371.347678},{accountNumber:'422001',note:'Diferencial cambiario realizado · Cobro TEST',credit:115.433054,localDebit:0,localCredit:18428.321449},{accountNumber:'111005',debit:27837.21,localDebit:4444074.174171,localCredit:0},{accountNumber:'631002',debit:29.6,localDebit:4725.49496,localCredit:0}]});
 assert.match(html,/Impacto contable · JMD/);
 assert.ok(html.includes('USD '+(27866.81).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})));
 assert.ok(html.includes('JMD '+(18428.32).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})));
 assert.ok(!html.includes('USD '+(115.43).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})));
 assert.match(html,/Débito original USD/); assert.match(html,/Crédito original USD/);
 assert.match(html,/ASIENTO CUADRADO/);
});
