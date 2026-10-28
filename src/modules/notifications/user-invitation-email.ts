import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { cleanBody, escapeHtml, validateTemplate } from './payment-email.js';
import { rpc, smtpStatus } from './email-notification.service.js';

export const userInvitationEmailTags = [
  'empresa_nombre',
  'usuario_nombre',
  'usuario_correo',
  'enlace_activacion',
  'fecha_expiracion'
];

export const userPasswordRecoveryEmailTags = [
  'empresa_nombre',
  'usuario_nombre',
  'usuario_correo',
  'enlace_recuperacion',
  'fecha_expiracion'
];

export const userInvitationEmailSubject = 'Activa tu acceso a GENTIA ERP · {{empresa_nombre}}';
export const userInvitationEmailBody = '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Se creó una cuenta para ti en GENTIA ERP con el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón de activación para establecer tu contraseña personal. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>';
export const userPasswordRecoveryEmailSubject = 'Recupera tu acceso a GENTIA ERP · {{empresa_nombre}}';
export const userPasswordRecoveryEmailBody = '<p>Hola <strong>{{usuario_nombre}}</strong>,</p><p>Un administrador solicitó la recuperación de tu acceso a GENTIA ERP para el correo <strong>{{usuario_correo}}</strong>.</p><p>Utiliza el botón para definir una nueva contraseña. El enlace es confidencial, de un solo uso y vence el {{fecha_expiracion}}.</p>';

export type UserInvitationEmailSnapshot = {
  empresa_nombre: string;
  empresa_logo_url?: string | null;
  usuario_nombre: string;
  usuario_correo: string;
  enlace_activacion: string;
  fecha_expiracion: string;
  access_mode?: 'INVITATION' | 'RECOVERY';
};

type InvitationTemplateSettings = {
  template?: {
    asunto_template?: string;
    cuerpo_template?: string;
    activo?: boolean;
  } | null;
  subsidiary?: {name?: string;logo?: string | null} | null;
  canEdit?: boolean;
};

type MailResult = {accepted?: unknown[];messageId?: string};

export type UserAccessEmailIssue =
  | 'TEMPLATE_UNAVAILABLE'
  | 'TEMPLATE_MISSING'
  | 'TEMPLATE_INACTIVE'
  | 'TEMPLATE_INVALID'
  | 'SMTP_NOT_CONFIGURED'
  | 'SMTP_DISABLED'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_UNAVAILABLE'
  | 'SMTP_REJECTED'
  | 'SMTP_SEND_FAILED';

export class UserAccessEmailError extends Error {
  constructor(readonly issue: UserAccessEmailIssue, message: string) {
    super(message);
    this.name = 'UserAccessEmailError';
  }
}

function smtpDeliveryError(cause: unknown, templateLabel: string) {
  const detail = typeof cause === 'object' && cause !== null
    ? cause as {code?: unknown;command?: unknown;responseCode?: unknown}
    : {};
  const code = String(detail.code ?? '').toUpperCase();
  const command = String(detail.command ?? '').toUpperCase();
  if (code === 'EAUTH' || command === 'AUTH') {
    return new UserAccessEmailError(
      'SMTP_AUTH_FAILED',
      'El servidor SMTP rechazó la autenticación. Revise SMTP_USER y SMTP_PASSWORD en Railway.'
    );
  }
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'ESOCKET', 'ETIMEDOUT'].includes(code)) {
    return new UserAccessEmailError(
      'SMTP_UNAVAILABLE',
      'No fue posible conectar con el servidor SMTP. Revise SMTP_HOST, SMTP_PORT y la conectividad de Railway.'
    );
  }
  if (detail.responseCode || ['MAIL FROM', 'RCPT TO'].includes(command)) {
    return new UserAccessEmailError(
      'SMTP_REJECTED',
      `El servidor SMTP rechazó el correo de ${templateLabel}. Revise el remitente y el destinatario.`
    );
  }
  return new UserAccessEmailError(
    'SMTP_SEND_FAILED',
    `No fue posible enviar el correo de ${templateLabel}. Revise la configuración SMTP de Railway e intente nuevamente.`
  );
}

function validEmail(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) || email.length > 254) {
    throw new Error('El usuario no tiene un correo electrónico válido.');
  }
  return email;
}

function safeActivationLink(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 8192) throw new Error('El enlace de activación no es válido.');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('El enlace de activación no es válido.'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('El enlace de activación debe utilizar HTTPS.');
  }
  if (url.username || url.password) throw new Error('El enlace de activación no es válido.');
  return url.toString();
}

