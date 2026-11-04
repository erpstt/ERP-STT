import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {pollMilliseconds,startAdaptivePoller} from '../../core/runtime/adaptive-poller.js';
import {publicAppUrl} from '../../shared/services/public-app-url.js';
import {rpc,smtpStatus} from './email-notification.service.js';
import {cleanBody,escapeHtml,validateTemplate} from './payment-email.js';
import {requireStatementSettingsAccess} from './statement-access.service.js';

export const paymentRequestApprovedEmailKind='SOLICITUD_PAGO_APROBADA';
export const paymentRequestApprovedEmailTags=[
 'empresa_nombre','numero_solicitud','moneda','monto_total','beneficiario_nombre','concepto',
 'fecha_solicitud','fecha_pago_programada','solicitante_nombre','aprobador_nombre','fecha_aprobacion',
 'tipo_solicitud','enlace_solicitud'
];
export const paymentRequestApprovedEmailSubject='Solicitud de pago {{numero_solicitud}} aprobada para Tesorería · {{empresa_nombre}}';
export const paymentRequestApprovedEmailBody='<p>La solicitud de pago <strong>{{numero_solicitud}}</strong> completó su aprobación y está lista para aplicar o ejecutar el pago en Tesorería.</p><p>Consulte su estado actual en GENTIA antes de ejecutar el pago.</p>';

type Id=number|string;
export type PaymentRequestApprovedSnapshot={
 requestId:Id;subsidiaryId:Id;instanceId:Id;approvalVersion:Id;approvalCycle:string;
 empresa_nombre:string|null;numero_solicitud:string|null;moneda:string|null;monto_total?:number|string;total?:number|string;
 beneficiario_nombre:string|null;concepto:string|null;fecha_solicitud:string|null;fecha_pago_programada:string|null;
 solicitante_nombre:string|null;aprobador_nombre:string|null;fecha_aprobacion:string|null;tipo_solicitud:string|null;
 empresa_zona_horaria?:string|null;
 enlace_solicitud?:string;deepLink?:string;
};
export type PaymentRequestApprovedEmailJob={
 id:string;lease:string;request_id:Id;subsidiary_id:Id;instance_id:Id;approval_version:Id;approval_cycle:string;
 recipient_email:string;subject_template:string;body_template:string;payload:PaymentRequestApprovedSnapshot;
};
type MailResult={accepted?:unknown[];messageId?:string};
type Finish=(status:string,messageId:string|null,error:string|null)=>Promise<unknown>;

function positiveId(value:unknown){
 if((typeof value!=='number'&&typeof value!=='string')||!Number.isSafeInteger(Number(value))||Number(value)<=0||!/^\d+$/.test(String(value)))throw Error('Identificador de la notificación inválido.');
 return String(Number(value));
}
function snapshotScope(snapshot:PaymentRequestApprovedSnapshot){
 const requestId=positiveId(snapshot.requestId),subsidiaryId=positiveId(snapshot.subsidiaryId),version=positiveId(snapshot.approvalVersion);
 const instanceId=positiveId(snapshot.instanceId);
 if(snapshot.approvalCycle!==`wf:${instanceId}`)throw Error('El ciclo de aprobación no corresponde a la solicitud.');
 return{requestId,subsidiaryId,instanceId,version};
}
function notificationLink(snapshot:PaymentRequestApprovedSnapshot){
 const{requestId,subsidiaryId}=snapshotScope(snapshot),url=publicAppUrl({disallowLocalhost:true,rootOnly:true});
 if(url.hostname.toLowerCase()==='[::1]')throw Error('La URL pública de GENTIA no puede apuntar a localhost.');
 url.pathname='/payment-requests.html';url.search=new URLSearchParams({id:requestId,subsidiaryId}).toString();
 return url.toString();
}
const displayed=(value:unknown)=>typeof value==='string'&&value.trim()?value:'—';
const dateLabel=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('/'):displayed(value);
function approvalDate(snapshot:PaymentRequestApprovedSnapshot){
 const value=snapshot.fecha_aprobacion;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return dateLabel(value);
 const date=new Date(value);if(!Number.isFinite(date.valueOf()))return displayed(value);
 let zone=snapshot.empresa_zona_horaria||'UTC';
 try{new Intl.DateTimeFormat('es-CR',{timeZone:zone}).format(date);}catch{zone='UTC';}
 return`${new Intl.DateTimeFormat('es-CR',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)} (${zone})`;
}

