const BASE_URL = 'https://apim.bccr.fi.cr/SDDE/api/Bccr.Ge.SDDE.Publico.Indicadores.API';
const TIME_ZONE = 'America/Costa_Rica';

export function fechaCostaRica(value?: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Error('La fecha efectiva no es válida.');
    return value;
  }
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw Error('La fecha efectiva no es válida.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function esperaBCCR(response: Response, body: string, attempt: number): number {
  const retry = response.headers.get('retry-after');
  if (retry !== null && /^\d+$/.test(retry)) return Number(retry) * 1000 + 1000;
  if (retry && Number.isFinite(Date.parse(retry))) return Math.max(1000, Date.parse(retry) - Date.now() + 1000);
  const seconds = body.match(/in\s+(\d+)\s+seconds?/i);
  return seconds ? (Number(seconds[1]) + 1) * 1000 : 3000 * 2 ** attempt;
}

type Dependencies = { fetch?: typeof fetch; wait?: (ms: number) => Promise<void> };
export async function obtenerSerieBCCR(indicator: '317' | '318', start: string, end: string, dependencies: Dependencies = {}): Promise<Map<string, number>> {
  const token = process.env.BCCR_TOKEN?.trim().replace(/^Bearer\s+/i, '');
  if (!token) throw Error('Configure BCCR_TOKEN con el token generado en Mi Perfil del SDDE del BCCR.');
  const from = fechaCostaRica(start), to = fechaCostaRica(end);
  if (from > to) throw Error('La fecha inicial debe ser anterior o igual a la fecha final.');
  const url = new URL(`${BASE_URL}/indicadoresEconomicos/${indicator}/series`);
  url.search = new URLSearchParams({ fechaInicio: from.replaceAll('-', '/'), fechaFin: to.replaceAll('-', '/'), idioma: 'es' }).toString();
  const request = dependencies.fetch ?? fetch;
  const wait = dependencies.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await request(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    } catch { throw Error('No fue posible conectar con el SDDE del BCCR dentro del tiempo de espera. Intente nuevamente.'); }
    const body = await response.text();
    if (response.status === 401 || response.status === 403) throw Error('El BCCR rechazó el token SDDE. Revise BCCR_TOKEN o genere un token nuevo en Mi Perfil del BCCR.');
    if (response.status === 429 || response.status === 503) {
      const delay = esperaBCCR(response, body, attempt);
      if (attempt === 2 || delay > 30000) throw Error(`El BCCR está limitando las consultas o no está disponible (HTTP ${response.status}). Intente nuevamente en ${Math.ceil(delay / 1000)} segundos.`);
      await wait(delay);
      continue;
    }
    if (!response.ok) throw Error(`El SDDE del BCCR respondió con estado ${response.status}.`);
    let payload: { estado?: boolean; datos?: Array<{ series?: Array<{ fecha?: string; valorDatoPorPeriodo?: unknown }> }> };
    try { payload = JSON.parse(body); } catch { throw Error('El SDDE del BCCR devolvió una respuesta JSON inválida.'); }
    if (payload?.estado !== true || !Array.isArray(payload.datos)) throw Error('El BCCR no devolvió datos para el rango solicitado.');
    const values = new Map<string, number>();
    for (const data of payload.datos) {
      if (!Array.isArray(data.series)) continue;
      for (const row of data.series) {
        const day = typeof row.fecha === 'string' ? row.fecha.slice(0, 10) : '';
        const value = typeof row.valorDatoPorPeriodo === 'number' || typeof row.valorDatoPorPeriodo === 'string' ? Number(row.valorDatoPorPeriodo) : NaN;
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= from && day <= to && Number.isFinite(value) && value > 0) values.set(day, value);
      }
    }
    return values;
  }
  throw Error('No fue posible consultar el indicador del BCCR.');
}

const pending = new Map<string, Promise<{ compra: number; venta: number }>>();
export async function consultarTasasBCCR(date: string) {
  // Share concurrent manual/automatic calls, but never retain an error in the cache.
  const existing = pending.get(date);
  if (existing) return existing;
  const work = (async () => {
    const buy = await obtenerSerieBCCR('317', date, date);
    const sell = await obtenerSerieBCCR('318', date, date);
    const compra = buy.get(date), venta = sell.get(date);
    if (compra === undefined || venta === undefined) throw Error(`El BCCR todavía no publicó compra y venta para ${date}. No se guardó una tasa de otra fecha.`);
    return { compra, venta };
  })();
  pending.set(date, work);
  try { return await work; } finally { pending.delete(date); }
}
