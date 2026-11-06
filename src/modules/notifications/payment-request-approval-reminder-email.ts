import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import {fetchSupabase,getSupabaseConfig} from '../../core/database/supabase.client.js';
import {pollMilliseconds,startAdaptivePoller} from '../../core/runtime/adaptive-poller.js';
import {publicAppUrl} from '../../shared/services/public-app-url.js';
import {rpc,smtpStatus} from './email-notification.service.js';
import {cleanBody,escapeHtml,validateTemplate} from './payment-email.js';
import {requireStatementSettingsAccess} from './statement-access.service.js';

export const paymentRequestApprovalReminderEmailKind='SOLICITUD_PAGO_RECORDATORIO_APROBACION';
export const paymentRequestApprovalReminderEmailTags=[
 'empresa_nombre','numero_solicitud','moneda','monto_total','beneficiario_nombre','concepto',
 'fecha_solicitud','fecha_pago_programada','solicitante_nombre','aprobador_nombre',
 'fecha_inicio_aprobacion','fecha_limite_recordatorio','tipo_solicitud','enlace_solicitud'
];
export const paymentRequestApprovalReminderEmailSubject='Recordatorio: solicitud {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}';
export const paymentRequestApprovalReminderEmailBody='<p>La solicitud de pago <strong>{{numero_solicitud}}</strong> continúa pendiente de su aprobación después de 48 horas de lunes a viernes.</p><p>El cómputo excluye los sábados y domingos completos. Consulte el estado actual en GENTIA para revisar y aprobar o rechazar la solicitud.</p>';

