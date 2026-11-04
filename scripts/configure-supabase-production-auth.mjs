import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_URL = 'https://erp-stt-production.up.railway.app';
export const PRODUCTION_REDIRECT = `${PRODUCTION_URL}/**`;
const MANAGEMENT_API = 'https://api.supabase.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const PROJECT_REF = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

class ConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}
const failure = (code, message) => new ConfigurationError(code, message);
const safeError = error => error instanceof ConfigurationError
  ? error
  : failure('CONFIGURATION_FAILED', 'No fue posible configurar Supabase Auth. No se muestran detalles sensibles.');

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw failure('MISSING_CONFIGURATION', 'Falta ' + name + ' en el entorno.');
  return normalized;
}

function validateProjectRef(value) {
  if (typeof value !== 'string' || !PROJECT_REF.test(value)) {
    throw failure('INVALID_PROJECT_REF', 'El destino debe ser un project ref válido, sin URL ni credenciales.');
  }
  return value;
}

function validateTarget({ apply, withSmtp, projectRef, confirmProjectRef }) {
  if (typeof apply !== 'boolean' || typeof withSmtp !== 'boolean') {
    throw failure('INVALID_OPTIONS', 'Las opciones apply y withSmtp deben ser booleanas.');
  }
  if (apply && (projectRef === undefined || confirmProjectRef === undefined)) {
    throw failure('TARGET_CONFIRMATION_REQUIRED', 'Aplicar requiere --project-ref y --confirm-project-ref explícitos e iguales.');
  }
  const target = projectRef === undefined ? null : validateProjectRef(projectRef);
  const confirmation = confirmProjectRef === undefined ? null : validateProjectRef(confirmProjectRef);
  if ((confirmation !== null && target === null) || (confirmation !== null && confirmation !== target)) {
    throw failure('TARGET_CONFIRMATION_MISMATCH', 'El destino y su confirmación deben coincidir.');
  }
  return target;
}

export function deriveProjectRef(supabaseUrl) {
  let url;
  try {
    url = new URL(required(supabaseUrl, 'SUPABASE_URL'));
  } catch {
    throw failure('INVALID_SUPABASE_URL', 'SUPABASE_URL no es una URL válida.');
  }
  const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
  if (url.protocol !== 'https:' || !match?.[1] || url.username || url.password || url.port
      || url.search || url.hash || url.pathname !== '/') {
    throw failure('INVALID_SUPABASE_URL', 'SUPABASE_URL debe ser el origen HTTPS de un proyecto de supabase.co.');
  }
  return validateProjectRef(match[1].toLowerCase());
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
    throw failure('INVALID_CONFIGURATION', name + ' debe ser true o false.');
  }
  return normalized === 'true';
}

