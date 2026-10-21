import ExcelJS from 'exceljs';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';
import { assetCategoryReport } from './asset-category.service.js';

type Json = Record<string, unknown>;
export type AssetCategoryExportFormat = 'csv' | 'xlsx' | 'pdf';
export type AssetCategoryExportFilters = { status: string; search: string };
export type AssetCategoryExportRow = {
  code: string;
  name: string;
  description: string;
  usefulLifeMonths: string;
  method: string;
  residualPercentage: number;
  assetAccount: string;
  depreciationAccount: string;
  expenseAccount: string;
  linkedAssets: number;
  status: string;
};
export type AssetCategoryExportPayload = {
  header: {
    subsidiary: string;
    status: string;
    search: string;
    generatedAt: string;
  };
  rows: AssetCategoryExportRow[];
  totals: { count: number; active: number; inactive: number; linkedAssets: number };
};
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };
type ExportColumn = {
  key: keyof AssetCategoryExportRow;
  header: string;
  width: number;
  kind: 'text' | 'integer' | 'percentage';
};

export const ASSET_CATEGORY_EXPORT_COLUMNS: readonly ExportColumn[] = [
  { key: 'code', header: 'Código', width: 18, kind: 'text' },
  { key: 'name', header: 'Categoría', width: 30, kind: 'text' },
  { key: 'description', header: 'Descripción', width: 36, kind: 'text' },
  { key: 'usefulLifeMonths', header: 'Vida útil (meses)', width: 18, kind: 'text' },
  { key: 'method', header: 'Método de depreciación', width: 27, kind: 'text' },
  { key: 'residualPercentage', header: 'Valor residual (%)', width: 19, kind: 'percentage' },
  { key: 'assetAccount', header: 'Cuenta de activo', width: 34, kind: 'text' },
  { key: 'depreciationAccount', header: 'Depreciación acumulada', width: 36, kind: 'text' },
  { key: 'expenseAccount', header: 'Gasto por depreciación', width: 36, kind: 'text' },
  { key: 'linkedAssets', header: 'Activos vinculados', width: 18, kind: 'integer' },
  { key: 'status', header: 'Estado', width: 14, kind: 'text' },
];

const text = (value: unknown) => String(value ?? '');
const number = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value: unknown) => Math.max(0, Math.trunc(number(value)));
const spreadsheetText = (value: unknown) => {
  const result = text(value);
  return /^\s*[=+@-]/.test(result) ? `'${result}` : result;
};
const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
const escapeHtml = (value: unknown) => text(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character] || character));

function normalizeFilters(input: Record<string, unknown>): AssetCategoryExportFilters {
  const status = text(input.status || 'ALL').trim().toUpperCase() || 'ALL';
  if (!['ALL', 'ACTIVE', 'INACTIVE'].includes(status)) {
    throw new Error('Seleccione un estado válido para exportar las categorías de activos.');
  }
  const search = text(input.search).trim();
  if (search.length > 200) throw new Error('La búsqueda no puede superar 200 caracteres.');
  return { status, search };
}

function displayValue(column: ExportColumn, row: AssetCategoryExportRow, protectSpreadsheet = false): string | number {
  const value = row[column.key];
  if (column.kind !== 'text') return number(value);
  return protectSpreadsheet ? spreadsheetText(value) : text(value);
}

function statusLabel(status: string) {
  if (status === 'ACTIVE') return 'Activas';
  if (status === 'INACTIVE') return 'Inactivas';
  return 'Todas';
}

function generatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('es-CR', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Costa_Rica'
  });
}

function filterLabel(payload: AssetCategoryExportPayload) {
  const filters = [`Estado: ${statusLabel(payload.header.status)}`];
  if (payload.header.search) filters.push(`Búsqueda: “${payload.header.search}”`);
  return filters.join(' · ');
}

