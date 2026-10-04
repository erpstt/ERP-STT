import { createHash } from 'node:crypto';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';

type Json = Record<string, unknown>;
export type BatchItem = {
  id: number;
  lineNumber: number;
  lineReference: string;
  requestId: number;
  requestNumber: string;
  supplier: string;
  taxId: string;
  idType: string;
  iban: string;
  amount: number;
};
export type BatchHeader = {
  id: number;
  number: string;
  executionDate: string;
  currency: string;
  bank: string;
  account: string;
  accountIban: string;
  formatCode: string;
  formatName: string;
  extension: string;
  encoding: string;
  structureDefinition?: Json;
  responseDefinition?: Json;
};
export type BatchDetail = { header: BatchHeader; items: BatchItem[] };
export type GeneratedBankFile = { fileName: string; mimeType: string; buffer: Buffer };

async function rpc<T>(authorization: string, name: string, parameters: Json = {}): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(parameters)
  });
  const raw = await response.text();
  let result: unknown = null;
  try { result = raw ? JSON.parse(raw) : null; } catch { result = raw; }
  if (!response.ok) {
    const message = typeof result === 'object' && result && 'message' in result ? String((result as Json).message) : 'No fue posible procesar el lote de pago.';
    throw new Error(message);
  }
  return result as T;
}

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const clean = (value: unknown, length = 999) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\r\n|,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
const fixed = (value: unknown, length: number, align: 'left' | 'right' = 'left', fill = ' ') => {
  const normalized = clean(value, length);
  return align === 'right' ? normalized.padStart(length, fill) : normalized.padEnd(length, fill);
};
const amount = (value: unknown) => Number(value || 0).toFixed(2);
const cents = (value: unknown, length: number) => Math.round(Number(value || 0) * 100).toString().padStart(length, '0');
const crDestinationBankCode = (value: unknown) => {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return normalized.startsWith('CR') && normalized.length === 22 ? normalized.slice(4, 8) : '';
};
const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const xml = (value: unknown) => String(value ?? '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]!));
const lineBreak = (header: BatchHeader) => String(header.structureDefinition?.recordDelimiter || '').toUpperCase() === 'LF' ? '\n' : '\r\n';

abstract class BankFileBuilder {
  abstract build(detail: BatchDetail): GeneratedBankFile;
  protected output(detail: BatchDetail, content: string, mimeType: string): GeneratedBankFile {
    const encoding = String(detail.header.encoding || 'UTF-8').toUpperCase();
    const buffer = Buffer.from(content, encoding.includes('8859') || encoding.includes('LATIN') ? 'latin1' : 'utf8');
    return { fileName: `${detail.header.number}${detail.header.extension}`, mimeType, buffer };
  }
}

class BACFileBuilder extends BankFileBuilder {
  build(detail: BatchDetail) {
    const eol = lineBreak(detail.header);
    const currencyCode = detail.header.currency === 'CRC' ? '158' : detail.header.currency === 'USD' ? '840' : detail.header.currency;
    const total = detail.items.reduce((sum, item) => sum + Number(item.amount), 0);
    const source = digits(detail.header.accountIban || detail.header.account);
    const lines = [
      ['H', detail.header.number, detail.header.executionDate.replace(/-/g, ''), source, currencyCode, detail.items.length, amount(total)].map(csv).join(','),
      ...detail.items.map(item => ['D', item.lineReference, source, item.iban, item.idType, digits(item.taxId), clean(item.supplier, 80), amount(item.amount), currencyCode, clean(item.requestNumber, 40)].map(csv).join(',')),
      ['T', detail.items.length, amount(total)].map(csv).join(',')
    ];
    return this.output(detail, `${lines.join(eol)}${eol}`, 'text/plain; charset=utf-8');
  }
}

class BNCRFileBuilder extends BankFileBuilder {
  build(detail: BatchDetail) {
    const eol = lineBreak(detail.header);
    const total = detail.items.reduce((sum, item) => sum + Number(item.amount), 0);
    const source = digits(detail.header.accountIban || detail.header.account);
    const lines = [
      `1${fixed(detail.header.number, 25)}${fixed(detail.header.executionDate.replace(/-/g, ''), 8)}${fixed(source, 22)}${fixed(detail.header.currency, 3)}${fixed(detail.items.length, 6, 'right', '0')}${cents(total, 18)}`,
      ...detail.items.map(item => `2${fixed(item.lineReference, 20)}${fixed(item.idType, 5)}${fixed(digits(item.taxId), 12)}${fixed(item.supplier, 60)}${fixed(item.iban, 22)}${fixed(crDestinationBankCode(item.iban), 4)}${cents(item.amount, 18)}${fixed(item.requestNumber, 35)}`),
      `9${fixed(detail.items.length, 6, 'right', '0')}${cents(total, 18)}`
    ];
    return this.output(detail, `${lines.join(eol)}${eol}`, 'text/plain; charset=utf-8');
  }
}

class BCRFileBuilder extends BankFileBuilder {
  build(detail: BatchDetail) {
    const eol = lineBreak(detail.header);
    const headings = ['REFERENCIA_ERP', 'CUENTA_ORIGEN', 'IBAN_DESTINO', 'CODIGO_BANCO_DESTINO', 'TIPO_ID', 'IDENTIFICACION', 'BENEFICIARIO', 'MONTO', 'MONEDA', 'FECHA_PAGO', 'CONCEPTO'];
    const source = digits(detail.header.accountIban || detail.header.account);
    const rows = detail.items.map(item => [item.lineReference, source, item.iban, crDestinationBankCode(item.iban), item.idType, digits(item.taxId), clean(item.supplier, 80), amount(item.amount), detail.header.currency, detail.header.executionDate, clean(item.requestNumber, 40)].map(csv).join(','));
    return this.output(detail, `${headings.map(csv).join(',')}${eol}${rows.join(eol)}${eol}`, 'text/csv; charset=utf-8');
  }
}

class SINPEFileBuilder extends BankFileBuilder {
  build(detail: BatchDetail) {
    const total = detail.items.reduce((sum, item) => sum + Number(item.amount), 0);
    const source = digits(detail.header.accountIban || detail.header.account);
    const entries = detail.items.map(item => `    <Pago>\n      <ReferenciaERP>${xml(item.lineReference)}</ReferenciaERP>\n      <CuentaOrigen>${xml(source)}</CuentaOrigen>\n      <IBANDestino>${xml(item.iban)}</IBANDestino>\n      <CodigoBancoDestino>${xml(crDestinationBankCode(item.iban))}</CodigoBancoDestino>\n      <TipoIdentificacion>${xml(item.idType)}</TipoIdentificacion>\n      <Identificacion>${xml(digits(item.taxId))}</Identificacion>\n      <Beneficiario>${xml(item.supplier)}</Beneficiario>\n      <Monto moneda="${xml(detail.header.currency)}">${amount(item.amount)}</Monto>\n      <Concepto>${xml(item.requestNumber)}</Concepto>\n    </Pago>`).join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<LotePagos version="1.0">\n  <Encabezado><Numero>${xml(detail.header.number)}</Numero><Fecha>${xml(detail.header.executionDate)}</Fecha><Cantidad>${detail.items.length}</Cantidad><Total>${amount(total)}</Total></Encabezado>\n  <Pagos>\n${entries}\n  </Pagos>\n</LotePagos>\n`;
    return this.output(detail, content, 'application/xml; charset=utf-8');
  }
}

class BankFileGeneratorFactory {
  static create(formatCode: string, definition: Json = {}): BankFileBuilder {
    const strategy = String(definition.strategy || formatCode).toUpperCase();
    if (strategy.includes('BAC')) return new BACFileBuilder();
    if (strategy.includes('BNCR')) return new BNCRFileBuilder();
    if (strategy.includes('BCR')) return new BCRFileBuilder();
    if (strategy.includes('SINPE')) return new SINPEFileBuilder();
    throw new Error(`El formato ${formatCode} no tiene una estrategia de generación registrada.`);
  }
}

export function buildPaymentBatchFile(detail: BatchDetail): GeneratedBankFile {
  return BankFileGeneratorFactory.create(detail.header.formatCode, detail.header.structureDefinition || {}).build(detail);
}

function parseDelimitedLine(line: string, delimiter: string) {
  const values: string[] = [];
  let current = '', quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { values.push(current.trim()); current = ''; }
    else current += character;
  }
  values.push(current.trim());
  return values;
}

const normalizedHeading = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const headingIndex = (headings: string[], candidates: string[], fallback: number) => {
  const normalized = headings.map(normalizedHeading);
  const index = normalized.findIndex(value => candidates.includes(value));
  return index >= 0 ? index : fallback;
};

function parseXmlResponse(content: string) {
  const items: Json[] = [];
  const blocks = content.match(/<(?:Pago|Item|Transaccion)\b[^>]*>[\s\S]*?<\/(?:Pago|Item|Transaccion)>/gi) || [];
  const tag = (block: string, names: string[]) => {
    for (const name of names) {
      const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
      if (match) return match[1].replace(/<[^>]+>/g, '').trim();
    }
    return '';
  };
  for (const block of blocks) items.push({
    lineReference: tag(block, ['ReferenciaERP', 'Referencia', 'LineReference']),
    requestNumber: tag(block, ['Solicitud', 'RequestNumber']),
    status: tag(block, ['Estado', 'Status', 'Resultado']),
    bankReference: tag(block, ['ReferenciaBanco', 'Comprobante', 'BankReference']),
    code: tag(block, ['Codigo', 'Code']),
    reason: tag(block, ['Motivo', 'Mensaje', 'Reason'])
  });
  return items.filter(item => item.lineReference || item.requestNumber);
}

function parseBankResponse(content: string, definition: Json = {}) {
  if (/^\s*</.test(content)) return parseXmlResponse(content);
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = String(definition.delimiter || (lines[0].includes('|') ? '|' : lines[0].includes(';') ? ';' : ','));
  const first = parseDelimitedLine(lines[0], delimiter);
  const hasHeader = first.some(value => /refer|estado|status|result/i.test(value));
  const headings = hasHeader ? first : [];
  const referenceIndex = headingIndex(headings, ['referenciaerp', 'referencia', 'linereference', 'solicitud', 'numerosolicitud'], Number(definition.referenceColumn ?? 0));
  const statusIndex = headingIndex(headings, ['estado', 'status', 'resultado'], Number(definition.statusColumn ?? 1));
  const bankReferenceIndex = headingIndex(headings, ['referenciabanco', 'comprobante', 'bankreference', 'transaccion'], Number(definition.bankReferenceColumn ?? 2));
  const reasonIndex = headingIndex(headings, ['motivo', 'mensaje', 'reason', 'detalle'], Number(definition.reasonColumn ?? 3));
  const codeIndex = headingIndex(headings, ['codigo', 'code'], Number(definition.codeColumn ?? -1));
  return lines.slice(hasHeader ? 1 : 0).map(line => {
    const values = parseDelimitedLine(line, delimiter);
    return { lineReference: values[referenceIndex] || '', status: values[statusIndex] || '', bankReference: values[bankReferenceIndex] || '', reason: values[reasonIndex] || '', code: codeIndex >= 0 ? values[codeIndex] || '' : '' };
  }).filter(item => item.lineReference && item.status);
}

export function parsePaymentBatchResponse(content: string, definition: Json = {}) {
  return parseBankResponse(content, definition);
}

export const paymentBatchOptions = (authorization: string) => rpc<Json>(authorization, 'payment_batch_options');
export const paymentBatchCandidates = (authorization: string, payload: Json) => rpc<Json[]>(authorization, 'payment_batch_candidates', { p: payload });
export const paymentBatchReport = (authorization: string, payload: Json) => rpc<Json>(authorization, 'payment_batch_report', { p: payload });
export const paymentBatchDetail = (authorization: string, id: number) => rpc<BatchDetail>(authorization, 'payment_batch_detail', { p_batch_id: id });

export async function generatePaymentBatch(authorization: string, payload: Json) {
  const prepared = await rpc<BatchDetail>(authorization, 'payment_batch_prepare', { p: payload });
  const id = Number(prepared.header.id);
  try {
    const file = buildPaymentBatchFile(prepared);
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    return await rpc<Json>(authorization, 'payment_batch_finalize', { p: { batchId: id, fileName: file.fileName, mimeType: file.mimeType, checksum, contentBase64: file.buffer.toString('base64') } });
  } catch (cause) {
    await rpc(authorization, 'payment_batch_cancel', { p: { batchId: id, reason: 'La generación del archivo no pudo completarse.' } }).catch(() => undefined);
    throw cause;
  }
}

export async function downloadPaymentBatch(authorization: string, id: number): Promise<GeneratedBankFile> {
  const file = await rpc<{ fileName: string; mimeType: string; contentBase64: string }>(authorization, 'payment_batch_file', { p_batch_id: id });
  return { fileName: file.fileName, mimeType: file.mimeType || 'application/octet-stream', buffer: Buffer.from(file.contentBase64, 'base64') };
}

export const markPaymentBatchSent = (authorization: string, id: number) => rpc<Json>(authorization, 'payment_batch_mark_sent', { p: { batchId: id } });
export const cancelPaymentBatch = (authorization: string, id: number, payload: Json) => rpc<Json>(authorization, 'payment_batch_cancel', { p: { ...payload, batchId: id } });
export const applyPaymentBatchReference = (authorization: string, id: number, payload: Json) => rpc<Json>(authorization, 'payment_batch_apply_reference', { p: { ...payload, batchId: id } });

export async function applyPaymentBatchResponse(authorization: string, id: number, payload: Json) {
  const detail = await paymentBatchDetail(authorization, id);
  const fileName = String(payload.fileName || '').trim();
  const contentBase64 = String(payload.contentBase64 || '');
  if (!/\.(ack|res|csv|txt|xml)$/i.test(fileName)) throw new Error('Use una respuesta bancaria .ACK, .RES, .CSV, .TXT o .XML.');
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('La respuesta bancaria debe pesar entre 1 byte y 5 MB.');
  const content = buffer.toString('utf8');
  const results = parsePaymentBatchResponse(content, detail.header.responseDefinition || {});
  if (!results.length) throw new Error('No se reconocieron líneas de pago en la respuesta bancaria. Verifique el formato configurado.');
  const checksum = createHash('sha256').update(buffer).digest('hex');
  return rpc<Json>(authorization, 'payment_batch_apply_response', { p: {
    batchId: id,
    responseFileName: fileName,
    responseChecksum: checksum,
    responseContentBase64: contentBase64,
    results
  } });
}
