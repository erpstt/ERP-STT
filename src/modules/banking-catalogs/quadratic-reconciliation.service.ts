import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';

type JsonObject = Record<string, unknown>;
type MatrixColumns = {
  startBalance: number;
  receipts: number;
  disbursements: number;
  endBalance: number;
};
type QuadraticDetail = JsonObject & {
  header?: JsonObject;
  matrix?: JsonObject;
  items?: unknown[];
  matches?: unknown[];
  statementLines?: unknown[];
  bookTransactions?: unknown[];
  continuity?: JsonObject;
};
export type QuadraticExportFile = { fileName: string; mimeType: string; buffer: Buffer };

const ITEM_TYPES = new Set([
  'DEPOSIT_IN_TRANSIT_PRIOR',
  'DEPOSIT_IN_TRANSIT_CURRENT',
  'OUTSTANDING_CHECK_PRIOR',
  'OUTSTANDING_CHECK_CURRENT',
  'UNRECORDED_BANK_CHARGE',
  'UNRECORDED_BANK_CREDIT',
  'BOOK_ERROR',
  'BANK_ERROR'
]);
const STATUSES = new Set(['draft', 'in_review', 'approved', 'closed']);

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function first(source: JsonObject, ...keys: string[]) {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function positiveId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} no es válido.`);
  return id;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} debe estar entre ${minimum} y ${maximum}.`);
  }
  return number;
}

