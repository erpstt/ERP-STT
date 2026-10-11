import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { cleanBody, escapeHtml, validateTemplate } from './payment-email.js';
import { rpc, smtpStatus } from './email-notification.service.js';

export const expenseApprovalEmailTags = [
  'empresa_nombre',
  'aprobador_nombre',
  'numero_solicitud',
  'solicitante_nombre',
  'tipo_solicitud',
  'fecha_solicitud',
  'fecha_pago_programada',
  'moneda',
  'monto_total',
  'concepto',
  'departamentos',
  'centros_costo',
  'nivel_aprobacion',
  'enlace_solicitud'
];

export const expenseApprovalEmailSubject = 'Solicitud de gasto {{numero_solicitud}} pendiente de aprobación · {{empresa_nombre}}';
export const expenseApprovalEmailBody = '<p>Hola <strong>{{aprobador_nombre}}</strong>,</p><p>Tiene la solicitud de gasto <strong>{{numero_solicitud}}</strong> pendiente de revisión y aprobación.</p><p>Revise el concepto, las imputaciones y los archivos de respaldo antes de tomar una decisión.</p>';

export type ExpenseApprovalSnapshot = {
  empresa_nombre: string;
  empresa_logo_url?: string;
  aprobador_nombre: string;
  numero_solicitud: string;
  solicitante_nombre: string;
  tipo_solicitud: string;
  fecha_solicitud: string;
  fecha_pago_programada: string;
  moneda: string;
  monto_total?: number;
  total?: number;
  concepto: string;
  departamentos?: string | Array<{name?: string}>;
  departamentos_texto?: string;
  centros_costo?: string;
  centros_costos?: Array<{code?: string; name?: string}>;
  centros_costos_texto?: string;
  nivel_aprobacion?: string;
  approvalLevelName?: string;
  lineas?: Array<{
    cuenta?: string;
    tercero?: string;
    departamento?: string;
    centroCosto?: string;
    concepto?: string;
    monto?: number;
  }>;
  enlace_solicitud?: string;
  deep_link?: string;
  deepLink?: string;
};

export type ExpenseApprovalEmailJob = {
  id: string | number;
  lease: string;
  email?: string;
  destinatario?: string;
  recipient_email?: string;
  payload: ExpenseApprovalSnapshot;
  subject_template: string;
  body_template: string;
  // Compatibilidad con trabajos creados por versiones preliminares del worker.
  asunto_template?: string;
  cuerpo_template?: string;
};

type MailResult = { accepted?: unknown[]; messageId?: string };
type Finish = (status: string, message: string | null, error: string | null) => Promise<unknown>;
type SmtpFailure = {responseCode?: number; command?: string; code?: string};

function smtpFailureDisposition(failure: SmtpFailure): 'REINTENTO' | 'ERROR' | 'INCIERTO' {
  const responseCode = Number(failure.responseCode || 0);
  if (responseCode >= 400 && responseCode < 500) return 'REINTENTO';
  if (responseCode >= 500) return 'ERROR';

  // These commands happen before the server can accept the message. Retrying
  // them cannot duplicate a previously delivered approval notification.
  const command = String(failure.command || '').toUpperCase();
  if (['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(command)) return 'REINTENTO';

  // A disconnect while DATA is being transferred has an ambiguous outcome.
  return 'INCIERTO';
}

const displayDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value.split('-').reverse().join('/')
  : value || '—';
const money = (value: number) => Number(value || 0).toLocaleString('es-CR', {minimumFractionDigits: 2, maximumFractionDigits: 2});

function appBaseUrl() {
  const configured = String(process.env.APP_BASE_URL ?? process.env.GENTIA_APP_URL ?? process.env.NEXO_APP_URL ?? '').trim().replace(/\/$/, '');
  if (!/^https:\/\/[^\s]+$/i.test(configured)) return '';
  try {
    const hostname = new URL(configured).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return '';
  } catch {
    return '';
  }
  return configured;
}

function safeApprovalLink(snapshot: ExpenseApprovalSnapshot) {
  const raw = String(snapshot.enlace_solicitud ?? snapshot.deep_link ?? snapshot.deepLink ?? '').trim();
  if (/^https:\/\/[^\s]+$/i.test(raw)) return raw;
  if (!/^\/(?!\/)[^\s]*$/.test(raw)) return '';
  const base = appBaseUrl();
  return base ? base + raw : '';
}

function mergeTemplate(template: string, values: Record<string, string>, html: boolean) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => html ? escapeHtml(values[key] ?? '') : values[key] ?? '');
}

