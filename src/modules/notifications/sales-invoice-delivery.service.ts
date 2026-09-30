import nodemailer from 'nodemailer';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';
import { rpc, smtpStatus } from './email-notification.service.js';
import { renderSalesInvoiceEmail } from './sales-invoice-email.js';

export type SalesInvoiceSupport = {
  type: 'Archivo' | 'Enlace';
  name: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  fileData?: string;
};

export type SalesInvoiceDocument = {
  id: number;
  number: string;
  issueDate: string;
  dueDate: string;
  memo: string;
  total: number;
  receivable: number;
  company: {name:string; address:string; logo?:string};
  customer: {name:string; email:string; address:string; taxId:string};
  currency: {code:string; name:string; symbol:string};
  paymentTerm: string;
  lines: Array<{
    product:string; description:string; serviceCountry:string; quantity:number;
    unitPrice:number; amount:number; taxRate:number; taxAmount:number; grossAmount:number;
  }>;
  withholdingTotal: number;
  supports: SalesInvoiceSupport[];
};

type MailAttachment = {filename:string; content:Buffer; contentType:string; contentDisposition:'attachment'};
type RenderedFile = {fileName:string; mimeType:string; base64:string};
type TemplateSettings = {template?:{asunto_template?:string;cuerpo_template?:string;activo?:boolean}|null};

