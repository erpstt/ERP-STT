import assert from 'node:assert/strict';
import {test} from 'node:test';
import nodemailer from 'nodemailer';
import net from 'node:net';
import {
 paymentRequestApprovedEmailBody as body,paymentRequestApprovedEmailSubject as subject,
 renderPaymentRequestApprovedEmail,deliverPaymentRequestApprovedJob,startPaymentRequestApprovedNotifications
} from '../dist/modules/notifications/payment-request-approved-email.js';

function environment(t){
 const keys=['GENTIA_APP_URL','APP_BASE_URL','NEXO_APP_URL','RAILWAY_PUBLIC_DOMAIN','SMTP_FROM','EMAIL_NOTIFICATIONS_ENABLED'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)delete process.env[key];
 process.env.GENTIA_APP_URL='https://erp.example.invalid/ignored-path?ignored=1#ignored';process.env.SMTP_FROM='sender@example.invalid';process.env.EMAIL_NOTIFICATIONS_ENABLED='false';
 t.after(()=>{for(const[key,value]of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}
const snapshot=()=>({requestId:128,subsidiaryId:24,instanceId:42,approvalVersion:3,approvalCycle:'wf:42',empresa_nombre:'Empresa sintética',numero_solicitud:'SOL-PAG-SYN-128',moneda:'USD',monto_total:1234.123456,beneficiario_nombre:'Proveedor sintético A; Beneficiario sintético B',concepto:'Servicios profesionales',fecha_solicitud:'2026-11-04',fecha_pago_programada:'2026-11-10',solicitante_nombre:'Solicitante sintético',aprobador_nombre:'Aprobador sintético',fecha_aprobacion:'2026-11-04T17:30:00Z',empresa_zona_horaria:'America/Costa_Rica',tipo_solicitud:'Otros pagos',enlace_solicitud:'https://untrusted.example.invalid/execute?token=forbidden',deepLink:'javascript:alert(1)'});
const job=()=>({id:'00000000-0000-4000-8000-000000000128',lease:'00000000-0000-4000-8000-000000000042',request_id:128,subsidiary_id:24,instance_id:42,approval_version:3,approval_cycle:'wf:42',recipient_email:'treasury@example.invalid',subject_template:subject,body_template:body,payload:snapshot()});

test('approved notice includes required facts and a scoped authenticated read link, with no execution or attachments',t=>{
 environment(t);const result=renderPaymentRequestApprovedEmail(subject,body,snapshot());
 for(const text of ['SOL-PAG-SYN-128','Empresa sintética','USD','Proveedor sintético A','Beneficiario sintético B','Servicios profesionales','Solicitante sintético','Aprobador sintético','10/11/2026','Importe aprobado de la solicitud','1234,123456'])assert.ok((result.html+result.text).replace(/[.\u00a0\s]/g,'').includes(text.replace(/[.\u00a0\s]/g,'')),text);
 assert.ok(result.html.includes('https://erp.example.invalid/payment-requests.html?id=128&amp;subsidiaryId=24'));assert.ok(result.text.includes('https://erp.example.invalid/payment-requests.html?id=128&subsidiaryId=24'));
 for(const forbidden of ['untrusted.example.invalid','token=forbidden','javascript:','ignored-path','attachment','IBAN'])assert.ok(!result.html.includes(forbidden));
 assert.ok(result.text.includes('lista para aplicar o ejecutar el pago en Tesorería'));assert.ok(result.text.includes('Abrir este enlace no ejecuta ningún pago'));assert.ok(result.text.includes('estado actual'));assert.ok(!result.text.includes('importe pagado'));
});

test('calendar dates do not shift and approval timestamps use an explicit company zone or labelled UTC',t=>{
 environment(t);const data=snapshot(),result=renderPaymentRequestApprovedEmail(subject,body,data);assert.ok(result.text.includes('04/11/2026'));assert.ok(result.text.includes('11:30'));assert.ok(result.text.includes('(America/Costa_Rica)'));
 data.empresa_zona_horaria='Invalid/Zone';const fallback=renderPaymentRequestApprovedEmail(subject,body,data);assert.ok(fallback.text.includes('17:30'));assert.ok(fallback.text.includes('(UTC)'));
 data.empresa_zona_horaria=null;assert.ok(renderPaymentRequestApprovedEmail(subject,body,data).text.includes('(UTC)'));
});

test('missing nullable issuer fields render an em dash without substituting another company or person',t=>{
 environment(t);const data=snapshot();for(const key of ['empresa_nombre','numero_solicitud','moneda','beneficiario_nombre','concepto','fecha_solicitud','fecha_pago_programada','solicitante_nombre','aprobador_nombre','fecha_aprobacion','tipo_solicitud'])data[key]=null;
 const result=renderPaymentRequestApprovedEmail(subject,body,data);assert.ok(result.html.includes('—'));assert.ok(!result.html.includes('null'));assert.ok(!result.html.includes('undefined'));assert.ok(result.text.replace(/[.\u00a0\s]/g,'').includes('1234,123456'));
});

test('hostile business values and editable HTML remain text while header control characters cannot inject recipients',t=>{
 environment(t);const attack='"><img src=x onerror=alert(1)> & <b>texto</b>',data=snapshot();for(const key of ['empresa_nombre','beneficiario_nombre','concepto','solicitante_nombre','aprobador_nombre'])data[key]=attack;data.numero_solicitud='SYN\r\nBcc: injected@example.invalid';
 const result=renderPaymentRequestApprovedEmail(subject,'<script>alert(1)</script><p onclick="bad()">{{concepto}}</p><a href="javascript:bad()">Texto</a>',data);
 assert.ok(!/<(?:img|script)\b|<[^>]+\s(?:onerror|onclick)\s*=|href="javascript:/i.test(result.html));assert.ok(result.html.includes('&lt;img'));assert.ok(!/[\r\n\0]/.test(result.subject));
 assert.throws(()=>renderPaymentRequestApprovedEmail('Aviso\r\nBcc: bad@example.invalid',body,data),/sin saltos/);assert.throws(()=>renderPaymentRequestApprovedEmail('Aviso {{variable_ajena}}',body,data),/Variable no admitida/);
});

test('unsafe or missing public URL fails without sending an arbitrary snapshot URL',t=>{
 environment(t);for(const url of ['http://erp.example.invalid','https://localhost','https://[::1]','https://user:password@erp.example.invalid','javascript:alert(1)']){process.env.GENTIA_APP_URL=url;assert.throws(()=>renderPaymentRequestApprovedEmail(subject,body,snapshot()));}
 delete process.env.GENTIA_APP_URL;assert.throws(()=>renderPaymentRequestApprovedEmail(subject,body,snapshot()));
});

test('invalid amounts and unproven workflow cycles fail closed before delivery',async t=>{
 environment(t);for(const amount of [undefined,null,'',0,-1,NaN,Infinity]){const data=snapshot();data.monto_total=amount;assert.throws(()=>renderPaymentRequestApprovedEmail(subject,body,data),/importe/);}
 for(const change of [{instanceId:null,approvalCycle:'legacy:3'},{instanceId:0},{approvalVersion:0},{requestId:Number.MAX_SAFE_INTEGER+1},{subsidiaryId:'24/other'},{approvalCycle:'wf:99'}])assert.throws(()=>renderPaymentRequestApprovedEmail(subject,body,{...snapshot(),...change}));
});

test('delivery uses only the snapshotted Treasury recipient and disables file/URL access',async t=>{
 environment(t);const data=job(),mails=[],states=[];data.email='general@example.invalid';data.payload.email='other@example.invalid';
 await deliverPaymentRequestApprovedJob(data,async message=>{mails.push(message);return{accepted:[data.recipient_email],messageId:'synthetic-message'};},async(...args)=>states.push(args));
 assert.equal(mails.length,1);assert.equal(mails[0].to,'treasury@example.invalid');assert.equal(mails[0].from,'sender@example.invalid');assert.equal(mails[0].disableFileAccess,true);assert.equal(mails[0].disableUrlAccess,true);assert.equal(mails[0].attachments,undefined);assert.equal(mails[0].cc,undefined);assert.equal(mails[0].bcc,undefined);assert.deepEqual(states,[['ENVIADO','synthetic-message',null]]);
});

test('missing, malformed, multi-recipient and CRLF mailboxes never fall back to general email',async t=>{
 environment(t);for(const email of [undefined,null,'','bad','a@example.invalid,b@example.invalid','a@example.invalid;b@example.invalid','Name <a@example.invalid>','a@example.invalid\r\n','a@example.invalid\nBcc: b@example.invalid','a\0@example.invalid','(a)@example.invalid','a..b@example.invalid','x'.repeat(65)+'@example.invalid']){
  let sent=0;const states=[];await deliverPaymentRequestApprovedJob({...job(),recipient_email:email,email:'general@example.invalid'},async()=>{sent++;return{accepted:['general@example.invalid']};},async(...args)=>states.push(args));assert.equal(sent,0,String(email));assert.equal(states[0][0],'ERROR');
 }
});

test('tenant, request, workflow, version and lease mismatches are rejected before SMTP',async t=>{
 environment(t);for(const change of [{subsidiary_id:25},{request_id:129},{instance_id:43},{instance_id:null},{approval_version:4},{approval_cycle:'wf:43'},{id:'invalid'},{lease:'invalid'},{payload:{...snapshot(),subsidiaryId:25}},{payload:{...snapshot(),instanceId:null,approvalCycle:'legacy:3'}}]){
  let sends=0;const states=[];await deliverPaymentRequestApprovedJob({...job(),...change},async()=>{sends++;return{};},async(...args)=>states.push(args));assert.equal(sends,0);assert.equal(states[0][0],'ERROR');
 }
});

test('known SMTP rejections retry within the queue while ambiguous DATA outcomes remain INCIERTO',async t=>{
 environment(t);for(const[cause,status]of[[{responseCode:450},'REINTENTO'],[{responseCode:550},'ERROR'],[{command:'CONN'},'REINTENTO'],[{command:'AUTH'},'REINTENTO'],[{command:'RCPT TO'},'REINTENTO'],[{command:'DATA',code:'ETIMEDOUT'},'INCIERTO'],[new Error('Synthetic private SMTP detail'),'INCIERTO']]){
  let sends=0;const states=[];await deliverPaymentRequestApprovedJob(job(),async()=>{sends++;throw cause;},async(...args)=>states.push(args));assert.equal(sends,1);assert.equal(states[0][0],status);assert.ok(!JSON.stringify(states).includes('private'));
 }
});

test('SMTP acceptance is not retried if persistence subsequently fails',async t=>{
 environment(t);let sends=0,finishes=0;await assert.rejects(deliverPaymentRequestApprovedJob(job(),async()=>{sends++;return{accepted:['treasury@example.invalid'],messageId:'synthetic'};},async()=>{finishes++;throw Error('Synthetic persistence failure');}),/persistence/);assert.equal(sends,1);assert.equal(finishes,1);
});

test('a response that does not accept the exact Treasury recipient is not reported ENVIADO',async t=>{
 environment(t);for(const accepted of [[],['other@example.invalid']]){const states=[];await deliverPaymentRequestApprovedJob(job(),async()=>({accepted}),async(...args)=>states.push(args));assert.equal(states[0][0],'ERROR');}
});

test('in-memory Nodemailer composition preserves the exact envelope without opening a socket',async t=>{
 environment(t);let sockets=0;t.mock.method(net.Socket.prototype,'connect',()=>{sockets++;throw Error('Forbidden socket');});
 const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows',disableFileAccess:true,disableUrlAccess:true});t.after(()=>transport.close());let composed;
 await deliverPaymentRequestApprovedJob(job(),async message=>{composed=await transport.sendMail(message);return{accepted:composed.envelope.to,messageId:composed.messageId};},async status=>assert.equal(status,'ENVIADO'));
 assert.deepEqual(composed.envelope,{from:'sender@example.invalid',to:['treasury@example.invalid']});assert.ok(Buffer.isBuffer(composed.message));assert.ok(composed.message.toString().includes('payment-requests.html'));assert.equal(sockets,0);
});

test('disabled notification configuration starts no worker or SMTP connection',t=>{
 environment(t);t.mock.method(globalThis,'fetch',()=>{throw Error('Unexpected fetch');});t.mock.method(nodemailer,'createTransport',()=>{throw Error('Unexpected transport');});assert.equal(startPaymentRequestApprovedNotifications(),undefined);
});