type Id=number|string;
export type PaymentRequestApprovalReminderSnapshot={
 requestId:Id;subsidiaryId:Id;instanceId:Id;approvalVersion:Id;approvalLevelId:Id;approverUserId:Id;
 assignmentId:string;reminderCycle:string;companyUtcOffsetMinutes:number;
 empresa_nombre:string|null;numero_solicitud:string|null;moneda:string|null;monto_total:number|string;
 beneficiario_nombre:string|null;concepto:string|null;fecha_solicitud:string|null;fecha_pago_programada:string|null;
 solicitante_nombre:string|null;aprobador_nombre:string|null;fecha_inicio_aprobacion:string;fecha_limite_recordatorio:string;
 tipo_solicitud:string|null;empresa_zona_horaria?:string|null;enlace_solicitud?:string;deepLink?:string;
};
export type PaymentRequestApprovalReminderEmailJob={
 id:string;lease:string;request_id:Id;subsidiary_id:Id;instance_id:Id;approval_version:Id;
 approval_level_id:Id;approver_user_id:Id;assignment_id:string;reminder_cycle:string;
 recipient_email:string;subject_template:string;body_template:string;payload:PaymentRequestApprovalReminderSnapshot;
};
type MailResult={accepted?:unknown[];messageId?:string};
type Finish=(status:string,messageId:string|null,error:string|null)=>Promise<unknown>;
const failure=(status:number,message:string)=>Object.assign(Error(message),{status});
function positiveId(value:unknown){
 if((typeof value!=='number'&&typeof value!=='string')||!Number.isSafeInteger(Number(value))||Number(value)<=0||!/^\d+$/.test(String(value)))throw Error('Identificador del recordatorio inválido.');
 return String(Number(value));
}
function uuid(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw Error('Reserva o asignación del recordatorio inválida.');return value.toLowerCase();}
function timestamp(value:unknown){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))throw Error('El recordatorio requiere fechas con zona explícita.');return Date.parse(value);}
function snapshotScope(snapshot:PaymentRequestApprovalReminderSnapshot){
 const assignmentId=uuid(snapshot.assignmentId),scope={requestId:positiveId(snapshot.requestId),subsidiaryId:positiveId(snapshot.subsidiaryId),instanceId:positiveId(snapshot.instanceId),version:positiveId(snapshot.approvalVersion),levelId:positiveId(snapshot.approvalLevelId),approverId:positiveId(snapshot.approverUserId),assignmentId};
 if(snapshot.reminderCycle!==`assignment:${assignmentId}`)throw Error('La asignación no corresponde al ciclo del recordatorio.');
 if(!Number.isInteger(snapshot.companyUtcOffsetMinutes)||Math.abs(snapshot.companyUtcOffsetMinutes)>840)throw Error('El desfase horario de la empresa no es válido.');
 if(timestamp(snapshot.fecha_inicio_aprobacion)>=timestamp(snapshot.fecha_limite_recordatorio))throw Error('El plazo del recordatorio no es válido.');
 return scope;
}
function notificationLink(snapshot:PaymentRequestApprovalReminderSnapshot){
 const scope=snapshotScope(snapshot),url=publicAppUrl({disallowLocalhost:true,rootOnly:true});
 if(url.hostname.toLowerCase()==='[::1]')throw Error('La URL pública no puede apuntar a localhost.');
 url.pathname='/payment-requests.html';url.search=new URLSearchParams({id:scope.requestId,subsidiaryId:scope.subsidiaryId}).toString();return url.toString();
}
const displayed=(value:unknown)=>typeof value==='string'&&value.trim()?value:'—';
const dateLabel=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('/'):displayed(value);
function zonedDate(value:string,snapshot:PaymentRequestApprovalReminderSnapshot){
 const offset=snapshot.companyUtcOffsetMinutes,sign=offset<0?'-':'+',absolute=Math.abs(offset),label=`UTC${sign}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`;
 const shifted=new Date(timestamp(value)+offset*60000),date=new Intl.DateTimeFormat('es-CR',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(shifted);
 return `${date} (${snapshot.empresa_zona_horaria?.trim()?snapshot.empresa_zona_horaria.trim()+' · ':''}${label})`;
}
function amountLabel(value:unknown){
 if(typeof value!=='number'&&typeof value!=='string')throw Error('El importe solicitado no es válido.');
 const text=String(value).trim();if(!/^\d{1,18}(?:\.\d{1,6})?$/.test(text)||!/[1-9]/.test(text))throw Error('El importe solicitado no es válido.');
 const[integer,fraction='']=text.split('.'),formatted=BigInt(integer!).toLocaleString('es-CR'),decimals=fraction.replace(/0+$/,'').padEnd(2,'0');return `${formatted},${decimals}`;
}
function validatedTemplate(subject:string,body:string){
 if(/[\x00-\x1f\x7f]/.test(subject))throw failure(400,'Ingrese un asunto de hasta 200 caracteres, sin saltos de línea ni controles.');
 try{return validateTemplate(subject,body,paymentRequestApprovalReminderEmailTags);}catch(cause){throw failure(400,cause instanceof Error?cause.message:'Revise la plantilla del recordatorio.');}
}
export function renderPaymentRequestApprovalReminderEmail(subject:string,body:string,snapshot:PaymentRequestApprovalReminderSnapshot){
 const template=validatedTemplate(subject,body),link=notificationLink(snapshot);
 const values:Record<string,string>={empresa_nombre:displayed(snapshot.empresa_nombre),numero_solicitud:displayed(snapshot.numero_solicitud),moneda:displayed(snapshot.moneda),monto_total:amountLabel(snapshot.monto_total),beneficiario_nombre:displayed(snapshot.beneficiario_nombre),concepto:displayed(snapshot.concepto),fecha_solicitud:dateLabel(snapshot.fecha_solicitud),fecha_pago_programada:dateLabel(snapshot.fecha_pago_programada),solicitante_nombre:displayed(snapshot.solicitante_nombre),aprobador_nombre:displayed(snapshot.aprobador_nombre),fecha_inicio_aprobacion:zonedDate(snapshot.fecha_inicio_aprobacion,snapshot),fecha_limite_recordatorio:zonedDate(snapshot.fecha_limite_recordatorio,snapshot),tipo_solicitud:displayed(snapshot.tipo_solicitud),enlace_solicitud:link};
 const merge=(text:string,html:boolean)=>text.replace(/{{\s*(\w+)\s*}}/g,(_match,key:string)=>html?escapeHtml(values[key]??''):values[key]??'');
 const renderedSubject=merge(template.subject,false).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200),intro=cleanBody(merge(template.body,true));
 const row=(label:string,value:string)=>`<tr><td style="padding:9px 0;color:#64748b;width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:9px 0;vertical-align:top;font-weight:700">${escapeHtml(value)}</td></tr>`;
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font:14px Arial,sans-serif;color:#172033"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="660" cellspacing="0" cellpadding="0" style="width:100%;max-width:660px;background:#fff;border:1px solid #dbe3ec"><tr><td style="padding:26px;background:#042e72;color:#fff"><div style="font-size:12px;letter-spacing:1px">APROBACIONES · RECORDATORIO</div><h1 style="font-size:23px;margin:12px 0">${escapeHtml(values.numero_solicitud)}</h1><div>${escapeHtml(values.empresa_nombre)}</div></td></tr><tr><td style="padding:26px;line-height:1.6">${intro}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${row('Aprobador destinatario',values.aprobador_nombre)}${row('Solicitante',values.solicitante_nombre)}${row('Beneficiario',values.beneficiario_nombre)}${row('Concepto',values.concepto)}${row('Tipo de solicitud',values.tipo_solicitud)}${row('Fecha de solicitud',values.fecha_solicitud)}${row('Pago programado',values.fecha_pago_programada)}${row('Inicio de la etapa pendiente',values.fecha_inicio_aprobacion)}${row('Plazo de 48 horas de lunes a viernes',values.fecha_limite_recordatorio)}</table><p style="margin-bottom:0;text-align:center;color:#526176">Importe solicitado</p><p style="padding:18px;background:#ecfdf5;font-size:22px;text-align:center;font-weight:700">${escapeHtml(values.monto_total)} ${escapeHtml(values.moneda)}</p><p style="text-align:center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#078464;color:#fff;text-decoration:none;padding:13px 20px;border-radius:7px;font-weight:700">Revisar solicitud pendiente</a></p><p style="font-size:12px;color:#64748b">Ingrese con su sesión autenticada y seleccione la empresa ${escapeHtml(values.empresa_nombre)}. Consulte el estado actual en GENTIA antes de aprobar o rechazar. Abrir este enlace no aprueba, rechaza ni ejecuta ningún pago.</p></td></tr><tr><td style="padding:16px 26px;background:#f8fafc;color:#64748b;font-size:12px">Recordatorio automático de ${escapeHtml(values.empresa_nombre)}. El detalle y los respaldos se consultan dentro de GENTIA.</td></tr></table></td></tr></table></body></html>`;
 const text=sanitizeHtml(html.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|tr|h1|div)>/gi,'\n').replace(/<\/t[dh]>/gi,' | '),{allowedTags:[],allowedAttributes:{}}).replace(/\n\s*\n\s*\n+/g,'\n\n').trim()+`\n\nConsultar solicitud: ${link}`;
 return{subject:renderedSubject,html,text};
}

