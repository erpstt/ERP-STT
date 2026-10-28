import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_URL = 'https://erp-stt-production.up.railway.app';
export const PRODUCTION_REDIRECT = `${PRODUCTION_URL}/**`;
const MANAGEMENT_API = 'https://api.supabase.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Falta ${name} en el entorno.`);
  return normalized;
}

export function deriveProjectRef(supabaseUrl) {
  let url;
  try {
    url = new URL(required(supabaseUrl, 'SUPABASE_URL'));
  } catch {
    throw new Error('SUPABASE_URL no es una URL válida.');
  }
  const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
  if (url.protocol !== 'https:' || !match?.[1]) {
    throw new Error('SUPABASE_URL debe usar HTTPS y pertenecer a un proyecto de supabase.co.');
  }
  return match[1].toLowerCase();
}

function redirectEntries(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  return entries.map(entry => String(entry).trim()).filter(Boolean);
}

export function mergeRedirectAllowList(current) {
  const redirects = new Set(redirectEntries(current));
  redirects.add(PRODUCTION_URL);
  redirects.add(PRODUCTION_REDIRECT);
  return [...redirects].join(',');
}

function parseBoolean(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!['true', 'false'].includes(normalized)) {
    throw new Error(`${name} debe ser true o false.`);
  }
  return normalized === 'true';
}

function parseSender(value) {
  const from = required(value, 'SMTP_FROM');
  const bracketed = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(from);
  const address = (bracketed?.[2] ?? from).trim().toLowerCase();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)) {
    throw new Error('SMTP_FROM debe contener una dirección de correo válida.');
  }
  const senderName = bracketed?.[1]?.trim().replace(/^['"]|['"]$/g, '') || 'GENTIA ERP';
  return { address, senderName };
}

export function buildSmtpConfig(environment) {
  if (!parseBoolean(environment.EMAIL_NOTIFICATIONS_ENABLED, 'EMAIL_NOTIFICATIONS_ENABLED')) {
    throw new Error('EMAIL_NOTIFICATIONS_ENABLED debe estar en true para configurar el SMTP de Supabase.');
  }
  const port = Number(required(environment.SMTP_PORT, 'SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT debe ser un puerto válido entre 1 y 65535.');
  }
  const sender = parseSender(environment.SMTP_FROM);
  return {
    external_email_enabled: true,
    smtp_admin_email: sender.address,
    smtp_sender_name: sender.senderName,
    smtp_host: required(environment.SMTP_HOST, 'SMTP_HOST'),
    smtp_port: String(port),
    smtp_user: required(environment.SMTP_USER, 'SMTP_USER'),
    smtp_pass: required(environment.SMTP_PASSWORD, 'SMTP_PASSWORD')
  };
}

async function managementRequest(fetchImpl, url, accessToken, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    },
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Supabase Management API respondió ${response.status} al consultar o actualizar Auth.`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Supabase Management API devolvió una respuesta no válida.');
  }
}

export async function configureSupabaseProductionAuth({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
  withSmtp = false,
  logger = console
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Este proceso requiere una implementación de fetch.');
  const accessToken = required(environment.SUPABASE_ACCESS_TOKEN, 'SUPABASE_ACCESS_TOKEN');
  const projectRef = deriveProjectRef(environment.SUPABASE_URL);
  const endpoint = `${MANAGEMENT_API}/projects/${encodeURIComponent(projectRef)}/config/auth`;
  const current = await managementRequest(fetchImpl, endpoint, accessToken);
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('No fue posible leer la configuración actual de Supabase Auth.');
  }

  const update = {
    site_url: PRODUCTION_URL,
    uri_allow_list: mergeRedirectAllowList(current.uri_allow_list)
  };
  if (withSmtp) Object.assign(update, buildSmtpConfig(environment));

  const redirectCount = redirectEntries(update.uri_allow_list).length;
  if (!apply) {
    logger.info(`Vista previa preparada para el proyecto ${projectRef}.`);
    logger.info(`Site URL: ${PRODUCTION_URL}`);
    logger.info(`Redirect URLs conservadas y configuradas: ${redirectCount}.`);
    logger.info(`SMTP de Supabase: ${withSmtp ? 'incluido' : 'sin cambios'}.`);
    logger.info('No se realizó ningún cambio. Ejecute nuevamente con --apply para confirmar.');
    return { applied: false, projectRef, update };
  }

  await managementRequest(fetchImpl, endpoint, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(update)
  });
  logger.info(`Configuración de Supabase Auth actualizada para ${projectRef}.`);
  logger.info(`Site URL: ${PRODUCTION_URL}`);
  logger.info(`Redirect URLs conservadas y configuradas: ${redirectCount}.`);
  logger.info(`SMTP de Supabase: ${withSmtp ? 'configurado' : 'sin cambios'}.`);
  return { applied: true, projectRef, update };
}

function loadRepositoryEnv() {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

async function main() {
  loadRepositoryEnv();
  const allowed = new Set(['--apply', '--with-smtp']);
  const unknown = process.argv.slice(2).filter(argument => !allowed.has(argument));
  if (unknown.length) throw new Error(`Opción no reconocida: ${unknown.join(', ')}`);
  await configureSupabaseProductionAuth({
    apply: process.argv.includes('--apply'),
    withSmtp: process.argv.includes('--with-smtp')
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'No fue posible configurar Supabase Auth.');
    process.exitCode = 1;
  });
}
