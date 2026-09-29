import assert from 'node:assert/strict';
import {buildSalesInvoicePdfHtml,deliverSalesInvoiceEmail,renderSalesInvoicePdf} from '../dist/modules/notifications/sales-invoice-delivery.service.js';

const document={
  id:77,number:'FAC-2026-001',issueDate:'2026-09-28',dueDate:'2026-10-28',memo:'Servicios <especiales>',total:1220,receivable:1200,
  company:{name:'Empresa de Pruebas',address:'San José'},customer:{name:'Cliente & Asociados',email:'facturas@example.invalid',address:'Costa Rica',taxId:'3-101-000001'},
  currency:{code:'USD',name:'Dólar estadounidense',symbol:'$'},paymentTerm:'Neto 30',withholdingTotal:20,
  lines:[{product:'Consultoría',description:'Implementación',serviceCountry:'Costa Rica',quantity:1,unitPrice:1000,amount:1000,taxRate:22,taxAmount:220,grossAmount:1220}],
  supports:[
    {type:'Archivo',name:'Orden de compra',fileName:'orden.pdf',mimeType:'application/pdf',fileSize:6,fileData:'data:application/pdf;base64,JVBERi0x'},
    {type:'Enlace',name:'Portal del proyecto',url:'https://example.com/respaldo?id=7'},
    {type:'Enlace',name:'Enlace inseguro',url:'javascript:alert(1)'}
  ]
};

const html=buildSalesInvoicePdfHtml(document);
assert.ok(html.startsWith('<!doctype html>'));
assert.match(html,/País de servicio/);
assert.match(html,/Costa Rica/);
assert.ok(!html.includes('Servicios <especiales>'));
assert.match(html,/Servicios &lt;especiales&gt;/);

let sent;
const result=await deliverSalesInvoiceEmail(document,{subject:'Factura {{numero_factura}} · {{empresa_nombre}}',body:'<p>Hola <strong>{{cliente_nombre}}</strong></p>'},async message=>{sent=message;return{accepted:[document.customer.email],messageId:'mock-77'};},async()=>({fileName:'factura-FAC-2026-001.pdf',mimeType:'application/pdf',base64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64')}));
assert.equal(result.status,'ENVIADO');
assert.equal(result.recipient,document.customer.email);
assert.equal(result.attachments.length,2);
assert.equal(result.links,1);
assert.equal(sent.to,document.customer.email);
assert.equal(sent.disableFileAccess,true);
assert.equal(sent.disableUrlAccess,true);
assert.equal(sent.attachments[0].content.subarray(0,4).toString(),'%PDF');
assert.equal(sent.attachments[1].filename,'orden.pdf');
assert.match(sent.html,/https:\/\/example\.com\/respaldo\?id=7/);
assert.ok(sent.html.indexOf('https://example.com/respaldo?id=7')<sent.html.indexOf('Este mensaje fue generado'));
assert.ok(!sent.html.includes('<!--support-links-->'));
assert.ok(!sent.html.includes('javascript:'));

await assert.rejects(()=>deliverSalesInvoiceEmail({...document,customer:{...document.customer,email:'correo-invalido'}},{subject:'Factura {{numero_factura}}',body:'<p>Factura</p>'},async()=>{throw Error('No debe enviar');}),/correo electrónico válido/);
await assert.rejects(()=>deliverSalesInvoiceEmail({...document,supports:[{type:'Archivo',name:'Dañado',fileData:'data:text/plain;base64,'}]},{subject:'Factura {{numero_factura}}',body:'<p>Factura</p>'},async()=>({accepted:[document.customer.email]}),async()=>({fileName:'factura.pdf',mimeType:'application/pdf',base64:Buffer.from('%PDF').toString('base64')})),/archivo válido|supera 5 MB|vacío/);

const pdf=await renderSalesInvoicePdf({...document,supports:[]});
assert.equal(Buffer.from(pdf.base64,'base64').subarray(0,4).toString(),'%PDF');
assert.match(pdf.fileName,/^factura-FAC-2026-001\.pdf$/);

console.log(JSON.stringify({professionalPdf:true,directPdf:true,recipientFromCustomer:true,invoiceAttached:true,supportFilesAttached:true,supportLinksInBody:true,unsafeLinksIgnored:true,noExternalAttachmentFetch:true,invalidEmailRejected:true,noRealEmails:true}));
