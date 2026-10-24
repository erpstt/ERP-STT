import type ExcelJS from 'exceljs';
import { createExcelWorkbook } from '../../core/export/excel-workbook.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

type ReportRow = {
  accountId: number | null;
  accountNumber: string;
  accountName: string;
  groupCode: string;
  groupName: string;
  level: number;
  classification: string;
  groupPath: Array<{ id: number | null; code: string; name: string; level: number; category: string }>;
  debit: number;
  credit: number;
  debtorBalance: number;
  creditorBalance: number;
  asset: number;
  liability: number;
  loss: number;
  gain: number;
};

type NumericColumns = Pick<ReportRow, 'debit' | 'credit' | 'debtorBalance' | 'creditorBalance' | 'asset' | 'liability' | 'loss' | 'gain'>;

type NormalizedReport = {
  header: {
    subsidiaryId: number | null;
    subsidiary: string;
    legalName: string;
    taxId: string;
    book: string;
    currencyCode: string;
    currencySymbol: string;
    dateFrom: string;
    dateTo: string;
    detailLevel: number;
    generatedAt: string;
  };
  rows: ReportRow[];
  summary: {
    subtotal: NumericColumns;
    result: NumericColumns;
    finalTotal: NumericColumns;
    checks: {
      debitCredit: number;
      debtorCreditor: number;
      inventoryVsResult: number;
      finalInventory: number;
      finalResults: number;
      balanced: boolean;
    };
    classificationIssues: Array<{ accountNumber: string; accountName: string }>;
  };
  warnings: string[];
};

const numericKeys: Array<keyof NumericColumns> = ['debit', 'credit', 'debtorBalance', 'creditorBalance', 'asset', 'liability', 'loss', 'gain'];
const isExactZero = (value: number) => Math.abs(value) < 0.0000005;