function decimal(value: unknown, label: string, options: { required?: boolean; nonNegative?: boolean } = {}) {
  if ((value === undefined || value === null || value === '') && !options.required) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} debe ser un importe válido.`);
  if (options.nonNegative && number < 0) throw new Error(`${label} no puede ser negativo.`);
  return number;
}

function validDate(value: unknown, label: string) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).valueOf())) {
    throw new Error(`${label} no es válida.`);
  }
  return date;
}

function errorStatus(code: unknown) {
  const value = String(code ?? '');
  if (value === '42501' || value === 'PGRST301') return 403;
  if (value === 'PGRST116' || value === 'P0002') return 404;
  if (value === '23505') return 409;
  if (['22023', '23503', '23514', 'P0001'].includes(value)) return 422;
  return 400;
}

async function rpc<T>(authorization: string, name: string, input: JsonObject = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: authorization,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(input)
  });
  const raw = await response.text();
  let payload: unknown = null;
  try { payload = raw ? JSON.parse(raw) : null; }
  catch { payload = raw; }
  if (!response.ok) {
    const failure = object(payload);
    const error = new Error(String(first(failure, 'message', 'details', 'hint') ?? 'No fue posible procesar la conciliación cuadrática.')) as Error & { status?: number };
    error.status = errorStatus(failure.code);
    throw error;
  }
  return payload as T;
}

function listFilters(input: JsonObject) {
  const filters: JsonObject = {};
  const subsidiary = first(input, 'subsidiaryId', 'subsidiary_id');
  const account = first(input, 'bankAccountId', 'bank_account_id');
  const year = first(input, 'periodYear', 'period_year', 'year');
  const month = first(input, 'periodMonth', 'period_month', 'month');
  const status = String(input.status ?? '').trim().toLowerCase();
  if (subsidiary !== undefined && subsidiary !== '') filters.subsidiaryId = positiveId(subsidiary, 'La subsidiaria indicada');
  if (account !== undefined && account !== '') filters.bankAccountId = positiveId(account, 'La cuenta bancaria indicada');
  if (year !== undefined && year !== '') filters.periodYear = integerInRange(year, 'El año', 2000, 2199);
  if (month !== undefined && month !== '') filters.periodMonth = integerInRange(month, 'El mes', 1, 12);
  if (status) {
    if (!STATUSES.has(status)) throw new Error('El estado de conciliación indicado no es válido.');
    filters.status = status;
  }
  const page = first(input, 'page');
  const pageSize = first(input, 'pageSize', 'page_size');
  if (page !== undefined && page !== '') filters.page = integerInRange(page, 'La página', 1, 1_000_000);
  if (pageSize !== undefined && pageSize !== '') filters.pageSize = integerInRange(pageSize, 'La cantidad de registros', 1, 250);
  return filters;
}

function cleanHeader(input: JsonObject) {
  const payload: JsonObject = {};
  if (input.id !== undefined && input.id !== null && input.id !== '') payload.id = positiveId(input.id, 'La conciliación indicada');
  payload.bankAccountId = positiveId(first(input, 'bankAccountId', 'bank_account_id'), 'La cuenta bancaria indicada');
  payload.periodYear = integerInRange(first(input, 'periodYear', 'period_year'), 'El año', 2000, 2199);
  payload.periodMonth = integerInRange(first(input, 'periodMonth', 'period_month'), 'El mes', 1, 12);
  payload.bankStartBalance = decimal(first(input, 'bankStartBalance', 'bank_start_balance'), 'El saldo inicial del banco', { required: true });
  payload.bankTotalReceipts = decimal(first(input, 'bankTotalReceipts', 'bank_total_receipts'), 'El total de ingresos del banco', { required: true, nonNegative: true });
  payload.bankTotalDisbursements = decimal(first(input, 'bankTotalDisbursements', 'bank_total_disbursements'), 'El total de egresos del banco', { required: true, nonNegative: true });
  payload.bankEndBalance = decimal(first(input, 'bankEndBalance', 'bank_end_balance'), 'El saldo final del banco', { required: true });
  const notes = String(input.notes ?? '').trim();
  if (notes.length > 2000) throw new Error('Las notas no pueden superar 2.000 caracteres.');
  payload.notes = notes || null;
  return payload;
}

function cleanItem(input: JsonObject) {
  const payload: JsonObject = {};
  if (input.id !== undefined && input.id !== null && input.id !== '') payload.id = positiveId(input.id, 'La partida indicada');
  const itemType = String(first(input, 'itemType', 'item_type') ?? '').trim().toUpperCase();
  if (!ITEM_TYPES.has(itemType)) throw new Error('Seleccione un tipo de partida de conciliación válido.');
  const description = String(input.description ?? '').trim();
  if (!description || description.length > 255) throw new Error('La descripción es obligatoria y admite hasta 255 caracteres.');
  const referenceNumber = String(first(input, 'referenceNumber', 'reference_number') ?? '').trim();
  if (referenceNumber.length > 100) throw new Error('La referencia no puede superar 100 caracteres.');
  payload.itemType = itemType;
  payload.description = description;
  payload.referenceNumber = referenceNumber || null;
  payload.transactionDate = validDate(first(input, 'transactionDate', 'transaction_date'), 'La fecha de la partida');
  payload.amount = decimal(input.amount, 'El monto de la partida', { required: true, nonNegative: true });
  payload.impactStartBalance = decimal(first(input, 'impactStartBalance', 'impact_start_balance'), 'El impacto en saldo inicial');
  payload.impactReceipts = decimal(first(input, 'impactReceipts', 'impact_receipts'), 'El impacto en ingresos');
  payload.impactDisbursements = decimal(first(input, 'impactDisbursements', 'impact_disbursements'), 'El impacto en egresos');
  payload.impactEndBalance = decimal(first(input, 'impactEndBalance', 'impact_end_balance'), 'El impacto en saldo final');
  const bankTransactionId = first(input, 'bankTransactionId', 'bank_transaction_id', 'transactionId', 'transaction_id');
  if (bankTransactionId !== undefined && bankTransactionId !== null && bankTransactionId !== '') payload.bankTransactionId = positiveId(bankTransactionId, 'El movimiento de libros indicado');
  const statementLineId = first(input, 'statementLineId', 'statement_line_id');
  if (statementLineId !== undefined && statementLineId !== null && statementLineId !== '') payload.statementLineId = positiveId(statementLineId, 'La línea del extracto indicada');
  const sourceKind = String(first(input, 'sourceKind', 'source_kind') ?? '').trim().toUpperCase();
  if (sourceKind) {
    if (!/^[A-Z_]{2,30}$/.test(sourceKind)) throw new Error('El origen de la partida no es válido.');
    payload.sourceKind = sourceKind;
  }
  return payload;
}

export function quadraticReconciliationOptions(authorization: string) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_options');
}

export function listQuadraticReconciliations(authorization: string, filters: JsonObject = {}) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_list', { p_filters: listFilters(filters) });
}

export function getQuadraticReconciliation(authorization: string, reconciliationId: number) {
  return rpc<QuadraticDetail>(authorization, 'quadratic_reconciliation_get', { p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada') });
}

export function saveQuadraticReconciliation(authorization: string, input: JsonObject) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_save', { p_payload: cleanHeader(input) });
}

export async function getQuadraticReconciliationMatrix(authorization: string, reconciliationId: number) {
  const detail = await getQuadraticReconciliation(authorization, reconciliationId);
  const matrix = object(detail.matrix);
  return { header: object(detail.header), matrix, continuity: detail.continuity ?? matrix.continuity ?? null };
}

export function saveQuadraticReconciliationItem(authorization: string, reconciliationId: number, input: JsonObject) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_item_save', {
    p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_item: cleanItem(input)
  });
}

export function deleteQuadraticReconciliationItem(authorization: string, reconciliationId: number, itemId: number) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_item_delete', {
    p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_item_id: positiveId(itemId, 'La partida indicada')
  });
}

export function autoMatchQuadraticReconciliation(authorization: string, reconciliationId: number, input: JsonObject = {}) {
  const toleranceDays = integerInRange(first(input, 'toleranceDays', 'tolerance_days') ?? 3, 'La tolerancia de fechas', 0, 31);
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_auto_match', {
    p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_tolerance_days: toleranceDays
  });
}

export function matchQuadraticReconciliation(authorization: string, reconciliationId: number, input: JsonObject) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_match', {
    p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_bank_tran_id: positiveId(first(input, 'bankTransactionId', 'bank_transaction_id'), 'El movimiento de libros indicado'),
    p_statement_line_id: positiveId(first(input, 'statementLineId', 'statement_line_id'), 'La línea del extracto indicada')
  });
}

export function unmatchQuadraticReconciliation(authorization: string, reconciliationId: number, matchId: number) {
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_unmatch', {
    p_reconciliation_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_match_id: positiveId(matchId, 'El punteo indicado')
  });
}

export function transitionQuadraticReconciliation(authorization: string, reconciliationId: number, requestedStatus: unknown) {
  const aliases: Record<string, string> = { submit: 'in_review', review: 'in_review', return: 'draft', reopen: 'in_review', approve: 'approved', close: 'closed' };
  const requested = String(requestedStatus ?? '').trim().toLowerCase();
  const status = aliases[requested] ?? requested;
  if (!STATUSES.has(status)) throw new Error('Seleccione un estado de conciliación válido.');
  return rpc<JsonObject>(authorization, 'quadratic_reconciliation_transition', {
    p_id: positiveId(reconciliationId, 'La conciliación indicada'),
    p_status: status
  });
}

function columns(value: unknown, fallback: Partial<MatrixColumns> = {}): MatrixColumns {
  const row = object(value);
  const amount = (keys: string[], defaultValue: number) => {
    const found = first(row, ...keys);
    const number = Number(found ?? defaultValue);
    return Number.isFinite(number) ? number : defaultValue;
  };
  return {
    startBalance: amount(['startBalance', 'start_balance', 'initialBalance', 'initial_balance'], fallback.startBalance ?? 0),
    receipts: amount(['receipts', 'totalReceipts', 'total_receipts'], fallback.receipts ?? 0),
    disbursements: amount(['disbursements', 'totalDisbursements', 'total_disbursements'], fallback.disbursements ?? 0),
    endBalance: amount(['endBalance', 'end_balance', 'closingBalance', 'closing_balance'], fallback.endBalance ?? 0)
  };
}

function addColumns(left: MatrixColumns, right: MatrixColumns): MatrixColumns {
  return {
    startBalance: left.startBalance + right.startBalance,
    receipts: left.receipts + right.receipts,
    disbursements: left.disbursements + right.disbursements,
    endBalance: left.endBalance + right.endBalance
  };
}

function subtractColumns(left: MatrixColumns, right: MatrixColumns): MatrixColumns {
  return {
    startBalance: left.startBalance - right.startBalance,
    receipts: left.receipts - right.receipts,
    disbursements: left.disbursements - right.disbursements,
    endBalance: left.endBalance - right.endBalance
  };
}

function itemImpacts(items: JsonObject[], side: 'BANK' | 'BOOK') {
  return items.filter(item => String(first(item, 'adjustmentSide', 'adjustment_side') ?? '').toUpperCase() === side).reduce<MatrixColumns>((sum, item) => addColumns(sum, {
    startBalance: Number(first(item, 'impactStartBalance', 'impact_start_balance') ?? 0),
    receipts: Number(first(item, 'impactReceipts', 'impact_receipts') ?? 0),
    disbursements: Number(first(item, 'impactDisbursements', 'impact_disbursements') ?? 0),
    endBalance: Number(first(item, 'impactEndBalance', 'impact_end_balance') ?? 0)
  }), { startBalance: 0, receipts: 0, disbursements: 0, endBalance: 0 });
}

function normalizedReport(detail: QuadraticDetail) {
  const header = object(detail.header), matrix = object(detail.matrix), items = arrayOfObjects(detail.items), matches = arrayOfObjects(detail.matches);
  const bankBase = columns(matrix.bankBase, {
    startBalance: Number(first(header, 'bankStartBalance', 'bank_start_balance') ?? 0),
    receipts: Number(first(header, 'bankTotalReceipts', 'bank_total_receipts') ?? 0),
    disbursements: Number(first(header, 'bankTotalDisbursements', 'bank_total_disbursements') ?? 0),
    endBalance: Number(first(header, 'bankEndBalance', 'bank_end_balance') ?? 0)
  });
  const bookBase = columns(matrix.bookBase, {
    startBalance: Number(first(header, 'bookStartBalance', 'book_start_balance') ?? 0),
    receipts: Number(first(header, 'bookTotalReceipts', 'book_total_receipts') ?? 0),
    disbursements: Number(first(header, 'bookTotalDisbursements', 'book_total_disbursements') ?? 0),
    endBalance: Number(first(header, 'bookEndBalance', 'book_end_balance') ?? 0)
  });
  const bankAdjustments = columns(matrix.bankAdjustments, itemImpacts(items, 'BANK'));
  const bookAdjustments = columns(matrix.bookAdjustments, itemImpacts(items, 'BOOK'));
  const bankAdjusted = columns(matrix.bankAdjusted, addColumns(bankBase, bankAdjustments));
  const bookAdjusted = columns(matrix.bookAdjusted, addColumns(bookBase, bookAdjustments));
  const differences = columns(matrix.differences, subtractColumns(bankAdjusted, bookAdjusted));
  const balancedValue = first(matrix, 'balanced', 'isBalanced', 'is_balanced');
  const balanced = typeof balancedValue === 'boolean' ? balancedValue : Object.values(differences).every(value => Math.abs(value) < .005);
  return {
    header,
    matrix,
    items,
    matches,
    statementLines: arrayOfObjects(detail.statementLines),
    bookTransactions: arrayOfObjects(detail.bookTransactions),
    continuity: object(detail.continuity ?? matrix.continuity),
    equations: object(matrix.equations),
    bankBase,
    bankAdjustments,
    bankAdjusted,
    bookBase,
    bookAdjustments,
    bookAdjusted,
    differences,
    balanced
  };
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const absoluteNumber = (value: unknown) => Math.abs(number(value)).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: unknown, symbol: unknown) => number(value) < 0 ? `(${String(symbol ?? '').trim()} ${absoluteNumber(value)})`.trim() : `${String(symbol ?? '').trim()} ${absoluteNumber(value)}`.trim();
const displayDate = (value: unknown) => {
  const raw = String(value ?? '').slice(0, 10), parsed = new Date(`${raw}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? (raw || '—') : parsed.toLocaleDateString('es-CR', { day: '2-digit', month: 'short', year: 'numeric' });
};
const safePart = (value: unknown, fallback: string) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || fallback;
const monthLabel = (year: unknown, month: unknown) => new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('es-CR', { month: 'long', year: 'numeric' });