function displayExpiration(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || 'según lo indicado en el enlace';
  const formatted = new Intl.DateTimeFormat('es-CR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Costa_Rica'
  }).format(date);
  return `${formatted} (hora de Costa Rica)`;
}

function mergeTemplate(template: string, values: Record<string, string>, html: boolean) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => html
    ? escapeHtml(values[key] ?? '')
    : values[key] ?? '');
}

function validateInvitationSubject(subject: string) {
  if (/\{\{\s*enlace_(?:activacion|recuperacion)\s*\}\}/i.test(subject)) {
    throw new Error('La variable del enlace seguro solo puede utilizarse en el cuerpo del correo.');
  }
}

export function renderUserInvitationEmail(
  subject: string,
  body: string,
  snapshot: UserInvitationEmailSnapshot
) {
  const isRecovery = snapshot.access_mode === 'RECOVERY';
  validateInvitationSubject(subject);
  const template = validateTemplate(subject, body, isRecovery ? userPasswordRecoveryEmailTags : userInvitationEmailTags);
  const activationLink = safeActivationLink(snapshot.enlace_activacion);
  const recipientEmail = validEmail(snapshot.usuario_correo);
  const values: Record<string, string> = {
    empresa_nombre: snapshot.empresa_nombre || 'GENTIA ERP',
    usuario_nombre: snapshot.usuario_nombre || recipientEmail,
    usuario_correo: recipientEmail,
    enlace_activacion: activationLink,
    enlace_recuperacion: activationLink,
    fecha_expiracion: displayExpiration(snapshot.fecha_expiracion)
  };
  const securityEyebrow = isRecovery ? 'RECUPERACIÓN SEGURA' : 'INVITACIÓN SEGURA';
  const securityTitle = isRecovery ? 'Restablece tu contraseña' : 'Activa tu cuenta';
  const actionLabel = isRecovery ? 'Definir nueva contraseña' : 'Activar mi cuenta';
  const recoveryNotice = isRecovery
    ? '<p style="margin:0 0 18px;padding:13px 15px;border-radius:8px;background:#eefbf7;border:1px solid #b9e7d8;color:#125b48"><strong>Un administrador solicitó este enlace para recuperar tu acceso.</strong> Tu contraseña actual no se conoce, no se muestra y no se envía por correo.</p>'
    : '';
  const renderedSubject = mergeTemplate(template.subject, values, false).replace(/[\r\n]/g, ' ').slice(0, 200);
  const introduction = cleanBody(mergeTemplate(template.body, values, true));
  const logo = snapshot.empresa_logo_url && /^https:\/\/[^\s]+$/i.test(snapshot.empresa_logo_url)
    ? `<img src="${escapeHtml(snapshot.empresa_logo_url)}" alt="${escapeHtml(values.empresa_nombre)}" style="max-width:180px;max-height:64px;margin-bottom:14px">`
    : '';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#334155"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff;border:1px solid #dbe3ec;border-radius:12px;overflow:hidden"><tr><td style="padding:28px;background:#042e72;color:#fff;text-align:center">${logo}<div style="font-size:12px;letter-spacing:1.2px;font-weight:700;color:#9fe1cf">${securityEyebrow}</div><h1 style="font-size:24px;line-height:1.25;margin:10px 0 5px">${securityTitle}</h1><div style="font-size:14px">${escapeHtml(values.empresa_nombre)}</div></td></tr><tr><td style="padding:30px;line-height:1.6">${recoveryNotice}${introduction}<p style="margin:28px 0 18px;text-align:center"><a href="${escapeHtml(activationLink)}" style="display:inline-block;background:#078464;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700">${actionLabel}</a></p><div style="margin:20px 0;padding:16px 18px;border-radius:8px;background:#f4f8fb;border:1px solid #dbe5ee;font-size:13px;line-height:1.65"><strong style="color:#172033">Pasos para ingresar</strong><ol style="margin:8px 0 0;padding-left:20px"><li>Selecciona <strong>${actionLabel}</strong> y crea tu contraseña personal.</li><li>Inicia sesión con el correo <strong>${escapeHtml(recipientEmail)}</strong>.</li><li>Dentro de GENTIA puedes actualizarla desde el menú lateral, en <strong>Cambiar contraseña</strong>. Si la olvidas, utiliza <strong>¿Olvidaste tu contraseña?</strong> en la pantalla de acceso.</li></ol></div><div style="padding:15px 17px;border-radius:8px;background:#f8fafc;border-left:4px solid #f26938;color:#475569;font-size:13px;line-height:1.55"><strong style="color:#172033">Protege tu acceso</strong><br>Este enlace es personal y de un solo uso. No lo reenvíes ni compartas. GENTIA nunca solicitará tu contraseña por correo.</div><p style="margin-top:22px;font-size:12px;color:#64748b">Si el botón no funciona, copia este enlace en tu navegador:<br><a href="${escapeHtml(activationLink)}" style="color:#0759a5;word-break:break-all">${escapeHtml(activationLink)}</a></p><p style="font-size:12px;color:#64748b">Si no esperabas este mensaje, ignóralo y no abras el enlace.</p></td></tr><tr><td style="padding:16px 26px;background:#f8fafc;color:#64748b;font-size:12px;text-align:center">Mensaje automático de ${escapeHtml(values.empresa_nombre)}. No contiene ni comunica contraseñas.</td></tr></table></td></tr></table></body></html>`;
  const text = sanitizeHtml(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|tr|h1|div)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | '),
    {allowedTags: [], allowedAttributes: {}}
  ).replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return {subject: renderedSubject, html, text};
}

