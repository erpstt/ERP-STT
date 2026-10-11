import assert from 'node:assert/strict';
import {
  deliverExpenseApprovalJob,
  expenseApprovalEmailBody,
  expenseApprovalEmailSubject,
  renderExpenseApprovalEmail
} from '../dist/modules/notifications/expense-approval-email.js';

const oldBase=process.env.APP_BASE_URL;
process.env.APP_BASE_URL='https://erp.example.test';
const payload={
  empresa_nombre:'Empresa <Prueba>',
  empresa_logo_url:'https://erp.example.test/logo.png',
  aprobador_nombre:'Ana & Equipo',
  numero_solicitud:'SOL-PAG-2026-00128',
  solicitante_nombre:'Carlos Solicitante',
  tipo_solicitud:'Otros Pagos',
  fecha_solicitud:'2026-10-05',
  fecha_pago_programada:'2026-10-10',
  moneda:'USD',
  monto_total:4850,
  concepto:'Servicio <urgente>',
  departamentos:'Operaciones',
  centros_costo:'CC-104 · Proyecto Regional',
  nivel_aprobacion:'Aprobación Proyectos (UP)',
  enlace_solicitud:'/payment-requests.html?id=128'
};

const rendered=renderExpenseApprovalEmail(expenseApprovalEmailSubject,expenseApprovalEmailBody,payload);
assert.match(rendered.subject,/SOL-PAG-2026-00128/);
assert.match(rendered.html,/Revisar y aprobar/);
assert.match(rendered.html,/https:\/\/erp\.example\.test\/payment-requests\.html\?id=128/);
assert.ok(!rendered.html.includes('Empresa <Prueba>'));
assert.match(rendered.html,/Empresa &lt;Prueba&gt;/);
assert.match(rendered.text,/Solicitudes de Pago/);
assert.throws(()=>renderExpenseApprovalEmail('Aviso {{variable_invalida}}',expenseApprovalEmailBody,payload),/Variable no admitida/);

const databaseSnapshot={...payload,monto_total:undefined,total:4850,departamentos:[],departamentos_texto:'Operaciones',centros_costo:undefined,centros_costos:[],centros_costos_texto:'CC-104 · Proyecto Regional',nivel_aprobacion:undefined,approvalLevelName:'Aprobación Proyectos (UP)',lineas:[{cuenta:'614014 · Impuestos y Tasas Municipales',tercero:'Municipalidad',departamento:'Operaciones',centroCosto:'CC-104 · Proyecto Regional',concepto:'Permiso anual',monto:4850}]};
const databaseRendered=renderExpenseApprovalEmail(expenseApprovalEmailSubject,expenseApprovalEmailBody,databaseSnapshot);
assert.match(databaseRendered.html,/4[. \s]?850,00/);
assert.match(databaseRendered.html,/Operaciones/);
assert.match(databaseRendered.html,/CC-104/);
assert.match(databaseRendered.html,/614014/);
assert.match(databaseRendered.html,/Aprobación Proyectos/);

// La forma del trabajo replica exactamente las columnas devueltas por
// expense_approval_email_claim(): subject_template y body_template.
const job={id:'job-1',lease:'lease-1',email:'ana@example.test',payload,subject_template:expenseApprovalEmailSubject,body_template:expenseApprovalEmailBody};
let sentMessage;
let completion;
await deliverExpenseApprovalJob(job,async message=>{sentMessage=message;return{accepted:['ana@example.test'],messageId:'mock-message'}},async(status,message,error)=>{completion={status,message,error}});
assert.equal(sentMessage.to,'ana@example.test');
assert.equal(completion.status,'ENVIADO');
assert.equal(completion.message,'mock-message');

const configuredBase=process.env.APP_BASE_URL;
process.env.APP_BASE_URL='http://localhost:3000';
const localOnly=renderExpenseApprovalEmail(expenseApprovalEmailSubject,expenseApprovalEmailBody,payload);
assert.doesNotMatch(localOnly.html,/Revisar y aprobar/);
assert.doesNotMatch(localOnly.html,/href="http:\/\/localhost/);
assert.match(localOnly.text,/Ingrese a GENTIA ERP/);
process.env.APP_BASE_URL=configuredBase;

completion=undefined;
await deliverExpenseApprovalJob({...job,id:'job-2',email:'correo-invalido'},async()=>{throw Error('No debe enviar')},async(status,message,error)=>{completion={status,message,error}});
assert.equal(completion.status,'ERROR');
assert.match(completion.error,/validar el destinatario/);

completion=undefined;
await deliverExpenseApprovalJob({...job,id:'job-3'},async()=>{const error=new Error('rejected');error.responseCode=550;throw error},async(status,message,error)=>{completion={status,message,error}});
assert.equal(completion.status,'ERROR');
assert.match(completion.error,/550/);

completion=undefined;
await deliverExpenseApprovalJob({...job,id:'job-4'},async()=>{const error=new Error('temporary');error.responseCode=451;error.command='RCPT TO';throw error},async(status,message,error)=>{completion={status,message,error}});
assert.equal(completion.status,'REINTENTO');
assert.match(completion.error,/reintentar/i);

completion=undefined;
await deliverExpenseApprovalJob({...job,id:'job-5'},async()=>{const error=new Error('connection timeout');error.code='ETIMEDOUT';error.command='CONN';throw error},async(status,message,error)=>{completion={status,message,error}});
assert.equal(completion.status,'REINTENTO');

completion=undefined;
await deliverExpenseApprovalJob({...job,id:'job-6'},async()=>{const error=new Error('timeout desconocido');error.code='ETIMEDOUT';error.command='DATA';throw error},async(status,message,error)=>{completion={status,message,error}});
assert.equal(completion.status,'INCIERTO');

if(oldBase===undefined)delete process.env.APP_BASE_URL;else process.env.APP_BASE_URL=oldBase;
console.log(JSON.stringify({render:true,databaseSnapshot:true,databaseJobShape:true,lineDetails:true,escaped:true,approvalLink:true,localhostLinkOmitted:true,instructions:true,mockDelivery:true,invalidRecipient:true,smtpRejection:true,transientRetry:true,unknownOutcome:true,realEmailsSent:0}));