export function renderExpenseApprovalEmail(subject: string, body: string, snapshot: ExpenseApprovalSnapshot) {
  const template = validateTemplate(subject, body, expenseApprovalEmailTags);
  const link = safeApprovalLink(snapshot);
  const departmentText = snapshot.departamentos_texto
    || (typeof snapshot.departamentos === 'string' ? snapshot.departamentos : snapshot.departamentos?.map(item => item.name).filter(Boolean).join(', '))
    || 'No indicado';
  const costCenterText = snapshot.centros_costos_texto
    || snapshot.centros_costo
    || snapshot.centros_costos?.map(item => [item.code, item.name].filter(Boolean).join(' · ')).filter(Boolean).join(', ')
    || 'No indicado';
  const amount = Number(snapshot.monto_total ?? snapshot.total ?? 0);
  const values: Record<string, string> = {
    empresa_nombre: snapshot.empresa_nombre || 'GENTIA ERP',
    aprobador_nombre: snapshot.aprobador_nombre || 'Aprobador/a',
    numero_solicitud: snapshot.numero_solicitud,
    solicitante_nombre: snapshot.solicitante_nombre || '—',
    tipo_solicitud: snapshot.tipo_solicitud || 'Otros Pagos',
    fecha_solicitud: displayDate(snapshot.fecha_solicitud),
    fecha_pago_programada: displayDate(snapshot.fecha_pago_programada),
    moneda: snapshot.moneda,
    monto_total: money(amount),
    concepto: snapshot.concepto || '—',
    departamentos: departmentText,
    centros_costo: costCenterText,
    nivel_aprobacion: snapshot.nivel_aprobacion || snapshot.approvalLevelName || 'Aprobación de gasto',
    enlace_solicitud: link
  };
  const renderedSubject = mergeTemplate(template.subject, values, false).replace(/[\r\n]/g, ' ').slice(0, 200);
  const intro = cleanBody(mergeTemplate(template.body, values, true));
  const logo = snapshot.empresa_logo_url && /^https:\/\/[^\s]+$/i.test(snapshot.empresa_logo_url)
    ? `<img src="${escapeHtml(snapshot.empresa_logo_url)}" alt="${escapeHtml(values.empresa_nombre)}" style="max-width:180px;max-height:62px;margin-bottom:14px">`
    : '';
  const row = (label: string, value: string) => `<tr><td style="padding:9px 0;color:#64748b;width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:9px 0;color:#172033;font-weight:700;vertical-align:top">${escapeHtml(value || '—')}</td></tr>`;
  const button = link
    ? `<p style="margin:26px 0 12px;text-align:center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#078464;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700">Revisar y aprobar</a></p>`
    : '';
  const fallback = `<div style="margin-top:20px;padding:15px 17px;border-radius:8px;background:#f8fafc;border-left:4px solid #f26938;color:#475569;font-size:13px;line-height:1.55"><strong style="color:#172033">Para procesar la solicitud:</strong><br>1. Ingrese a GENTIA ERP.<br>2. Abra <strong>Solicitudes de Pago</strong> o <strong>Workflow · Mis aprobaciones</strong>.<br>3. Busque <strong>${escapeHtml(values.numero_solicitud)}</strong>, revise el detalle y seleccione <strong>Aprobar</strong> o <strong>Rechazar</strong>.</div>`;
  const displayedLines = (snapshot.lineas || []).slice(0, 20);
  const lineTable = displayedLines.length ? `<div style="margin-top:22px"><div style="font-size:12px;font-weight:800;color:#526176;text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px">Imputaciones de la solicitud</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px"><thead><tr style="background:#f8fafc;text-align:left"><th style="padding:9px;border-bottom:1px solid #dbe3ec">Cuenta / concepto</th><th style="padding:9px;border-bottom:1px solid #dbe3ec">Departamento / centro</th><th style="padding:9px;border-bottom:1px solid #dbe3ec;text-align:right">Monto</th></tr></thead><tbody>${displayedLines.map(line => `<tr><td style="padding:9px;border-bottom:1px solid #e8edf3"><strong>${escapeHtml(line.cuenta || '—')}</strong><br><span style="color:#64748b">${escapeHtml(line.concepto || line.tercero || '—')}</span></td><td style="padding:9px;border-bottom:1px solid #e8edf3">${escapeHtml(line.departamento || '—')}<br><span style="color:#64748b">${escapeHtml(line.centroCosto || '—')}</span></td><td style="padding:9px;border-bottom:1px solid #e8edf3;text-align:right;font-weight:700">${money(Number(line.monto || 0))}</td></tr>`).join('')}</tbody></table>${(snapshot.lineas?.length || 0) > displayedLines.length ? `<p style="font-size:12px;color:#64748b">Se muestran 20 de ${snapshot.lineas?.length} imputaciones. Consulte la solicitud para ver el detalle completo.</p>` : ''}</div>` : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="660" cellspacing="0" cellpadding="0" style="width:100%;max-width:660px;background:#fff;border:1px solid #dbe3ec;border-radius:12px;overflow:hidden"><tr><td style="padding:27px;background:#042e72;color:#fff;text-align:center">${logo}<div style="font-size:12px;letter-spacing:1.3px;font-weight:700;color:#9fe1cf">APROBACIÓN PENDIENTE</div><h1 style="font-size:24px;line-height:1.25;margin:10px 0 5px">Solicitud de gasto</h1><div style="font-size:15px">${escapeHtml(values.numero_solicitud)}</div></td></tr><tr><td style="padding:28px;line-height:1.6">${intro}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${row('Solicitante', values.solicitante_nombre)}${row('Tipo', values.tipo_solicitud)}${row('Fecha de solicitud', values.fecha_solicitud)}${row('Pago programado', values.fecha_pago_programada)}${row('Departamento', values.departamentos)}${row('Centro de costos', values.centros_costo)}${row('Concepto', values.concepto)}${row('Nivel de aprobación', values.nivel_aprobacion)}</table><div style="margin-top:18px;padding:17px;background:#ecfdf5;border-radius:8px;text-align:center"><div style="font-size:12px;color:#526176;text-transform:uppercase;letter-spacing:.7px">Monto solicitado</div><div style="font-size:26px;font-weight:800;color:#07684f;margin-top:4px">${escapeHtml(values.monto_total)} ${escapeHtml(values.moneda)}</div></div>${lineTable}${button}${fallback}</td></tr><tr><td style="padding:16px 26px;background:#f8fafc;color:#64748b;font-size:12px;text-align:center">Mensaje automático de ${escapeHtml(values.empresa_nombre)}. La aprobación exige una sesión autenticada en GENTIA ERP.</td></tr></table></td></tr></table></body></html>`;
  const text = sanitizeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|tr|h1|div)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | '), {allowedTags: [], allowedAttributes: {}})
    .replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return {subject: renderedSubject, html, text};
}

export async function expenseApprovalTemplateSettings(authorization: string, action: string, payload: Record<string, unknown>) {
  if (action === 'save') {
    const template = validateTemplate(String(payload.subject || ''), String(payload.body || ''), expenseApprovalEmailTags);
    return rpc('expense_approval_email_settings', {p_action: 'save', p_payload: {...template, active: payload.active === true}}, authorization);
  }
  const data = await rpc('expense_approval_email_settings', {p_action: 'get', p_payload: {}}, authorization) as Record<string, any>;
  if (data.template?.cuerpo_template) data.template.cuerpo_template = cleanBody(String(data.template.cuerpo_template));
  if (action === 'preview') {
    return renderExpenseApprovalEmail(String(payload.subject || expenseApprovalEmailSubject), String(payload.body || expenseApprovalEmailBody), {
      empresa_nombre: String(data.subsidiary?.name || 'Empresa de ejemplo'),
      empresa_logo_url: data.subsidiary?.logo,
      aprobador_nombre: 'Ana Aprobadora',
      numero_solicitud: 'SOL-PAG-2026-00128',
      solicitante_nombre: 'Carlos Solicitante',
      tipo_solicitud: 'Otros Pagos',
      fecha_solicitud: '2026-10-05',
      fecha_pago_programada: '2026-10-10',
      moneda: 'USD',
      monto_total: 4850,
      concepto: 'Servicios profesionales del proyecto regional',
      departamentos: 'Operaciones',
      centros_costo: 'CC-104 · Proyecto Regional',
      nivel_aprobacion: 'Aprobación Proyectos (UP)',
      enlace_solicitud: '/payment-requests.html?id=128'
    });
  }
  if (action !== 'get') throw Error('Acción inválida.');
  return {...data, transport: smtpStatus(), defaults: {subject: expenseApprovalEmailSubject, body: expenseApprovalEmailBody}};
}

function recipient(job: ExpenseApprovalEmailJob) {
  return String(job.email ?? job.destinatario ?? job.recipient_email ?? '').trim();
}

export async function deliverExpenseApprovalJob(
  job: ExpenseApprovalEmailJob,
  send: (message: Record<string, unknown>) => Promise<MailResult>,
  finish: Finish
) {
  const to = recipient(job);
  let message: ReturnType<typeof renderExpenseApprovalEmail>;
  try {
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || to.length > 254) throw Error('Destinatario inválido.');
    const subjectTemplate = job.subject_template ?? job.asunto_template;
    const bodyTemplate = job.body_template ?? job.cuerpo_template;
    if (!subjectTemplate || !bodyTemplate) throw Error('La cola no contiene una plantilla válida.');
    message = renderExpenseApprovalEmail(subjectTemplate, bodyTemplate, job.payload);
  } catch {
    await finish('ERROR', null, 'No fue posible validar el destinatario o preparar la notificación de aprobación.');
    return;
  }
  let result: MailResult;
  try {
    result = await send({from: process.env.SMTP_FROM, to, ...message, disableFileAccess: true, disableUrlAccess: true});
  } catch (cause) {
    const failure = cause as SmtpFailure;
    const disposition = smtpFailureDisposition(failure);
    const detail = failure.responseCode || failure.code || failure.command || 'conexión';
    await finish(disposition, null,
      disposition === 'REINTENTO'
        ? `Fallo SMTP temporal confirmado antes de la aceptación (${detail}). Se reintentará automáticamente.`
        : disposition === 'ERROR'
          ? `El servidor SMTP rechazó la notificación (${detail}).`
          : 'No se pudo confirmar el resultado. Revise el SMTP antes de reenviar.');
    return;
  }
  await finish(result.accepted?.length ? 'ENVIADO' : 'ERROR', result.messageId ?? null, result.accepted?.length ? null : 'El servidor SMTP no aceptó al destinatario.');
}

export function startExpenseApprovalNotifications() {
  const smtp = smtpStatus();
  if (!smtp.enabled) {
    console.log('Aprobaciones de gastos: envío SMTP desactivado.');
    return;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? {user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD} : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const job = await rpc('expense_approval_email_claim', {}) as ExpenseApprovalEmailJob | null;
      if (job) await deliverExpenseApprovalJob(job, message => transport.sendMail(message), (status, message, error) => rpc('expense_approval_email_finish', {
        p_id: job.id,
        p_lease: job.lease,
        p_status: status,
        p_message_id: message,
        p_error: error
      }));
    } catch {
      console.error('Aprobaciones de gastos: no se pudo completar el ciclo de la cola.');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 10000);
  timer.unref();
  void tick();
}