function statusLabel(value: unknown) {
  return ({ draft: 'BORRADOR', in_review: 'EN REVISIÓN', approved: 'APROBADA', closed: 'CERRADA' } as Record<string, string>)[String(value ?? '').toLowerCase()] ?? String(value ?? '—').toUpperCase();
}

function itemTypeLabel(value: unknown) {
  return ({
    DEPOSIT_IN_TRANSIT_PRIOR: 'Depósito en tránsito · mes anterior',
    DEPOSIT_IN_TRANSIT_CURRENT: 'Depósito en tránsito · mes actual',
    OUTSTANDING_CHECK_PRIOR: 'Cheque/pago pendiente · mes anterior',
    OUTSTANDING_CHECK_CURRENT: 'Cheque/pago pendiente · mes actual',
    UNRECORDED_BANK_CHARGE: 'Cargo bancario no registrado',
    UNRECORDED_BANK_CREDIT: 'Crédito bancario no registrado',
    BOOK_ERROR: 'Error o corrección en libros',
    BANK_ERROR: 'Error o corrección del banco'
  } as Record<string, string>)[String(value ?? '').toUpperCase()] ?? String(value ?? 'Partida de conciliación');
}

function matrixCells(values: MatrixColumns, symbol: unknown, className = '') {
  return [values.startBalance, values.receipts, values.disbursements, values.endBalance]
    .map(value => `<td class="num ${className}">${escapeHtml(money(value, symbol))}</td>`).join('');
}

