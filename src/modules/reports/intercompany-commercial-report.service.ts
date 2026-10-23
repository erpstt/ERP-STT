import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

type CommercialBalance = {
  subsidiaryId: number | null;
  subsidiaryName: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyId: number | null;
  partyKey: string;
  partyCode: string;
  partyName: string;
  identification: string;
  masterIntercompany: boolean;
  accountNumber: string;
  accountName: string;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  openingBalance: number;
  debits: number;
  credits: number;
  periodMovement: number;
  closingBalance: number;
  documentBalance: number;
  openDocumentCount: number;
  documentOriginalTotal: number;
  settledTotal: number;
  difference: number;
};

type CurrencySummary = {
  subsidiaryId: number | null;
  subsidiaryName: string;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  receivableOpening: number;
  payableOpening: number;
  receivableDebits: number;
  receivableCredits: number;
  payableDebits: number;
  payableCredits: number;
  receivableClosing: number;
  payableClosing: number;
  netPosition: number;
  receivableDocuments: number;
  payableDocuments: number;
};

type LocalPosition = {
  subsidiaryName: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyKey: string;
  partyCode: string;
  partyName: string;
  identification: string;
  masterIntercompany: boolean;
  originalCurrencyCode: string;
  originalCurrencyName: string;
  originalCurrencySymbol: string;
  localCurrencyCode: string;
  localCurrencyName: string;
  localCurrencySymbol: string;
  openingBalance: number;
  debits: number;
  credits: number;
  periodMovement: number;
  closingBalance: number;
  receivableClosing: number;
  payableClosing: number;
  netPosition: number;
};

type CommercialDocument = {
  id: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyKey: string;
  partyCode: string;
  partyName: string;
  identification: string;
  masterIntercompany: boolean;
  subsidiaryName: string;
  accountNumber: string;
  accountName: string;
  documentNumber: string;
  issueDate: string;
  dueDate: string;
  postingDate: string;
  overdueDays: number;
  agingBucket: string;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  exchangeRate: number;
  originalAmount: number;
  appliedAmount: number;
  creditAmount: number;
  debitAmount: number;
  outstanding: number;
  localCurrencyCode: string;
  localCurrencySymbol: string;
  historicalLocalOutstanding: number;
  journalId: number | null;
  transactionId: number | null;
  isOpeningBalance: boolean;
};

type CommercialMovement = {
  id: string;
  date: string;
  transactionNumber: string;
  transactionType: string;
  journalId: number | null;
  journalNumber: string;
  memo: string;
  note: string;
  subsidiaryName: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyKey: string;
  partyCode: string;
  partyName: string;
  identification: string;
  partyAssigned: boolean;
  masterIntercompany: boolean;
  accountNumber: string;
  accountName: string;
  currencyCode: string;
  currencySymbol: string;
  exchangeRate: number;
  originalDebit: number;
  originalCredit: number;
  originalMovement: number;
  originalRunningBalance: number;
  localCurrencyCode: string;
  localCurrencySymbol: string;
  localDebit: number;
  localCredit: number;
  localMovement: number;
  localRunningBalance: number;
  isFxRevaluation: boolean;
};

type Report = {
  generatedAt: string;
  dateFrom: string;
  dateTo: string;
  receivables: CommercialBalance[];
  payables: CommercialBalance[];
  reconciliation: CommercialBalance[];
  currencySummaries: CurrencySummary[];
  localCurrencySummaries: CurrencySummary[];
  localPositions: LocalPosition[];
  documents: CommercialDocument[];
  details: CommercialMovement[];
  quality: {
    movementCount: number;
    documentCount: number;
    openDocumentCount: number;
    partyCount: number;
    currencyCount: number;
    unassignedPartyMovementCount: number;
    unassignedOpeningPartyMovementCount: number;
    unassignedPeriodPartyMovementCount: number;
    classificationMismatchCount: number;
    reconciliationDifferenceCount: number;
    fxAdjustmentMovementCount: number;
    hasReconciliationDifferences: boolean;
  };
  metadata: { subsidiary: string; legalName: string; book: string };
};

async function rpc<T>(authorization: string, name: string, input: Json = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  const raw = await response.text();
  const payload: unknown = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : 'No fue posible generar el reporte de cuentas comerciales intercompany.';
    throw new Error(message);
  }
  return payload as T;
}

