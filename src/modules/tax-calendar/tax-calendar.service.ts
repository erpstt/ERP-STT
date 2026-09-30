import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { getSupabaseConfig } from '../../core/database/supabase.client.js';
import { rpc, smtpStatus } from '../notifications/email-notification.service.js';
import { escapeHtml } from '../notifications/payment-email.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_UPLOADS = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png']
]);
const actions = new Set(['options', 'list', 'get', 'save', 'delete', 'mark-read']);

type JsonObject = Record<string, unknown>;
type TaxCalendarEmailPayload = JsonObject & {
  taxTypeCode?: string;
  tax_type_code?: string;
  taxTypeName?: string;
  tax_type_name?: string;
  period?: string;
  dueDate?: string;
  due_date?: string;
  daysBeforeDue?: number;
  days_before_due?: number;
  status?: string;
  subsidiaryName?: string;
  subsidiary_name?: string;
  assignedUserName?: string;
  assigned_user_name?: string;
  deepLink?: string;
  deep_link?: string;
  templateSubject?: string;
  template_subject?: string;
  templateBody?: string;
  template_body?: string;
  notificationKind?: string;
  notification_kind?: string;
};
type TaxCalendarEmailJob = JsonObject & {
  id: string;
  lease: string;
  recipient_email?: string;
  recipientEmail?: string;
  destinatario?: string;
  priority?: string;
  payload: TaxCalendarEmailPayload;
};
type TaxMailResult = { accepted?: unknown[]; messageId?: string };
type TaxFinish = (status: string, message: string | null, error: string | null) => Promise<unknown>;
type ValidatedUpload = { name: string; mimeType: string; size: number; bytes: Buffer };
export type TaxCalendarDocumentFile = { bytes: Buffer; mimeType: string; fileName: string };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function upload(payload: JsonObject) {
  const nested = object(payload.file);
  const dataUrl = nested?.dataUrl ?? nested?.data_url ?? payload.documentDataUrl ?? payload.document_data_url;
  const name = nested?.name ?? nested?.fileName ?? nested?.file_name ?? payload.documentFileName ?? payload.document_file_name;
  const mime = nested?.mimeType ?? nested?.mime_type ?? payload.documentMimeType ?? payload.document_mime_type;
  const size = nested?.size ?? nested?.fileSize ?? nested?.file_size ?? payload.documentSize ?? payload.document_size;
  return { present: nested !== null || dataUrl !== undefined, dataUrl, name, mime, size };
}

function hasMagicBytes(bytes: Buffer, kind: string) {
  if (kind === 'pdf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (kind === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function validateUpload(payload: JsonObject): ValidatedUpload | null {
  const file = upload(payload);
  if (!file.present) return null;
  if (String(payload.documentType ?? payload.document_type ?? '') !== 'file_upload') {
    throw Error('Seleccione Archivo como tipo de respaldo antes de adjuntar un documento.');
  }
  if (typeof file.dataUrl !== 'string') throw Error('El archivo adjunto no contiene datos válidos.');
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.dataUrl);
  if (!match) throw Error('El respaldo debe enviarse como un archivo codificado en data URL.');
  const mime = match[1].toLowerCase();
  const kind = ALLOWED_UPLOADS.get(mime);
  if (!kind) throw Error('Solo se permiten archivos PDF, JPG o PNG.');
  const encoded = match[2];
  if (encoded.length % 4 !== 0 || encoded.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) {
    throw Error('El archivo adjunto supera el límite de 5 MB.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw Error('El archivo adjunto supera el límite de 5 MB.');
  if (typeof file.mime === 'string' && file.mime.toLowerCase() !== mime) throw Error('El tipo declarado del archivo no coincide con su contenido.');
  if (file.size !== undefined && (!Number.isSafeInteger(Number(file.size)) || Number(file.size) !== bytes.length)) {
    throw Error('El tamaño declarado del archivo no coincide con su contenido.');
  }
  if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\x00-\x1f\\/]/.test(file.name)) {
    throw Error('El nombre del archivo no es válido.');
  }
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const validExtension = kind === 'jpeg' ? extension === 'jpg' || extension === 'jpeg' : extension === kind;
  if (!validExtension || !hasMagicBytes(bytes, kind)) throw Error('La extensión o el contenido del archivo no coincide con su tipo.');
  return { name: file.name.trim(), mimeType: mime, size: bytes.length, bytes };
}

