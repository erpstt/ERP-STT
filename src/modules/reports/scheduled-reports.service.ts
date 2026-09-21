import nodemailer from 'nodemailer';
import {rpc,smtpStatus} from '../notifications/email-notification.service.js';
import {escapeHtml as esc} from '../notifications/payment-email.js';
import {renderBankReconciliationPdf} from './accounting-reports.service.js';

type Row={entity_name:string;document_number:string;issue_date:string;due_date:string;overdue_days:number;original_amount:number;applied_amount:number;pending:number};
export type ScheduledReport={kind:'AR'|'AP';cutoff:string;company:string;currency:string;rows:Row[];summary:{subledger:number;advances:number;netBalance:number}};
const title=(kind:string)=>kind==='AR'?'Cuentas por Cobrar':'Cuentas por Pagar';
const money=(value:unknown)=>Number(value||0).toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2});
const date=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value.split('-').reverse().join('/'):value;
export function scheduledReportCsv(report:ScheduledReport){
 const rows:unknown[][]=[['Sociedad','Moneda','Fecha de corte',report.kind==='AR'?'Cliente':'Proveedor','Documento','Fecha emisión','Vencimiento','Días vencidos','Importe original','Aplicado','Saldo pendiente'],
 ...report.rows.map(r=>[report.company,report.currency,report.cutoff,r.entity_name,r.document_number,r.issue_date,r.due_date,r.overdue_days,r.original_amount,r.applied_amount,r.pending])];
 const cell=(v:unknown)=>{let s=String(v??'');if(typeof v!=='number'&&/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 return '\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
export function scheduledReportHtml(report:ScheduledReport){
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title(report.kind))}</title><style>@page{size:A4 landscape;margin:14mm}*{box-sizing:border-box}body{font:10px Arial,sans-serif;color:#17324d;margin:0}header{border-bottom:3px solid #0b8069;padding-bottom:14px;display:flex;justify-content:space-between;gap:20px}h1{font-size:25px;margin:5px 0}h2{font-size:15px;margin:0}.muted{color:#607286}.summary{display:flex;gap:18px;margin:18px 0}.metric{background:#f1f5f9;padding:12px 18px;flex:1}.metric b{display:block;font-size:19px;margin-top:5px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#18334e;color:white;text-align:left}td,th{padding:7px;border-bottom:1px solid #dce5ed;overflow-wrap:anywhere}tr{break-inside:avoid}.num{text-align:right;font-variant-numeric:tabular-nums}footer{margin-top:18px;border-top:1px solid #dce5ed;padding-top:10px;color:#607286}.empty{padding:30px;text-align:center}</style></head><body><header><div><h2>${esc(report.company)}</h2><h1>${esc(title(report.kind))}</h1><span class="muted">Documentos pendientes · Moneda local ${esc(report.currency)}</span></div><div>Fecha de corte<br><strong>${esc(date(report.cutoff))}</strong><p>${report.rows.length} documentos</p></div></header><section class="summary">${[['Saldo de documentos',report.summary.subledger],['Anticipos disponibles',report.summary.advances],['Saldo neto',report.summary.netBalance]].map(([label,value])=>`<div class="metric">${esc(label)}<b>${money(value)} ${esc(report.currency)}</b></div>`).join('')}</section><table><thead><tr><th>${report.kind==='AR'?'Cliente':'Proveedor'}</th><th>Documento</th><th>Emisión</th><th>Vencimiento</th><th class="num">Días vencidos</th><th class="num">Original</th><th class="num">Aplicado</th><th class="num">Pendiente</th></tr></thead><tbody>${report.rows.map(r=>`<tr><td>${esc(r.entity_name)}</td><td>${esc(r.document_number)}</td><td>${esc(date(r.issue_date))}</td><td>${esc(date(r.due_date))}</td><td class="num">${esc(r.overdue_days)}</td><td class="num">${money(r.original_amount)}</td><td class="num">${money(r.applied_amount)}</td><td class="num">${money(r.pending)}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">No hay documentos pendientes a la fecha de corte.</td></tr>'}</tbody></table><footer>NEXO · Reporte programado · Los anticipos se presentan separados del saldo de documentos.</footer></body></html>`;
}
export async function scheduledReportFiles(report:ScheduledReport,format:string){
 const name=`${report.kind==='AR'?'cxc':'cxp'}_${report.cutoff}`,files:{fileName:string;mimeType:string;base64:string}[]=[];
 if(format==='PDF'||format==='BOTH')files.push(await renderBankReconciliationPdf({html:scheduledReportHtml(report),fileName:name+'.pdf'}));
 if(format==='CSV'||format==='BOTH')files.push({fileName:name+'.csv',mimeType:'text/csv',base64:Buffer.from(scheduledReportCsv(report)).toString('base64')});
 if(!files.length)throw Error('Formato de reporte inválido.');return files;
}
export async function scheduledReportsAction(authorization:string,action:string,payload:Record<string,unknown>){
 if(action==='preview'){
  const data=await rpc('scheduled_report_manage',{p_action:'list',p:{}},authorization);
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const cutoff=new Date(local+'T12:00:00Z');
  if(payload.cutoff==='PREVIOUS_MONTH_END')cutoff.setUTCDate(0);else if(payload.cutoff==='PREVIOUS_DAY')cutoff.setUTCDate(cutoff.getUTCDate()-1);else if(payload.cutoff!=='SEND_DATE')throw Error('Seleccione la fecha de corte.');
  const snapshot=await rpc('scheduled_report_snapshot',{p_sid:data.company.id,p_kind:payload.report,p_cutoff:cutoff.toISOString().slice(0,10)},authorization);
  const files=await scheduledReportFiles(snapshot,payload.format==='CSV'?'CSV':'PDF');return{file:files[0],cutoff:snapshot.cutoff};
 }
 if(!['list','save','toggle','delete'].includes(action))throw Error('Acción inválida.');
 return {...await rpc('scheduled_report_manage',{p_action:action,p:payload},authorization),transport:smtpStatus()};
}

type Job={id:string;lease:string;subsidiary_id:number;cutoff:string;recipient:string;configuration:{report_kind:'AR'|'AP';format:string;name:string}};
type Finish=(status:string,message:string|null,error:string|null)=>Promise<unknown>;
// One job per recipient. Never retry an uncertain SMTP outcome automatically.
export async function deliverScheduledReport(job:Job,prepare:()=>Promise<ScheduledReport>,send:(mail:any)=>Promise<any>,begin:()=>Promise<boolean>,finish:Finish,files=scheduledReportFiles){
 let report:ScheduledReport,attachments:Awaited<ReturnType<typeof scheduledReportFiles>>;
 try{if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(job.recipient))throw Error();report=await prepare();attachments=await files(report,job.configuration.format);}catch{await finish('ERROR',null,'No fue posible preparar el reporte o generar sus archivos.');return;}
 if(!await begin())return;
 let result;
 try{result=await send({from:process.env.SMTP_FROM,to:job.recipient,subject:`${title(report.kind)} · ${report.company} · ${date(report.cutoff)}`.replace(/[\r\n]/g,' ').slice(0,200),text:`${report.company}\n${title(report.kind)}\nFecha de corte: ${date(report.cutoff)}\nSaldo neto: ${money(report.summary.netBalance)} ${report.currency}\nAdjunto encontrará el reporte solicitado.`,html:`<div style="font-family:Arial;color:#17324d;max-width:640px"><h2>${esc(report.company)}</h2><h1>${esc(title(report.kind))}</h1><p>Adjunto encontrará el reporte programado con fecha de corte al <strong>${esc(date(report.cutoff))}</strong>.</p><p>Saldo neto: <strong>${money(report.summary.netBalance)} ${esc(report.currency)}</strong></p><p>NEXO · ${esc(job.configuration.name)}</p></div>`,attachments:attachments.map(f=>({filename:f.fileName,content:Buffer.from(f.base64,'base64'),contentType:f.mimeType})),disableFileAccess:true,disableUrlAccess:true});}
 catch(cause){const e=cause as {responseCode?:number;command?:string};const rejected=!!e.responseCode||['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(e.command||'');await finish(rejected?'ERROR':'INCIERTO',null,rejected?'El servidor SMTP rechazó el envío.':'El resultado SMTP no pudo confirmarse. Revise el servidor antes de reenviar.');return;}
 await finish(result.accepted?.length?'ENVIADO':'ERROR',result.messageId||null,result.accepted?.length?null:'El servidor no aceptó al destinatario.');
}
export function startScheduledReports(){
 if(!smtpStatus().enabled){console.log('Reportes programados: SMTP desactivado.');return;}
 const port=Number(process.env.SMTP_PORT||587),transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
 let busy=false,lastSchedule=0;
 const tick=async()=>{if(busy)return;busy=true;try{
  if(Date.now()-lastSchedule>=60000){await rpc('scheduled_report_schedule',{});lastSchedule=Date.now();}
  const job=await rpc('scheduled_report_claim',{})as Job|null;
  if(job)await deliverScheduledReport(job,()=>rpc('scheduled_report_snapshot',{p_sid:job.subsidiary_id,p_kind:job.configuration.report_kind,p_cutoff:job.cutoff}),mail=>transport.sendMail(mail),()=>rpc('scheduled_report_begin_send',{p_id:job.id,p_lease:job.lease}),(status,message,error)=>rpc('scheduled_report_finish',{p_id:job.id,p_lease:job.lease,p_status:status,p_message:message,p_error:error}));
 }catch{console.error('Reportes programados: no se pudo completar el ciclo de procesamiento.');}finally{busy=false;}};
 const timer=setInterval(()=>void tick(),10000);timer.unref();void tick();
}
