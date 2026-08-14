import { getSupabaseConfig } from '../../../core/database/supabase.client.js';

const BNA_HISTORY_URL = 'https://www.bna.com.ar/Cotizador/HistoricoPrincipales';
type CurrencyRow = { currency_id: number; currency_code: string };

function effectiveDate(value?: Date | string) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('La fecha efectiva no es válida.');
  return date.toISOString().slice(0, 10);
}
function previous(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
function toBnaDate(iso: string) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
function normalizeBnaDate(value: string) {
  const [day, month, year] = value.trim().split('/');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
function parseBnaAmount(value: string) {
  return Number(value.trim().replace(/\./g, '').replace(',', '.'));
}
function parseDollarRows(html: string) {
  const rows: Array<{ fecha: string; compra: number; venta: number }> = [];
  const pattern = /<tr[^>]*>[\s\S]*?<td[^>]*>\s*Dolar U\.S\.A\s*<\/td>[\s\S]*?<td[^>]*>\s*([\d.,]+)\s*<\/td>[\s\S]*?<td[^>]*>\s*([\d.,]+)\s*<\/td>[\s\S]*?<td[^>]*>\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*<\/td>[\s\S]*?<\/tr>/gi;
  for (const match of html.matchAll(pattern)) {
    rows.push({ fecha: normalizeBnaDate(match[3]), compra: parseBnaAmount(match[1]), venta: parseBnaAmount(match[2]) });
  }
  return rows;
}

/** Consulta la cotización de venta del dólar billete publicada por el BNA. */
export async function obtenerTipoDeCambioAR(monedaOrigen = 'USD', monedaDestino = 'ARS', fechaEfectiva?: Date | string) {
  const from = monedaOrigen.trim().toUpperCase(), to = monedaDestino.trim().toUpperCase(), effective = effectiveDate(fechaEfectiva);
  if (from === to) return { monedaOrigen: from, monedaDestino: to, fechaEfectiva: effective, tipoCambio: 1, fuente: 'Banco de la Nación Argentina' };
  if (!((from === 'USD' && to === 'ARS') || (from === 'ARS' && to === 'USD'))) throw new Error('Por ahora la consulta de Argentina admite únicamente USD y ARS.');
  for (let days = 0; days <= 7; days += 1) {
    const sourceDate = previous(effective, days), url = new URL(BNA_HISTORY_URL);
    url.searchParams.set('id', 'billetes');
    url.searchParams.set('fecha', toBnaDate(sourceDate));
    url.searchParams.set('idMoneda', '22');
    const response = await fetch(url, { headers: { Accept: 'text/html', 'User-Agent': 'Nexo ERP/1.0' } });
    const html = await response.text();
    if (!response.ok) throw new Error(`El BNA respondió con estado ${response.status}.`);
    const row = parseDollarRows(html).find((item) => item.fecha === sourceDate);
    if (row && Number.isFinite(row.venta) && row.venta > 0) return {
      monedaOrigen: from, monedaDestino: to, fechaEfectiva: effective, fechaFuente: sourceDate,
      tipoCambio: from === 'USD' ? row.venta : 1 / row.venta, tasaCompra: row.compra, tasaVenta: row.venta,
      serie: 'Cotización billete - venta', fuente: 'Banco de la Nación Argentina',
    };
  }
  throw new Error('El BNA no devolvió una tasa de venta válida para la fecha solicitada ni los 7 días anteriores.');
}

function claims(auth: string) {
  const part = auth.replace(/^Bearer\s+/, '').split('.')[1];
  if (!part) throw new Error('La sesión no es válida.');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}
async function rest<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetch(new URL(`/rest/v1/${path}`, config.url), { ...init, headers: { apikey: config.anonKey, Authorization: auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const raw = await response.text(), payload: unknown = raw ? JSON.parse(raw) : null;
  if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'No fue posible guardar el tipo de cambio.');
  return payload as T;
}
async function currency(auth: string, code: string) {
  const rows = await rest<CurrencyRow[]>(`currencies?select=currency_id,currency_code&currency_code=eq.${encodeURIComponent(code)}&limit=1`, auth);
  if (!rows[0]) throw new Error(`La moneda ${code} no existe en el catálogo de Monedas.`);
  return rows[0];
}
async function localCurrency(auth: string) {
  const tokenClaims = claims(auth), session = String(tokenClaims.session_id ?? tokenClaims.sub ?? '');
  const selected = await rest<Array<{ subsidiary_id: number }>>(`user_company_sessions?select=subsidiary_id&session_id=eq.${encodeURIComponent(session)}&limit=1`, auth);
  if (!selected[0]) throw new Error('Debe seleccionar una empresa activa antes de consultar el tipo de cambio.');
  const subsidiaries = await rest<Array<{ currency_id: number }>>(`subsidiaries?select=currency_id&subsidiary_id=eq.${selected[0].subsidiary_id}&limit=1`, auth);
  const currencies = await rest<CurrencyRow[]>(`currencies?select=currency_id,currency_code&currency_id=eq.${subsidiaries[0]?.currency_id ?? -1}&limit=1`, auth);
  if (!currencies[0]) throw new Error('La moneda local de la empresa activa no está configurada.');
  return currencies[0];
}
async function save(auth: string, key: string | undefined, origin: CurrencyRow, destination: CurrencyRow, rate: Awaited<ReturnType<typeof obtenerTipoDeCambioAR>>) {
  const rows = await rest<Array<Record<string, unknown>>>('exchange_rates?on_conflict=from_currency_id,to_currency_id,effective_date', auth, { method: 'POST', headers: { ...(key ? { apikey: key } : {}), Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ from_currency_id: origin.currency_id, to_currency_id: destination.currency_id, effective_date: rate.fechaEfectiva, spot_rate: rate.tipoCambio }) });
  return { ...rate, guardado: true, registro: rows[0] };
}
export async function consultarYGuardarTipoDeCambioAR(auth: string, input: { monedaOrigen?: string; monedaDestino?: string; fechaEfectiva?: Date | string }) {
  const origin = await currency(auth, (input.monedaOrigen || 'USD').trim().toUpperCase());
  const destination = input.monedaDestino ? await currency(auth, input.monedaDestino.trim().toUpperCase()) : await localCurrency(auth);
  const rate = await obtenerTipoDeCambioAR(origin.currency_code, destination.currency_code, input.fechaEfectiva);
  return origin.currency_id === destination.currency_id ? { ...rate, guardado: false } : save(auth, undefined, origin, destination, rate);
}
export async function consultarYGuardarTipoDeCambioARAutomatico(fechaEfectiva?: Date | string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no está configurada para la automatización.');
  const auth = `Bearer ${key}`, [origin, destination] = await Promise.all([currency(auth, 'USD'), currency(auth, 'ARS')]);
  return save(auth, key, origin, destination, await obtenerTipoDeCambioAR('USD', 'ARS', fechaEfectiva));
}