function serviceStorage() {
  const config = getSupabaseConfig();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!config || !key) throw Error('Falta la configuración del almacenamiento seguro.');
  return { ...config, key };
}

function encodedStoragePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function safeFileName(name: string) {
  const normalized = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-120);
  return normalized || 'respaldo';
}

function uuid(value: unknown) {
  const id = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw Error('Obligación tributaria inválida.');
  return id;
}

function subsidiarySegment(value: unknown) {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(id)) throw Error('Seleccione una subsidiaria válida para almacenar el respaldo.');
  return id;
}

function isStoragePath(path: string) {
  const segments = path.split('/');
  return path.length <= 700 && segments.length === 3 && /^[1-9][0-9]*$/.test(segments[0]) && /^[0-9a-f-]{36}$/i.test(segments[1]) && !!segments[2] && !segments.some(segment => segment === '.' || segment === '..');
}

async function uploadDocument(path: string, file: ValidatedUpload) {
  const storage = serviceStorage();
  const response = await fetch(new URL(`/storage/v1/object/tax-calendar/${encodedStoragePath(path)}`, storage.url), {
    method: 'POST',
    headers: { apikey: storage.key, Authorization: `Bearer ${storage.key}`, 'Content-Type': file.mimeType, 'x-upsert': 'false' },
    body: file.bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw Error('No fue posible guardar el respaldo en el almacenamiento seguro.');
}

async function removeDocument(path: string) {
  if (!isStoragePath(path)) throw Error('La ruta del respaldo no es válida.');
  const storage = serviceStorage();
  const response = await fetch(new URL('/storage/v1/object/tax-calendar', storage.url), {
    method: 'DELETE',
    headers: { apikey: storage.key, Authorization: `Bearer ${storage.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw Error('No fue posible retirar el respaldo anterior del almacenamiento seguro.');
}

function withoutClientStorageFields(payload: JsonObject) {
  const clean = { ...payload };
  for (const key of ['file', 'documentDataUrl', 'document_data_url', 'documentFileName', 'document_file_name', 'documentMimeType', 'document_mime_type', 'documentSize', 'document_size', 'storagePath', 'storage_path']) delete clean[key];
  return clean;
}

export async function taxCalendarAction(authorization: string, action: string, payload: JsonObject = {}) {
  if (!actions.has(action)) throw Error('Acción de calendario tributario inválida.');
  if (action !== 'save') {
    const result = await rpc('tax_calendar_manage', { p_action: action, p_payload: payload }, authorization);
    if (action === 'options') {
      const base = object(result) ?? {};
      const catalog = object(await rpc('tax_obligation_catalog_manage', { p_action: 'calendar-options', p_payload: {} }, authorization));
      return { ...base, taxTypes: Array.isArray(catalog?.taxTypes) ? catalog.taxTypes : [] };
    }
    const obsolete = String(object(result)?.obsoleteStoragePath ?? object(result)?.obsolete_storage_path ?? '');
    if (obsolete) {
      try { await removeDocument(obsolete); }
      catch { console.error('Calendario tributario: no se pudo retirar el respaldo eliminado.'); }
    }
    return result;
  }

  const file = validateUpload(payload);
  const rpcPayload = withoutClientStorageFields(payload);
  if (!file) {
    const result = await rpc('tax_calendar_manage', { p_action: action, p_payload: rpcPayload }, authorization);
    const obsolete = String(object(result)?.obsoleteStoragePath ?? object(result)?.obsolete_storage_path ?? '');
    if (obsolete) {
      try { await removeDocument(obsolete); }
      catch { console.error('Calendario tributario: no se pudo retirar el respaldo sustituido.'); }
    }
    return result;
  }

  const eventId = payload.id ? uuid(payload.id) : randomUUID();
  const subsidiaryId = subsidiarySegment(payload.subsidiaryId ?? payload.subsidiary_id);
  const storagePath = `${subsidiaryId}/${eventId}/${randomUUID()}-${safeFileName(file.name)}`;
  await uploadDocument(storagePath, file);
  rpcPayload.id = eventId;
  rpcPayload.file = { name: file.name, mimeType: file.mimeType, size: file.size, storagePath };
  let result: unknown;
  try {
    result = await rpc('tax_calendar_manage', { p_action: action, p_payload: rpcPayload }, authorization);
  } catch (cause) {
    try { await removeDocument(storagePath); }
    catch { console.error('Calendario tributario: no se pudo limpiar un respaldo rechazado.'); }
    throw cause;
  }
  const response = object(result);
  const obsolete = String(response?.obsoleteStoragePath ?? response?.obsolete_storage_path ?? '');
  if (obsolete && obsolete !== storagePath) {
    try { await removeDocument(obsolete); }
    catch { console.error('Calendario tributario: no se pudo retirar el respaldo sustituido.'); }
  }
  return result;
}

export async function taxCalendarDocument(authorization: string, eventId: string): Promise<TaxCalendarDocumentFile> {
  const id = uuid(eventId);
  const metadata = object(await rpc('tax_calendar_document', { p_event_id: id }, authorization));
  const path = String(metadata?.storagePath ?? metadata?.storage_path ?? '');
  if (!isStoragePath(path) || path.split('/')[1].toLowerCase() !== id) throw Error('El respaldo de la obligación no está disponible.');
  const mimeType = String(metadata?.mimeType ?? metadata?.mime_type ?? '').toLowerCase();
  const kind = ALLOWED_UPLOADS.get(mimeType);
  if (!kind) throw Error('El respaldo tiene un tipo de archivo no permitido.');
  const fileName = String(metadata?.fileName ?? metadata?.file_name ?? 'respaldo');
  if (!fileName || fileName.length > 255 || /[\x00-\x1f\\/]/.test(fileName)) throw Error('El respaldo tiene un nombre de archivo inválido.');
  const storage = serviceStorage();
  const response = await fetch(new URL(`/storage/v1/object/authenticated/tax-calendar/${encodedStoragePath(path)}`, storage.url), {
    headers: { apikey: storage.key, Authorization: `Bearer ${storage.key}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw Error(response.status === 404 ? 'El archivo de respaldo ya no existe.' : 'No fue posible descargar el respaldo.');
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) throw Error('El respaldo supera el límite permitido.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || !hasMagicBytes(bytes, kind)) throw Error('El contenido del respaldo no es válido.');
  return { bytes, mimeType, fileName };
}

function stringValue(payload: TaxCalendarEmailPayload, camel: keyof TaxCalendarEmailPayload, snake: keyof TaxCalendarEmailPayload) {
  return String(payload[camel] ?? payload[snake] ?? '');
}

function date(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : value;
}

function safeLink(payload: TaxCalendarEmailPayload) {
  const raw = stringValue(payload, 'deepLink', 'deep_link');
  if (/^https:\/\/[^\s]+$/i.test(raw)) return raw;
  if (!/^\/(?!\/)[^\s]*$/.test(raw)) return '';
  const base = String(process.env.APP_BASE_URL ?? process.env.GENTIA_APP_URL ?? process.env.NEXO_APP_URL ?? '').replace(/\/$/, '');
  return /^https?:\/\/[^\s]+$/i.test(base) ? base + raw : '';
}

function applyEmailTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([a-z_]+)\}\}/gi, (_match, token: string) => values[token.toLowerCase()] ?? '');
}

export function renderTaxCalendarEmail(job: TaxCalendarEmailJob) {
  const payload = object(job.payload) as TaxCalendarEmailPayload | null;
  if (!payload) throw Error('La notificación no contiene datos de la obligación.');
  const company = stringValue(payload, 'subsidiaryName', 'subsidiary_name') || 'GENTIA ERP';
  const taxType = stringValue(payload, 'taxTypeCode', 'tax_type_code');
  const taxTypeName = stringValue(payload, 'taxTypeName', 'tax_type_name') || taxType;
  const period = String(payload.period ?? '');
  const dueDate = stringValue(payload, 'dueDate', 'due_date');
  const status = String(payload.status ?? '').toLowerCase();
  const responsible = stringValue(payload, 'assignedUserName', 'assigned_user_name');
  const daysValue = payload.daysBeforeDue ?? payload.days_before_due;
  const days = daysValue === undefined || daysValue === null ? null : Number(daysValue);
  const high = String(job.priority ?? '').toUpperCase() === 'HIGH' || String(job.priority ?? '').toUpperCase() === 'ALTA' || status === 'overdue' || (days !== null && days < 0);
  const timing = days === null || !Number.isFinite(days)
    ? `Vencimiento: ${date(dueDate)}`
    : days < 0
      ? `Vencida hace ${Math.abs(days)} ${Math.abs(days) === 1 ? 'día' : 'días'}`
      : days === 0
        ? 'Vence hoy'
        : `Vence en ${days} ${days === 1 ? 'día' : 'días'}`;
  const heading = high ? 'Obligación tributaria vencida' : 'Recordatorio de obligación tributaria';
  const link = safeLink(payload);
  const statusLabel = ({ pending: 'Pendiente', in_review: 'En revisión', filed: 'Presentada', overdue: 'Vencida', exempt: 'Exenta' } as Record<string, string>)[status] ?? status;
  const values = {
    empresa: company,
    obligacion: taxTypeName || taxType || 'Obligación tributaria',
    codigo: taxType,
    periodo: period,
    fecha_vencimiento: date(dueDate),
    responsable: responsible || 'Sin asignar',
    estado: statusLabel,
    mensaje_vencimiento: timing,
    enlace: link
  };
  const defaultSubject = `${high ? 'URGENTE · ' : ''}${values.obligacion} · ${company} · ${timing}`;
  const configuredSubject = stringValue(payload, 'templateSubject', 'template_subject');
  const subject = applyEmailTemplate(configuredSubject || defaultSubject, values).replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || defaultSubject.slice(0, 200);
  const defaultBody = `${company} tiene una obligación fiscal que requiere seguimiento.\n\n${values.obligacion} corresponde al período ${period} y ${timing.toLowerCase()}.`;
  const configuredBody = stringValue(payload, 'templateBody', 'template_body');
  const bodyText = applyEmailTemplate(configuredBody || defaultBody, values).trim().slice(0, 8000) || defaultBody;
  const bodyHtml = escapeHtml(bodyText).replace(/\r?\n/g, '<br>');
  const row = (label: string, value: string) => `<tr><td style="padding:8px 0;color:#64748b;width:42%">${escapeHtml(label)}</td><td style="padding:8px 0;font-weight:700;color:#172033">${escapeHtml(value || '—')}</td></tr>`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden"><tr><td style="padding:24px;background:${high ? '#991b1b' : '#042e72'};color:#fff"><div style="font-size:12px;letter-spacing:1px;font-weight:700">${high ? 'PRIORIDAD ALTA' : 'CALENDARIO TRIBUTARIO'}</div><h1 style="font-size:24px;line-height:1.25;margin:9px 0 0">${escapeHtml(heading)}</h1></td></tr><tr><td style="padding:26px"><div style="margin:0 0 20px;line-height:1.65">${bodyHtml}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${row('Obligación', taxTypeName)}${row('Código', taxType)}${row('Período', period)}${row('Fecha límite', date(dueDate))}${row('Estado', statusLabel)}${responsible ? row('Responsable', responsible) : ''}</table><p style="margin:22px 0 0;padding:14px 16px;border-radius:8px;background:${high ? '#fef2f2' : '#ecfdf5'};color:${high ? '#991b1b' : '#065f46'};font-weight:700">${escapeHtml(timing)}</p>${link ? `<p style="margin:24px 0 0;text-align:center"><a href="${escapeHtml(link)}" style="display:inline-block;background:#042e72;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:700">Abrir obligación en GENTIA</a></p>` : ''}</td></tr><tr><td style="padding:16px 26px;background:#f8fafc;color:#64748b;font-size:12px;text-align:center">Mensaje automático de GENTIA ERP</td></tr></table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${bodyText}\n\nObligación: ${taxTypeName}\nCódigo: ${taxType}\nPeríodo: ${period}\nFecha límite: ${date(dueDate)}\nEstado: ${statusLabel}\n${timing}${link ? `\n${link}` : ''}`;
  return { subject, html, text };
}

function recipient(job: TaxCalendarEmailJob) {
  return String(job.recipient_email ?? job.recipientEmail ?? job.destinatario ?? '');
}

export async function deliverTaxCalendarJob(
  job: TaxCalendarEmailJob,
  send: (message: JsonObject) => Promise<TaxMailResult>,
  begin: () => Promise<boolean>,
  finish: TaxFinish
) {
  const to = recipient(job);
  let message: ReturnType<typeof renderTaxCalendarEmail>;
  try {
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || to.length > 254) throw Error('Destinatario inválido.');
    message = renderTaxCalendarEmail(job);
  } catch {
    await finish('ERROR', null, 'No fue posible validar el destinatario o preparar la notificación tributaria.');
    return;
  }
  if (!await begin()) return;
  let result: TaxMailResult;
  try {
    result = await send({ from: process.env.SMTP_FROM, to, ...message, disableFileAccess: true, disableUrlAccess: true });
  } catch (cause) {
    const failure = cause as { responseCode?: number; command?: string; code?: string };
    const rejected = !!failure.responseCode || ['CONN', 'AUTH', 'EHLO', 'HELO', 'STARTTLS', 'MAIL FROM', 'RCPT TO'].includes(failure.command ?? '');
    await finish(rejected ? 'ERROR' : 'INCIERTO', null, rejected ? 'El servidor SMTP rechazó la notificación tributaria.' : 'El resultado SMTP no pudo confirmarse. Revise el servidor antes de reenviar.');
    return;
  }
  await finish(result.accepted?.length ? 'ENVIADO' : 'ERROR', result.messageId ?? null, result.accepted?.length ? null : 'El servidor SMTP no aceptó al destinatario.');
}

export function startTaxCalendarNotifications() {
  const smtp = smtpStatus();
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = smtp.enabled ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
    disableFileAccess: true,
    disableUrlAccess: true
  }) : null;
  let busy = false;
  let lastSchedule = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastSchedule >= 60000) {
        await rpc('tax_calendar_schedule', {});
        lastSchedule = Date.now();
      }
      if (!transport) return;
      const job = await rpc('tax_calendar_claim', {}) as TaxCalendarEmailJob | null;
      if (job) await deliverTaxCalendarJob(
        job,
        message => transport.sendMail(message),
        () => rpc('tax_calendar_begin_send', { p_id: job.id, p_lease: job.lease }) as Promise<boolean>,
        (status, message, error) => rpc('tax_calendar_finish', { p_id: job.id, p_lease: job.lease, p_status: status, p_message: message, p_error: error })
      );
    } catch {
      console.error('Calendario tributario: no se pudo completar el ciclo de notificaciones.');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 10000);
  timer.unref();
  void tick();
  if (!smtp.enabled) console.log('Calendario tributario: recordatorios internos activos; envío SMTP desactivado.');
}