async function rpc<T>(authorization: string, name: string, input: Json = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/rpc/${name}`, config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  const raw = await response.text();
  let payload: unknown = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : 'No fue posible generar el Balance General de 8 Columnas.';
    throw new Error(message);
  }
  return payload as T;
}

export function eightColumnBalanceOptions(authorization: string) {
  return rpc<Json>(authorization, 'eight_column_balance_report_options');
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}

function first(source: Json, ...keys: string[]) {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function string(source: Json, ...keys: string[]) {
  const value = first(source, ...keys);
  return value === undefined || value === null ? '' : String(value);
}

function number(source: Json, ...keys: string[]) {
  const parsed = Number(first(source, ...keys) ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(source: Json, ...keys: string[]) {
  const value = first(source, ...keys);
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function numeric(source: Json): NumericColumns {
  return {
    debit: number(source, 'debit', 'debits', 'debitos'),
    credit: number(source, 'credit', 'credits', 'creditos'),
    debtorBalance: number(source, 'debtorBalance', 'debtor_balance', 'saldoDeudor', 'saldo_deudor'),
    creditorBalance: number(source, 'creditorBalance', 'creditor_balance', 'saldoAcreedor', 'saldo_acreedor'),
    asset: number(source, 'asset', 'activo'),
    liability: number(source, 'liability', 'pasivo'),
    loss: number(source, 'loss', 'perdida', 'expense'),
    gain: number(source, 'gain', 'ganancia', 'income')
  };
}

function sumRows(rows: ReportRow[]): NumericColumns {
  const total = emptyNumeric();
  for (const row of rows) for (const key of numericKeys) total[key] += row[key];
  return total;
}

function emptyNumeric(): NumericColumns {
  return { debit: 0, credit: 0, debtorBalance: 0, creditorBalance: 0, asset: 0, liability: 0, loss: 0, gain: 0 };
}

function normalizeRow(source: Json): ReportRow {
  const id = first(source, 'accountId', 'account_id');
  const rawPath = first(source, 'groupPath', 'group_path');
  return {
    accountId: id === undefined || id === null || id === '' ? null : Number(id),
    accountNumber: string(source, 'accountNumber', 'account_number', 'code', 'codigo'),
    accountName: string(source, 'accountName', 'account_name', 'name', 'nombre'),
    groupCode: string(source, 'groupCode', 'group_code'),
    groupName: string(source, 'groupName', 'group_name'),
    level: number(source, 'level', 'detailLevel', 'detail_level') || 4,
    classification: string(source, 'classification', 'balanceType', 'balance_type', 'category', 'categoria') || 'SIN_CLASIFICAR',
    groupPath: Array.isArray(rawPath) ? rawPath.map(item => {
      const group = object(item), groupId = first(group, 'id', 'groupId', 'group_id');
      return { id: groupId == null ? null : Number(groupId), code: string(group, 'code', 'groupCode', 'group_code'), name: string(group, 'name', 'groupName', 'group_name'), level: number(group, 'level'), category: string(group, 'category', 'categoria') };
    }) : [],
    ...numeric(source)
  };
}

function classificationFor(category: string, fallback: string) {
  const normalized = category.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (normalized === 'ACTIVO') return 'ACTIVO';
  if (normalized === 'PASIVO' || normalized === 'PATRIMONIO') return 'PASIVO';
  if (normalized === 'COSTO' || normalized === 'GASTO') return 'PERDIDA';
  if (normalized === 'INGRESO') return 'GANANCIA';
  return fallback;
}

function aggregateAtLevel(rows: ReportRow[], level: number): ReportRow[] {
  if (level >= 4) return rows;
  const groups = new Map<string, ReportRow>();
  for (const row of rows) {
    const path = [...row.groupPath].sort((a, b) => a.level - b.level);
    const group = path.find(item => item.level === level) ?? path.filter(item => item.level <= level).at(-1) ?? path[0];
    const code = group?.code || row.groupCode || row.accountNumber, baseName = group?.name || row.groupName || row.accountName;
    const groupClassification = classificationFor(group?.category || '', ''), classification = row.classification;
    const name = groupClassification === classification ? baseName : `${baseName} · ${classification.replaceAll('_', ' ')}`;
    const key = `${String(group?.id ?? `${level}:${code}`)}:${classification}`, existing = groups.get(key) ?? {
      accountId: null, accountNumber: code, accountName: name, groupCode: code, groupName: name, level,
      classification, groupPath: path, ...emptyNumeric()
    };
    for (const numericKey of numericKeys) existing[numericKey] += row[numericKey];
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber, 'es', { numeric: true }));
}

function normalizeIssues(value: unknown, rows: ReportRow[]) {
  const values = Array.isArray(value) ? value.map(object).map(issue => ({
    accountNumber: string(issue, 'accountNumber', 'account_number', 'code'),
    accountName: string(issue, 'accountName', 'account_name', 'name')
  })) : [];
  if (values.length) return values;
  return rows.filter(row => /SIN[_ ]?CLASIFICAR|UNCLASSIFIED/i.test(row.classification)).map(row => ({ accountNumber: row.accountNumber, accountName: row.accountName }));
}

export function normalizeEightColumnBalanceReport(payload: unknown): NormalizedReport {
  const root = object(payload), rawHeader = object(first(root, 'header', 'encabezado')), rawSummary = object(first(root, 'summary', 'resumen'));
  const rows = (Array.isArray(first(root, 'rows', 'data', 'lines')) ? first(root, 'rows', 'data', 'lines') as unknown[] : []).map(item => normalizeRow(object(item)));
  const rawSubtotal = object(first(rawSummary, 'subtotal', 'subtotals', 'totals', 'subtotal_general'));
  const rawResult = object(first(rawSummary, 'resultRow', 'result_row', 'result', 'exerciseResultRow', 'exercise_result_row', 'resultado'));
  const rawFinal = object(first(rawSummary, 'equalized', 'finalTotal', 'final_total', 'equalizedTotal', 'equalized_total', 'totalesIguales', 'totales_iguales'));
  const subtotal = Object.keys(rawSubtotal).length ? numeric(rawSubtotal) : first(rawSummary, 'debit', 'debits', 'debitos') !== undefined ? numeric(rawSummary) : sumRows(rows);
  const profit = subtotal.gain - subtotal.loss;
  const fallbackResult = emptyNumeric();
  if (profit >= 0) { fallbackResult.liability = profit; fallbackResult.loss = profit; }
  else { fallbackResult.asset = -profit; fallbackResult.gain = -profit; }
  const result = Object.keys(rawResult).length ? numeric(rawResult) : fallbackResult;
  const fallbackFinal = emptyNumeric();
  for (const key of numericKeys) fallbackFinal[key] = subtotal[key] + result[key];
  const parsedFinal = numeric(rawFinal), finalTotal = { ...fallbackFinal };
  if (Object.keys(rawFinal).length) {
    const aliases: Record<keyof NumericColumns, string[]> = {
      debit: ['debit', 'debits', 'debitos'], credit: ['credit', 'credits', 'creditos'],
      debtorBalance: ['debtorBalance', 'debtor_balance', 'saldoDeudor', 'saldo_deudor'], creditorBalance: ['creditorBalance', 'creditor_balance', 'saldoAcreedor', 'saldo_acreedor'],
      asset: ['asset', 'activo'], liability: ['liability', 'pasivo'], loss: ['loss', 'perdida', 'expense'], gain: ['gain', 'ganancia', 'income']
    };
    for (const key of numericKeys) if (first(rawFinal, ...aliases[key]) !== undefined) finalTotal[key] = parsedFinal[key];
  }
  const rawChecks = object(first(rawSummary, 'checks', 'validations', 'cuadratura') ?? first(root, 'checks', 'validations'));
  const debitCredit = first(rawChecks, 'debitCredit', 'debit_credit', 'debitCreditDifference', 'debit_credit_difference') !== undefined ? number(rawChecks, 'debitCredit', 'debit_credit', 'debitCreditDifference', 'debit_credit_difference') : subtotal.debit - subtotal.credit;
  const debtorCreditor = first(rawChecks, 'debtorCreditor', 'debtor_creditor', 'balanceDifference', 'balance_difference') !== undefined ? number(rawChecks, 'debtorCreditor', 'debtor_creditor', 'balanceDifference', 'balance_difference') : subtotal.debtorBalance - subtotal.creditorBalance;
  const inventoryVsResult = first(rawChecks, 'inventoryVsResult', 'inventory_vs_result', 'crossDifference', 'cross_difference') !== undefined
    ? number(rawChecks, 'inventoryVsResult', 'inventory_vs_result', 'crossDifference', 'cross_difference')
    : first(rawSummary, 'inventoryDifference', 'inventory_difference') !== undefined || first(rawSummary, 'resultDifference', 'result_difference') !== undefined
      ? number(rawSummary, 'inventoryDifference', 'inventory_difference') - number(rawSummary, 'resultDifference', 'result_difference')
      : (subtotal.asset - subtotal.liability) - (subtotal.gain - subtotal.loss);
  const finalInventory = first(rawChecks, 'finalInventory', 'final_inventory') !== undefined ? number(rawChecks, 'finalInventory', 'final_inventory') : finalTotal.asset - finalTotal.liability;
  const finalResults = first(rawChecks, 'finalResults', 'final_results') !== undefined ? number(rawChecks, 'finalResults', 'final_results') : finalTotal.loss - finalTotal.gain;
  const classificationIssues = normalizeIssues(first(rawSummary, 'classificationIssues', 'classification_issues', 'unclassifiedAccounts', 'unclassified_accounts') ?? first(root, 'classificationIssues', 'classification_issues'), rows);
  const calculatedBalanced = [debitCredit, debtorCreditor, inventoryVsResult, finalInventory, finalResults].every(isExactZero) && classificationIssues.length === 0;
  const suppliedBalanced = first(rawChecks, 'allBalanced', 'all_balanced', 'balanced', 'isBalanced', 'is_balanced');
  const rawWarnings = first(root, 'warnings', 'advertencias') ?? first(rawSummary, 'warnings', 'advertencias');
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.map(String) : [];
  return {
    header: {
      subsidiaryId: first(rawHeader, 'subsidiaryId', 'subsidiary_id') == null ? null : number(rawHeader, 'subsidiaryId', 'subsidiary_id'),
      subsidiary: string(rawHeader, 'subsidiary', 'subsidiaryName', 'subsidiary_name', 'company'),
      legalName: string(rawHeader, 'legalName', 'legal_name') || string(rawHeader, 'subsidiary', 'subsidiaryName', 'subsidiary_name', 'company'),
      taxId: string(rawHeader, 'taxId', 'tax_id', 'identification', 'rut'),
      book: string(rawHeader, 'book', 'bookName', 'book_name'),
      currencyCode: string(rawHeader, 'currencyCode', 'currency_code', 'currency') || 'MONEDA LOCAL',
      currencySymbol: string(rawHeader, 'currencySymbol', 'currency_symbol', 'symbol'),
      dateFrom: string(rawHeader, 'dateFrom', 'date_from', 'fechaInicio', 'fecha_inicio'),
      dateTo: string(rawHeader, 'dateTo', 'date_to', 'fechaFin', 'fecha_fin'),
      detailLevel: number(rawHeader, 'detailLevel', 'detail_level', 'hierarchy') || 4,
      generatedAt: string(rawHeader, 'generatedAt', 'generated_at') || new Date().toISOString()
    },
    rows,
    summary: {
      subtotal,
      result,
      finalTotal,
      checks: { debitCredit, debtorCreditor, inventoryVsResult, finalInventory, finalResults, balanced: calculatedBalanced && (suppliedBalanced === undefined || boolean(rawChecks, 'allBalanced', 'all_balanced', 'balanced', 'isBalanced', 'is_balanced')) },
      classificationIssues
    },
    warnings
  };
}

export async function runEightColumnBalanceReport(authorization: string, filters: Json) {
  const payload = await rpc<Json>(authorization, 'run_eight_column_balance_report', { p_filters: filters });
  const report = normalizeEightColumnBalanceReport(payload), requested = Number(first(filters, 'detailLevel', 'detail_level', 'hierarchy') ?? 4), level = Number.isInteger(requested) ? Math.min(4, Math.max(1, requested)) : 4;
  report.header.detailLevel = level;
  report.rows = aggregateAtLevel(report.rows, level);
  return report;
}

function money(value: number, symbol: string) {
  const formatted = Math.abs(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `(${symbol} ${formatted})` : `${symbol} ${formatted}`;
}

function dateLabel(value: string) {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function pdfHtml(report: NormalizedReport) {
  const { header: h, summary: s } = report, symbol = escapeHtml(h.currencySymbol || h.currencyCode), cells = (values: NumericColumns) => numericKeys.map(key => `<td class="n">${escapeHtml(money(values[key], symbol))}</td>`).join('');
  const rows = report.rows.map(row => `<tr><td class="code">${escapeHtml(row.accountNumber)}</td><td>${escapeHtml(row.accountName)}<small>${escapeHtml(row.classification.replaceAll('_', ' '))}</small></td>${cells(row)}</tr>`).join('');
  const controlDifference = (difference: number) => Math.abs(difference) < .005 && !isExactZero(difference) ? `${symbol} ${difference.toLocaleString('es-CR', { minimumFractionDigits: 6, maximumFractionDigits: 6 })}` : money(difference, symbol);
  const control = (label: string, difference: number) => `<div class="control ${isExactZero(difference) ? 'ok' : 'bad'}"><span>${escapeHtml(label)}</span><b>${isExactZero(difference) ? 'Cuadrado exacto' : `Diferencia ${escapeHtml(controlDifference(difference))}`}</b></div>`;
  const issues = s.classificationIssues.length ? `<section class="warning"><b>${s.classificationIssues.length} cuenta(s) sin clasificación contable.</b><span>${escapeHtml(s.classificationIssues.map(item => `${item.accountNumber} ${item.accountName}`).join(' · '))}</span></section>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
  @page{size:A4 landscape;margin:10mm 8mm 12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#14233b;margin:0;font-size:8px}header{display:flex;justify-content:space-between;border-bottom:3px solid #ef6c30;padding-bottom:8px;margin-bottom:8px}.brand{font-size:18px;font-weight:800;letter-spacing:2px;color:#063b79}h1{font-size:16px;margin:4px 0}.meta{text-align:right;line-height:1.5}.controls{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.control{border:1px solid #d9e2ec;border-left:4px solid #0b8b69;border-radius:5px;padding:5px 7px}.control.bad{border-left-color:#c43832;background:#fff5f4}.control span{display:block;color:#607086}.control b{font-size:9px}.warning{background:#fff5e8;border:1px solid #f5c979;padding:6px;margin:7px 0;display:flex;gap:8px}table{border-collapse:collapse;width:100%;table-layout:fixed}thead{display:table-header-group}th,td{border:1px solid #d9e2ec;padding:4px}th{background:#063b79;color:#fff;text-align:center;font-size:7px}.band th{background:#0b6f63}.code{width:8%;font-weight:700}td:nth-child(2){width:24%}.n{text-align:right;font-variant-numeric:tabular-nums}small{display:block;color:#718096;margin-top:2px}.subtotal td{font-weight:700;background:#eaf1f7}.result td{font-weight:700;background:#fff3e8}.final td{font-weight:800;background:#dff3ec;border-top:2px solid #0b8b69}.status{font-weight:800;color:${s.checks.balanced ? '#08775c' : '#b42318'}}footer{margin-top:7px;display:flex;justify-content:space-between;color:#718096}</style></head><body>
  <header><div><div class="brand">GENTIA</div><h1>Balance General de 8 Columnas</h1><div>${escapeHtml(h.legalName || h.subsidiary)} · ID fiscal: ${escapeHtml(h.taxId || 'No registrado')}</div></div><div class="meta"><b>${escapeHtml(h.book)}</b><br>${dateLabel(h.dateFrom)} al ${dateLabel(h.dateTo)}<br>${escapeHtml(h.currencyCode)} · Moneda local</div></header>
  <div class="controls">${control('Partida doble', s.checks.debitCredit)}${control('Saldos deudor / acreedor', s.checks.debtorCreditor)}${control('Inventario vs. resultado', s.checks.inventoryVsResult)}${control('Totales finales', Math.max(Math.abs(s.checks.finalInventory), Math.abs(s.checks.finalResults)))}</div>${issues}
  <table><thead><tr><th rowspan="2">Código</th><th rowspan="2">Cuenta contable</th><th colspan="2">Sumas del Mayor</th><th colspan="2">Saldos</th><th colspan="2">Inventario</th><th colspan="2">Resultado</th></tr><tr class="band"><th>Débitos</th><th>Créditos</th><th>Deudor</th><th>Acreedor</th><th>Activo</th><th>Pasivo</th><th>Pérdida</th><th>Ganancia</th></tr></thead><tbody>${rows || '<tr><td colspan="10">No hay cuentas para los filtros seleccionados.</td></tr>'}<tr class="subtotal"><td colspan="2">SUBTOTALES</td>${cells(s.subtotal)}</tr><tr class="result"><td colspan="2">RESULTADO DEL EJERCICIO</td>${cells(s.result)}</tr><tr class="final"><td colspan="2">TOTALES IGUALES</td>${cells(s.finalTotal)}</tr></tbody></table>
  <footer><span class="status">${s.checks.balanced ? 'BALANCE CUADRADO AL CENTAVO' : 'REPORTE CON DIFERENCIAS POR REVISAR'}</span><span>Generado ${new Date(h.generatedAt).toLocaleString('es-CR')}</span></footer></body></html>`;
}

export function eightColumnBalancePdfHtml(payload: unknown) {
  return pdfHtml(normalizeEightColumnBalanceReport(payload));
}

export async function buildEightColumnBalancePdf(report: NormalizedReport): Promise<ExportFile> {
  const rendered = await renderBankReconciliationPdf({ html: pdfHtml(report), fileName: `balance-general-8-columnas-${report.header.dateTo}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

export async function exportEightColumnBalancePdf(authorization: string, filters: Json): Promise<ExportFile> {
  return buildEightColumnBalancePdf(await runEightColumnBalanceReport(authorization, filters));
}

function border(color = 'D7E1EA'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function styleNumericRow(row: ExcelJS.Row, numFmt: string) {
  for (let column = 3; column <= 10; column++) {
    const cell = row.getCell(column); cell.numFmt = numFmt; cell.alignment = { horizontal: 'right' }; cell.border = border();
  }
  row.getCell(1).border = border(); row.getCell(2).border = border();
}

export async function buildEightColumnBalanceExcel(report: NormalizedReport): Promise<ExportFile> {
  const { header: h, summary: s } = report;
  const workbook = await createExcelWorkbook(); workbook.creator = 'GENTIA ERP'; workbook.company = h.legalName || h.subsidiary; workbook.created = new Date();
  const sheet = workbook.addWorksheet('Balance 8 columnas', { views: [{ state: 'frozen', xSplit: 2, ySplit: 7 }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .25, right: .25, top: .5, bottom: .5, header: .2, footer: .2 } } });
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&C&P de &N&RBalance General de 8 Columnas';
  sheet.columns = [{ width: 15 }, { width: 38 }, ...Array.from({ length: 8 }, () => ({ width: 17 }))];
  sheet.mergeCells('A1:J1'); const title = sheet.getCell('A1'); title.value = 'GENTIA · BALANCE GENERAL DE 8 COLUMNAS'; title.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }; title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; title.alignment = { vertical: 'middle' }; sheet.getRow(1).height = 34;
  sheet.mergeCells('A2:F2'); sheet.getCell('A2').value = h.legalName || h.subsidiary; sheet.getCell('A2').font = { bold: true, size: 13, color: { argb: 'FF14233B' } };
  sheet.mergeCells('G2:J2'); sheet.getCell('G2').value = `ID fiscal: ${h.taxId || 'No registrado'}`; sheet.getCell('G2').alignment = { horizontal: 'right' };
  sheet.mergeCells('A3:F3'); sheet.getCell('A3').value = `Libro: ${h.book}`;
  sheet.mergeCells('G3:J3'); sheet.getCell('G3').value = `${dateLabel(h.dateFrom)} al ${dateLabel(h.dateTo)}`; sheet.getCell('G3').alignment = { horizontal: 'right' };
  sheet.mergeCells('A4:J4'); sheet.getCell('A4').value = `Moneda: ${h.currencyCode} · importes expresados en moneda local`; sheet.getCell('A4').font = { italic: true, color: { argb: 'FF607086' } };
  sheet.mergeCells('A6:A7'); sheet.mergeCells('B6:B7'); sheet.mergeCells('C6:D6'); sheet.mergeCells('E6:F6'); sheet.mergeCells('G6:H6'); sheet.mergeCells('I6:J6');
  [['A6','Código'],['B6','Cuenta contable'],['C6','Sumas del Mayor'],['E6','Saldos'],['G6','Inventario'],['I6','Resultado']].forEach(([cell, value]) => { sheet.getCell(cell).value = value; });
  ['Débitos','Créditos','Deudor','Acreedor','Activo','Pasivo','Pérdida','Ganancia'].forEach((value, index) => { sheet.getCell(7, index + 3).value = value; });
  for (let rowNumber = 6; rowNumber <= 7; rowNumber++) sheet.getRow(rowNumber).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNumber === 6 ? 'FF063B79' : 'FF0B6F63' } }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = border('FFFFFF'); });
  const start = 8, numFmt = `"${h.currencySymbol || h.currencyCode}" #,##0.00;[Red]("${h.currencySymbol || h.currencyCode}" #,##0.00);-`;
  for (const item of report.rows) {
    const row = sheet.addRow([item.accountNumber, item.accountName, ...numericKeys.map(key => item[key])]);
    styleNumericRow(row, numFmt); row.getCell(1).font = { bold: true, color: { argb: 'FF063B79' } };
  }
  const end = sheet.rowCount, subtotalRow = sheet.addRow(['', 'SUBTOTALES']);
  for (let column = 3; column <= 10; column++) subtotalRow.getCell(column).value = report.rows.length
    ? { formula: `SUM(${sheet.getColumn(column).letter}${start}:${sheet.getColumn(column).letter}${end})`, result: s.subtotal[numericKeys[column - 3]] }
    : s.subtotal[numericKeys[column - 3]];
  subtotalRow.font = { bold: true, color: { argb: 'FF14233B' } }; subtotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F7' } }; styleNumericRow(subtotalRow, numFmt);
  const resultRow = sheet.addRow(['', 'RESULTADO DEL EJERCICIO', 0, 0, 0, 0, 0, 0, 0, 0]);
  resultRow.getCell(7).value = { formula: `MAX(I${subtotalRow.number}-J${subtotalRow.number},0)`, result: s.result.asset };
  resultRow.getCell(8).value = { formula: `MAX(J${subtotalRow.number}-I${subtotalRow.number},0)`, result: s.result.liability };
  resultRow.getCell(9).value = { formula: `MAX(J${subtotalRow.number}-I${subtotalRow.number},0)`, result: s.result.loss };
  resultRow.getCell(10).value = { formula: `MAX(I${subtotalRow.number}-J${subtotalRow.number},0)`, result: s.result.gain };
  resultRow.font = { bold: true, color: { argb: 'FF9A4B12' } }; resultRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E8' } }; styleNumericRow(resultRow, numFmt);
  const finalRow = sheet.addRow(['', 'TOTALES IGUALES']);
  for (let column = 3; column <= 10; column++) finalRow.getCell(column).value = { formula: `${sheet.getColumn(column).letter}${subtotalRow.number}+${sheet.getColumn(column).letter}${resultRow.number}`, result: s.finalTotal[numericKeys[column - 3]] };
  finalRow.font = { bold: true, color: { argb: 'FF08654D' } }; finalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDFF3EC' } }; styleNumericRow(finalRow, numFmt); finalRow.height = 24;
  sheet.autoFilter = { from: { row: 7, column: 1 }, to: { row: Math.max(7, end), column: 10 } };
  sheet.getColumn(2).alignment = { wrapText: true, vertical: 'middle' };
  const validations = workbook.addWorksheet('Validaciones', { views: [{ state: 'frozen', ySplit: 5 }] }); validations.columns = [{ width: 34 }, { width: 20 }, { width: 54 }];
  validations.mergeCells('A1:C1'); validations.getCell('A1').value = 'VALIDACIONES DE CUADRATURA'; validations.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }; validations.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  validations.addRow([]); const vh = validations.addRow(['Control', 'Diferencia', 'Estado']); vh.font = { bold: true, color: { argb: 'FFFFFFFF' } }; vh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6F63' } };
  const checkRows: Array<[string, number]> = [['Débitos vs. créditos',s.checks.debitCredit],['Saldo deudor vs. acreedor',s.checks.debtorCreditor],['Inventario vs. resultado',s.checks.inventoryVsResult],['Activo final vs. pasivo final',s.checks.finalInventory],['Pérdida final vs. ganancia final',s.checks.finalResults]];
  for (const [label, difference] of checkRows) { const row = validations.addRow([label, difference, isExactZero(difference) ? 'CUADRADO EXACTO' : 'REVISAR']); row.getCell(2).numFmt = Math.abs(difference) < .005 && !isExactZero(difference) ? '0.000000' : numFmt; row.getCell(3).font = { bold: true, color: { argb: isExactZero(difference) ? 'FF08654D' : 'FFB42318' } }; }
  validations.addRow([]); validations.addRow(['Cuentas sin clasificación', s.classificationIssues.length, s.classificationIssues.length ? 'Impiden certificar el balance' : 'Sin incidencias']).font = { bold: true };
  for (const issue of s.classificationIssues) validations.addRow([issue.accountNumber, '', issue.accountName]);
  const bytes = await workbook.xlsx.writeBuffer();
  return { fileName: `balance-general-8-columnas-${h.dateTo}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) };
}

export async function exportEightColumnBalanceExcel(authorization: string, filters: Json): Promise<ExportFile> {
  return buildEightColumnBalanceExcel(await runEightColumnBalanceReport(authorization, filters));
}