function continuitySummary(continuity: JsonObject, symbol: unknown) {
  if (!Object.keys(continuity).length) return '<span>Primer período o sin conciliación anterior para validar continuidad.</span>';
  const previous = first(continuity, 'expectedStartBalance', 'expected_start_balance', 'previousEndBalance', 'previous_end_balance', 'priorAdjustedEndBalance', 'prior_adjusted_end_balance');
  const current = first(continuity, 'actualStartBalance', 'actual_start_balance', 'currentStartBalance', 'current_start_balance', 'currentAdjustedStartBalance', 'current_adjusted_start_balance');
  const difference = first(continuity, 'difference', 'continuityDifference', 'continuity_difference');
  const valid = first(continuity, 'ok', 'valid', 'balanced', 'isValid', 'is_valid');
  return `<span>Final ajustado anterior: <b>${escapeHtml(money(previous, symbol))}</b></span><span>Inicial ajustado actual: <b>${escapeHtml(money(current, symbol))}</b></span><span class="${valid === false || Math.abs(number(difference)) >= .005 ? 'bad' : 'good'}">Diferencia: <b>${escapeHtml(money(difference, symbol))}</b></span>`;
}

function reportHtml(detail: QuadraticDetail) {
  const report = normalizedReport(detail), h = report.header;
  const currency = first(h, 'currencyCode', 'currency_code', 'currency') ?? '';
  const symbol = first(h, 'currencySymbol', 'currency_symbol', 'symbol') ?? currency;
  const year = first(h, 'periodYear', 'period_year'), month = first(h, 'periodMonth', 'period_month');
  const items = report.items.map(item => `<tr><td>${escapeHtml(itemTypeLabel(first(item, 'itemType', 'item_type')))}</td><td><b>${escapeHtml(item.description)}</b><small>${escapeHtml(first(item, 'referenceNumber', 'reference_number') ?? 'Sin referencia')}</small></td><td>${escapeHtml(displayDate(first(item, 'transactionDate', 'transaction_date')))}</td><td>${escapeHtml(String(first(item, 'adjustmentSide', 'adjustment_side') ?? '').toUpperCase() === 'BANK' ? 'Banco' : 'Libros')}</td><td class="num">${escapeHtml(money(item.amount, symbol))}</td>${matrixCells(columns({ startBalance: first(item, 'impactStartBalance', 'impact_start_balance'), receipts: first(item, 'impactReceipts', 'impact_receipts'), disbursements: first(item, 'impactDisbursements', 'impact_disbursements'), endBalance: first(item, 'impactEndBalance', 'impact_end_balance') }), symbol)}</tr>`).join('');
  const differenceClass = (value: number) => Math.abs(value) < .005 ? 'zero' : 'difference';
  const matrixDifferenceCells = [report.differences.startBalance, report.differences.receipts, report.differences.disbursements, report.differences.endBalance].map(value => `<td class="num ${differenceClass(value)}">${escapeHtml(money(value, symbol))}</td>`).join('');
  const status = String(first(h, 'status') ?? 'draft').toLowerCase();
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Prueba de efectivo · ${escapeHtml(year)}-${escapeHtml(month)}</title><style>@page{size:A4 landscape;margin:11mm 10mm 15mm}*{box-sizing:border-box}body{margin:0;color:#17233b;font:8.2pt Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;gap:24px;padding-bottom:9px;border-bottom:4px solid #f26938}.brand{color:#042e72;font-size:21pt;font-weight:900;letter-spacing:4px}.company{margin-top:4px;line-height:1.45}.title{text-align:right}.title h1{margin:0;color:#042e72;font-size:17pt}.title p{margin:4px 0;color:#5f6f85}.meta{display:grid;grid-template-columns:1.4fr 1.25fr .8fr .65fr;gap:7px;margin:10px 0}.meta>div{padding:7px 9px;border:1px solid #dce3ed;border-radius:6px;background:#f4f6fa}.meta small,.item-note{display:block;color:#6b7280}.meta b{display:block;margin-top:3px}.status{display:inline-block;padding:4px 7px;border-radius:99px;background:${status === 'closed' || status === 'approved' ? '#dff5ec' : status === 'in_review' ? '#fff0d9' : '#e8eef8'};color:${status === 'closed' || status === 'approved' ? '#08654d' : status === 'in_review' ? '#8a4a0d' : '#042e72'};font-size:7pt;font-weight:800}.result{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:8px 0;padding:8px 11px;border:1px solid ${report.balanced ? '#9dd4c1' : '#efb4b0'};border-left:5px solid ${report.balanced ? '#138a68' : '#b42318'};border-radius:7px;background:${report.balanced ? '#eef9f5' : '#fff1f0'}}.result strong{color:${report.balanced ? '#08654d' : '#a11d16'};font-size:10pt}.continuity{display:flex;gap:20px;flex-wrap:wrap;color:#52657d}.continuity .good{color:#08654d}.continuity .bad{color:#b42318}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{padding:6px;background:#042e72;color:#fff;text-align:left}th.num,td.num{text-align:right}td{padding:5px 6px;border-bottom:1px solid #dce3ed;vertical-align:top}tr{page-break-inside:avoid}.matrix{margin-bottom:12px;font-size:8.5pt}.matrix td{padding:6px 8px}.matrix .section td{border-top:2px solid #9fb0c6;background:#e8eef8;color:#042e72;font-weight:800}.matrix .adjusted td{background:#f4f6fa;font-weight:800}.matrix .difference-row td{border-top:2px solid #64748b;font-weight:900}.matrix .zero{background:#dff5ec;color:#08654d}.matrix .difference{background:#fee4e2;color:#b42318}.items-title{display:flex;justify-content:space-between;align-items:end;margin:10px 0 5px}.items-title h2{margin:0;color:#042e72;font-size:11pt}.items th{font-size:7.3pt}.items td{font-size:7.2pt}.items td small{display:block;margin-top:2px;color:#6b7280}.items .num{white-space:nowrap}.empty{text-align:center;padding:18px;color:#6b7280;font-style:italic}.formula{margin-top:8px;padding:7px 9px;border:1px dashed #aebaca;border-radius:6px;color:#52657d}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:24px}.signatures div{padding-top:5px;border-top:1px solid #64748b;text-align:center;color:#52657d}.footer{position:fixed;right:0;bottom:-10mm;left:0;display:flex;justify-content:space-between;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;font-size:7pt}</style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${escapeHtml(first(h, 'subsidiaryLegalName', 'subsidiary_legal_name', 'legalName', 'legal_name', 'subsidiaryName', 'subsidiary_name'))}</b><br>Identificación fiscal: ${escapeHtml(first(h, 'taxId', 'tax_id') ?? 'No registrada')}</div></div><div class="title"><h1>CONCILIACIÓN CUADRÁTICA</h1><p>Prueba de efectivo de cuatro columnas</p><p><b>${escapeHtml(monthLabel(year, month))}</b> · ${escapeHtml(currency)}</p></div></header><section class="meta"><div><small>Cuenta bancaria</small><b>${escapeHtml(first(h, 'bankName', 'bank_name') ?? '')} · ${escapeHtml(first(h, 'bankAccountNumber', 'bank_account_number', 'accountNumber', 'account_number') ?? '')}</b></div><div><small>Cuenta contable</small><b>${escapeHtml(first(h, 'ledgerAccountNumber', 'ledger_account_number') ?? '')} · ${escapeHtml(first(h, 'ledgerAccountName', 'ledger_account_name') ?? '')}</b></div><div><small>Período</small><b>${escapeHtml(monthLabel(year, month))}</b></div><div><small>Estado</small><span class="status">${escapeHtml(statusLabel(status))}</span></div></section><section class="result"><strong>${report.balanced ? '✓ Las cuatro columnas están conciliadas' : '⚠ Existen diferencias pendientes de conciliar'}</strong><div class="continuity">${continuitySummary(report.continuity, symbol)}</div></section><table class="matrix"><colgroup><col style="width:34%"><col style="width:16.5%"><col style="width:16.5%"><col style="width:16.5%"><col style="width:16.5%"></colgroup><thead><tr><th>Concepto</th><th class="num">Saldo inicial</th><th class="num">Ingresos / depósitos</th><th class="num">Egresos / retiros</th><th class="num">Saldo final</th></tr></thead><tbody><tr class="section"><td>Saldos según extracto bancario</td>${matrixCells(report.bankBase, symbol)}</tr><tr><td>Ajustes al banco</td>${matrixCells(report.bankAdjustments, symbol)}</tr><tr class="adjusted"><td>Saldo bancario ajustado</td>${matrixCells(report.bankAdjusted, symbol)}</tr><tr class="section"><td>Saldos según libros GENTIA</td>${matrixCells(report.bookBase, symbol)}</tr><tr><td>Ajustes a libros</td>${matrixCells(report.bookAdjustments, symbol)}</tr><tr class="adjusted"><td>Saldo en libros ajustado</td>${matrixCells(report.bookAdjusted, symbol)}</tr><tr class="difference-row"><td>Diferencia banco − libros</td>${matrixDifferenceCells}</tr></tbody></table><div class="items-title"><h2>Partidas de conciliación y ajustes</h2><span>${report.items.length} partida${report.items.length === 1 ? '' : 's'} · ${report.matches.length} punteo${report.matches.length === 1 ? '' : 's'}</span></div><table class="items"><colgroup><col style="width:16%"><col style="width:21%"><col style="width:8%"><col style="width:7%"><col style="width:8%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:10%"></colgroup><thead><tr><th>Tipo</th><th>Descripción / referencia</th><th>Fecha</th><th>Lado</th><th class="num">Monto</th><th class="num">Saldo inicial</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Saldo final</th></tr></thead><tbody>${items || '<tr><td colspan="9" class="empty">No hay partidas de ajuste registradas.</td></tr>'}</tbody></table><div class="formula"><b>Control matemático:</b> saldo inicial ajustado + ingresos ajustados − egresos ajustados = saldo final ajustado. Para aprobar o cerrar, Banco ajustado − Libros ajustados debe ser 0,00 en las cuatro columnas.</div><div class="signatures"><div>Preparado por<br><b>${escapeHtml(first(h, 'reconciledByName', 'reconciled_by_name') ?? '—')}</b></div><div>Revisado por<br><b>${escapeHtml(first(h, 'reviewedByName', 'reviewed_by_name') ?? '—')}</b></div><div>Aprobado por<br><b>${escapeHtml(first(h, 'approvedByName', 'approved_by_name') ?? '—')}</b></div></div><div class="footer"><span>GENTIA · Bancos y Tesorería</span><span>Prueba de efectivo · Generado ${escapeHtml(new Date().toLocaleString('es-CR'))}</span></div></body></html>`;
}

function reportFileBase(header: JsonObject) {
  const account = safePart(first(header, 'bankAccountNumber', 'bank_account_number', 'accountNumber', 'account_number'), 'cuenta');
  const year = first(header, 'periodYear', 'period_year') ?? 'periodo';
  const month = String(first(header, 'periodMonth', 'period_month') ?? '').padStart(2, '0');
  return `conciliacion-cuadratica-${account}-${year}-${month}`;
}

export async function buildQuadraticReconciliationPdf(detail: QuadraticDetail): Promise<QuadraticExportFile> {
  const rendered = await renderBankReconciliationPdf({ html: reportHtml(detail), fileName: `${reportFileBase(object(detail.header))}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

export async function exportQuadraticReconciliationPdf(authorization: string, reconciliationId: number): Promise<QuadraticExportFile> {
  return buildQuadraticReconciliationPdf(await getQuadraticReconciliation(authorization, reconciliationId));
}

function border(color = 'DCE3ED') {
  return {
    top: { style: 'thin' as const, color: { argb: color } },
    left: { style: 'thin' as const, color: { argb: color } },
    bottom: { style: 'thin' as const, color: { argb: color } },
    right: { style: 'thin' as const, color: { argb: color } }
  };
}

function excelDate(value: unknown) {
  const raw = String(value ?? '').slice(0, 10), parsed = new Date(`${raw}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? raw : parsed;
}

function styleHeader(row: ExcelJS.Row, color = 'FF042E72') {
  row.height = 28;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = border(color.slice(-6));
  });
}

export async function buildQuadraticReconciliationExcel(detail: QuadraticDetail): Promise<QuadraticExportFile> {
  const report = normalizedReport(detail), h = report.header;
  const year = first(h, 'periodYear', 'period_year'), month = first(h, 'periodMonth', 'period_month');
  const currency = String(first(h, 'currencyCode', 'currency_code', 'currency') ?? '');
  const symbol = String(first(h, 'currencySymbol', 'currency_symbol', 'symbol') ?? currency);
  const excelSymbol = symbol.replace(/["\\]/g, '').slice(0, 12), amountFormat = `"${excelSymbol}" #,##0.00;[Red]("${excelSymbol}" #,##0.00)`;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = String(first(h, 'subsidiaryLegalName', 'subsidiary_legal_name', 'legalName', 'legal_name', 'subsidiaryName', 'subsidiary_name') ?? 'GENTIA');
  workbook.created = new Date();
  workbook.modified = new Date();

  const matrixSheet = workbook.addWorksheet('Prueba de efectivo', {
    views: [{ state: 'frozen', ySplit: 8 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .25, right: .25, top: .45, bottom: .45, header: .2, footer: .2 } }
  });
  matrixSheet.columns = [{ width: 42 }, { width: 21 }, { width: 21 }, { width: 21 }, { width: 21 }];
  matrixSheet.mergeCells('A1:E1');
  const title = matrixSheet.getCell('A1');
  title.value = 'GENTIA · CONCILIACIÓN CUADRÁTICA / PRUEBA DE EFECTIVO';
  title.font = { bold: true, size: 17, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF042E72' } };
  title.alignment = { vertical: 'middle' };
  matrixSheet.getRow(1).height = 32;
  matrixSheet.mergeCells('A2:C2');
  matrixSheet.getCell('A2').value = String(first(h, 'subsidiaryLegalName', 'subsidiary_legal_name', 'legalName', 'legal_name', 'subsidiaryName', 'subsidiary_name') ?? '');
  matrixSheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF17233B' } };
  matrixSheet.mergeCells('D2:E2');
  matrixSheet.getCell('D2').value = monthLabel(year, month);
  matrixSheet.getCell('D2').alignment = { horizontal: 'right' };
  matrixSheet.getCell('D2').font = { bold: true, color: { argb: 'FF042E72' } };
  matrixSheet.mergeCells('A3:E3');
  matrixSheet.getCell('A3').value = `Banco: ${first(h, 'bankName', 'bank_name') ?? ''} · Cuenta: ${first(h, 'bankAccountNumber', 'bank_account_number', 'accountNumber', 'account_number') ?? ''} · Moneda: ${currency} · Estado: ${statusLabel(first(h, 'status'))}`;
  matrixSheet.getCell('A3').font = { italic: true, color: { argb: 'FF64748B' } };
  matrixSheet.mergeCells('A5:E5');
  matrixSheet.getCell('A5').value = report.balanced ? 'CUADRE COMPLETO · Las cuatro diferencias son 0,00' : 'PENDIENTE · Existen diferencias en una o más columnas';
  matrixSheet.getCell('A5').font = { bold: true, color: { argb: report.balanced ? 'FF08654D' : 'FFB42318' } };
  matrixSheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: report.balanced ? 'FFDFF5EC' : 'FFFEE4E2' } };
  matrixSheet.getCell('A5').alignment = { horizontal: 'center' };
  matrixSheet.getCell('A5').border = border(report.balanced ? '9DD4C1' : 'EFB4B0');
  matrixSheet.mergeCells('A6:E6');
  const continuity = report.continuity;
  matrixSheet.getCell('A6').value = Object.keys(continuity).length ? `Continuidad: final ajustado anterior ${money(first(continuity, 'expectedStartBalance', 'expected_start_balance', 'previousEndBalance', 'previous_end_balance'), symbol)} · inicial ajustado actual ${money(first(continuity, 'actualStartBalance', 'actual_start_balance', 'currentStartBalance', 'current_start_balance'), symbol)} · diferencia ${money(first(continuity, 'difference', 'continuityDifference', 'continuity_difference'), symbol)}` : 'Continuidad: primer período o sin conciliación anterior disponible.';
  matrixSheet.getCell('A6').font = { color: { argb: 'FF52657D' } };
  matrixSheet.getCell('A6').alignment = { wrapText: true };
  const matrixHeader = matrixSheet.addRow(['Concepto', 'Saldo inicial', 'Ingresos / depósitos', 'Egresos / retiros', 'Saldo final']);
  styleHeader(matrixHeader);
  const matrixRows: Array<[string, MatrixColumns, 'section' | 'normal' | 'adjusted' | 'difference']> = [
    ['Saldos según extracto bancario', report.bankBase, 'section'],
    ['Ajustes al banco', report.bankAdjustments, 'normal'],
    ['Saldo bancario ajustado', report.bankAdjusted, 'adjusted'],
    ['Saldos según libros GENTIA', report.bookBase, 'section'],
    ['Ajustes a libros', report.bookAdjustments, 'normal'],
    ['Saldo en libros ajustado', report.bookAdjusted, 'adjusted'],
    ['Diferencia banco − libros', report.differences, 'difference']
  ];
  for (const [label, values, kind] of matrixRows) {
    const row = matrixSheet.addRow([label, values.startBalance, values.receipts, values.disbursements, values.endBalance]);
    row.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'middle' }; });
    for (let column = 2; column <= 5; column++) row.getCell(column).numFmt = amountFormat;
    if (kind === 'section') row.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FF042E72' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } }; });
    if (kind === 'adjusted') row.eachCell(cell => { cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FA' } }; });
    if (kind === 'difference') row.eachCell((cell, column) => {
      const value = column === 1 ? 0 : number(cell.value);
      cell.font = { bold: true, color: { argb: column === 1 || Math.abs(value) < .005 ? 'FF08654D' : 'FFB42318' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column === 1 || Math.abs(value) < .005 ? 'FFDFF5EC' : 'FFFEE4E2' } };
    });
  }
  const formulaRow = matrixSheet.rowCount + 2;
  matrixSheet.mergeCells(formulaRow, 1, formulaRow + 1, 5);
  const formula = matrixSheet.getCell(formulaRow, 1);
  formula.value = 'Control: saldo inicial ajustado + ingresos ajustados − egresos ajustados = saldo final ajustado. Para aprobar o cerrar, Banco ajustado − Libros ajustados debe ser 0,00 en las cuatro columnas.';
  formula.alignment = { wrapText: true, vertical: 'middle' };
  formula.font = { italic: true, color: { argb: 'FF52657D' } };
  formula.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FA' } };
  matrixSheet.headerFooter.oddFooter = 'GENTIA · Conciliación Cuadrática                                      Página &P de &N';

  const itemSheet = workbook.addWorksheet('Partidas de conciliación', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  itemSheet.columns = [{ width: 28 }, { width: 35 }, { width: 20 }, { width: 15 }, { width: 13 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }];
  itemSheet.mergeCells('A1:J1');
  itemSheet.getCell('A1').value = 'PARTIDAS DE CONCILIACIÓN Y AJUSTES';
  itemSheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  itemSheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF042E72' } };
  itemSheet.getRow(1).height = 29;
  itemSheet.mergeCells('A2:J2');
  itemSheet.getCell('A2').value = `${monthLabel(year, month)} · ${first(h, 'bankName', 'bank_name') ?? ''} · ${first(h, 'bankAccountNumber', 'bank_account_number', 'accountNumber', 'account_number') ?? ''}`;
  itemSheet.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };
  const itemHeader = itemSheet.addRow(['Tipo', 'Descripción', 'Referencia', 'Fecha', 'Lado', 'Monto', 'Impacto saldo inicial', 'Impacto ingresos', 'Impacto egresos', 'Impacto saldo final']);
  styleHeader(itemHeader);
  for (const item of report.items) {
    const row = itemSheet.addRow([
      itemTypeLabel(first(item, 'itemType', 'item_type')),
      item.description,
      first(item, 'referenceNumber', 'reference_number') ?? '',
      excelDate(first(item, 'transactionDate', 'transaction_date')),
      String(first(item, 'adjustmentSide', 'adjustment_side') ?? '').toUpperCase() === 'BANK' ? 'Banco' : 'Libros',
      number(item.amount),
      number(first(item, 'impactStartBalance', 'impact_start_balance')),
      number(first(item, 'impactReceipts', 'impact_receipts')),
      number(first(item, 'impactDisbursements', 'impact_disbursements')),
      number(first(item, 'impactEndBalance', 'impact_end_balance'))
    ]);
    row.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; });
    row.getCell(4).numFmt = 'dd/mm/yyyy';
    for (let column = 6; column <= 10; column++) row.getCell(column).numFmt = amountFormat;
  }
  itemSheet.autoFilter = 'A3:J3';
  itemSheet.headerFooter.oddFooter = 'GENTIA · Partidas de conciliación                                      Página &P de &N';

  const matchSheet = workbook.addWorksheet('Punteo', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  matchSheet.columns = [{ width: 15 }, { width: 22 }, { width: 18 }, { width: 18 }, { width: 20 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 17 }];
  matchSheet.mergeCells('A1:I1');
  matchSheet.getCell('A1').value = 'PUNTEO DE EXTRACTO BANCARIO CONTRA LIBROS';
  matchSheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  matchSheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF042E72' } };
  matchSheet.getRow(1).height = 29;
  matchSheet.mergeCells('A2:I2');
  matchSheet.getCell('A2').value = `${report.matches.length} coincidencia${report.matches.length === 1 ? '' : 's'} · ${report.statementLines.length} líneas de extracto · ${report.bookTransactions.length} movimientos de libros`;
  matchSheet.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };
  const matchHeader = matchSheet.addRow(['Punteo', 'Referencia extracto', 'Fecha extracto', 'Monto extracto', 'Referencia libros', 'Fecha libros', 'Monto libros', 'Diferencia', 'Método']);
  styleHeader(matchHeader, 'FF138A68');
  const statementById = new Map(report.statementLines.map(line => [String(line.id), line]));
  const bookById = new Map(report.bookTransactions.map(transaction => [String(transaction.id), transaction]));
  for (const match of report.matches) {
    const statement = Object.keys(object(first(match, 'statementLine', 'statement_line'))).length
      ? object(first(match, 'statementLine', 'statement_line'))
      : statementById.get(String(first(match, 'statementLineId', 'statement_line_id'))) ?? {};
    const book = Object.keys(object(first(match, 'bookTransaction', 'book_transaction'))).length
      ? object(first(match, 'bookTransaction', 'book_transaction'))
      : bookById.get(String(first(match, 'bankTransactionId', 'bank_transaction_id'))) ?? {};
    const statementAmount = number(first(match, 'statementAmount', 'statement_amount') ?? first(statement, 'amount'));
    const bookAmount = number(first(match, 'bookAmount', 'book_amount') ?? first(book, 'amount'));
    const row = matchSheet.addRow([
      first(match, 'id', 'matchId', 'match_id'),
      first(match, 'statementReference', 'statement_reference') ?? first(statement, 'referenceNumber', 'reference_number', 'reference') ?? '',
      excelDate(first(match, 'statementDate', 'statement_date') ?? first(statement, 'transactionDate', 'transaction_date', 'date')),
      statementAmount,
      first(match, 'bookReference', 'book_reference') ?? first(book, 'referenceNumber', 'reference_number', 'reference') ?? '',
      excelDate(first(match, 'bookDate', 'book_date') ?? first(book, 'transactionDate', 'transaction_date', 'date')),
      bookAmount,
      number(first(match, 'difference') ?? statementAmount - bookAmount),
      String(first(match, 'matchMethod', 'match_method', 'method') ?? 'Manual')
    ]);
    row.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; });
    row.getCell(3).numFmt = row.getCell(6).numFmt = 'dd/mm/yyyy';
    for (const column of [4, 7, 8]) row.getCell(column).numFmt = amountFormat;
    if (Math.abs(number(row.getCell(8).value)) >= .005) {
      row.getCell(8).font = { bold: true, color: { argb: 'FFB42318' } };
      row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE4E2' } };
    }
  }
  matchSheet.autoFilter = 'A3:I3';
  matchSheet.headerFooter.oddFooter = 'GENTIA · Punteo bancario                                      Página &P de &N';

  const content = await workbook.xlsx.writeBuffer();
  return {
    fileName: `${reportFileBase(h)}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(content)
  };
}

export async function exportQuadraticReconciliationExcel(authorization: string, reconciliationId: number): Promise<QuadraticExportFile> {
  return buildQuadraticReconciliationExcel(await getQuadraticReconciliation(authorization, reconciliationId));
}
