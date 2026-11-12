import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCustomerEmailRecipients as parse} from '../public/customer-email-recipients.js';
import {deliverSalesInvoiceEmail} from '../dist/modules/notifications/sales-invoice-delivery.service.js';
import {deliverStatement,statementSubject,statementBody} from '../dist/modules/notifications/customer-statement.js';
const invoice={id:1,number:'SYN-1',issueDate:'2026-11-12',dueDate:'2026-11-12',memo:'',total:10,receivable:10,company:{name:'Synthetic company',address:''},customer:{name:'Synthetic customer',email:'one@example.invalid',address:'',taxId:''},currency:{code:'USD',name:'USD',symbol:'$'},paymentTerm:'',withholdingTotal:0,lines:[],supports:[]};
const template={subject:'Factura {{numero_factura}}',body:'<p>Factura</p>'},pdf=async()=>({fileName:'synthetic.pdf',mimeType:'application/pdf',base64:Buffer.from('%PDF-fixture').toString('base64')});
test('normalizes comma/semicolon lists, preserves addresses and removes repeated recipients',()=>{assert.deepEqual(parse(' one@example.invalid; Two@example.invalid,ONE@example.invalid; '),['one@example.invalid','Two@example.invalid']);assert.deepEqual(parse(''),[]);for(const value of ['bad@','one@example.invalid,invalid','one@example.invalid\r\nBcc: attacker@example.invalid','Name <one@example.invalid>','.one@example.invalid','one..two@example.invalid','one@-example.invalid',Array.from({length:21},(_,i)=>`email${i}@example.invalid`).join(',')])assert.throws(()=>parse(value),value);});
test('invoice sends the PDF to every unique recipient, retains single-recipient behavior and reports partial SMTP acceptance',async()=>{
 for(const [value,expected]of [[' one@example.invalid ','one@example.invalid'],['one@example.invalid;Two@example.invalid,ONE@example.invalid',['one@example.invalid','Two@example.invalid']]]){
  let sent;const result=await deliverSalesInvoiceEmail({...invoice,customer:{...invoice.customer,email:value}},template,async m=>{sent=m;return{accepted:Array.isArray(m.to)?m.to:[m.to],messageId:'mock'};},pdf);
  assert.deepEqual(sent.to,expected);assert.equal(result.status,'ENVIADO');assert.equal(sent.attachments.length,1);
 }
 const partial=await deliverSalesInvoiceEmail({...invoice,customer:{...invoice.customer,email:'one@example.invalid;two@example.invalid'}},template,async()=>({accepted:['one@example.invalid']}),pdf);assert.equal(partial.status,'PARCIAL');
 let calls=0;await assert.rejects(()=>deliverSalesInvoiceEmail({...invoice,customer:{...invoice.customer,email:'one@example.invalid;bad'}},template,async()=>{calls++;},pdf));assert.equal(calls,0);
});
test('statements use the same list and do not mark partial delivery as fully sent',async()=>{
 const job={destinatario:'one@example.invalid;two@example.invalid',asunto_template:statementSubject,cuerpo_template:statementBody,payload:{empresa_nombre:'Synthetic',cliente_nombre:'Customer',fecha_corte:'2026-11-12',saldo_total:10,moneda:'USD'}};
 let sent,finished;await deliverStatement(job,async m=>{sent=m;return{accepted:m.to,messageId:'mock'};},async(...a)=>finished=a,pdf);assert.deepEqual(sent.to,['one@example.invalid','two@example.invalid']);assert.equal(finished[0],'ENVIADO');
 await deliverStatement(job,async()=>({accepted:['one@example.invalid']}),async(...a)=>finished=a,pdf);assert.equal(finished[0],'INCIERTO');
});