export async function userInvitationTemplateSettings(
  authorization: string,
  action: string,
  payload: Record<string, unknown>
) {
  if (action === 'save') {
    validateInvitationSubject(String(payload.subject || ''));
    const template = validateTemplate(
      String(payload.subject || ''),
      String(payload.body || ''),
      userInvitationEmailTags
    );
    return rpc('user_invitation_email_settings', {
      p_action: 'save',
      p_payload: {...template, active: payload.active === true}
    }, authorization);
  }
  const data = await rpc('user_invitation_email_settings', {
    p_action: 'get',
    p_payload: {}
  }, authorization) as InvitationTemplateSettings;
  if (data.template?.cuerpo_template) {
    data.template.cuerpo_template = cleanBody(String(data.template.cuerpo_template));
  }
  if (action === 'preview') {
    return renderUserInvitationEmail(
      String(payload.subject || userInvitationEmailSubject),
      String(payload.body || userInvitationEmailBody),
      {
        empresa_nombre: data.subsidiary?.name || 'Empresa de ejemplo',
        empresa_logo_url: data.subsidiary?.logo,
        usuario_nombre: 'María González',
        usuario_correo: 'maria.gonzalez@example.com',
        enlace_activacion: 'https://app.example.com/activar-cuenta?token=enlace-de-ejemplo',
        fecha_expiracion: '2026-10-27T18:00:00-06:00'
      }
    );
  }
  if (action !== 'get') throw new Error('Acción inválida.');
  return {
    ...data,
    transport: smtpStatus(),
    defaults: {subject: userInvitationEmailSubject, body: userInvitationEmailBody}
  };
}

export async function userPasswordRecoveryTemplateSettings(
  authorization: string,
  action: string,
  payload: Record<string, unknown>
) {
  if (action === 'save') {
    validateInvitationSubject(String(payload.subject || ''));
    const template = validateTemplate(
      String(payload.subject || ''),
      String(payload.body || ''),
      userPasswordRecoveryEmailTags
    );
    return rpc('user_password_recovery_email_settings', {
      p_action: 'save',
      p_payload: {...template, active: payload.active === true}
    }, authorization);
  }
  const data = await rpc('user_password_recovery_email_settings', {
    p_action: 'get',
    p_payload: {}
  }, authorization) as InvitationTemplateSettings;
  if (data.template?.cuerpo_template) {
    data.template.cuerpo_template = cleanBody(String(data.template.cuerpo_template));
  }
  if (action === 'preview') {
    return renderUserInvitationEmail(
      String(payload.subject || userPasswordRecoveryEmailSubject),
      String(payload.body || userPasswordRecoveryEmailBody),
      {
        empresa_nombre: data.subsidiary?.name || 'Empresa de ejemplo',
        empresa_logo_url: data.subsidiary?.logo,
        usuario_nombre: 'María González',
        usuario_correo: 'maria.gonzalez@example.com',
        enlace_activacion: 'https://app.example.com/recuperar-acceso?token=enlace-de-ejemplo',
        fecha_expiracion: '2026-10-27T18:00:00-06:00',
        access_mode: 'RECOVERY'
      }
    );
  }
  if (action !== 'get') throw new Error('Acción inválida.');
  return {
    ...data,
    transport: smtpStatus(),
    defaults: {subject: userPasswordRecoveryEmailSubject, body: userPasswordRecoveryEmailBody}
  };
}

