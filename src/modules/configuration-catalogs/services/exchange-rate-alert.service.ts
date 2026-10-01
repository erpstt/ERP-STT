import nodemailer from 'nodemailer';
import { fetchSupabase, getSupabaseConfig } from '../../../core/database/supabase.client.js';
import { smtpStatus } from '../../notifications/email-notification.service.js';

type FailureInput={countryCode:string;countryName:string;currencyPair:string;effectiveDate:string;cause:unknown};
type Incident={incident_id:number;notified_at:string|null};
type Role={role_id:number};
type UserRole={user_id:number};
type User={email:string};
type MailResult={accepted?:unknown[];messageId?:string};
type MailSender=(message:Record<string,unknown>)=>Promise<MailResult>;

function message(cause:unknown){return(cause instanceof Error?cause.message:String(cause||'Error desconocido')).slice(0,1500);}
function esc(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]||char));}
function serviceHeaders(extra:Record<string,string>={}){const config=getSupabaseConfig(),key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!config||!key)throw Error('Falta la configuración de Supabase para registrar la alerta.');return{config,key,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...extra}};}
async function rest<T>(path:string,init:RequestInit={}):Promise<T>{const{config,headers}=serviceHeaders((init.headers||{})as Record<string,string>),response=await fetchSupabase(new URL(`/rest/v1/${path}`,config.url),{...init,headers}),raw=await response.text();let payload:unknown=null;try{payload=raw?JSON.parse(raw):null;}catch{payload=raw;}if(!response.ok)throw Error(typeof payload==='object'&&payload&&'message'in payload?String(payload.message):`Supabase respondió ${response.status}.`);return payload as T;}
async function recipients(){const roles=await rest<Role[]>('roles?select=role_id&role_name=in.(Administrador,Administrator,Admin)');if(!roles.length)return[];const roleIds=roles.map(row=>row.role_id).join(','),links=await rest<UserRole[]>(`user_roles?select=user_id&role_id=in.(${roleIds})`);if(!links.length)return[];const userIds=[...new Set(links.map(row=>row.user_id))].join(','),users=await rest<User[]>(`users?select=email&is_active=eq.true&user_id=in.(${userIds})`);return[...new Set(users.map(row=>row.email.trim().toLowerCase()).filter(email=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)))];}
async function saveFailure(input:FailureInput,error:string){const body={country_code:input.countryCode,currency_pair:input.currencyPair,effective_date:input.effectiveDate,error_message:error,last_failed_at:new Date().toISOString(),resolved_at:null};const rows=await rest<Incident[]>('exchange_rate_update_incidents?on_conflict=country_code,currency_pair,effective_date',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(body)});const incident=rows[0];if(!incident)throw Error('No fue posible registrar el incidente del tipo de cambio.');return incident;}
async function patchIncident(id:number,payload:Record<string,unknown>){await rest(`exchange_rate_update_incidents?incident_id=eq.${id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(payload)});}

export async function reportExchangeRateFailure(input:FailureInput,sendOverride?:MailSender){
  const error=message(input.cause),incident=await saveFailure(input,error);
  if(incident.notified_at)return{sent:false,reason:'already-notified'};
  const emails=await recipients();
  if(!emails.length){await patchIncident(incident.incident_id,{last_notification_error:'No hay usuarios administradores activos con correo válido.'});return{sent:false,reason:'no-recipients'};}
  if(!smtpStatus().enabled){await patchIncident(incident.incident_id,{last_notification_error:'El envío SMTP está desactivado o incompleto.'});return{sent:false,reason:'smtp-disabled'};}
  const port=Number(process.env.SMTP_PORT||587),transport=sendOverride?null:nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
  try{
    const mail={from:process.env.SMTP_FROM,to:process.env.SMTP_FROM,bcc:emails,subject:`GENTIA · No se actualizó el tipo de cambio ${input.currencyPair}`.slice(0,200),text:`No fue posible actualizar el tipo de cambio ${input.currencyPair} de ${input.countryName} para ${input.effectiveDate}.\n\nDetalle: ${error}\n\nEl sistema volverá a intentarlo en la siguiente ejecución programada.`,html:`<div style="background:#f4f7fb;padding:28px;font-family:Arial,sans-serif;color:#12233f"><div style="max-width:680px;margin:auto;background:#fff;border:1px solid #dbe4ef;border-radius:14px;overflow:hidden"><div style="background:#073b7a;color:#fff;padding:22px 26px"><div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#55d6be">GENTIA · ALERTA OPERATIVA</div><h1 style="font-size:22px;margin:8px 0 0">No se actualizó un tipo de cambio</h1></div><div style="padding:26px"><p>El proceso automático no pudo guardar el tipo de cambio de <strong>${esc(input.countryName)}</strong>.</p><table style="width:100%;border-collapse:collapse;margin:20px 0"><tr><td style="padding:10px;border-bottom:1px solid #e5ebf2;color:#60708a">Par de monedas</td><td style="padding:10px;border-bottom:1px solid #e5ebf2;font-weight:700">${esc(input.currencyPair)}</td></tr><tr><td style="padding:10px;border-bottom:1px solid #e5ebf2;color:#60708a">Fecha efectiva</td><td style="padding:10px;border-bottom:1px solid #e5ebf2;font-weight:700">${esc(input.effectiveDate)}</td></tr></table><div style="background:#fff4f2;border-left:4px solid #eb5b4b;padding:14px;border-radius:6px"><strong>Detalle técnico</strong><br><span style="color:#66332e">${esc(error)}</span></div><p style="margin:22px 0 0;color:#60708a">GENTIA volverá a intentarlo en la siguiente ejecución programada.</p></div></div></div>`,disableFileAccess:true,disableUrlAccess:true};
    const result=await(sendOverride?sendOverride(mail):transport!.sendMail(mail));
    if(!result.accepted?.length)throw Error('El servidor SMTP no aceptó ningún destinatario.');
    await patchIncident(incident.incident_id,{notified_at:new Date().toISOString(),last_notification_error:null});
    return{sent:true,recipients:emails.length};
  }catch(cause){const notificationError=message(cause);await patchIncident(incident.incident_id,{last_notification_error:notificationError}).catch(()=>undefined);throw Error(`No fue posible enviar la alerta de tipo de cambio: ${notificationError}`);}
  finally{transport?.close();}
}

export async function resolveExchangeRateFailure(countryCode:string,currencyPair:string,effectiveDate:string){
  try{await rest(`exchange_rate_update_incidents?country_code=eq.${encodeURIComponent(countryCode)}&currency_pair=eq.${encodeURIComponent(currencyPair)}&effective_date=eq.${effectiveDate}&resolved_at=is.null`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({resolved_at:new Date().toISOString()})});}
  catch(cause){console.error(`[TipoCambio${countryCode}] No fue posible cerrar un incidente previo:`,message(cause));}
}
