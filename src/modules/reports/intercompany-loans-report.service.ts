import type ExcelJS from 'exceljs';
import { createExcelWorkbook } from '../../core/export/excel-workbook.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

type Aggregate = {
  relatedCompanyId: number | null;
  relatedCompanyCode: string;
  relatedCompanyName: string;
  currencyId: number | null;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  openingBalance: number;
  debits: number;
  credits: number;
  periodMovement: number;
  closingBalance: number;
};

type Position = {
  subsidiaryId: number | null;
  subsidiaryName: string;
  relatedCompanyId: number | null;
  relatedCompanyCode: string;
  relatedCompanyName: string;
  currencyId: number | null;
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
};

type LocalPosition = {
  subsidiaryId: number | null;
  subsidiaryName: string;
  relatedCompanyId: number | null;
  relatedCompanyCode: string;
  relatedCompanyName: string;
  originalCurrencyId: number | null;
  originalCurrencyCode: string;
  originalCurrencyName: string;
  originalCurrencySymbol: string;
  localCurrencyId: number | null;
  localCurrencyCode: string;
  localCurrencyName: string;
  localCurrencySymbol: string;
  receivableOpening: number;
  payableOpening: number;
  receivableDebits: number;
  receivableCredits: number;
  payableDebits: number;
  payableCredits: number;
  receivableClosing: number;
  payableClosing: number;
  netPosition: number;
};

type Detail = {
  id: string;
  date: string;
  transactionId: number | null;
  transactionNumber: string;
  transactionType: string;
  journalId: number | null;
  journalNumber: string;
  memo: string;
  note: string;
  subsidiaryId: number | null;
  subsidiaryName: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  accountGroupCode: string;
  accountGroupName: string;
  accountNumber: string;
  accountName: string;
  relatedCompanyId: number | null;
  relatedCompanyCode: string;
  relatedCompanyName: string;
  relatedCompanyIdentification: string;
  dimensionAssigned: boolean;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  exchangeRate: number;
  originalDebit: number;
  originalCredit: number;
  originalMovement: number;
  originalRunningBalance: number;
  localCurrencyCode: string;
  localCurrencyName: string;
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
  receivables: Aggregate[];
  payables: Aggregate[];
  netPositions: Position[];
  localPositions: LocalPosition[];
  currencySummaries: Position[];
  localCurrencySummaries: Position[];
  details: Detail[];
  quality: {
    movementCount: number;
    accountCount: number;
    relatedCompanyCount: number;
    currencyCount: number;
    unassignedMovementCount: number;
    unassignedOpeningMovementCount: number;
    unassignedPeriodMovementCount: number;
    fxAdjustmentMovementCount: number;
    hasUnassignedDimensions: boolean;
  };
  metadata: {
    subsidiary: string;
    legalName: string;
    book: string;
  };
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
      : 'No fue posible generar el reporte de préstamos intercompany.';
    throw new Error(message);
  }
  return payload as T;
}