export function renderPaymentRequestApprovedEmail(subject:string,body:string,snapshot:PaymentRequestApprovedSnapshot){
 const template=validateTemplate(subject,body,paymentRequestApprovedEmailTags),link=notificationLink(snapshot);
 const rawAmount=snapshot.monto_total??snapshot.total,amount=Number(rawAmount);
 if(rawAmount===undefined||rawAmount===null||String(rawAmount).trim()===''||!Number.isFinite(amount)||amount<=0)throw Error('El importe aprobado no es válido.');
 const values:Record<string,string>={
  empresa_nombre:displayed(snapshot.empresa_nombre),numero_solicitud:displayed(snapshot.numero_solicitud),moneda:displayed(snapshot.moneda),
  monto_total:amount.toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:6}),beneficiario_nombre:displayed(snapshot.beneficiario_nombre),
  concepto:displayed(snapshot.concepto),fecha_solicitud:dateLabel(snapshot.fecha_solicitud),fecha_pago_programada:dateLabel(snapshot.fecha_pago_programada),
  solicitante_nombre:displayed(snapshot.solicitante_nombre),aprobador_nombre:displayed(snapshot.aprobador_nombre),fecha_aprobacion:approvalDate(snapshot),
  tipo_solicitud:displayed(snapshot.tipo_solicitud),enlace_solicitud:link
 };
 const merge=(text:string,html:boolean)=>text.replace(/{{\s*(\w+)\s*}}/g,(_match,key:string)=>html?escapeHtml(values[key]??''):values[key]??'');
 const renderedSubject=merge(template.subject,false).replace(/[\r\n\0]/g,' ').slice(0,200),intro=cleanBody(merge(template.body,true));
 const row=(label:string,value:string)=>`<tr><td style="padding:9px 0;color:#64748b;width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:9px 0;vertical-align:top;font-weight:700">${escapeHtml(value)}</td></tr>`;
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font:14px Arial,sans-serif;color:#172033"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="660" cellspacing="0" cellpadding="0" style="width:100%;max-width:660px;background:#fff;border:1px solid #dbe3ec"><tr><td style="padding:26px;background:#042e72;color:#fff"><div style="font-size:12px;letter-spacing:1px">TESORERÍA · SOLICITUD APROBADA</div><h1 style="font-size:23px;margin:12px 0">${escapeHtml(values.numero_solicitud)}</h1><div>${escapeHtml(values.empresa_nombre)}</div></td></tr><tr><td style="padding:26px;line-height:1.6">${intro}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${row('Beneficiario',values.beneficiario_nombre)}${row('Concepto',values.concepto)}${row('Tipo de solicitud',values.tipo_solicitud)}${row('Fecha de solicitud',values.fecha_solicitud)}${row('Pago programado',values.fecha_pago_programada)}${row('Solicitante',values.solicitante_nombre)}${row('Aprobado por',values.aprobador_nombre)}${row('Fecha de aprobación',values.fecha_aprobacion)}</table><p style="margin-bottom:0;text-align:center;color:#526176">Importe aprobado de la solicitud</p><p style="padding:18px;background:#ecfdf5;font-size:22px;text-align:center;font-weight:700">${escapeHtml(values.monto_total)} ${escapeHtml(values.moneda)}</p><p style="text-align:center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#078464;color:#fff;text-decoration:none;padding:13px 20px;border-radius:7px;font-weight:700">Revisar solicitud en Tesorería</a></p><p style="font-size:12px;color:#64748b">Ingrese con su sesión autenticada y seleccione la empresa ${escapeHtml(values.empresa_nombre)}. Consulte el estado actual en GENTIA antes de ejecutar el pago. Abrir este enlace no ejecuta ningún pago.</p></td></tr><tr><td style="padding:16px 26px;background:#f8fafc;color:#64748b;font-size:12px">Mensaje automático de ${escapeHtml(values.empresa_nombre)}. El detalle y los respaldos se consultan dentro de GENTIA.</td></tr></table></td></tr></table></body></html>`;
 const text=sanitizeHtml(html.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|tr|h1|div)>/gi,'\n').replace(/<\/t[dh]>/gi,' | '),{allowedTags:[],allowedAttributes:{}}).replace(/\n\s*\n\s*\n+/g,'\n\n').trim()+`\n\nConsultar solicitud: ${link}`;
 return{subject:renderedSubject,html,text};
}