export async function paymentRequestApprovalReminderTemplateSettings(authorization:string,action:string,payload:Record<string,unknown>={}){
 await requireStatementSettingsAccess(authorization,action);
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw failure(400,'Datos de plantilla inválidos.');
 const input=action==='save'?{...validatedTemplate(String(payload.subject||''),String(payload.body||'')),active:payload.active===true}:{};
 const config=getSupabaseConfig();if(!config)throw failure(503,'No fue posible conectar con el servicio de plantillas.');
 let response:Response;try{response=await fetchSupabase(new URL('/rest/v1/rpc/payment_request_approval_reminder_email_settings',config.url),{method:'POST',headers:{apikey:config.anonKey,Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify({p_action:action==='save'?'save':'get',p_payload:input})});}catch{throw failure(503,'No fue posible conectar con el servicio de plantillas.');}
 let data:Record<string,any>;try{data=await response.json();}catch{throw failure(503,'El servicio de plantillas no devolvió una respuesta válida.');}
 if(!response.ok){const status=response.status===401?401:response.status===403||data?.code==='42501'?403:response.status===400?400:response.status===429?429:503;throw failure(status,status===401?'Debe iniciar sesión.':status===403?'El rol activo no puede consultar o editar esta plantilla.':'No fue posible procesar la plantilla del recordatorio.');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw failure(503,'El servicio de plantillas no devolvió una respuesta válida.');
 if(action==='save')return data;
 if(data.template?.cuerpo_template)data.template.cuerpo_template=cleanBody(String(data.template.cuerpo_template));
 if(action==='preview')return renderPaymentRequestApprovalReminderEmail(String(payload.subject||paymentRequestApprovalReminderEmailSubject),String(payload.body||paymentRequestApprovalReminderEmailBody),{
  requestId:128,subsidiaryId:positiveId(data.subsidiary?.id),instanceId:42,approvalVersion:3,approvalLevelId:7,approverUserId:9,assignmentId:'00000000-0000-4000-8000-000000000128',reminderCycle:'assignment:00000000-0000-4000-8000-000000000128',companyUtcOffsetMinutes:Number.isInteger(data.subsidiary?.utcOffsetMinutes)?data.subsidiary.utcOffsetMinutes:0,
  empresa_nombre:String(data.subsidiary?.name||'Empresa de ejemplo'),numero_solicitud:'SOL-PAG-EJEMPLO-00128',moneda:'USD',monto_total:'4850.123456',beneficiario_nombre:'Beneficiario de ejemplo',concepto:'Servicios profesionales de ejemplo',fecha_solicitud:'2026-11-02',fecha_pago_programada:'2026-11-10',solicitante_nombre:'Persona solicitante de ejemplo',aprobador_nombre:'Persona aprobadora de ejemplo',fecha_inicio_aprobacion:'2026-11-02T16:00:00Z',fecha_limite_recordatorio:'2026-11-04T16:00:00Z',tipo_solicitud:'Otros pagos',empresa_zona_horaria:typeof data.subsidiary?.timezoneName==='string'?data.subsidiary.timezoneName:null
 });
 return{...data,transport:smtpStatus(),variables:paymentRequestApprovalReminderEmailTags,defaults:{subject:paymentRequestApprovalReminderEmailSubject,body:paymentRequestApprovalReminderEmailBody}};
}

function validRecipient(value:unknown){
 if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw Error('Destinatario aprobador inválido.');
 const email=value.trim(),parts=email.split('@');
 if(email.length>254||parts.length!==2||parts[0]!.length>64||!parts[0]||parts[0].startsWith('.')||parts[0].endsWith('.')||parts[0].includes('..')||!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(email))throw Error('Destinatario aprobador inválido.');return email;
}
function assertJobScope(job:PaymentRequestApprovalReminderEmailJob){
 uuid(job.id);uuid(job.lease);const scope=snapshotScope(job.payload);
 if(positiveId(job.request_id)!==scope.requestId||positiveId(job.subsidiary_id)!==scope.subsidiaryId||positiveId(job.instance_id)!==scope.instanceId||positiveId(job.approval_version)!==scope.version||positiveId(job.approval_level_id)!==scope.levelId||positiveId(job.approver_user_id)!==scope.approverId||uuid(job.assignment_id)!==scope.assignmentId||job.reminder_cycle!==job.payload.reminderCycle)throw Error('La cola no corresponde a la asignación vigente de la solicitud.');
 if(timestamp(job.payload.fecha_limite_recordatorio)>Date.now())throw Error('El recordatorio todavía no alcanzó su plazo.');
}
export async function deliverPaymentRequestApprovalReminderJob(job:PaymentRequestApprovalReminderEmailJob,send:(message:Record<string,unknown>)=>Promise<MailResult>,finish:Finish,authorize:()=>Promise<boolean>=async()=>false){
 let to:string,message:ReturnType<typeof renderPaymentRequestApprovalReminderEmail>;
 try{assertJobScope(job);to=validRecipient(job.recipient_email);message=renderPaymentRequestApprovalReminderEmail(job.subject_template,job.body_template,job.payload);}
 catch{await finish('ERROR',null,'No fue posible validar el destinatario, la asignación, el plazo o la plantilla del recordatorio.');return;}
 const weekday=new Date(Date.now()+job.payload.companyUtcOffsetMinutes*60000).getUTCDay();
 if(weekday===0||weekday===6){await finish('REINTENTO',null,'El recordatorio se retomará en un día de lunes a viernes.');return;}
 // SQL validates the live lease and assignment immediately before transport.
 // A false authorization already records its cancellation in the outbox.
 let authorized:boolean;try{authorized=await authorize();}catch{await finish('REINTENTO',null,'No fue posible revalidar la asignación antes de enviar el recordatorio.');return;}
 if(authorized!==true)return;
 const sendWeekday=new Date(Date.now()+job.payload.companyUtcOffsetMinutes*60000).getUTCDay();
 if(sendWeekday===0||sendWeekday===6){await finish('REINTENTO',null,'El recordatorio se retomará en un día de lunes a viernes.');return;}
 let result:MailResult;
 try{result=await send({from:process.env.SMTP_FROM,to,...message,disableFileAccess:true,disableUrlAccess:true});}
 catch(cause){const error=cause as {responseCode?:number;command?:string},code=Number(error?.responseCode||0),command=String(error?.command||'').toUpperCase();const status=code>=400&&code<500?'REINTENTO':code>=500?'ERROR':['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(command)?'REINTENTO':'INCIERTO';await finish(status,null,status==='REINTENTO'?'El servidor SMTP confirmó un fallo antes de aceptar el recordatorio.':status==='ERROR'?'El servidor SMTP rechazó el recordatorio.':'No se pudo confirmar el resultado SMTP. Revise el servidor antes de reenviar.');return;}
 const accepted=result.accepted?.some(address=>typeof address==='string'&&address.toLowerCase()===to.toLowerCase())===true;
 await finish(accepted?'ENVIADO':'ERROR',accepted?result.messageId??null:null,accepted?null:'El servidor SMTP no aceptó al destinatario aprobador.');
}

export function startPaymentRequestApprovalReminderNotifications(){
 if(!smtpStatus().enabled){console.log('Recordatorios de aprobación de pagos: envío SMTP desactivado.');return;}
 const port=Number(process.env.SMTP_PORT||587),transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
 const configured=Number(process.env.PAYMENT_REQUEST_REMINDER_COLLECT_MS||120000),collectionMilliseconds=Number.isFinite(configured)?Math.max(60000,Math.min(300000,Math.trunc(configured))):120000;
 // Collection is independent of queue activity. It never activates the short
 // active-poll interval and cannot scan the workflow once per delivered email.
 const stopCollect=startAdaptivePoller(async()=>{await rpc('payment_request_approval_reminder_email_collect',{});return false;},{idleMilliseconds:collectionMilliseconds,onError:()=>console.error('Recordatorios de aprobación de pagos: no se pudo revisar el trabajo pendiente.')});
 const stopQueue=startAdaptivePoller(async()=>{const job=await rpc('payment_request_approval_reminder_email_claim',{})as PaymentRequestApprovalReminderEmailJob|null;if(!job)return false;await deliverPaymentRequestApprovalReminderJob(job,message=>transport.sendMail(message),(status,messageId,error)=>rpc('payment_request_approval_reminder_email_finish',{p_id:job.id,p_lease:job.lease,p_status:status,p_message_id:messageId,p_error:error}),async()=>await rpc('payment_request_approval_reminder_email_authorize',{p_id:job.id,p_lease:job.lease})===true);return true;},{idleMilliseconds:pollMilliseconds(process.env.NOTIFICATION_QUEUE_POLL_MS),onError:()=>console.error('Recordatorios de aprobación de pagos: no se pudo completar el ciclo de la cola.')});
 return()=>{stopCollect();stopQueue();transport.close();};
}