function parseSender(value) {
  const from = required(value, 'SMTP_FROM');
  const bracketed = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(from);
  const address = (bracketed?.[2] ?? from).trim().toLowerCase();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)) {
    throw failure('INVALID_CONFIGURATION', 'SMTP_FROM debe contener una dirección de correo válida.');
  }
  const senderName = bracketed?.[1]?.trim().replace(/^['"]|['"]$/g, '') || 'GENTIA ERP';
  return { address, senderName };
}

// Request-payload builder only: its result contains credentials and must not be logged.
export function buildSmtpConfig(environment) {
  if (!parseBoolean(environment.EMAIL_NOTIFICATIONS_ENABLED, 'EMAIL_NOTIFICATIONS_ENABLED')) {
    throw failure('INVALID_CONFIGURATION', 'EMAIL_NOTIFICATIONS_ENABLED debe estar en true para configurar el SMTP de Supabase.');
  }
  const port = Number(required(environment.SMTP_PORT, 'SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw failure('INVALID_CONFIGURATION', 'SMTP_PORT debe ser un puerto válido entre 1 y 65535.');
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

async function managementRequest(fetchImpl, url, accessToken, { method = 'GET', body } = {}) {
  try {
    const response = await fetchImpl(url, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + accessToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? ' (' + response.status + ')' : '';
      throw failure('MANAGEMENT_HTTP_ERROR', 'Supabase Management API rechazó la operación de Auth' + status + '.');
    }
    // PATCH may return configuration secrets; its body is never read or returned.
    if (method === 'PATCH' || response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw failure('MANAGEMENT_INVALID_RESPONSE', 'Supabase Management API devolvió una respuesta no válida.');
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw failure('MANAGEMENT_REQUEST_FAILED', 'No fue posible completar la solicitud a Supabase Management API.');
  }
}

export async function configureSupabaseProductionAuth({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  apply = false,
  withSmtp = false,
  projectRef,
  confirmProjectRef,
  logger = console
} = {}) {
  try {
    // Confirm the explicit target before reading environment values or credentials.
    const target = validateTarget({ apply, withSmtp, projectRef, confirmProjectRef });
    if (!apply) {
      const summary = {
        mode: 'preview', applied: false, projectRef: target,
        siteUrl: PRODUCTION_URL, productionRedirect: PRODUCTION_REDIRECT,
        preservesRedirects: true, smtpRequested: withSmtp,
        readsEnvironment: false, opensConnections: false,
        requiresExplicitTargetConfirmation: true
      };
      logger.info('Vista previa local: no se leyó el entorno ni se consultó Supabase Auth.');
      return summary;
    }

    if (deriveProjectRef(environment.SUPABASE_URL) !== target) {
      throw failure('ENVIRONMENT_TARGET_MISMATCH', 'SUPABASE_URL no coincide con el destino confirmado.');
    }
    if (typeof fetchImpl !== 'function') {
      throw failure('FETCH_REQUIRED', 'Este proceso requiere una implementación de fetch.');
    }
    const accessToken = required(environment.SUPABASE_ACCESS_TOKEN, 'SUPABASE_ACCESS_TOKEN');
    const smtp = withSmtp ? buildSmtpConfig(environment) : null;
    const endpoint = MANAGEMENT_API + '/projects/' + encodeURIComponent(target) + '/config/auth';
    const current = await managementRequest(fetchImpl, endpoint, accessToken);
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw failure('MANAGEMENT_INVALID_RESPONSE', 'No fue posible leer la configuración actual de Supabase Auth.');
    }

    const update = {
      site_url: PRODUCTION_URL,
      uri_allow_list: mergeRedirectAllowList(current.uri_allow_list),
      ...(smtp ?? {})
    };
    await managementRequest(fetchImpl, endpoint, accessToken, {
      method: 'PATCH', body: JSON.stringify(update)
    });
    const summary = {
      mode: 'applied', applied: true, projectRef: target, siteUrl: PRODUCTION_URL,
      redirectCount: redirectEntries(update.uri_allow_list).length, smtpConfigured: withSmtp
    };
    logger.info('Configuración de Supabase Auth actualizada para el destino confirmado.');
    logger.info('Redirect URLs conservadas y configuradas: ' + summary.redirectCount + '.');
    logger.info('SMTP de Supabase: ' + (withSmtp ? 'configurado' : 'sin cambios') + '.');
    return summary;
  } catch (error) {
    throw safeError(error);
  }
}

function parseArguments(argv) {
  const values = new Map();
  const booleans = new Set(['--apply', '--with-smtp', '--dry-run', '--load-env', '--help']);
  const targets = new Set(['--project-ref', '--confirm-project-ref']);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (typeof argument !== 'string') throw failure('INVALID_ARGUMENTS', 'Argumentos no válidos.');
    const separator = argument.indexOf('=');
    const flag = argument === '-h' ? '--help' : separator === -1 ? argument : argument.slice(0, separator);
    if (values.has(flag) || (!booleans.has(flag) && !targets.has(flag))) {
      throw failure('INVALID_ARGUMENTS', 'Opción no reconocida o repetida.');
    }
    if (booleans.has(flag)) {
      if (separator !== -1) throw failure('INVALID_ARGUMENTS', 'Las opciones booleanas no aceptan valores.');
      values.set(flag, true);
    } else {
      const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
      if (typeof value !== 'string' || value.startsWith('-')) {
        throw failure('INVALID_ARGUMENTS', 'Falta un valor de destino válido.');
      }
      values.set(flag, value);
    }
  }
  if (values.has('--help')) {
    if (values.size !== 1) throw failure('INVALID_ARGUMENTS', 'La ayuda debe solicitarse sin otras opciones.');
    return { help: true };
  }
  const options = {
    apply: values.has('--apply'), withSmtp: values.has('--with-smtp'),
    projectRef: values.get('--project-ref'), confirmProjectRef: values.get('--confirm-project-ref'),
    loadEnv: values.has('--load-env')
  };
  if (options.apply && values.has('--dry-run')) {
    throw failure('INVALID_ARGUMENTS', '--apply y --dry-run no pueden combinarse.');
  }
  validateTarget(options);
  if (options.loadEnv && !options.apply) {
    throw failure('ENV_LOAD_REQUIRES_APPLY', '--load-env requiere una aplicación con destino confirmado.');
  }
  return options;
}

function loadRepositoryEnv() {
  try {
    const envFile = fileURLToPath(new URL('../.env', import.meta.url));
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  } catch {
    throw failure('ENVIRONMENT_LOAD_FAILED', 'No fue posible cargar el archivo de entorno solicitado.');
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({
      mode: 'help', readsEnvironment: false, opensConnections: false,
      preview: 'node scripts/configure-supabase-production-auth.mjs [--dry-run] [--with-smtp]',
      apply: 'node scripts/configure-supabase-production-auth.mjs --apply --project-ref=<ref> --confirm-project-ref=<ref> [--with-smtp] [--load-env]',
      environment: 'El entorno solo se consulta al aplicar. El archivo .env requiere además --load-env explícito.'
    }));
    return;
  }
  if (options.loadEnv) loadRepositoryEnv();
  const summary = await configureSupabaseProductionAuth({ ...options, logger: { info() {} } });
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    const controlled = safeError(error);
    console.error(JSON.stringify({ mode: 'blocked', code: controlled.code, message: controlled.message }));
    process.exitCode = 1;
  });
}
