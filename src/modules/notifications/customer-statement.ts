import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { cleanBody, escapeHtml as esc, validateTemplate } from './payment-email.js';
import { rpc, smtpStatus } from './email-notification.service.js';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';

export const statementTags=['empresa_nombre','cliente_nombre','fecha_corte','saldo_total','moneda'];
export const statementSubject='Estado de cuenta · {{empresa_nombre}} · {{fecha_corte}}';
export const statementBody='<p>Estimado/a <strong>{{cliente_nombre}}</strong>,</p><p>Adjunto encontrará su estado de cuenta con fecha de corte al {{fecha_corte}}, por un saldo pendiente de {{saldo_total}} {{moneda}}.</p><p>Le invitamos a revisar el PDF adjunto. Para cualquier consulta, contacte a nuestro departamento de cobros.</p>';
type Row={document_number:string;issue_date:string;due_date:string;overdue_days:number;original_amount:number;applied_amount:number;pending:number;bucket:string};
export type Statement={empresa_nombre:string;empresa_logo_url?:string;address?:string;cliente_nombre:string;customerCode:string;email:string;fecha_corte:string;saldo_total:number;moneda:string;note?:string;rows:Row[];summary:{subledger:number;advances:number;netBalance:number}};
const money=(v:unknown)=>Number(v||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const date=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v.split('-').reverse().join('/'):v;
export function renderStatementEmail(subject:string,body:string,s:Statement){
 const valid=validateTemplate(subject,body,statementTags);
 const values:Record<string,string>={empresa_nombre:s.empresa_nombre,cliente_nombre:s.cliente_nombre,fecha_corte:date(s.fecha_corte),saldo_total:money(s.saldo_total),moneda:s.moneda};
 const merge=(v:string,html:boolean)=>v.replace(/{{\s*(\w+)\s*}}/g,(_,key:string)=>html?esc(values[key]):values[key]);
 const logo=s.empresa_logo_url&&/^https:\/\//.test(s.empresa_logo_url)?`<img src="${esc(s.empresa_logo_url)}" alt="${esc(s.empresa_nombre)}" style="max-height:60px;max-width:200px">`:'';
 const html=`<!doctype html><html lang="es"><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><div style="max-width:650px;margin:24px auto;background:white;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden"><div style="background:#0f172a;padding:24px;text-align:center;color:white">${logo}<p>${esc(s.empresa_nombre)}</p></div><div style="padding:30px;line-height:1.6"><h1 style="font-size:24px;color:#0f172a">Estado de Cuenta Mensual</h1>${cleanBody(merge(valid.body,true))}<div style="background:#f8fafc;border-left:4px solid #3b82f6;padding:18px;margin:22px 0"><small>Saldo total pendiente al ${esc(date(s.fecha_corte))}</small><p style="font-size:26px;font-weight:bold;margin:6px 0">${money(s.saldo_total)} ${esc(s.moneda)}</p></div>${s.note?`<p style="white-space:pre-wrap">${esc(s.note)}</p>`:''}<p>Consulte el PDF adjunto para revisar el detalle de sus documentos y aplicaciones.</p></div></div></body></html>`;
 return {subject:merge(valid.subject,false).replace(/[\r\n]/g,' ').slice(0,200),html,text:`${s.empresa_nombre}\nEstado de cuenta al ${date(s.fecha_corte)}\n${s.cliente_nombre}\nSaldo pendiente: ${money(s.saldo_total)} ${s.moneda}\n${s.note||''}\nConsulte el PDF adjunto.`};
}
export async function statementPdf(s:Statement){
 let html=await readFile('public/account-statement.html','utf8');
 const css=await readFile('public/account-statement.css','utf8');
 const set=(id:string,value:string)=>{html=html.replace(new RegExp(`(<[^>]+id="${id}"[^>]*>)[\\s\\S]*?(</[^>]+>)`),`$1${value.replace(/\$/g,'$$$$')}$2`);};
 html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<nav>[\s\S]*?<\/nav>/,'').replace(/<link[^>]+>/g,`<style>${css}</style>`).replace('id="statement" hidden','id="statement"');
 // PDF generation never fetches remote assets. Embedded company logos are safe to print offline.
 const embedded=s.empresa_logo_url&&/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(s.empresa_logo_url)&&s.empresa_logo_url.length<2_000_000;
 html=html.replace('<img id="logo" hidden>',embedded?`<img id="logo" src="${s.empresa_logo_url}">`:'');
 const fields:Record<string,string>={company:s.empresa_nombre,companyAddress:s.address||'',footerCompany:s.empresa_nombre,statementType:'CUENTAS POR COBRAR',cutoff:`Fecha de corte: ${date(s.fecha_corte)}`,partyLabel:'Cliente',partyName:s.cliente_nombre,partyCode:`Código: ${s.customerCode}`,partyContact:s.email,partyTax:'',balance:`${money(s.saldo_total)} ${s.moneda}`,currencyLabel:`Moneda local (${s.moneda})`,documentTotal:money(s.summary.subledger),invoiceBalance:money(s.summary.subledger),advances:money(s.summary.advances),netBalance:money(s.saldo_total)};
 for(const [id,value]of Object.entries(fields))set(id,esc(value));
 const buckets:Record<string,string>={CURRENT:'Por vencer','1_30':'1–30 días','31_60':'31–60 días','61_90':'61–90 días','91_120':'91–120 días',OVER_120:'Más de 120 días'};
 set('aging',Object.entries(buckets).map(([key,label])=>`<div><small>${label}</small><strong>${money(s.rows.filter(r=>r.bucket===key).reduce((total,r)=>total+Number(r.pending),0))}</strong></div>`).join(''));
 set('documents',s.rows.map(r=>`<tr><td>${esc(r.document_number)}</td><td>${esc(date(r.issue_date))}</td><td>${esc(date(r.due_date))}</td><td class="num">${esc(r.overdue_days)}</td><td class="num">${money(r.original_amount)}</td><td class="num">${money(r.applied_amount)}</td><td class="num">${money(r.pending)}</td></tr>`).join(''));
 html=html.replace('</head>','<style>@page{size:A4;margin:14mm}thead{display:table-header-group}tr{break-inside:avoid}body{background:white}</style></head>');
 return renderBankReconciliationPdf({html,fileName:`estado_cuenta_${s.customerCode}_${s.fecha_corte}.pdf`});
}
export async function statementSettings(authorization:string,action:string,payload:Record<string,unknown>){
 if(action==='save'){const day=Number(payload.day??1),time=String(payload.time??'08:00');if(!Number.isInteger(day)||day<1||day>31||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Seleccione un día entre 1 y 31 y una hora válida.');const valid=validateTemplate(String(payload.subject||''),String(payload.body||''),statementTags);return rpc('statement_settings',{p_action:'save',p_payload:{...valid,active:payload.active===true,day,time}},authorization);}
 const data=await rpc('statement_settings',{p_action:'get'},authorization);
 if(action==='preview')return renderStatementEmail(String(payload.subject||statementSubject),String(payload.body||statementBody),{empresa_nombre:data.subsidiary.name,empresa_logo_url:data.subsidiary.logo,cliente_nombre:'Cliente de ejemplo',customerCode:'CLI-EJEMPLO',email:'cliente@example.invalid',fecha_corte:'2026-08-31',saldo_total:1500,moneda:'USD',rows:[],summary:{subledger:1500,advances:0,netBalance:1500}});
 if(data.template)data.template.cuerpo_template=cleanBody(data.template.cuerpo_template);
 return {...data,transport:smtpStatus(),defaults:{subject:statementSubject,body:statementBody}};
}
export async function customerStatement(authorization:string,id:number,action:string,payload:Record<string,unknown>){
 if(!Number.isSafeInteger(id)||id<=0)throw Error('Cliente inválido.');
 const cutoff=String(payload.cutoff||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoff))throw Error('Seleccione la fecha de corte.');
 if(action==='send'){
  if(!smtpStatus().enabled)throw Error('El envío SMTP todavía no está activado en el servidor.');
  return rpc('statement_send',{p_customer:id,p_cutoff:cutoff,p_note:String(payload.note||''),p_request:payload.requestId,p_sid:payload.subsidiaryId||null},authorization);
 }
 const data=await rpc('statement_customer',{p_customer:id,p_cutoff:cutoff,p_sid:payload.subsidiaryId||null},authorization);
 if(action==='pdf')return statementPdf(data.statement);
 return {...data,transport:smtpStatus()};
}
export async function deliverStatement(job:any,send:(message:any)=>Promise<any>,finish:(status:string,message:string|null,error:string|null)=>Promise<unknown>,pdf=statementPdf){
 let message,attachment;
 try{if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(job.destinatario))throw Error();message=renderStatementEmail(job.asunto_template,job.cuerpo_template,job.payload);attachment=await pdf(job.payload);}catch{await finish('ERROR',null,'No fue posible preparar el correo o generar el PDF.');return;}
 let result;
 try{result=await send({from:process.env.SMTP_FROM,to:job.destinatario,...message,attachments:[{filename:attachment.fileName,content:Buffer.from(attachment.base64,'base64'),contentType:'application/pdf'}],disableFileAccess:true,disableUrlAccess:true});}
 catch(cause){const e=cause as {responseCode?:number;command?:string};const rejected=!!e.responseCode||['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(e.command||'');await finish(rejected?'ERROR':'INCIERTO',null,rejected?'El servidor SMTP rechazó el envío.':'Resultado SMTP sin confirmar. Verifique el servidor antes de reenviar.');return;}
 await finish(result.accepted?.length?'ENVIADO':'ERROR',result.messageId||null,result.accepted?.length?null:'El servidor no aceptó el destinatario.');
}
export function startStatementNotifications(){
 if(!smtpStatus().enabled)return;
 const port=Number(process.env.SMTP_PORT||587),transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
 let busy=false,lastSchedule=0;
 const tick=async()=>{if(busy)return;busy=true;try{
  if(Date.now()-lastSchedule>60000){await rpc('statement_schedule',{});lastSchedule=Date.now();}
  const job=await rpc('statement_claim',{});if(job)await deliverStatement(job,m=>transport.sendMail(m),(status,message,error)=>rpc('payment_email_finish',{p_id:job.id,p_lease:job.lease,p_status:status,p_message:message,p_error:error}));
 }catch{console.error('Estados de cuenta: no se pudo completar el ciclo de envío.');}finally{busy=false;}};
 const timer=setInterval(()=>void tick(),10000);timer.unref();void tick();
}
