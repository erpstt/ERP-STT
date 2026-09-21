import nodemailer from 'nodemailer';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { cleanBody, defaultBody, defaultSubject, renderPaymentEmail, validateTemplate, type PaymentSnapshot } from './payment-email.js';

export function smtpStatus() {
  const port = Number(process.env.SMTP_PORT || 587);
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_FROM && Number.isInteger(port) && port>0 && port<=65535);
  return {configured, enabled: configured && process.env.EMAIL_NOTIFICATIONS_ENABLED==='true'};
}
export async function rpc(name:string, parameters:Record<string,unknown>, authorization?:string) {
  const config=getSupabaseConfig();
  if(!config) throw Error('Supabase no está configurado.');
  const key=authorization?config.anonKey:process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key) throw Error('Falta la configuración del servicio de notificaciones.');
  const response=await (authorization?fetchSupabase:fetch)(new URL(`/rest/v1/rpc/${name}`,config.url),{method:'POST',headers:{apikey:key,Authorization:authorization||`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(parameters),signal:AbortSignal.timeout(20000)});
  const result=await response.json();
  if(!response.ok) throw Error(result?.message||'No fue posible procesar la notificación.');
  return result;
}
export async function notificationSettings(authorization:string, action:string, payload:Record<string,unknown>) {
  if(action==='save') {
    const template=validateTemplate(String(payload.subject||''),String(payload.body||''));
    return rpc('payment_email_settings',{p_action:'save',p_payload:{...template,active:payload.active===true}},authorization);
  }
  const data=await rpc('payment_email_settings',{p_action:'get'},authorization);
  if(data.template?.cuerpo_template)data.template.cuerpo_template=cleanBody(data.template.cuerpo_template);
  if(action==='preview') {
    const sample:PaymentSnapshot={empresa_nombre:data.subsidiary?.name||'Su empresa',empresa_logo_url:data.subsidiary?.logo,proveedor_nombre:'Proveedor de ejemplo',fecha_pago:'20/09/2026',referencia_pago:'TRF-EJEMPLO-001',moneda:'USD',total_pagado:980,aplicado:1000,retenciones:20,anticipos:0,invoices:[{number:'FAC-EJEMPLO-001',date:'15/09/2026',total:1500,applied:1000,withholding:20,withholdingDetail:'Retención 2%'}]};
    return renderPaymentEmail(String(payload.subject||defaultSubject),String(payload.body||defaultBody),sample);
  }
  if(action!=='get') throw Error('Acción inválida.');
  return {...data,transport:smtpStatus(),defaults:{subject:defaultSubject,body:defaultBody}};
}
export async function paymentNotifications(authorization:string,id:number,action:string,payload:Record<string,unknown>) {
  if(!Number.isSafeInteger(id)||id<=0)throw Error('Pago inválido.');
  if(action==='resend') {
    if(!smtpStatus().enabled) throw Error('El envío SMTP todavía no está activado en el servidor.');
    return rpc('payment_email_resend',{p_id:id,p_email:payload.email||null},authorization);
  }
  return {logs:await rpc('payment_email_history',{p_id:id},authorization),transport:smtpStatus()};
}

type Job={id:string;lease:string;destinatario:string;payload:PaymentSnapshot;asunto_template:string;cuerpo_template:string};
// A send with an unknown outcome is never retried automatically: SMTP cannot guarantee exactly-once delivery.
export async function deliverPaymentJob(job:Job,send:(message:Record<string,unknown>)=>Promise<{accepted?:unknown[];messageId?:string}>,finish:(status:string,message:string|null,error:string|null)=>Promise<unknown>) {
  let message:ReturnType<typeof renderPaymentEmail>;
  try {
    if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(job.destinatario))throw Error('Destinatario inválido.');
    message=renderPaymentEmail(job.asunto_template,job.cuerpo_template,job.payload);
  }catch {await finish('ERROR',null,'No fue posible validar el destinatario o la plantilla.');return;}
  let result;
  try {
    result=await send({from:process.env.SMTP_FROM,to:job.destinatario,...message,disableFileAccess:true,disableUrlAccess:true});
  }catch(cause) {
    const err=cause as {responseCode?:number;command?:string;code?:string};
    const knownRejection=!!err.responseCode || ['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(err.command||'');
    await finish(knownRejection?'ERROR':'INCIERTO',null,knownRejection?`El servidor SMTP rechazó el envío (${err.responseCode||err.code||'conexión'}).`:'No se pudo confirmar el resultado. Revise el SMTP antes de reenviar.');return;
  }
  // If persistence fails after SMTP acceptance, leave the lease for recovery as INCIERTO; never resend here.
  await finish(result.accepted?.length?'ENVIADO':'ERROR',result.messageId||null,result.accepted?.length?null:'El servidor no aceptó al destinatario.');
}
export function startEmailNotifications() {
  if(!smtpStatus().enabled) {console.log('Notificaciones de pagos: envío SMTP desactivado.');return;}
  const port=Number(process.env.SMTP_PORT||587);
  const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
  let running=false;
  const tick=async()=>{if(running)return;running=true;try {
    const job=await rpc('payment_email_claim',{}) as Job|null;
    if(job)await deliverPaymentJob(job,m=>transport.sendMail(m),(status,message,error)=>rpc('payment_email_finish',{p_id:job.id,p_lease:job.lease,p_status:status,p_message:message,p_error:error}));
  }catch {console.error('Notificaciones de pagos: no se pudo completar el ciclo de la cola.');}finally{running=false;}};
  const timer=setInterval(()=>void tick(),10000);timer.unref();void tick();
}