async function deliverUserAccessEmail(
  settings: InvitationTemplateSettings,
  snapshot: UserInvitationEmailSnapshot,
  defaults: {subject:string;body:string},
  templateLabel: string
) {
  if (!settings.template) {
    throw new UserAccessEmailError(
      'TEMPLATE_MISSING',
      `Configure la plantilla de ${templateLabel} en Configuración > Plantillas de Notificación.`
    );
  }
  if (!settings.template.activo) {
    throw new UserAccessEmailError(
      'TEMPLATE_INACTIVE',
      `Active la plantilla de ${templateLabel} en Configuración > Plantillas de Notificación.`
    );
  }
  const transportStatus = smtpStatus();
  if (!transportStatus.configured) {
    throw new UserAccessEmailError(
      'SMTP_NOT_CONFIGURED',
      'El correo no fue enviado: configure SMTP_HOST, SMTP_PORT y SMTP_FROM en Railway.'
    );
  }
  if (!transportStatus.enabled) {
    throw new UserAccessEmailError(
      'SMTP_DISABLED',
      'El correo no fue enviado: configure EMAIL_NOTIFICATIONS_ENABLED=true en Railway y vuelva a desplegar.'
    );
  }
  const effectiveSnapshot: UserInvitationEmailSnapshot = {
    ...snapshot,
    empresa_nombre: snapshot.empresa_nombre || settings.subsidiary?.name || 'GENTIA ERP',
    empresa_logo_url: snapshot.empresa_logo_url || settings.subsidiary?.logo || null
  };
  let message: ReturnType<typeof renderUserInvitationEmail>;
  try {
    message = renderUserInvitationEmail(
      String(settings.template.asunto_template || defaults.subject),
      String(settings.template.cuerpo_template || defaults.body),
      effectiveSnapshot
    );
  } catch {
    throw new UserAccessEmailError(
      'TEMPLATE_INVALID',
      `La plantilla de ${templateLabel} contiene datos o variables no válidos. Revísela en Configuración > Plantillas de Notificación.`
    );
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER
      ? {user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD}
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  let result: MailResult;
  try {
    result = await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: validEmail(effectiveSnapshot.usuario_correo),
      ...message,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  } catch (cause) {
    throw smtpDeliveryError(cause, templateLabel);
  } finally {
    transport.close();
  }
  if (!result.accepted?.length) {
    throw new UserAccessEmailError(
      'SMTP_REJECTED',
      `El servidor SMTP no aceptó al destinatario del correo de ${templateLabel}. Revise su dirección de correo.`
    );
  }
  return {success: true, messageId: result.messageId ?? null};
}

export async function sendUserInvitationEmail(
  authorization: string,
  snapshot: UserInvitationEmailSnapshot
) {
  let settings: InvitationTemplateSettings;
  try {
    settings = await rpc('user_invitation_email_settings', {
      p_action: 'delivery',
      p_payload: {}
    }, authorization) as InvitationTemplateSettings;
  } catch {
    throw new UserAccessEmailError(
      'TEMPLATE_UNAVAILABLE',
      'No fue posible consultar la plantilla de invitación. Revise su configuración y permisos.'
    );
  }
  return deliverUserAccessEmail(settings,{...snapshot,access_mode:'INVITATION'},{subject:userInvitationEmailSubject,body:userInvitationEmailBody},'invitación');
}

export async function sendUserPasswordRecoveryEmail(
  authorization: string,
  snapshot: UserInvitationEmailSnapshot
) {
  let settings: InvitationTemplateSettings;
  try {
    settings = await rpc('user_password_recovery_email_settings', {
      p_action: 'delivery',
      p_payload: {}
    }, authorization) as InvitationTemplateSettings;
  } catch {
    throw new UserAccessEmailError(
      'TEMPLATE_UNAVAILABLE',
      'No fue posible consultar la plantilla de recuperación de acceso. Revise su configuración y permisos.'
    );
  }
  return deliverUserAccessEmail(settings,{...snapshot,access_mode:'RECOVERY'},{subject:userPasswordRecoveryEmailSubject,body:userPasswordRecoveryEmailBody},'recuperación de acceso');
}
