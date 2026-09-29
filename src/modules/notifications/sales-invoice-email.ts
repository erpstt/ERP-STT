import sanitizeHtml from 'sanitize-html';
import { cleanBody, escapeHtml, validateTemplate } from './payment-email.js';
import { rpc, smtpStatus } from './email-notification.service.js';

export const salesInvoiceEmailTags = [
  'empresa_nombre',
  'cliente_nombre',
  'numero_factura',
  'fecha_factura',
  'fecha_vencimiento',
  'total_factura',
  'moneda'
];

export const salesInvoiceEmailSubject = 'Factura {{numero_factura}} · {{empresa_nombre}}';
export const salesInvoiceEmailBody = '<p>Estimado/a <strong>{{cliente_nombre}}</strong>,</p><p>Adjunto encontrará la factura <strong>{{numero_factura}}</strong>, emitida por {{empresa_nombre}} el {{fecha_factura}}, por un total de {{total_factura}} {{moneda}}.</p><p>Agradecemos su preferencia. Para cualquier consulta, puede responder directamente a este correo.</p>';

export type SalesInvoiceEmailSnapshot = {
  empresa_nombre: string;
  empresa_logo_url?: string;
  cliente_nombre: string;
  numero_factura: string;
  fecha_factura: string;
  fecha_vencimiento: string;
  total_factura: number;
  moneda: string;
};

const money = (value: number) => Number(value || 0).toLocaleString('es-CR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const displayDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : value;

export function renderSalesInvoiceEmail(subject: string, body: string, invoice: SalesInvoiceEmailSnapshot) {
  const template = validateTemplate(subject, body, salesInvoiceEmailTags);
  const values: Record<string, string> = {
    empresa_nombre: invoice.empresa_nombre,
    cliente_nombre: invoice.cliente_nombre,
    numero_factura: invoice.numero_factura,
    fecha_factura: displayDate(invoice.fecha_factura),
    fecha_vencimiento: displayDate(invoice.fecha_vencimiento),
    total_factura: money(invoice.total_factura),
    moneda: invoice.moneda
  };
  const merge = (value: string, html: boolean) => value.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => html ? escapeHtml(values[key] ?? '') : values[key] ?? '');
  const renderedSubject = merge(template.subject, false).replace(/[\r\n]/g, ' ').slice(0, 200);
  const intro = cleanBody(merge(template.body, true));
  const logo = invoice.empresa_logo_url && /^https:\/\//i.test(invoice.empresa_logo_url)
    ? `<img src="${escapeHtml(invoice.empresa_logo_url)}" alt="${escapeHtml(invoice.empresa_nombre)}" style="max-width:180px;max-height:64px;margin-bottom:14px">`
    : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 8px"><table role="presentation" width="650" style="width:100%;max-width:650px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td style="background:#0f172a;color:#fff;text-align:center;padding:28px">${logo}<div style="font-size:14px">${escapeHtml(invoice.empresa_nombre)}</div><h1 style="font-size:24px;margin:10px 0 0">Factura de venta</h1></td></tr><tr><td style="padding:30px;line-height:1.6">${intro}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;background:#f8fafc;border-left:4px solid #078464"><tr><td style="padding:18px"><div style="font-size:12px;color:#64748b">Factura</div><div style="font-size:20px;font-weight:bold;color:#0f172a">${escapeHtml(invoice.numero_factura)}</div></td><td style="padding:18px;text-align:right"><div style="font-size:12px;color:#64748b">Total</div><div style="font-size:24px;font-weight:bold;color:#078464">${money(invoice.total_factura)} ${escapeHtml(invoice.moneda)}</div></td></tr></table><p style="font-size:13px;color:#64748b">Fecha de emisión: <strong>${escapeHtml(displayDate(invoice.fecha_factura))}</strong><br>Fecha de vencimiento: <strong>${escapeHtml(displayDate(invoice.fecha_vencimiento))}</strong></p><!--support-links--><p style="font-size:13px;color:#64748b">El PDF de la factura se incluye como adjunto. Los archivos cargados también se adjuntan y los enlaces registrados aparecen en este mensaje.</p></td></tr><tr><td style="background:#f8fafc;padding:18px;text-align:center;font-size:12px;color:#64748b">Este mensaje fue generado por ${escapeHtml(invoice.empresa_nombre)}.</td></tr></table></td></tr></table></body></html>`;
  const text = sanitizeHtml(html.replace(/<\/(p|tr|h1)>/g, '\n').replace(/<\/t[dh]>/g, ' | '), {allowedTags: [], allowedAttributes: {}});
  return {subject: renderedSubject, html, text};
}

export async function salesInvoiceTemplateSettings(authorization: string, action: string, payload: Record<string, unknown>) {
  if (action === 'save') {
    const template = validateTemplate(String(payload.subject || ''), String(payload.body || ''), salesInvoiceEmailTags);
    return rpc('sales_invoice_email_settings', {p_action: 'save', p_payload: {...template, active: payload.active === true}}, authorization);
  }
  const data = await rpc('sales_invoice_email_settings', {p_action: 'get', p_payload: {}}, authorization);
  if (data.template?.cuerpo_template) data.template.cuerpo_template = cleanBody(data.template.cuerpo_template);
  if (action === 'preview') {
    return renderSalesInvoiceEmail(String(payload.subject || salesInvoiceEmailSubject), String(payload.body || salesInvoiceEmailBody), {
      empresa_nombre: data.subsidiary?.name || 'Empresa de ejemplo',
      empresa_logo_url: data.subsidiary?.logo,
      cliente_nombre: 'Cliente de ejemplo',
      numero_factura: 'FAC-VEN-2026-00125',
      fecha_factura: '2026-09-28',
      fecha_vencimiento: '2026-10-28',
      total_factura: 2450,
      moneda: 'USD'
    });
  }
  if (action !== 'get') throw Error('Acción inválida.');
  return {...data, transport: smtpStatus(), defaults: {subject: salesInvoiceEmailSubject, body: salesInvoiceEmailBody}};
}
