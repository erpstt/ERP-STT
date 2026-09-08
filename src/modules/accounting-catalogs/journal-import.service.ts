import { getSupabaseConfig } from '../../core/database/supabase.client.js';

export const journalCsvOptionalHeaders = ['entidad','nombre','departamento','centro_costos','clase','acreedor_financiero','compania_relacionada'];
export const journalCsvHeaders = ['asiento_referencia','tipo_asiento','fecha','moneda','tipo_cambio','nota_asiento','numero_cuenta','debito','credito','nota_linea','mes_servicio', ...journalCsvOptionalHeaders];

// Quoted fields may contain delimiters, escaped quotes and line breaks (RFC 4180).
export function parseJournalCsv(source: string): Record<string, string>[] {
  if (Buffer.byteLength(source, 'utf8') > 2 * 1024 * 1024) throw Error('El CSV supera el límite de 2 MB.');
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const delimiter = text.split('\n')[0].includes(';') ? ';' : ',';
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const finishField = () => { row.push(field.trim()); field = ''; closed = false; };
  const finishRow = () => { finishField(); if (row.some(Boolean)) records.push(row); row = []; if (records.length > 2001) throw Error('El CSV admite hasta 2000 líneas contables.'); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === delimiter) finishField();
    else if (char === '\n') finishRow();
    else if (char === '"' && !field && !closed) quoted = true;
    else { if (closed || char === '"') throw Error('CSV inválido: revise las comillas.'); field += char; }
  }
  if (quoted) throw Error('CSV inválido: hay comillas sin cerrar.');
  if (field || row.length || closed) finishRow();
  const headers = records.shift();
  if (!headers || new Set(headers).size !== headers.length || headers.some(key => !journalCsvHeaders.includes(key)) || journalCsvHeaders.filter(key => !journalCsvOptionalHeaders.includes(key)).some(key => !headers.includes(key))) throw Error(`Conserve las columnas de la plantilla: ${journalCsvHeaders.join(', ')}.`);
  if (!records.length) throw Error('El CSV no contiene líneas contables.');
  return records.map((values, index) => {
    if (values.length !== headers.length) throw Error(`Registro ${index + 2}: cantidad de columnas incorrecta.`);
    // Omit empty optional fields to preserve receipts for previously imported files.
    return Object.fromEntries(headers.map((key, column) => [key, values[column]]).filter(([key, value]) => value !== '' || !journalCsvOptionalHeaders.includes(key)));
  });
}

export async function importJournalCsv(authorization: string, input: Record<string, unknown>) {
  if (typeof input.csv !== 'string' || typeof input.preview !== 'boolean' || !Number.isSafeInteger(input.subsidiaryId) || Number(input.subsidiaryId) <= 0) throw Error('Seleccione un CSV y una subsidiaria válida.');
  const rows = parseJournalCsv(input.csv);
  const config = getSupabaseConfig();
  if (!config) throw Error('Supabase no está configurado.');
  const response = await fetch(new URL('/rest/v1/rpc/import_journal_csv', config.url), {
    method: 'POST', headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_rows: rows, p_preview: input.preview, p_subsidiary_id: input.subsidiaryId })
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw Error(String(result.message || 'No fue posible importar los asientos.'));
  return result;
}