export async function paymentRequestApprovedTemplateSettings(authorization:string,action:string,payload:Record<string,unknown>={}){
 await requireStatementSettingsAccess(authorization,action);
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Object.assign(Error('Datos de plantilla inválidos.'),{status:400});
 const input=action==='save'?{...validateTemplate(String(payload.subject||''),String(payload.body||''),paymentRequestApprovedEmailTags),active:payload.active===true}:{};
 const config=getSupabaseConfig();if(!config)throw Error('Supabase no está configurado.');
 const response=await fetchSupabase(new URL('/rest/v1/rpc/payment_request_approved_email_settings',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({p_action:action==='save'?'save':'get',p_payload:input})});
 const data=await response.json();
 if(!response.ok)throw Object.assign(Error(response.status===401?'Debe iniciar sesión.':response.status===403||data?.code==='42501'?'El rol activo no puede consultar o editar esta plantilla.':'No fue posible procesar la plantilla de solicitud aprobada.'),{status:response.status===401?401:response.status===403||data?.code==='42501'?403:response.status===400?400:500});
 if(action==='save')return data;
 if(data.template?.cuerpo_template)data.template.cuerpo_template=cleanBody(String(data.template.cuerpo_template));
 if(action==='preview')return renderPaymentRequestApprovedEmail(String(payload.subject||paymentRequestApprovedEmailSubject),String(payload.body||paymentRequestApprovedEmailBody),{
  requestId:128,subsidiaryId:positiveId(data.subsidiary?.id),instanceId:42,approvalVersion:3,approvalCycle:'wf:42',
  empresa_nombre:String(data.subsidiary?.name||'Empresa de ejemplo'),numero_solicitud:'SOL-PAG-EJEMPLO-00128',moneda:'USD',monto_total:4850.123456,
  beneficiario_nombre:'Beneficiario de ejemplo',concepto:'Servicios profesionales de ejemplo',fecha_solicitud:'2026-11-04',fecha_pago_programada:'2026-11-10',
  solicitante_nombre:'Persona solicitante de ejemplo',aprobador_nombre:'Persona aprobadora de ejemplo',fecha_aprobacion:'2026-11-04',tipo_solicitud:'Otros pagos'
 });
 return{...data,transport:smtpStatus(),variables:paymentRequestApprovedEmailTags,defaults:{subject:paymentRequestApprovedEmailSubject,body:paymentRequestApprovedEmailBody}};
}

function validRecipient(value:unknown){
 if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw Error('Destinatario de Tesorería inválido.');
 const email=value.trim(),parts=email.split('@');
 if(email.length>254||parts.length!==2||parts[0].length>64||!parts[0]||parts[0].startsWith('.')||parts[0].endsWith('.')||parts[0].includes('..')||!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(email))throw Error('Destinatario de Tesorería inválido.');
 return email;
}
function assertJobScope(job:PaymentRequestApprovedEmailJob){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.id)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.lease))throw Error('La cola no contiene una reserva de envío válida.');
 const scope=snapshotScope(job.payload);
 if(positiveId(job.request_id)!==scope.requestId||positiveId(job.subsidiary_id)!==scope.subsidiaryId||positiveId(job.approval_version)!==scope.version||job.approval_cycle!==job.payload.approvalCycle||positiveId(job.instance_id)!==scope.instanceId)throw Error('La cola no corresponde al alcance de la solicitud.');
}
export async function deliverPaymentRequestApprovedJob(job:PaymentRequestApprovedEmailJob,send:(message:Record<string,unknown>)=>Promise<MailResult>,finish:Finish){
 let to:string,message:ReturnType<typeof renderPaymentRequestApprovedEmail>;
 try{assertJobScope(job);to=validRecipient(job.recipient_email);message=renderPaymentRequestApprovedEmail(job.subject_template,job.body_template,job.payload);}
 catch{await finish('ERROR',null,'No fue posible validar el destinatario, el alcance o la plantilla de la solicitud aprobada.');return;}
 let result:MailResult;
 try{result=await send({from:process.env.SMTP_FROM,to,...message,disableFileAccess:true,disableUrlAccess:true});}
 catch(cause){
  const failure=cause as {responseCode?:number;command?:string};
  const responseCode=Number(failure?.responseCode||0),command=String(failure?.command||'').toUpperCase();
  const status=responseCode>=400&&responseCode<500?'REINTENTO':responseCode>=500?'ERROR':['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(command)?'REINTENTO':'INCIERTO';
  await finish(status,null,status==='REINTENTO'?'El servidor SMTP confirmó un fallo antes de aceptar la notificación.':status==='ERROR'?'El servidor SMTP rechazó la notificación de Tesorería.':'No se pudo confirmar el resultado SMTP. Revise el servidor antes de reenviar.');return;
 }
 const accepted=result.accepted?.some(address=>typeof address==='string'&&address.toLowerCase()===to.toLowerCase())===true;
 await finish(accepted?'ENVIADO':'ERROR',accepted?result.messageId??null:null,accepted?null:'El servidor SMTP no aceptó al destinatario de Tesorería.');
}

export function startPaymentRequestApprovedNotifications(){
 if(!smtpStatus().enabled){console.log('Solicitudes aprobadas para Tesorería: envío SMTP desactivado.');return;}
 const port=Number(process.env.SMTP_PORT||587),transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
 return startAdaptivePoller(async()=>{
  const job=await rpc('payment_request_approved_email_claim',{})as PaymentRequestApprovedEmailJob|null;if(!job)return false;
  await deliverPaymentRequestApprovedJob(job,message=>transport.sendMail(message),(status,messageId,error)=>rpc('payment_request_approved_email_finish',{p_id:job.id,p_lease:job.lease,p_status:status,p_message_id:messageId,p_error:error}));
  return true;
 },{idleMilliseconds:pollMilliseconds(process.env.NOTIFICATION_QUEUE_POLL_MS),onError:()=>console.error('Solicitudes aprobadas para Tesorería: no se pudo completar el ciclo de la cola.')});
}