const object = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const text = (source: Json, key: string) => source[key] === undefined || source[key] === null ? '' : String(source[key]);
const number = (source: Json, key: string) => {
  const value = Number(source[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
};
const nullableNumber = (source: Json, key: string) => {
  if (source[key] === undefined || source[key] === null || source[key] === '') return null;
  const value = Number(source[key]);
  return Number.isFinite(value) ? value : null;
};
const boolean = (source: Json, key: string) => source[key] === true;
const direction = (source: Json): 'RECEIVABLE' | 'PAYABLE' => text(source, 'direction') === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';
const partyType = (source: Json): 'CUSTOMER' | 'SUPPLIER' => text(source, 'partyType') === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER';

function balance(value: unknown): CommercialBalance {
  const row = object(value);
  return {
    subsidiaryId: nullableNumber(row, 'subsidiaryId'), subsidiaryName: text(row, 'subsidiaryName'),
    direction: direction(row), partyType: partyType(row), partyId: nullableNumber(row, 'partyId'),
    partyKey: text(row, 'partyKey'), partyCode: text(row, 'partyCode'), partyName: text(row, 'partyName'),
    identification: text(row, 'identification'), masterIntercompany: boolean(row, 'masterIntercompany'),
    accountNumber: text(row, 'accountNumber'), accountName: text(row, 'accountName'),
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    openingBalance: number(row, 'openingBalance'), debits: number(row, 'debits'), credits: number(row, 'credits'),
    periodMovement: number(row, 'periodMovement'), closingBalance: number(row, 'closingBalance'),
    documentBalance: number(row, 'documentBalance'), openDocumentCount: number(row, 'openDocumentCount'),
    documentOriginalTotal: number(row, 'documentOriginalTotal'), settledTotal: number(row, 'settledTotal'),
    difference: number(row, 'difference')
  };
}

function currencySummary(value: unknown): CurrencySummary {
  const row = object(value);
  return {
    subsidiaryId: nullableNumber(row, 'subsidiaryId'), subsidiaryName: text(row, 'subsidiaryName'),
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    receivableOpening: number(row, 'receivableOpening'), payableOpening: number(row, 'payableOpening'),
    receivableDebits: number(row, 'receivableDebits'), receivableCredits: number(row, 'receivableCredits'),
    payableDebits: number(row, 'payableDebits'), payableCredits: number(row, 'payableCredits'),
    receivableClosing: number(row, 'receivableClosing'), payableClosing: number(row, 'payableClosing'),
    netPosition: number(row, 'netPosition'), receivableDocuments: number(row, 'receivableDocuments'),
    payableDocuments: number(row, 'payableDocuments')
  };
}

function localPosition(value: unknown): LocalPosition {
  const row = object(value);
  return {
    subsidiaryName: text(row, 'subsidiaryName'), direction: direction(row), partyType: partyType(row),
    partyKey: text(row, 'partyKey'), partyCode: text(row, 'partyCode'), partyName: text(row, 'partyName'),
    identification: text(row, 'identification'), masterIntercompany: boolean(row, 'masterIntercompany'),
    originalCurrencyCode: text(row, 'originalCurrencyCode'), originalCurrencyName: text(row, 'originalCurrencyName'),
    originalCurrencySymbol: text(row, 'originalCurrencySymbol'), localCurrencyCode: text(row, 'localCurrencyCode'),
    localCurrencyName: text(row, 'localCurrencyName'), localCurrencySymbol: text(row, 'localCurrencySymbol'),
    openingBalance: number(row, 'openingBalance'), debits: number(row, 'debits'), credits: number(row, 'credits'),
    periodMovement: number(row, 'periodMovement'), closingBalance: number(row, 'closingBalance'),
    receivableClosing: number(row, 'receivableClosing'), payableClosing: number(row, 'payableClosing'),
    netPosition: number(row, 'netPosition')
  };
}

function document(value: unknown): CommercialDocument {
  const row = object(value);
  return {
    id: text(row, 'id'), direction: direction(row), partyType: partyType(row), partyKey: text(row, 'partyKey'),
    partyCode: text(row, 'partyCode'), partyName: text(row, 'partyName'), identification: text(row, 'identification'),
    masterIntercompany: boolean(row, 'masterIntercompany'), subsidiaryName: text(row, 'subsidiaryName'),
    accountNumber: text(row, 'accountNumber'), accountName: text(row, 'accountName'),
    documentNumber: text(row, 'documentNumber'), issueDate: text(row, 'issueDate'), dueDate: text(row, 'dueDate'),
    postingDate: text(row, 'postingDate'), overdueDays: number(row, 'overdueDays'), agingBucket: text(row, 'agingBucket'),
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    exchangeRate: number(row, 'exchangeRate'), originalAmount: number(row, 'originalAmount'),
    appliedAmount: number(row, 'appliedAmount'), creditAmount: number(row, 'creditAmount'),
    debitAmount: number(row, 'debitAmount'), outstanding: number(row, 'outstanding'),
    localCurrencyCode: text(row, 'localCurrencyCode'), localCurrencySymbol: text(row, 'localCurrencySymbol'),
    historicalLocalOutstanding: number(row, 'historicalLocalOutstanding'), journalId: nullableNumber(row, 'journalId'),
    transactionId: nullableNumber(row, 'transactionId'), isOpeningBalance: boolean(row, 'isOpeningBalance')
  };
}

function movement(value: unknown): CommercialMovement {
  const row = object(value);
  return {
    id: text(row, 'id'), date: text(row, 'date'), transactionNumber: text(row, 'transactionNumber'),
    transactionType: text(row, 'transactionType'), journalId: nullableNumber(row, 'journalId'),
    journalNumber: text(row, 'journalNumber'), memo: text(row, 'memo'), note: text(row, 'note'),
    subsidiaryName: text(row, 'subsidiaryName'), direction: direction(row), partyType: partyType(row),
    partyKey: text(row, 'partyKey'), partyCode: text(row, 'partyCode'), partyName: text(row, 'partyName'),
    identification: text(row, 'identification'), partyAssigned: boolean(row, 'partyAssigned'),
    masterIntercompany: boolean(row, 'masterIntercompany'), accountNumber: text(row, 'accountNumber'),
    accountName: text(row, 'accountName'), currencyCode: text(row, 'currencyCode'),
    currencySymbol: text(row, 'currencySymbol'), exchangeRate: number(row, 'exchangeRate'),
    originalDebit: number(row, 'originalDebit'), originalCredit: number(row, 'originalCredit'),
    originalMovement: number(row, 'originalMovement'), originalRunningBalance: number(row, 'originalRunningBalance'),
    localCurrencyCode: text(row, 'localCurrencyCode'), localCurrencySymbol: text(row, 'localCurrencySymbol'),
    localDebit: number(row, 'localDebit'), localCredit: number(row, 'localCredit'),
    localMovement: number(row, 'localMovement'), localRunningBalance: number(row, 'localRunningBalance'),
    isFxRevaluation: boolean(row, 'isFxRevaluation')
  };
}

function normalize(payload: unknown): Report {
  const source = object(payload), quality = object(source.quality);
  return {
    generatedAt: text(source, 'generatedAt') || new Date().toISOString(),
    dateFrom: text(source, 'dateFrom'), dateTo: text(source, 'dateTo'),
    receivables: list(source.receivables).map(balance), payables: list(source.payables).map(balance),
    reconciliation: list(source.reconciliation).map(balance),
    currencySummaries: list(source.currencySummaries).map(currencySummary),
    localCurrencySummaries: list(source.localCurrencySummaries).map(currencySummary),
    localPositions: list(source.localPositions).map(localPosition),
    documents: list(source.documents).map(document), details: list(source.details ?? source.rows).map(movement),
    quality: {
      movementCount: number(quality, 'movementCount'), documentCount: number(quality, 'documentCount'),
      openDocumentCount: number(quality, 'openDocumentCount'), partyCount: number(quality, 'partyCount'),
      currencyCount: number(quality, 'currencyCount'),
      unassignedPartyMovementCount: number(quality, 'unassignedPartyMovementCount'),
      unassignedOpeningPartyMovementCount: number(quality, 'unassignedOpeningPartyMovementCount'),
      unassignedPeriodPartyMovementCount: number(quality, 'unassignedPeriodPartyMovementCount'),
      classificationMismatchCount: number(quality, 'classificationMismatchCount'),
      reconciliationDifferenceCount: number(quality, 'reconciliationDifferenceCount'),
      fxAdjustmentMovementCount: number(quality, 'fxAdjustmentMovementCount'),
      hasReconciliationDifferences: boolean(quality, 'hasReconciliationDifferences')
    },
    metadata: { subsidiary: '', legalName: '', book: '' }
  };
}

export function intercompanyCommercialReportOptions(authorization: string) {
  return rpc<Json>(authorization, 'accounting_report_options');
}

export function runIntercompanyCommercialReport(authorization: string, filters: Json) {
  return rpc<Json>(authorization, 'run_accounting_report', { p_report: 'intercompany-commercial', p_filters: filters });
}

async function fullReport(authorization: string, filters: Json) {
  const [payload, options] = await Promise.all([
    runIntercompanyCommercialReport(authorization, filters), intercompanyCommercialReportOptions(authorization)
  ]);
  const report = normalize(payload);
  const requested = Array.isArray(filters.subsidiaryIds)
    ? filters.subsidiaryIds.map(String) : [String(filters.subsidiaryId ?? '')];
  const subsidiaries = list(options.subsidiaries).filter(item => requested.includes(String(item.id ?? item.subsidiaryId)));
  const books = list(options.intercompanyBooks ?? options.books);
  const book = books.find(item => String(item.id ?? item.bookId) === String(filters.bookId ?? ''));
  report.metadata = {
    subsidiary: subsidiaries.length === 1 ? text(subsidiaries[0], 'name') : subsidiaries.map(item => text(item, 'name')).filter(Boolean).join(', ') || 'Empresas autorizadas',
    legalName: subsidiaries.length === 1 ? text(subsidiaries[0], 'legalName') || text(subsidiaries[0], 'name') : 'Empresas autorizadas',
    book: book ? text(book, 'name') : 'Libro principal activo'
  };
  return report;
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const amount = (value: number) => Number(value || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: number, row: { currencySymbol?: string; currencyCode?: string }) => `${row.currencySymbol || row.currencyCode || ''} ${amount(value)}`.trim();
const dateLabel = (value: string) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

function pdfRows(rows: CommercialBalance[], empty: string) {
  if (!rows.length) return `<tr><td colspan="9" class="empty">${escapeHtml(empty)}</td></tr>`;
  return rows.map(row => `<tr><td><b>${escapeHtml(row.partyCode || 'SIN-ASIGNAR')}</b><small>${escapeHtml(row.partyName)}</small></td><td>${escapeHtml(row.currencyCode)}</td><td>${row.openDocumentCount}</td><td class="num">${escapeHtml(money(row.openingBalance, row))}</td><td class="num">${escapeHtml(money(row.debits, row))}</td><td class="num">${escapeHtml(money(row.credits, row))}</td><td class="num"><b>${escapeHtml(money(row.closingBalance, row))}</b></td><td class="num">${escapeHtml(money(row.documentBalance, row))}</td><td class="num ${Math.abs(row.difference) > .005 ? 'issue' : 'ok'}">${escapeHtml(money(row.difference, row))}</td></tr>`).join('');
}

function pdfHtml(report: Report) {
  const cards = report.currencySummaries.map(row => `<article><small>${escapeHtml(row.currencyCode)} · ${escapeHtml(row.currencyName)}</small><div><span>CxC <b>${escapeHtml(money(row.receivableClosing, row))}</b></span><span>CxP <b>${escapeHtml(money(row.payableClosing, row))}</b></span><span>Neto <b>${escapeHtml(money(row.netPosition, row))}</b></span></div></article>`).join('') || '<article>Sin saldos para los filtros seleccionados.</article>';
  const documents = report.documents.map(row => `<tr><td>${row.direction === 'RECEIVABLE' ? 'CxC' : 'CxP'}</td><td><b>${escapeHtml(row.partyCode)}</b><small>${escapeHtml(row.partyName)}</small></td><td>${escapeHtml(row.documentNumber)}</td><td>${dateLabel(row.issueDate)}</td><td>${dateLabel(row.dueDate)}</td><td>${escapeHtml(row.currencyCode)}</td><td class="num">${escapeHtml(money(row.originalAmount, row))}</td><td class="num">${escapeHtml(money(row.appliedAmount + row.creditAmount - row.debitAmount, row))}</td><td class="num"><b>${escapeHtml(money(row.outstanding, row))}</b></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No hay documentos para mostrar.</td></tr>';
  const warning = report.quality.reconciliationDifferenceCount
    ? `<aside><b>${report.quality.reconciliationDifferenceCount} combinación(es) de tercero y moneda no concilian.</b> Revise la columna Diferencia y los movimientos sin documento.</aside>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4 landscape;margin:9mm 8mm 12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#14233b;margin:0;font-size:8px}header{display:flex;justify-content:space-between;border-bottom:3px solid #ef6c30;padding-bottom:8px}.brand{font-size:19px;font-weight:900;letter-spacing:2px;color:#063b79}h1{font-size:17px;margin:4px 0}.meta{text-align:right;line-height:1.55}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.cards article{border:1px solid #d6e0ea;border-left:4px solid #0b8b69;border-radius:5px;padding:6px}.cards article small{display:block;color:#607086;font-weight:bold}.cards article div{display:flex;gap:12px;margin-top:4px}.cards article span{display:flex;flex-direction:column}aside{background:#fff4e8;border:1px solid #efb36d;border-left:4px solid #e05b2d;padding:7px;margin:7px 0}h2{font-size:11px;color:#063b79;margin:10px 0 4px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{page-break-inside:avoid}th,td{border:1px solid #d9e2ec;padding:4px;vertical-align:top}th{background:#063b79;color:#fff;text-align:left}.payable th{background:#9a4b12}.num{text-align:right;font-variant-numeric:tabular-nums}td small{display:block;color:#65758a}.ok{color:#08775c;font-weight:bold}.issue{color:#b42318;font-weight:bold}.empty{text-align:center;color:#65758a;padding:12px}footer{display:flex;justify-content:space-between;color:#65758a;margin-top:8px}</style></head><body>
  <header><div><div class="brand">GENTIA</div><h1>Cuentas comerciales intercompany</h1><div>${escapeHtml(report.metadata.legalName || report.metadata.subsidiary)}</div></div><div class="meta"><b>${escapeHtml(report.metadata.book)}</b><br>${dateLabel(report.dateFrom)} al ${dateLabel(report.dateTo)}<br>Cuentas 113002 y 211002 · separación por tercero y moneda</div></header>
  <section class="cards">${cards}</section>${warning}
  <h2>A · 113002 Cuentas por Cobrar Clientes Intercompany</h2><table><thead><tr><th>Cliente</th><th>Moneda</th><th>Documentos</th><th class="num">Inicial</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Mayor</th><th class="num">Auxiliar</th><th class="num">Diferencia</th></tr></thead><tbody>${pdfRows(report.receivables, 'No hay cuentas por cobrar comerciales intercompany.')}</tbody></table>
  <h2>B · 211002 Cuentas por Pagar Proveedores Intercompany</h2><table class="payable"><thead><tr><th>Proveedor</th><th>Moneda</th><th>Documentos</th><th class="num">Inicial</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Mayor</th><th class="num">Auxiliar</th><th class="num">Diferencia</th></tr></thead><tbody>${pdfRows(report.payables, 'No hay cuentas por pagar comerciales intercompany.')}</tbody></table>
  <h2>C · Detalle de documentos</h2><table><thead><tr><th>Tipo</th><th>Tercero</th><th>Documento</th><th>Emisión</th><th>Vencimiento</th><th>Moneda</th><th class="num">Original</th><th class="num">Aplicado / notas</th><th class="num">Pendiente</th></tr></thead><tbody>${documents}</tbody></table>
  <footer><span>${report.quality.openDocumentCount} documentos abiertos · ${report.quality.partyCount} terceros · ${report.quality.currencyCount} monedas</span><span>Generado ${new Date(report.generatedAt).toLocaleString('es-CR')}</span></footer></body></html>`;
}

export async function exportIntercompanyCommercialPdf(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters);
  const rendered = await renderBankReconciliationPdf({
    html: pdfHtml(report), fileName: `cuentas-comerciales-intercompany-${report.dateTo || 'periodo'}.pdf`
  });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

function borders(): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: 'FFD8E2EC' } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function title(sheet: ExcelJS.Worksheet, value: string, lastColumn: string) {
  sheet.mergeCells(`A1:${lastColumn}1`);
  const cell = sheet.getCell('A1'); cell.value = value;
  cell.font = { bold: true, size: 17, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  sheet.getRow(1).height = 32;
}

function header(row: ExcelJS.Row, color = 'FF0B6F63') {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = borders();
  });
}

function data(row: ExcelJS.Row, numericFrom: number) {
  row.eachCell((cell, column) => {
    cell.border = borders(); cell.alignment = { vertical: 'top', wrapText: column < numericFrom };
    if (column >= numericFrom && typeof cell.value === 'number') {
      cell.numFmt = '#,##0.00;[Red](#,##0.00);-'; cell.alignment = { horizontal: 'right', vertical: 'top' };
    }
  });
}

function addBalanceSheet(workbook: ExcelJS.Workbook, name: string, rows: CommercialBalance[], color: string) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.columns = [18, 34, 20, 26, 14, 14, 17, 17, 17, 18, 18, 18, 16, 18].map(width => ({ width }));
  title(sheet, name === 'CxC comercial' ? '113002 · CUENTAS POR COBRAR CLIENTES INTERCOMPANY' : '211002 · CUENTAS POR PAGAR PROVEEDORES INTERCOMPANY', 'N');
  sheet.mergeCells('A2:N2'); sheet.getCell('A2').value = 'Saldos separados por tercero y moneda original. La diferencia compara el auxiliar documental con el Mayor.';
  sheet.addRow([]); sheet.addRow([]);
  const head = sheet.addRow(['Código', 'Tercero', 'Identificación fiscal', 'Subsidiaria', 'Cuenta', 'Moneda', 'Saldo inicial', 'Débitos', 'Créditos', 'Movimiento', 'Saldo Mayor', 'Saldo auxiliar', 'Documentos abiertos', 'Diferencia']); header(head, color);
  for (const item of rows) {
    const row = sheet.addRow([item.partyCode, item.partyName, item.identification, item.subsidiaryName, item.accountNumber, item.currencyCode, item.openingBalance, item.debits, item.credits, item.periodMovement, item.closingBalance, item.documentBalance, item.openDocumentCount, item.difference]);
    data(row, 7); row.getCell(13).numFmt = '0'; if (Math.abs(item.difference) > .005) row.getCell(14).font = { bold: true, color: { argb: 'FFB42318' } };
  }
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, sheet.rowCount), column: 14 } };
}

export async function exportIntercompanyCommercialExcel(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP'; workbook.company = report.metadata.legalName || report.metadata.subsidiary; workbook.created = new Date();
  const summary = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 5 }] });
  summary.columns = [16, 26, ...Array.from({ length: 11 }, () => 19)].map(width => ({ width }));
  title(summary, 'GENTIA · CUENTAS COMERCIALES INTERCOMPANY', 'M');
  summary.mergeCells('A2:H2'); summary.getCell('A2').value = report.metadata.legalName || report.metadata.subsidiary;
  summary.mergeCells('I2:M2'); summary.getCell('I2').value = `${dateLabel(report.dateFrom)} al ${dateLabel(report.dateTo)}`; summary.getCell('I2').alignment = { horizontal: 'right' };
  summary.addRow([]); const summaryHeader = summary.addRow(['Moneda', 'Descripción', 'CxC inicial', 'CxP inicial', 'Débitos CxC', 'Créditos CxC', 'Débitos CxP', 'Créditos CxP', 'CxC final', 'CxP final', 'Posición neta', 'Auxiliar CxC', 'Auxiliar CxP']); header(summaryHeader);
  for (const item of report.currencySummaries) { const row = summary.addRow([item.currencyCode, item.currencyName, item.receivableOpening, item.payableOpening, item.receivableDebits, item.receivableCredits, item.payableDebits, item.payableCredits, item.receivableClosing, item.payableClosing, item.netPosition, item.receivableDocuments, item.payableDocuments]); data(row, 3); }
  summary.addRow([]); const quality = summary.addRow(['Control de conciliación', `${report.quality.reconciliationDifferenceCount} diferencia(s) por tercero y moneda`, '', '', '', '', '', '', '', '', '', '', report.quality.hasReconciliationDifferences ? 'REVISAR' : 'CORRECTO']); quality.font = { bold: true, color: { argb: report.quality.hasReconciliationDifferences ? 'FFB42318' : 'FF08775C' } };
  addBalanceSheet(workbook, 'CxC comercial', report.receivables, 'FF0B6F63');
  addBalanceSheet(workbook, 'CxP comercial', report.payables, 'FF9A4B12');

  const local = workbook.addWorksheet('Equivalencia local', { views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  local.columns = [24, 12, 18, 34, 18, 15, 15, 18, 18, 18, 18, 18].map(width => ({ width }));
  title(local, 'EQUIVALENCIA LOCAL POR TERCERO Y MONEDA ORIGINAL', 'L');
  local.mergeCells('A2:L2'); local.getCell('A2').value = 'Cada fila conserva el tipo de tercero y la moneda original; los importes se expresan en la moneda funcional indicada.';
  local.addRow([]); local.addRow([]);
  const localHeader = local.addRow(['Subsidiaria', 'Tipo', 'Código', 'Cliente / proveedor', 'Identificación', 'Moneda original', 'Moneda local', 'Saldo inicial', 'Débitos', 'Créditos', 'Movimiento', 'Saldo final']); header(localHeader, 'FF6744A6');
  for (const item of report.localPositions) { const row = local.addRow([item.subsidiaryName, item.direction === 'RECEIVABLE' ? 'CxC' : 'CxP', item.partyCode, item.partyName, item.identification, item.originalCurrencyCode, item.localCurrencyCode, item.openingBalance, item.debits, item.credits, item.periodMovement, item.closingBalance]); data(row, 8); }
  local.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, local.rowCount), column: 12 } };

  const docs = workbook.addWorksheet('Documentos', { views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  docs.columns = [12, 17, 34, 18, 20, 16, 15, 15, 15, 14, 16, 18, 18, 18, 18, 18, 18, 16, 20].map(width => ({ width }));
  title(docs, 'DOCUMENTOS COMERCIALES INTERCOMPANY', 'S'); docs.addRow([]); docs.addRow([]); docs.addRow([]);
  const docsHeader = docs.addRow(['Tipo', 'Código', 'Cliente / proveedor', 'Identificación', 'Documento', 'Fecha contable', 'Emisión', 'Vencimiento', 'Mora días', 'Tramo', 'Cuenta', 'Moneda', 'Importe original', 'Aplicado', 'Notas crédito', 'Notas débito', 'Saldo pendiente', 'Tasa histórica', 'Equivalente histórico local']); header(docsHeader, 'FF063B79');
  for (const item of report.documents) { const row = docs.addRow([item.direction === 'RECEIVABLE' ? 'CxC' : 'CxP', item.partyCode, item.partyName, item.identification, item.documentNumber, item.postingDate, item.issueDate, item.dueDate, item.overdueDays, item.agingBucket, item.accountNumber, item.currencyCode, item.originalAmount, item.appliedAmount, item.creditAmount, item.debitAmount, item.outstanding, item.exchangeRate, item.historicalLocalOutstanding]); data(row, 13); row.getCell(18).numFmt = '0.0000000000'; }
  docs.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, docs.rowCount), column: 19 } };

  const movements = workbook.addWorksheet('Movimientos del Mayor', { views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  movements.columns = [14, 14, 20, 18, 18, 32, 18, 32, 16, 30, 18, 14, 14, 18, 18, 20, 14, 18, 18, 20, 18].map(width => ({ width }));
  title(movements, 'MOVIMIENTOS DEL MAYOR · 113002 / 211002', 'U'); movements.addRow([]); movements.addRow([]); movements.addRow([]);
  const movementsHeader = movements.addRow(['Fecha', 'Tipo', 'Documento', 'Asiento', 'Cuenta', 'Nombre de cuenta', 'Código tercero', 'Cliente / proveedor', 'Identificación', 'Concepto', 'Moneda', 'Tasa', 'Débito original', 'Crédito original', 'Saldo original', 'Moneda local', 'Débito local', 'Crédito local', 'Saldo local', 'Naturaleza', 'Control tercero']); header(movementsHeader, 'FF6744A6');
  for (const item of report.details) { const row = movements.addRow([item.date, item.direction === 'RECEIVABLE' ? 'CxC' : 'CxP', item.transactionNumber, item.journalNumber, item.accountNumber, item.accountName, item.partyCode, item.partyName, item.identification, item.note || item.memo, item.currencyCode, item.exchangeRate, item.originalDebit, item.originalCredit, item.originalRunningBalance, item.localCurrencyCode, item.localDebit, item.localCredit, item.localRunningBalance, item.isFxRevaluation ? 'REVALUACIÓN FX' : 'OPERATIVO', item.partyAssigned ? 'ASIGNADO' : 'REVISAR']); data(row, 12); row.getCell(12).numFmt = '0.0000000000'; if (!item.partyAssigned) row.getCell(21).font = { bold: true, color: { argb: 'FFB42318' } }; }
  movements.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, movements.rowCount), column: 21 } };

  const bytes = await workbook.xlsx.writeBuffer();
  return { fileName: `cuentas-comerciales-intercompany-${report.dateTo || 'periodo'}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) };
}