const object = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const text = (source: Json, key: string) => source[key] === undefined || source[key] === null ? '' : String(source[key]);
const numeric = (source: Json, key: string) => {
  const value = Number(source[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
};
const nullableNumber = (source: Json, key: string) => {
  const value = source[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function aggregate(value: unknown): Aggregate {
  const row = object(value);
  return {
    relatedCompanyId: nullableNumber(row, 'relatedCompanyId'), relatedCompanyCode: text(row, 'relatedCompanyCode'),
    relatedCompanyName: text(row, 'relatedCompanyName') || 'Sin compañía relacionada', currencyId: nullableNumber(row, 'currencyId'),
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    openingBalance: numeric(row, 'openingBalance'), debits: numeric(row, 'debits'), credits: numeric(row, 'credits'),
    periodMovement: numeric(row, 'periodMovement'), closingBalance: numeric(row, 'closingBalance')
  };
}

function position(value: unknown): Position {
  const row = object(value);
  return {
    subsidiaryId: nullableNumber(row, 'subsidiaryId'), subsidiaryName: text(row, 'subsidiaryName'),
    relatedCompanyId: nullableNumber(row, 'relatedCompanyId'), relatedCompanyCode: text(row, 'relatedCompanyCode'),
    relatedCompanyName: text(row, 'relatedCompanyName') || 'Sin compañía relacionada', currencyId: nullableNumber(row, 'currencyId'),
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    receivableOpening: numeric(row, 'receivableOpening'), payableOpening: numeric(row, 'payableOpening'),
    receivableDebits: numeric(row, 'receivableDebits'), receivableCredits: numeric(row, 'receivableCredits'),
    payableDebits: numeric(row, 'payableDebits'), payableCredits: numeric(row, 'payableCredits'),
    receivableClosing: numeric(row, 'receivableClosing'), payableClosing: numeric(row, 'payableClosing'), netPosition: numeric(row, 'netPosition')
  };
}

function localPosition(value: unknown): LocalPosition {
  const row = object(value);
  return {
    subsidiaryId: nullableNumber(row, 'subsidiaryId'), subsidiaryName: text(row, 'subsidiaryName'),
    relatedCompanyId: nullableNumber(row, 'relatedCompanyId'), relatedCompanyCode: text(row, 'relatedCompanyCode'),
    relatedCompanyName: text(row, 'relatedCompanyName') || 'Sin compañía relacionada',
    originalCurrencyId: nullableNumber(row, 'originalCurrencyId'), originalCurrencyCode: text(row, 'originalCurrencyCode'),
    originalCurrencyName: text(row, 'originalCurrencyName'), originalCurrencySymbol: text(row, 'originalCurrencySymbol'),
    localCurrencyId: nullableNumber(row, 'localCurrencyId'), localCurrencyCode: text(row, 'localCurrencyCode'),
    localCurrencyName: text(row, 'localCurrencyName'), localCurrencySymbol: text(row, 'localCurrencySymbol'),
    receivableOpening: numeric(row, 'receivableOpening'), payableOpening: numeric(row, 'payableOpening'),
    receivableDebits: numeric(row, 'receivableDebits'), receivableCredits: numeric(row, 'receivableCredits'),
    payableDebits: numeric(row, 'payableDebits'), payableCredits: numeric(row, 'payableCredits'),
    receivableClosing: numeric(row, 'receivableClosing'), payableClosing: numeric(row, 'payableClosing'),
    netPosition: numeric(row, 'netPosition')
  };
}

function detail(value: unknown): Detail {
  const row = object(value), direction = text(row, 'direction') === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';
  return {
    id: text(row, 'id'), date: text(row, 'date'), transactionId: nullableNumber(row, 'transactionId'),
    transactionNumber: text(row, 'transactionNumber'), transactionType: text(row, 'transactionType'),
    journalId: nullableNumber(row, 'journalId'), journalNumber: text(row, 'journalNumber'), memo: text(row, 'memo'), note: text(row, 'note'),
    subsidiaryId: nullableNumber(row, 'subsidiaryId'), subsidiaryName: text(row, 'subsidiaryName'), direction,
    accountGroupCode: text(row, 'accountGroupCode'), accountGroupName: text(row, 'accountGroupName'),
    accountNumber: text(row, 'accountNumber'), accountName: text(row, 'accountName'),
    relatedCompanyId: nullableNumber(row, 'relatedCompanyId'), relatedCompanyCode: text(row, 'relatedCompanyCode'),
    relatedCompanyName: text(row, 'relatedCompanyName') || 'Sin compañía relacionada',
    relatedCompanyIdentification: text(row, 'relatedCompanyIdentification'), dimensionAssigned: row.dimensionAssigned === true,
    currencyCode: text(row, 'currencyCode'), currencyName: text(row, 'currencyName'), currencySymbol: text(row, 'currencySymbol'),
    exchangeRate: numeric(row, 'exchangeRate'), originalDebit: numeric(row, 'originalDebit'), originalCredit: numeric(row, 'originalCredit'),
    originalMovement: numeric(row, 'originalMovement'), originalRunningBalance: numeric(row, 'originalRunningBalance'),
    localCurrencyCode: text(row, 'localCurrencyCode'), localCurrencyName: text(row, 'localCurrencyName'),
    localCurrencySymbol: text(row, 'localCurrencySymbol'), localDebit: numeric(row, 'localDebit'), localCredit: numeric(row, 'localCredit'),
    localMovement: numeric(row, 'localMovement'), localRunningBalance: numeric(row, 'localRunningBalance'),
    isFxRevaluation: row.isFxRevaluation === true || row.is_fx_revaluation === true
  };
}

function normalize(payload: unknown): Report {
  const source = object(payload), quality = object(source.quality);
  const legacyUnassigned = numeric(quality, 'unassignedMovementCount');
  const hasOpeningBreakdown = quality.unassignedOpeningMovementCount !== undefined;
  const hasPeriodBreakdown = quality.unassignedPeriodMovementCount !== undefined;
  const openingUnassigned = hasOpeningBreakdown ? numeric(quality, 'unassignedOpeningMovementCount') : hasPeriodBreakdown ? Math.max(legacyUnassigned - numeric(quality, 'unassignedPeriodMovementCount'), 0) : 0;
  const periodUnassigned = hasPeriodBreakdown ? numeric(quality, 'unassignedPeriodMovementCount') : hasOpeningBreakdown ? Math.max(legacyUnassigned - openingUnassigned, 0) : legacyUnassigned;
  const totalUnassigned = Math.max(legacyUnassigned, openingUnassigned + periodUnassigned);
  return {
    generatedAt: text(source, 'generatedAt') || new Date().toISOString(), dateFrom: text(source, 'dateFrom'), dateTo: text(source, 'dateTo'),
    receivables: list(source.receivables).map(aggregate), payables: list(source.payables).map(aggregate),
    netPositions: list(source.netPositions).map(position), localPositions: list(source.localPositions).map(localPosition),
    currencySummaries: list(source.currencySummaries).map(position),
    localCurrencySummaries: list(source.localCurrencySummaries).map(position),
    details: list(source.details ?? source.rows).map(detail),
    quality: {
      movementCount: numeric(quality, 'movementCount'), accountCount: numeric(quality, 'accountCount'),
      relatedCompanyCount: numeric(quality, 'relatedCompanyCount'), currencyCount: numeric(quality, 'currencyCount'),
      unassignedMovementCount: totalUnassigned, unassignedOpeningMovementCount: openingUnassigned,
      unassignedPeriodMovementCount: periodUnassigned, fxAdjustmentMovementCount: numeric(quality, 'fxAdjustmentMovementCount'),
      hasUnassignedDimensions: quality.hasUnassignedDimensions === true || totalUnassigned > 0
    },
    metadata: { subsidiary: '', legalName: '', book: '' }
  };
}

export function intercompanyLoansReportOptions(authorization: string) {
  return rpc<Json>(authorization, 'accounting_report_options');
}

export function runIntercompanyLoansReport(authorization: string, filters: Json) {
  return rpc<Json>(authorization, 'run_accounting_report', { p_report: 'intercompany-loans', p_filters: filters });
}

async function fullReport(authorization: string, filters: Json) {
  const [payload, options] = await Promise.all([
    runIntercompanyLoansReport(authorization, filters), intercompanyLoansReportOptions(authorization)
  ]);
  const report = normalize(payload), subsidiaryIds = Array.isArray(filters.subsidiaryIds) ? filters.subsidiaryIds.map(String) : [String(filters.subsidiaryId ?? '')];
  const companies = list(options.subsidiaries), selected = companies.filter(item => subsidiaryIds.includes(String(item.id ?? item.subsidiaryId)));
  const intercompanyBooks = list(options.intercompanyBooks ?? options.intercompany_books);
  const book = (intercompanyBooks.length ? intercompanyBooks : list(options.books))
    .find(item => String(item.id ?? item.bookId) === String(filters.bookId ?? ''));
  report.metadata = {
    subsidiary: selected.length === 1 ? text(selected[0], 'name') : selected.map(item => text(item, 'name')).filter(Boolean).join(', ') || 'Empresas autorizadas',
    legalName: selected.length === 1 ? text(selected[0], 'legalName') || text(selected[0], 'name') : 'Empresas autorizadas',
    book: book ? text(book, 'name') : 'Libro principal activo'
  };
  return report;
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const dateLabel = (value: string) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
const amount = (value: number) => Number(value || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyAmount = (value: number, row: { currencySymbol?: string; currencyCode?: string }) => `${row.currencySymbol || row.currencyCode || ''} ${amount(value)}`.trim();
const localCurrencyAmount = (value: number, row: LocalPosition) => `${row.localCurrencySymbol || row.localCurrencyCode || ''} ${amount(value)}`.trim();

function aggregateRows(rows: Aggregate[], emptyLabel: string) {
  if (!rows.length) return `<tr><td colspan="8" class="empty">${escapeHtml(emptyLabel)}</td></tr>`;
  return rows.map(row => `<tr><td><b>${escapeHtml(row.relatedCompanyCode || 'SIN-DIMENSIÓN')}</b><small>${escapeHtml(row.relatedCompanyName)}</small></td><td><span class="currency">${escapeHtml(row.currencyCode)}</span><small>${escapeHtml(row.currencyName)}</small></td><td class="num">${escapeHtml(currencyAmount(row.openingBalance, row))}</td><td class="num">${escapeHtml(currencyAmount(row.debits, row))}</td><td class="num">${escapeHtml(currencyAmount(row.credits, row))}</td><td class="num">${escapeHtml(currencyAmount(row.periodMovement, row))}</td><td class="num"><b>${escapeHtml(currencyAmount(row.closingBalance, row))}</b></td><td>${row.relatedCompanyId === null ? '<span class="issue">REVISAR DIMENSIÓN</span>' : '<span class="ok">ASIGNADA</span>'}</td></tr>`).join('');
}

function pdfHtml(report: Report) {
  const h = report.metadata, q = report.quality;
  const currencyCards = report.currencySummaries.map(row => `<article><small>${escapeHtml(row.currencyCode)} · ${escapeHtml(row.currencyName)}</small><div><span>Por cobrar <b>${escapeHtml(currencyAmount(row.receivableClosing, row))}</b></span><span>Por pagar <b>${escapeHtml(currencyAmount(row.payableClosing, row))}</b></span><span>Posición neta <b class="${row.netPosition < 0 ? 'negative' : ''}">${escapeHtml(currencyAmount(row.netPosition, row))}</b></span></div></article>`).join('') || '<article><b>Sin saldos para los filtros seleccionados.</b></article>';
  const localControl = report.localPositions.map(row => `<tr><td><b>${escapeHtml(row.subsidiaryName)}</b></td><td><b>${escapeHtml(row.relatedCompanyCode || 'SIN-DIMENSIÓN')}</b><small>${escapeHtml(row.relatedCompanyName)}</small></td><td><b>${escapeHtml(row.originalCurrencyCode)}</b><small>${escapeHtml(row.originalCurrencyName)}</small></td><td><b>${escapeHtml(row.localCurrencyCode)}</b><small>${escapeHtml(row.localCurrencyName)}</small></td><td class="num">${escapeHtml(localCurrencyAmount(row.receivableClosing, row))}</td><td class="num">${escapeHtml(localCurrencyAmount(row.payableClosing, row))}</td><td class="num ${row.netPosition < 0 ? 'negative' : ''}"><b>${escapeHtml(localCurrencyAmount(row.netPosition, row))}</b></td></tr>`).join('');
  const positions = report.netPositions.map(row => `<tr><td><b>${escapeHtml(row.relatedCompanyCode || 'SIN-DIMENSIÓN')}</b><small>${escapeHtml(row.relatedCompanyName)}</small></td><td>${escapeHtml(row.currencyCode)}</td><td class="num">${escapeHtml(currencyAmount(row.receivableClosing, row))}</td><td class="num">${escapeHtml(currencyAmount(row.payableClosing, row))}</td><td class="num ${row.netPosition < 0 ? 'negative' : ''}"><b>${escapeHtml(currencyAmount(row.netPosition, row))}</b></td><td>${Math.abs(row.netPosition) < .005 ? 'Compensado' : row.netPosition > 0 ? 'Posición por cobrar' : 'Posición por pagar'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No hay posiciones intercompany.</td></tr>';
  const missingBreakdown = [
    q.unassignedPeriodMovementCount ? `<span><b>${q.unassignedPeriodMovementCount}</b> del período consultado</span>` : '',
    q.unassignedOpeningMovementCount ? `<span><b>${q.unassignedOpeningMovementCount}</b> provenientes del saldo inicial</span>` : ''
  ].filter(Boolean).join(' · ');
  const warning = q.unassignedMovementCount ? `<aside><b>${q.unassignedMovementCount} movimiento(s) sin Compañía relacionada.</b><div>${missingBreakdown}</div>Deben corregirse para certificar la separación por contraparte.</aside>` : '';
  const fxNotice = q.fxAdjustmentMovementCount ? `<aside class="fx"><b>${q.fxAdjustmentMovementCount} ajuste(s) de revaluación FX identificados.</b> Se incluyen en los saldos y permanecen identificados en el detalle auditable.</aside>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4 landscape;margin:9mm 8mm 12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#14233b;margin:0;font-size:8px}header{display:flex;justify-content:space-between;border-bottom:3px solid #ef6c30;padding-bottom:8px}.brand{font-size:19px;font-weight:900;letter-spacing:2px;color:#063b79}h1{font-size:17px;margin:4px 0}.meta{text-align:right;line-height:1.55}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.cards article{border:1px solid #d6e0ea;border-left:4px solid #0b8b69;border-radius:5px;padding:6px}.cards article small{display:block;color:#607086;font-weight:bold}.cards article div{display:flex;gap:12px;margin-top:4px}.cards article span{display:flex;flex-direction:column}.cards b{font-size:9px}aside{background:#fff4e8;border:1px solid #efb36d;border-left:4px solid #e05b2d;padding:7px;margin:7px 0}aside div{margin:3px 0}aside.fx{background:#f4f0ff;border-color:#cfc0ef;border-left-color:#6744a6;color:#4f3481}h2{font-size:11px;color:#063b79;margin:10px 0 4px}table{width:100%;border-collapse:collapse;table-layout:fixed;page-break-inside:auto}thead{display:table-header-group}tr{page-break-inside:avoid}th,td{border:1px solid #d9e2ec;padding:4px;vertical-align:top}th{background:#063b79;color:#fff;text-align:left}.payable th{background:#9a4b12}.net th{background:#0b6f63}.num{text-align:right;font-variant-numeric:tabular-nums}td small{display:block;color:#65758a;margin-top:2px}.currency{font-weight:bold}.ok{color:#08775c;font-weight:bold}.issue,.negative{color:#b42318;font-weight:bold}.empty{text-align:center;color:#65758a;padding:12px}footer{display:flex;justify-content:space-between;color:#65758a;margin-top:8px}</style></head><body>
  <header><div><div class="brand">GENTIA</div><h1>Préstamos intercompany</h1><div>${escapeHtml(h.legalName || h.subsidiary)}</div></div><div class="meta"><b>${escapeHtml(h.book)}</b><br>${dateLabel(report.dateFrom)} al ${dateLabel(report.dateTo)}<br>Separado por moneda y Compañía relacionada</div></header>
  <section class="cards">${currencyCards}</section>${warning}${fxNotice}
  ${localControl ? `<h2>Equivalencia en moneda local por compañía y moneda original</h2><table class="net"><thead><tr><th>Subsidiaria</th><th>Compañía relacionada</th><th>Moneda original</th><th>Moneda funcional</th><th class="num">CxC equivalente</th><th class="num">CxP equivalente</th><th class="num">Posición neta</th></tr></thead><tbody>${localControl}</tbody></table>` : ''}
  <h2>A · Cuentas por Cobrar Compañías Relacionadas</h2><table><thead><tr><th>Compañía relacionada</th><th>Moneda</th><th class="num">Saldo inicial</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Movimiento</th><th class="num">Saldo final</th><th>Control</th></tr></thead><tbody>${aggregateRows(report.receivables, 'No hay cuentas por cobrar intercompany.')}</tbody></table>
  <h2>B · Cuentas por Pagar Compañías Relacionadas</h2><table class="payable"><thead><tr><th>Compañía relacionada</th><th>Moneda</th><th class="num">Saldo inicial</th><th class="num">Débitos</th><th class="num">Créditos</th><th class="num">Movimiento</th><th class="num">Saldo final</th><th>Control</th></tr></thead><tbody>${aggregateRows(report.payables, 'No hay cuentas por pagar intercompany.')}</tbody></table>
  <h2>C · Posición neta por contraparte y moneda</h2><table class="net"><thead><tr><th>Compañía relacionada</th><th>Moneda</th><th class="num">Por cobrar</th><th class="num">Por pagar</th><th class="num">Posición neta</th><th>Resultado</th></tr></thead><tbody>${positions}</tbody></table>
  <footer><span>${q.movementCount} movimientos · ${q.accountCount} cuentas · ${q.relatedCompanyCount} compañías</span><span>Generado ${new Date(report.generatedAt).toLocaleString('es-CR')}</span></footer></body></html>`;
}

export async function exportIntercompanyLoansPdf(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), rendered = await renderBankReconciliationPdf({ html: pdfHtml(report), fileName: `prestamos-intercompany-${report.dateTo || 'periodo'}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

function borders(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function styleTitle(sheet: ExcelJS.Worksheet, title: string, lastColumn: string) {
  sheet.mergeCells(`A1:${lastColumn}1`); const cell = sheet.getCell('A1'); cell.value = title; cell.font = { bold: true, size: 17, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; cell.alignment = { vertical: 'middle' }; sheet.getRow(1).height = 32;
}

function styleHeader(row: ExcelJS.Row, color = 'FF0B6F63') {
  row.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = borders('FFFFFF'); });
}

function styleData(row: ExcelJS.Row, numericFrom: number) {
  row.eachCell((cell, column) => { cell.border = borders(); cell.alignment = { vertical: 'top', wrapText: column < numericFrom }; if (column >= numericFrom && typeof cell.value === 'number') { cell.numFmt = '#,##0.00;[Red](#,##0.00);-'; cell.alignment = { horizontal: 'right', vertical: 'top' }; } });
}

function addAggregateSheet(workbook: ExcelJS.Workbook, name: string, title: string, rows: Aggregate[], color: string) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.columns = [{ width: 16 }, { width: 36 }, { width: 13 }, { width: 21 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  styleTitle(sheet, title, 'J'); sheet.mergeCells('A2:J2'); sheet.getCell('A2').value = 'Separación obligatoria por dimensión Compañía relacionada y moneda original'; sheet.getCell('A2').font = { italic: true, color: { argb: 'FF607086' } };
  sheet.addRow([]); sheet.addRow([]); const header = sheet.addRow(['Código compañía', 'Compañía relacionada', 'Moneda', 'Nombre de moneda', 'Saldo inicial', 'Débitos', 'Créditos', 'Movimiento del periodo', 'Saldo final', 'Control de dimensión']); styleHeader(header, color);
  for (const item of rows) { const row = sheet.addRow([item.relatedCompanyCode || 'SIN-DIMENSIÓN', item.relatedCompanyName, item.currencyCode, item.currencyName, item.openingBalance, item.debits, item.credits, item.periodMovement, item.closingBalance, item.relatedCompanyId === null ? 'REVISAR DIMENSIÓN' : 'ASIGNADA']); styleData(row, 5); if (item.relatedCompanyId === null) row.getCell(10).font = { bold: true, color: { argb: 'FFB42318' } }; }
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, sheet.rowCount), column: 10 } };
  sheet.headerFooter.oddFooter = `&LGENTIA ERP&C${title}&R&P de &N`;
  return sheet;
}

function addLocalPositionsSheet(workbook: ExcelJS.Workbook, rows: LocalPosition[]) {
  const sheet = workbook.addWorksheet('Equivalencia local', { views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.columns = [26, 17, 34, 13, 24, 13, 24, 18, 18, 18, 18, 18, 18, 18, 18, 19, 20].map(width => ({ width }));
  styleTitle(sheet, 'EQUIVALENCIA EN MONEDA LOCAL POR COMPAÑÍA Y MONEDA ORIGINAL', 'Q');
  sheet.mergeCells('A2:Q2'); sheet.getCell('A2').value = 'Cada fila conserva la moneda original como dimensión; todos los importes de esta hoja están expresados en la moneda funcional indicada.'; sheet.getCell('A2').font = { italic: true, color: { argb: 'FF607086' } };
  sheet.addRow([]); sheet.addRow([]);
  const header = sheet.addRow(['Subsidiaria', 'Código compañía', 'Compañía relacionada', 'Moneda original', 'Nombre moneda original', 'Moneda funcional', 'Nombre moneda funcional', 'CxC inicial', 'CxP inicial', 'Débitos CxC', 'Créditos CxC', 'Débitos CxP', 'Créditos CxP', 'CxC final', 'CxP final', 'Posición neta', 'Control dimensión']);
  styleHeader(header, 'FF6744A6');
  for (const item of rows) {
    const row = sheet.addRow([item.subsidiaryName, item.relatedCompanyCode || 'SIN-DIMENSIÓN', item.relatedCompanyName, item.originalCurrencyCode, item.originalCurrencyName, item.localCurrencyCode, item.localCurrencyName, item.receivableOpening, item.payableOpening, item.receivableDebits, item.receivableCredits, item.payableDebits, item.payableCredits, item.receivableClosing, item.payableClosing, item.netPosition, item.relatedCompanyId === null ? 'REVISAR DIMENSIÓN' : 'ASIGNADA']);
    styleData(row, 8);
    if (item.relatedCompanyId === null) { row.getCell(2).font = { bold: true, color: { argb: 'FFB42318' } }; row.getCell(17).font = { bold: true, color: { argb: 'FFB42318' } }; }
    if (item.netPosition < 0) row.getCell(16).font = { bold: true, color: { argb: 'FFB42318' } };
  }
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, sheet.rowCount), column: 17 } };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&CEquivalencia local intercompany&R&P de &N';
  return sheet;
}

export async function exportIntercompanyLoansExcel(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), workbook = await createExcelWorkbook();
  workbook.creator = 'GENTIA ERP'; workbook.company = report.metadata.legalName || report.metadata.subsidiary; workbook.created = new Date();
  const summary = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  summary.columns = [{ width: 17 }, { width: 28 }, ...Array.from({ length: 10 }, () => ({ width: 19 }))]; styleTitle(summary, 'GENTIA · PRÉSTAMOS INTERCOMPANY', 'L');
  summary.mergeCells('A2:H2'); summary.getCell('A2').value = report.metadata.legalName || report.metadata.subsidiary; summary.getCell('A2').font = { bold: true, size: 12 };
  summary.mergeCells('I2:L2'); summary.getCell('I2').value = `${dateLabel(report.dateFrom)} al ${dateLabel(report.dateTo)}`; summary.getCell('I2').alignment = { horizontal: 'right' };
  summary.mergeCells('A3:L3'); summary.getCell('A3').value = `${report.metadata.book} · Los importes permanecen separados por moneda; no se suman monedas distintas.`; summary.getCell('A3').font = { italic: true, color: { argb: 'FF607086' } };
  summary.addRow([]); const currencyHeader = summary.addRow(['Moneda', 'Descripción', 'CxC inicial', 'CxP inicial', 'Débitos CxC', 'Créditos CxC', 'Débitos CxP', 'Créditos CxP', 'CxC final', 'CxP final', 'Posición neta']); styleHeader(currencyHeader);
  for (const item of report.currencySummaries) { const row = summary.addRow([item.currencyCode, item.currencyName, item.receivableOpening, item.payableOpening, item.receivableDebits, item.receivableCredits, item.payableDebits, item.payableCredits, item.receivableClosing, item.payableClosing, item.netPosition]); styleData(row, 3); }
  summary.addRow([]); const positionHeader = summary.addRow(['Código compañía', 'Compañía relacionada', 'Moneda', 'CxC inicial', 'CxP inicial', 'Débitos CxC', 'Créditos CxC', 'Débitos CxP', 'Créditos CxP', 'CxC final', 'CxP final', 'Posición neta']); styleHeader(positionHeader, 'FF063B79');
  for (const item of report.netPositions) { const row = summary.addRow([item.relatedCompanyCode || 'SIN-DIMENSIÓN', item.relatedCompanyName, item.currencyCode, item.receivableOpening, item.payableOpening, item.receivableDebits, item.receivableCredits, item.payableDebits, item.payableCredits, item.receivableClosing, item.payableClosing, item.netPosition]); styleData(row, 4); }
  summary.addRow([]); const quality = summary.addRow(['Control de calidad', `${report.quality.unassignedMovementCount} movimiento(s) sin Compañía relacionada`, '', '', '', '', '', '', '', '', '', report.quality.unassignedMovementCount ? 'REVISAR' : 'CORRECTO']); quality.font = { bold: true, color: { argb: report.quality.unassignedMovementCount ? 'FFB42318' : 'FF08775C' } };
  if (report.quality.unassignedPeriodMovementCount) { const row = summary.addRow(['', 'Faltantes del período consultado', report.quality.unassignedPeriodMovementCount, '', '', '', '', '', '', '', '', 'CORREGIR DIMENSIÓN']); row.font = { color: { argb: 'FFB42318' } }; }
  if (report.quality.unassignedOpeningMovementCount) { const row = summary.addRow(['', 'Faltantes provenientes de saldos iniciales', report.quality.unassignedOpeningMovementCount, '', '', '', '', '', '', '', '', 'CORREGIR APERTURA']); row.font = { color: { argb: 'FFB45309' } }; }
  if (report.quality.fxAdjustmentMovementCount) { const row = summary.addRow(['', 'Ajustes de revaluación FX identificados', report.quality.fxAdjustmentMovementCount, '', '', '', '', '', '', '', '', 'INFORMATIVO']); row.font = { color: { argb: 'FF6744A6' } }; }
  summary.addRow([]); const localHeader = summary.addRow(['Subsidiaria', 'Moneda funcional', 'CxC inicial equivalente', 'CxP inicial equivalente', 'Débitos CxC', 'Créditos CxC', 'Débitos CxP', 'Créditos CxP', 'CxC final equivalente', 'CxP final equivalente', 'Posición neta equivalente', '']); styleHeader(localHeader, 'FF6744A6');
  for (const item of report.localCurrencySummaries) { const row = summary.addRow([item.subsidiaryName || report.metadata.subsidiary, item.currencyCode, item.receivableOpening, item.payableOpening, item.receivableDebits, item.receivableCredits, item.payableDebits, item.payableCredits, item.receivableClosing, item.payableClosing, item.netPosition, '']); styleData(row, 3); }
  addAggregateSheet(workbook, 'CxC', 'CUENTAS POR COBRAR COMPAÑÍAS RELACIONADAS', report.receivables, 'FF0B6F63');
  addAggregateSheet(workbook, 'CxP', 'CUENTAS POR PAGAR COMPAÑÍAS RELACIONADAS', report.payables, 'FF9A4B12');
  addLocalPositionsSheet(workbook, report.localPositions);
  const detailSheet = workbook.addWorksheet('Detalle', { views: [{ state: 'frozen', ySplit: 6, xSplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  detailSheet.columns = [14, 17, 18, 17, 30, 14, 18, 30, 16, 32, 13, 14, 15, 15, 15, 18, 14, 15, 15, 15, 20, 18].map(width => ({ width })); styleTitle(detailSheet, 'DETALLE AUDITABLE · PRÉSTAMOS INTERCOMPANY', 'V');
  detailSheet.mergeCells('A2:V2'); detailSheet.getCell('A2').value = 'Importes originales y equivalencia en moneda local, con vínculo al asiento contable e identificación de ajustes FX.'; detailSheet.getCell('A2').font = { italic: true, color: { argb: 'FF607086' } };
  detailSheet.addRow([]); detailSheet.addRow([]); const detailHeader = detailSheet.addRow(['Fecha', 'Tipo', 'Documento', 'Asiento', 'Concepto', 'Sección', 'Cuenta', 'Nombre de cuenta', 'Código compañía', 'Compañía relacionada', 'Identificación', 'Moneda', 'Tasa', 'Débito original', 'Crédito original', 'Saldo acumulado original', 'Moneda local', 'Débito local', 'Crédito local', 'Saldo acumulado local', 'Naturaleza', 'Control']); styleHeader(detailHeader, 'FF063B79');
  for (const item of report.details) { const row = detailSheet.addRow([item.date, item.transactionType, item.transactionNumber, item.journalNumber, item.note || item.memo, item.direction === 'RECEIVABLE' ? 'Por cobrar' : 'Por pagar', item.accountNumber, item.accountName, item.relatedCompanyCode || 'SIN-DIMENSIÓN', item.relatedCompanyName, item.relatedCompanyIdentification, item.currencyCode, item.exchangeRate, item.originalDebit, item.originalCredit, item.originalRunningBalance, item.localCurrencyCode, item.localDebit, item.localCredit, item.localRunningBalance, item.isFxRevaluation ? 'REVALUACIÓN FX' : 'MOVIMIENTO OPERATIVO', item.dimensionAssigned ? 'ASIGNADA' : 'REVISAR DIMENSIÓN']); styleData(row, 13); if (item.isFxRevaluation) row.getCell(21).font = { bold: true, color: { argb: 'FF6744A6' } }; if (!item.dimensionAssigned) row.getCell(22).font = { bold: true, color: { argb: 'FFB42318' } }; }
  detailSheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, detailSheet.rowCount), column: 22 } };
  const bytes = await workbook.xlsx.writeBuffer();
  return { fileName: `prestamos-intercompany-${report.dateTo || 'periodo'}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) };
}