export function buildAssetCategoryCsv(rows: AssetCategoryExportRow[]): Buffer {
  const matrix: Array<Array<string | number>> = [
    ASSET_CATEGORY_EXPORT_COLUMNS.map(column => column.header),
    ...rows.map(row => ASSET_CATEGORY_EXPORT_COLUMNS.map(column => displayValue(column, row, true))),
  ];
  return Buffer.from(`\uFEFF${matrix.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'utf8');
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: `FF${color}` } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

export async function buildAssetCategoryExcel(payload: AssetCategoryExportPayload): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = payload.header.subsidiary || 'GENTIA';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'Catálogo de categorías de activos';

  const sheet = workbook.addWorksheet('Categorías de activos', {
    views: [{ state: 'frozen', ySplit: 6, activeCell: 'A7' }],
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: .2, right: .2, top: .45, bottom: .45, header: .2, footer: .2 }
    },
    properties: { defaultRowHeight: 20 }
  });
  sheet.properties.tabColor = { argb: 'FF0D9272' };
  ASSET_CATEGORY_EXPORT_COLUMNS.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });
  const lastColumn = ASSET_CATEGORY_EXPORT_COLUMNS.length;

  sheet.mergeCells(1, 1, 1, lastColumn);
  const title = sheet.getCell(1, 1);
  title.value = 'GENTIA · CATEGORÍAS DE ACTIVOS';
  title.font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, lastColumn);
  const company = sheet.getCell(2, 1);
  company.value = `Subsidiaria: ${payload.header.subsidiary}`;
  company.font = { name: 'Aptos', size: 11, bold: true, color: { argb: 'FF15375F' } };
  company.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F6EF' } };
  company.alignment = { vertical: 'middle' };
  sheet.getRow(2).height = 25;

  sheet.mergeCells(3, 1, 3, lastColumn);
  const filters = sheet.getCell(3, 1);
  filters.value = `${filterLabel(payload)} · Generado ${generatedLabel(payload.header.generatedAt)}`;
  filters.font = { name: 'Aptos', size: 10, color: { argb: 'FF52657D' } };
  filters.alignment = { vertical: 'middle' };
  sheet.getRow(3).height = 23;

  sheet.mergeCells(4, 1, 4, lastColumn);
  const totals = sheet.getCell(4, 1);
  totals.value = `${payload.totals.count.toLocaleString('es-CR')} categorías · ${payload.totals.active.toLocaleString('es-CR')} activas · ${payload.totals.inactive.toLocaleString('es-CR')} inactivas · ${payload.totals.linkedAssets.toLocaleString('es-CR')} activos vinculados`;
  totals.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FF0B6F55' } };
  totals.alignment = { vertical: 'middle' };
  sheet.getRow(4).height = 23;

  const header = sheet.getRow(6);
  ASSET_CATEGORY_EXPORT_COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10845F' } };
    cell.alignment = { vertical: 'middle', horizontal: column.kind === 'text' ? 'left' : 'right', wrapText: true };
    cell.border = border('10845F');
  });
  header.height = 31;

  payload.rows.forEach((item, rowIndex) => {
    const row = sheet.getRow(rowIndex + 7);
    ASSET_CATEGORY_EXPORT_COLUMNS.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = displayValue(column, item, true);
      cell.border = border();
      cell.alignment = { vertical: 'top', horizontal: column.kind === 'text' ? 'left' : 'right', wrapText: true };
      if (column.kind === 'integer') cell.numFmt = '#,##0';
      if (column.kind === 'percentage') cell.numFmt = '0.00"%"';
      if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
    });
    const wrappedLines = Math.max(1, Math.ceil(item.name.length / 35), Math.ceil(item.description.length / 44));
    row.height = Math.min(72, Math.max(24, wrappedLines * 14 + 6));
  });
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: lastColumn } };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&CInformación confidencial&RPágina &P de &N';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pdfValue(column: ExportColumn, row: AssetCategoryExportRow) {
  const value = displayValue(column, row);
  if (column.kind === 'integer') return number(value).toLocaleString('es-CR', { maximumFractionDigits: 0 });
  if (column.kind === 'percentage') return `${number(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  return text(value) || '—';
}

export function buildAssetCategoryPdfHtml(payload: AssetCategoryExportPayload): string {
  const tableRows = payload.rows.map(row => `<tr>${ASSET_CATEGORY_EXPORT_COLUMNS.map(column => (
    `<td class="${column.kind === 'text' ? '' : 'number'}">${escapeHtml(pdfValue(column, row))}</td>`
  )).join('')}</tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Categorías de activos</title><style>
  @page{size:A3 landscape;margin:9mm 7mm 14mm}*{box-sizing:border-box}body{font:7pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.company{margin-top:4px;color:#4f6178}.title{text-align:right}.title h1{font-size:16pt;margin:0;color:#063b79;text-transform:uppercase}.title p{margin:3px 0;color:#63738a}.filters{margin:8px 0;color:#53657b}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:8px 0}.metric{border:1px solid #d7e2ec;border-radius:7px;padding:6px 8px;background:#f7fafc}.metric small,.metric b{display:block}.metric small{color:#65758a}.metric b{font-size:10pt;margin-top:2px;color:#0b6f55}table{width:100%;border-collapse:collapse;table-layout:auto}thead{display:table-header-group}th{background:#063b79;color:#fff;padding:5px 4px;text-align:left;vertical-align:bottom;overflow-wrap:anywhere}td{border-bottom:1px solid #dbe4ed;padding:4px;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f6f8fb}tr{page-break-inside:avoid}.number{text-align:right;white-space:nowrap}.empty{text-align:center;padding:35px;color:#64748b}.footer{position:fixed;bottom:-10mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;display:flex;justify-content:space-between}
  </style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${escapeHtml(payload.header.subsidiary)}</b><br>Subsidiaria activa</div></div><div class="title"><h1>Categorías de activos</h1><p>Políticas contables y parámetros de depreciación</p><p>Generado ${escapeHtml(generatedLabel(payload.header.generatedAt))}</p></div></header><div class="filters">${escapeHtml(filterLabel(payload))}</div><section class="summary"><div class="metric"><small>Total de categorías</small><b>${payload.totals.count.toLocaleString('es-CR')}</b></div><div class="metric"><small>Activas</small><b>${payload.totals.active.toLocaleString('es-CR')}</b></div><div class="metric"><small>Inactivas</small><b>${payload.totals.inactive.toLocaleString('es-CR')}</b></div><div class="metric"><small>Activos vinculados</small><b>${payload.totals.linkedAssets.toLocaleString('es-CR')}</b></div></section><table><thead><tr>${ASSET_CATEGORY_EXPORT_COLUMNS.map(column => `<th>${escapeHtml(column.header)}</th>`).join('')}</tr></thead><tbody>${tableRows || `<tr><td colspan="${ASSET_CATEGORY_EXPORT_COLUMNS.length}" class="empty">No hay categorías que coincidan con los filtros seleccionados.</td></tr>`}</tbody></table><div class="footer"><span>GENTIA · Activos Fijos</span><span>Categorías de activos · Información confidencial</span></div></body></html>`;
}

export async function loadAssetCategoryExportData(
  authorization: string,
  input: Record<string, unknown>
): Promise<AssetCategoryExportPayload> {
  const filters = normalizeFilters(input);
  const report = (await assetCategoryReport(authorization, filters) ?? {}) as Json;
  const subsidiary = (report.subsidiary ?? {}) as Json;
  const sourceRows = Array.isArray(report.rows) ? report.rows as Json[] : [];
  const rows: AssetCategoryExportRow[] = sourceRows.map(row => ({
    code: text(row.code),
    name: text(row.name),
    description: text(row.description),
    usefulLifeMonths: text(row.method) === 'No Depreciable' ? 'No aplica' : String(integer(row.usefulLife)),
    method: text(row.method),
    residualPercentage: number(row.residual),
    assetAccount: text(row.assetAccount),
    depreciationAccount: text(row.depreciationAccount),
    expenseAccount: text(row.expenseAccount) || 'No aplica',
    linkedAssets: integer(row.assets),
    status: row.active === true ? 'ACTIVA' : 'INACTIVA',
  }));
  const totals = rows.reduce((result, row) => ({
    count: result.count + 1,
    active: result.active + (row.status === 'ACTIVA' ? 1 : 0),
    inactive: result.inactive + (row.status === 'INACTIVA' ? 1 : 0),
    linkedAssets: result.linkedAssets + row.linkedAssets,
  }), { count: 0, active: 0, inactive: 0, linkedAssets: 0 });
  return {
    header: {
      subsidiary: text(subsidiary.name) || 'Subsidiaria activa',
      status: filters.status,
      search: filters.search,
      generatedAt: new Date().toISOString(),
    },
    rows,
    totals,
  };
}

function fileSlug(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'subsidiaria';
}

function localDateStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function exportAssetCategories(
  authorization: string,
  formatValue: string,
  input: Record<string, unknown>
): Promise<ExportFile> {
  const rawFormat = formatValue.toLowerCase();
  const format: AssetCategoryExportFormat = rawFormat === 'excel' ? 'xlsx' : rawFormat as AssetCategoryExportFormat;
  if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new Error('Seleccione un formato CSV, Excel o PDF válido.');
  const payload = await loadAssetCategoryExportData(authorization, input);
  const baseName = `categorias-de-activos-${fileSlug(payload.header.subsidiary)}-${localDateStamp()}`;
  if (format === 'csv') {
    return { fileName: `${baseName}.csv`, mimeType: 'text/csv; charset=utf-8', buffer: buildAssetCategoryCsv(payload.rows) };
  }
  if (format === 'xlsx') {
    return { fileName: `${baseName}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await buildAssetCategoryExcel(payload) };
  }
  const rendered = await renderBankReconciliationPdf({
    html: buildAssetCategoryPdfHtml(payload), fileName: `${baseName}.pdf`
  });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}
