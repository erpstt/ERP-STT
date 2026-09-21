import sanitizeHtml from 'sanitize-html';

export const defaultSubject = 'Notificación de pago · {{empresa_nombre}} · {{referencia_pago}}';
export const defaultBody = '<p>Estimado/a {{proveedor_nombre}},</p><p>Le informamos que {{empresa_nombre}} ha registrado un pago a su favor por {{total_pagado}} {{moneda}}, bajo la referencia {{referencia_pago}}, de fecha {{fecha_pago}}.</p>';
export const tags = ['empresa_nombre', 'proveedor_nombre', 'fecha_pago', 'referencia_pago', 'total_pagado', 'moneda'];
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function cleanBody(body: string) {
  return sanitizeHtml(body, { allowedTags: ['p','br','strong','b','em','i','u','ul','ol','li','a','span'], allowedAttributes: {a:['href','title']}, allowedSchemes:['https','http','mailto'], allowProtocolRelative:false });
}
export function validateTemplate(subject: string, body: string, allowedTags = tags) {
  if (!subject.trim() || subject.length > 200 || /[\r\n]/.test(subject)) throw Error('Ingrese un asunto de hasta 200 caracteres, sin saltos de línea.');
  if (!body.trim() || body.length > 20000) throw Error('Ingrese un mensaje de hasta 20.000 caracteres.');
  for (const match of (subject + body).matchAll(/{{(.*?)}}/gs)) if (!allowedTags.includes(match[1].trim())) throw Error(`Variable no admitida: ${match[0]}`);
  const cleaned = cleanBody(body);
  if (!sanitizeHtml(cleaned, {allowedTags:[], allowedAttributes:{}}).trim()) throw Error('El mensaje no puede estar vacío.');
  return {subject:subject.trim(), body:cleaned};
}
export type PaymentSnapshot = {
  empresa_nombre:string; proveedor_nombre:string; fecha_pago:string; referencia_pago:string;
  empresa_logo_url?:string; moneda:string; total_pagado:number; aplicado:number; retenciones:number; anticipos:number;
  invoices:Array<{number:string;date:string;total:number;applied:number;withholding:number;withholdingDetail?:string}>;
};
const money = (value: number) => Number(value).toLocaleString('es-CR', {minimumFractionDigits:2,maximumFractionDigits:2});
export function renderPaymentEmail(subject: string, body: string, payment: PaymentSnapshot) {
  const template = validateTemplate(subject, body);
  const values: Record<string,string> = Object.fromEntries(tags.map(tag => [tag, tag==='total_pagado' ? money(payment.total_pagado) : String(payment[tag as keyof PaymentSnapshot] ?? '')]));
  const merge = (text:string, html:boolean) => text.replace(/{{\s*(\w+)\s*}}/g, (_, tag:string) => html ? escapeHtml(values[tag]) : values[tag]);
  const renderedSubject = merge(template.subject,false).replace(/[\r\n]/g,' ').slice(0,200);
  const intro = cleanBody(merge(template.body,true));
  const logo = payment.empresa_logo_url && /^https:\/\//i.test(payment.empresa_logo_url) ? `<img src="${escapeHtml(payment.empresa_logo_url)}" alt="${escapeHtml(payment.empresa_nombre)}" style="max-width:180px;max-height:70px;margin-bottom:16px">` : '';
  const cell = 'padding:10px 8px;border-bottom:1px solid #e2e8f0;';
  const rows = payment.invoices.map(i => `<tr><td style="${cell}">${escapeHtml(i.number)}</td><td style="${cell}">${escapeHtml(i.date)}</td><td style="${cell}text-align:right">${money(i.total)}</td><td style="${cell}text-align:right;color:#b91c1c">${money(i.withholding)}${i.withholdingDetail?`<br><small>${escapeHtml(i.withholdingDetail)}</small>`:''}</td><td style="${cell}text-align:right;font-weight:bold">${money(i.applied-i.withholding)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 8px"><table role="presentation" width="700" style="width:100%;max-width:700px;background:white;border:1px solid #e2e8f0" cellspacing="0" cellpadding="0"><tr><td style="background:#0f172a;color:white;text-align:center;padding:28px">${logo}<div style="font-size:14px">${escapeHtml(payment.empresa_nombre)}</div><h1 style="font-size:23px;margin:12px 0 0">Notificación de Pago Realizado</h1></td></tr><tr><td style="padding:24px;line-height:1.6">${intro}<p style="font-size:12px;color:#64748b">Detalle del abono · ${escapeHtml(payment.moneda)}</p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr style="background:#f8fafc;text-align:left">${['No. factura','Fecha emisión','Total factura','Retenciones del pago','Monto pagado / aplicado neto'].map(t=>`<th style="${cell}">${t}</th>`).join('')}</tr></thead><tbody>${rows}</tbody><tfoot>${payment.anticipos>0?`<tr><td colspan="4" style="${cell}">Menos anticipos utilizados</td><td style="${cell}text-align:right">${money(payment.anticipos)}</td></tr>`:''}<tr><td colspan="4" style="padding:16px 8px;font-weight:bold">TOTAL TRANSFERIDO (${escapeHtml(payment.moneda)})</td><td style="padding:16px 8px;text-align:right;font-weight:bold;color:#15803d">${money(payment.total_pagado)}</td></tr></tfoot></table><p style="font-size:12px;color:#64748b">Los importes corresponden a este pago; pueden ser abonos parciales. Las retenciones practicadas al registrar la factura ya forman parte de su saldo exigible y no se descuentan nuevamente.${payment.anticipos>0?' El importe aplicado neto incluye anticipos compensados; el total transferido muestra únicamente el desembolso bancario.':''}</p></td></tr><tr><td style="background:#f8fafc;padding:18px;text-align:center;font-size:12px;color:#64748b">Referencia: ${escapeHtml(payment.referencia_pago)} · Fecha: ${escapeHtml(payment.fecha_pago)}</td></tr></table></td></tr></table></body></html>`;
  const text = sanitizeHtml(html.replace(/<\/(p|tr|h1)>/g,'\n').replace(/<\/t[dh]>/g,' | '), {allowedTags:[],allowedAttributes:{}});
  return {subject:renderedSubject,html,text};
}