const emailPattern=/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const date=(value:unknown)=>{const raw=String(value??'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return '—';return new Intl.DateTimeFormat('es-CR',{day:'2-digit',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${raw}T12:00:00Z`));};
const safeFileName=(value:unknown,fallback='archivo')=>String(value??fallback).replace(/[\\/\r\n\0<>:"|?*]/g,'_').trim().slice(0,160)||fallback;

export async function loadSalesInvoiceDocument(authorization:string,invoiceId:number):Promise<SalesInvoiceDocument>{
  if(!Number.isSafeInteger(invoiceId)||invoiceId<=0)throw Error('Factura de venta inválida.');
  // La función SECURITY DEFINER comprueba primero la sesión y la subsidiaria activa.
  const document=await rpc('sales_invoice_delivery_snapshot',{p_invoice_id:invoiceId},authorization) as SalesInvoiceDocument;
  if(!document||Number(document.id)!==invoiceId||!document.company||!document.customer||!Array.isArray(document.lines)||!Array.isArray(document.supports))throw Error('La factura no devolvió la información necesaria para generar el documento.');
  document.customer.email=String(document.customer.email??'').trim();
  return document;
}

function money(value:number,document:SalesInvoiceDocument){return `${document.currency.symbol} ${value.toLocaleString('es-CR',{minimumFractionDigits:2,maximumFractionDigits:2})}`.trim();}

export function buildSalesInvoicePdfHtml(document:SalesInvoiceDocument){
  const subtotal=document.lines.reduce((sum,line)=>sum+line.amount,0),tax=document.lines.reduce((sum,line)=>sum+line.taxAmount,0);
  const embeddedLogo=document.company.logo&&/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(document.company.logo)&&document.company.logo.length<2_000_000?`<img src="${document.company.logo}" alt="Logo">`:'';
  const lineRows=document.lines.map(line=>`<tr><td><b>${esc(line.product)}</b>${line.description?`<small>${esc(line.description)}</small>`:''}</td><td>${esc(line.serviceCountry)}</td><td class="num">${line.quantity.toLocaleString('es-CR',{maximumFractionDigits:6})}</td><td class="num">${esc(money(line.unitPrice,document))}</td><td class="num">${esc(money(line.amount,document))}</td><td class="num">${esc(money(line.taxAmount,document))}</td><td class="num strong">${esc(money(line.grossAmount,document))}</td></tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:13mm}*{box-sizing:border-box}body{margin:0;color:#17233b;font:12px Arial,sans-serif}header{display:flex;justify-content:space-between;gap:28px;padding-bottom:20px;border-bottom:3px solid #f26938}.brand{display:flex;align-items:center;gap:15px}.brand img{max-width:86px;max-height:64px}.brand h1{margin:0;font-size:22px}.brand p{margin:6px 0 0;max-width:420px;color:#64748b;white-space:pre-line}.identity{text-align:right}.identity small{color:#042e72;font-weight:bold;letter-spacing:.13em}.identity h2{margin:8px 0;font-size:24px}.identity span{display:inline-block;padding:5px 10px;border-radius:20px;background:#e6f6ef;color:#087252;font-weight:bold;font-size:10px}.parties{display:grid;grid-template-columns:1.2fr 1fr;gap:34px;margin:24px 0}.customer{padding:17px;background:#f5f8fb;border-radius:8px}.eyebrow{margin:0 0 10px;color:#64748b;font-size:10px;font-weight:bold;letter-spacing:.12em}.customer b{font-size:17px}.customer p{margin:5px 0;color:#475569}.facts{margin:0}.facts div,.totals div{display:flex;justify-content:space-between;gap:20px;padding:6px 0;border-bottom:1px solid #e2e8f0}.facts dt,.totals dt{color:#64748b}.facts dd,.totals dd{margin:0;text-align:right;font-weight:bold}table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{break-inside:avoid}th{padding:9px 7px;background:#edf2f6;border-bottom:2px solid #cbd5e1;color:#526176;text-align:left;font-size:9px;text-transform:uppercase}td{padding:10px 7px;border-bottom:1px solid #e2e8f0;vertical-align:top}td small{display:block;margin-top:3px;color:#64748b}.num{text-align:right;white-space:nowrap}.strong{font-weight:bold}.closing{display:grid;grid-template-columns:1fr 285px;gap:45px;margin-top:24px}.notes p{color:#475569;white-space:pre-wrap}.totals{margin:0}.totals .grand{margin-top:7px;padding:12px 8px;background:#eef9f5;border-top:2px solid #042e72;border-bottom:3px double #f26938;font-size:16px}footer{margin-top:55px;padding-top:10px;border-top:1px solid #d7dee8;color:#64748b;font-size:9px;display:flex;justify-content:space-between}
  </style></head><body><header><div class="brand">${embeddedLogo}<div><h1>${esc(document.company.name)}</h1><p>${esc(document.company.address)}</p></div></div><div class="identity"><small>FACTURA DE VENTA</small><h2>${esc(document.number)}</h2><span>CONTABILIZADA</span></div></header><section class="parties"><div class="customer"><p class="eyebrow">FACTURAR A</p><b>${esc(document.customer.name)}</b><p>${document.customer.taxId?`Identificación fiscal: ${esc(document.customer.taxId)}`:''}</p><p>${esc(document.customer.address)}</p><p>${esc(document.customer.email)}</p></div><dl class="facts"><div><dt>Fecha de emisión</dt><dd>${esc(date(document.issueDate))}</dd></div><div><dt>Fecha de vencimiento</dt><dd>${esc(date(document.dueDate))}</dd></div><div><dt>Términos de pago</dt><dd>${esc(document.paymentTerm||'—')}</dd></div><div><dt>Moneda</dt><dd>${esc(`${document.currency.code} - ${document.currency.name}`)}</dd></div></dl></section><table><thead><tr><th>Producto / descripción</th><th>País de servicio</th><th class="num">Cantidad</th><th class="num">Precio unitario</th><th class="num">Subtotal</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead><tbody>${lineRows||'<tr><td colspan="7">La factura no contiene líneas.</td></tr>'}</tbody></table><section class="closing"><div class="notes"><p class="eyebrow">NOTA</p><p>${esc(document.memo||'—')}</p></div><dl class="totals"><div><dt>Subtotal</dt><dd>${esc(money(subtotal,document))}</dd></div><div><dt>Impuestos</dt><dd>${esc(money(tax,document))}</dd></div><div><dt>Retenciones</dt><dd>${esc(money(document.withholdingTotal,document))}</dd></div><div class="grand"><dt>Total factura</dt><dd>${esc(money(document.total,document))}</dd></div><div><dt>Saldo por cobrar</dt><dd>${esc(money(document.receivable,document))}</dd></div></dl></section><footer><span>${esc(document.company.name)}</span><span>Documento generado desde GENTIA ERP</span></footer></body></html>`;
}

export function renderSalesInvoicePdf(document:SalesInvoiceDocument){
  return renderBankReconciliationPdf({html:buildSalesInvoicePdfHtml(document),fileName:`factura-${safeFileName(document.number,'venta')}.pdf`});
}

function supportLinks(supports:SalesInvoiceSupport[]){return supports.filter(item=>item.type==='Enlace').map(item=>{try{const url=new URL(item.url??'');return ['http:','https:'].includes(url.protocol)?{name:item.name||url.hostname,url:url.href}:null;}catch{return null;}}).filter((item):item is {name:string;url:string}=>!!item);}

function supportAttachments(supports:SalesInvoiceSupport[]):MailAttachment[]{
  let total=0;
  return supports.filter(item=>item.type==='Archivo').map((item,index)=>{
    const match=/^data:([^;,\s]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(item.fileData??'');
    if(!match)throw Error(`El respaldo ${item.name||index+1} no contiene un archivo válido.`);
    const encoded=match[2].replace(/\s/g,''),content=Buffer.from(encoded,'base64');
    if(!content.length||content.length>5*1024*1024)throw Error(`El respaldo ${item.name||index+1} supera 5 MB o está vacío.`);
    if(item.fileSize!==undefined&&Math.abs(item.fileSize-content.length)>2)throw Error(`El respaldo ${item.name||index+1} está incompleto.`);
    total+=content.length;if(total>15*1024*1024)throw Error('Los archivos de respaldo superan el límite total de 15 MB para el correo.');
    const contentType=/^[\w.+-]+\/[\w.+-]+$/.test(item.mimeType??match[1])?String(item.mimeType??match[1]):'application/octet-stream';
    return{filename:safeFileName(item.fileName??item.name,`respaldo-${index+1}`),content,contentType,contentDisposition:'attachment'};
  });
}

export async function deliverSalesInvoiceEmail(
  document:SalesInvoiceDocument,
  template:{subject:string;body:string},
  send:(message:Record<string,unknown>)=>Promise<{accepted?:unknown[];messageId?:string}>,
  pdf:(document:SalesInvoiceDocument)=>Promise<RenderedFile>=renderSalesInvoicePdf
){
  if(!emailPattern.test(document.customer.email))throw Error('El cliente no tiene un correo electrónico válido registrado.');
  const rendered=renderSalesInvoiceEmail(template.subject,template.body,{empresa_nombre:document.company.name,empresa_logo_url:document.company.logo,cliente_nombre:document.customer.name,numero_factura:document.number,fecha_factura:document.issueDate,fecha_vencimiento:document.dueDate,total_factura:document.total,moneda:document.currency.code});
  const links=supportLinks(document.supports),linkHtml=links.length?`<div style="margin:22px 0;padding:16px;background:#f8fafc;border-left:4px solid #f26938"><strong>Enlaces de respaldo</strong><ul>${links.map(item=>`<li><a href="${esc(item.url)}">${esc(item.name)}</a></li>`).join('')}</ul></div>`:'',linkText=links.length?`\n\nEnlaces de respaldo:\n${links.map(item=>`${item.name}: ${item.url}`).join('\n')}`:'';
  const message={...rendered,html:rendered.html.replace('<!--support-links-->',linkHtml),text:`${rendered.text}${linkText}`};
  const invoicePdf=await pdf(document),attachments:MailAttachment[]=[{filename:safeFileName(invoicePdf.fileName,'factura.pdf'),content:Buffer.from(invoicePdf.base64,'base64'),contentType:'application/pdf',contentDisposition:'attachment'},...supportAttachments(document.supports)];
  let result;
  try{result=await send({from:process.env.SMTP_FROM,to:document.customer.email,...message,attachments,disableFileAccess:true,disableUrlAccess:true});}
  catch(cause){const smtp=cause as{responseCode?:number;code?:string;command?:string};const detail=smtp.responseCode||smtp.code||smtp.command;throw Error(detail?`El servidor de correo rechazó el envío (${detail}).`:'No fue posible confirmar el envío con el servidor de correo.');}
  if(!result.accepted?.length)throw Error('El servidor de correo no aceptó al destinatario.');
  return{status:'ENVIADO',recipient:document.customer.email,messageId:result.messageId??null,attachments:attachments.map(item=>item.filename),links:links.length};
}

export async function downloadSalesInvoicePdf(authorization:string,invoiceId:number){return renderSalesInvoicePdf(await loadSalesInvoiceDocument(authorization,invoiceId));}

export async function sendSalesInvoiceEmail(authorization:string,invoiceId:number){
  const transportStatus=smtpStatus();
  if(!transportStatus.enabled)throw Error('El envío SMTP todavía no está activado en el servidor.');
  const document=await loadSalesInvoiceDocument(authorization,invoiceId),settings=await rpc('sales_invoice_email_settings',{p_action:'get',p_payload:{}},authorization)as TemplateSettings,template=settings.template;
  if(!template?.activo)throw Error('Active la plantilla de factura de venta en Configuración > Plantillas de Notificación.');
  if(!template.asunto_template||!template.cuerpo_template)throw Error('La plantilla de factura de venta está incompleta.');
  const port=Number(process.env.SMTP_PORT||587),transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:port===465,requireTLS:port!==465,auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000,disableFileAccess:true,disableUrlAccess:true});
  return deliverSalesInvoiceEmail(document,{subject:template.asunto_template,body:template.cuerpo_template},message=>transport.sendMail(message));
}
