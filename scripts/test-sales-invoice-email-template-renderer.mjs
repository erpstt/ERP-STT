import assert from 'node:assert/strict';
import {renderSalesInvoiceEmail, salesInvoiceEmailBody, salesInvoiceEmailSubject} from '../dist/modules/notifications/sales-invoice-email.js';

const rendered=renderSalesInvoiceEmail(salesInvoiceEmailSubject,salesInvoiceEmailBody,{
 empresa_nombre:'NEXO & Compañía',
 cliente_nombre:'Cliente <Prueba>',
 numero_factura:'FAC-VEN-001',
 fecha_factura:'2026-09-28',
 fecha_vencimiento:'2026-10-28',
 total_factura:2450.5,
 moneda:'USD'
});
assert.equal(rendered.subject,'Factura FAC-VEN-001 · NEXO & Compañía');
assert.match(rendered.html,/Cliente &lt;Prueba&gt;/);
assert.match(rendered.html,/2[\s.]450,50 USD/);
assert.match(rendered.html,/PDF de la factura se incluye como adjunto/);
assert.doesNotMatch(rendered.html,/Cliente <Prueba>/);
assert.throws(()=>renderSalesInvoiceEmail('Factura {{variable_invalida}}',salesInvoiceEmailBody,{
 empresa_nombre:'NEXO',cliente_nombre:'Cliente',numero_factura:'1',fecha_factura:'2026-09-28',fecha_vencimiento:'2026-10-28',total_factura:1,moneda:'USD'
}),/Variable no admitida/);
console.log(JSON.stringify({subject:true,escaping:true,money:true,attachmentCopy:true,variableValidation:true}));
