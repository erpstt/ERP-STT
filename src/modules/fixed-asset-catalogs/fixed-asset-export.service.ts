import type ExcelJS from 'exceljs';
import { createExcelWorkbook } from '../../core/export/excel-workbook.js';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';
import { fixedAssetOptions, fixedAssetReport } from './fixed-assets.service.js';

type Json = Record<string, unknown>;
export type FixedAssetExportFormat = 'csv' | 'xlsx' | 'pdf';
export type FixedAssetExportFilters = { status: string; categoryId: string; search: string };
export type FixedAssetExportRow = {
  number: string;
  name: string;
  description: string;
  serial: string;
  category: string;
  location: string;
  purchaseDate: string;
  serviceDate: string;
  department: string;
  costCenter: string;
  className: string;
  currency: string;
  cost: number;
  accumulated: number;
  bookValue: number;
  status: string;
};
export type FixedAssetExportPayload = {
  header: {
    subsidiary: string;
    currency: string;
    status: string;
    category: string;
    search: string;
    generatedAt: string;
  };
  rows: FixedAssetExportRow[];
  totals: { count: number; cost: number; accumulated: number; bookValue: number };
};
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

export const FIXED_ASSET_EXPORT_COLUMNS = [
  { key: 'number', header: 'Número', width: 18, kind: 'text' },
  { key: 'name', header: 'Activo', width: 30, kind: 'text' },
  { key: 'description', header: 'Descripción', width: 34, kind: 'text' },
  { key: 'serial', header: 'Número de serie', width: 20, kind: 'text' },
  { key: 'category', header: 'Categoría', width: 25, kind: 'text' },
  { key: 'location', header: 'Ubicación', width: 22, kind: 'text' },
  { key: 'purchaseDate', header: 'Fecha de compra', width: 16, kind: 'date' },
  { key: 'serviceDate', header: 'Fecha en servicio', width: 17, kind: 'date' },
  { key: 'department', header: 'Departamento', width: 23, kind: 'text' },
  { key: 'costCenter', header: 'Centro de costos', width: 23, kind: 'text' },
  { key: 'className', header: 'Clase', width: 20, kind: 'text' },
  { key: 'currency', header: 'Moneda', width: 12, kind: 'text' },
  { key: 'cost', header: 'Costo histórico', width: 18, kind: 'number' },
  { key: 'accumulated', header: 'Depreciación acumulada', width: 22, kind: 'number' },
  { key: 'bookValue', header: 'Valor en libros', width: 18, kind: 'number' },
  { key: 'status', header: 'Estado', width: 14, kind: 'text' },
] as const;

function normalizeFilters(input: Record<string, unknown>): FixedAssetExportFilters {
  const status = String(input.status ?? 'ALL').trim().toUpperCase() || 'ALL';
  if (!['ALL', 'ACTIVO', 'INACTIVO', 'BAJA'].includes(status)) throw new Error('Seleccione un estado válido para exportar los activos.');
  const categoryId = String(input.categoryId ?? '').trim();
  if (categoryId && (!/^\d+$/.test(categoryId) || Number(categoryId) <= 0)) throw new Error('Seleccione una categoría válida para exportar los activos.');
  const search = String(input.search ?? '').trim();
  if (search.length > 200) throw new Error('La búsqueda no puede superar 200 caracteres.');
  return { status, categoryId, search };
}

const text = (value: unknown) => String(value ?? '');
const amount = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const spreadsheetText = (value: unknown) => {
  const result = text(value);
  return /^\s*[=+@-]/.test(result) ? `'${result}` : result;
};
const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
const escapeHtml = (value: unknown) => text(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character] || character));

function displayValue(column: typeof FIXED_ASSET_EXPORT_COLUMNS[number], row: FixedAssetExportRow, protect = false): string | number {
  const value = row[column.key];
  if (column.kind === 'number') return amount(value);
  return protect ? spreadsheetText(value) : text(value);
}

function money(value: number) {
  return value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function generatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('es-CR', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Costa_Rica'
  });
}

function filterLabel(payload: FixedAssetExportPayload) {
  const parts = [
    `Estado: ${payload.header.status === 'ALL' ? 'Todos' : payload.header.status}`,
    `Categoría: ${payload.header.category || 'Todas'}`,
  ];
  if (payload.header.search) parts.push(`Búsqueda: “${payload.header.search}”`);
  return parts.join(' · ');
}

export function buildFixedAssetCsv(rows: FixedAssetExportRow[]): Buffer {
  const matrix: Array<Array<string | number>> = [
    FIXED_ASSET_EXPORT_COLUMNS.map(column => column.header),
    ...rows.map(row => FIXED_ASSET_EXPORT_COLUMNS.map(column => displayValue(column, row, true))),
  ];
  return Buffer.from(`\uFEFF${matrix.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'utf8');
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: `FF${color}` } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

export async function buildFixedAssetExcel(payload: FixedAssetExportPayload): Promise<Buffer> {
  const workbook = await createExcelWorkbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = payload.header.subsidiary || 'GENTIA';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'Maestro de activos fijos';

  const sheet = workbook.addWorksheet('Activos fijos', {
    views: [{ state: 'frozen', ySplit: 6, activeCell: 'A7' }],
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: .2, right: .2, top: .45, bottom: .45, header: .2, footer: .2 }
    },
    properties: { defaultRowHeight: 20 }
  });
  sheet.properties.tabColor = { argb: 'FF0D9272' };
  FIXED_ASSET_EXPORT_COLUMNS.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });
  const lastColumn = FIXED_ASSET_EXPORT_COLUMNS.length;

  sheet.mergeCells(1, 1, 1, lastColumn);
  const title = sheet.getCell(1, 1);
  title.value = 'GENTIA · MAESTRO DE ACTIVOS FIJOS';
  title.font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, lastColumn);
  const company = sheet.getCell(2, 1);
  company.value = `Subsidiaria: ${payload.header.subsidiary} · Moneda funcional: ${payload.header.currency || '—'}`;
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
  totals.value = `${payload.totals.count.toLocaleString('es-CR')} activo${payload.totals.count === 1 ? '' : 's'} · Costo: ${payload.header.currency} ${money(payload.totals.cost)} · Depreciación: ${payload.header.currency} ${money(payload.totals.accumulated)} · Valor en libros: ${payload.header.currency} ${money(payload.totals.bookValue)}`;
  totals.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FF0B6F55' } };
  totals.alignment = { vertical: 'middle' };
  sheet.getRow(4).height = 23;

  const header = sheet.getRow(6);
  FIXED_ASSET_EXPORT_COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10845F' } };
    cell.alignment = { vertical: 'middle', horizontal: column.kind === 'number' ? 'right' : 'left', wrapText: true };
    cell.border = border('10845F');
  });
  header.height = 31;

  payload.rows.forEach((item, rowIndex) => {
    const row = sheet.getRow(rowIndex + 7);
    FIXED_ASSET_EXPORT_COLUMNS.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = displayValue(column, item, true);
      cell.border = border();
      cell.alignment = { vertical: 'top', horizontal: column.kind === 'number' ? 'right' : 'left', wrapText: true };
      if (column.kind === 'number') cell.numFmt = '#,##0.00;[Red](#,##0.00);-';
      if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
    });
    const wrappedLines = Math.max(1, Math.ceil(item.name.length / 36), Math.ceil(item.description.length / 42));
    row.height = Math.min(72, Math.max(24, wrappedLines * 14 + 6));
  });
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: lastColumn } };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&CInformación confidencial&RPágina &P de &N';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildFixedAssetPdfHtml(payload: FixedAssetExportPayload): string {
  const tableRows = payload.rows.map(row => `<tr>${FIXED_ASSET_EXPORT_COLUMNS.map(column => {
    const value = displayValue(column, row);
    const shown = column.kind === 'number' ? money(Number(value)) : String(value || '—');
    return `<td class="${column.kind === 'number' ? 'number' : ''}">${escapeHtml(shown)}</td>`;
  }).join('')}</tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Maestro de activos fijos</title><style>
  @page{size:A3 landscape;margin:9mm 7mm 14mm}*{box-sizing:border-box}body{font:6.4pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.company{margin-top:4px;color:#4f6178}.title{text-align:right}.title h1{font-size:16pt;margin:0;color:#063b79;text-transform:uppercase}.title p{margin:3px 0;color:#63738a}.filters{margin:8px 0;color:#53657b}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:8px 0}.metric{border:1px solid #d7e2ec;border-radius:7px;padding:6px 8px;background:#f7fafc}.metric small,.metric b{display:block}.metric small{color:#65758a}.metric b{font-size:10pt;margin-top:2px;color:#0b6f55}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#063b79;color:#fff;padding:5px 3px;text-align:left;vertical-align:bottom;overflow-wrap:anywhere}td{border-bottom:1px solid #dbe4ed;padding:4px 3px;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f6f8fb}tr{page-break-inside:avoid}.number{text-align:right;white-space:nowrap}.empty{text-align:center;padding:35px;color:#64748b}.footer{position:fixed;bottom:-10mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;display:flex;justify-content:space-between}
  </style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${escapeHtml(payload.header.subsidiary)}</b><br>Moneda funcional: ${escapeHtml(payload.header.currency || '—')}</div></div><div class="title"><h1>Maestro de activos fijos</h1><p>Generado ${escapeHtml(generatedLabel(payload.header.generatedAt))}</p></div></header><div class="filters">${escapeHtml(filterLabel(payload))}</div><section class="summary"><div class="metric"><small>Total de activos</small><b>${payload.totals.count.toLocaleString('es-CR')}</b></div><div class="metric"><small>Costo histórico</small><b>${escapeHtml(payload.header.currency)} ${money(payload.totals.cost)}</b></div><div class="metric"><small>Depreciación acumulada</small><b>${escapeHtml(payload.header.currency)} ${money(payload.totals.accumulated)}</b></div><div class="metric"><small>Valor en libros</small><b>${escapeHtml(payload.header.currency)} ${money(payload.totals.bookValue)}</b></div></section><table><thead><tr>${FIXED_ASSET_EXPORT_COLUMNS.map(column => `<th>${escapeHtml(column.header)}</th>`).join('')}</tr></thead><tbody>${tableRows || `<tr><td colspan="${FIXED_ASSET_EXPORT_COLUMNS.length}" class="empty">No hay activos que coincidan con los filtros seleccionados.</td></tr>`}</tbody></table><div class="footer"><span>GENTIA · Activos Fijos</span><span>Subsidiaria activa · Información confidencial</span></div></body></html>`;
}

export async function loadFixedAssetExportData(authorization: string, input: Record<string, unknown>): Promise<FixedAssetExportPayload> {
  const filters = normalizeFilters(input);
  const [optionsValue, reportValue] = await Promise.all([
    fixedAssetOptions(authorization),
    fixedAssetReport(authorization, filters),
  ]);
  const options = (optionsValue ?? {}) as Json;
  const report = (reportValue ?? {}) as Json;
  const subsidiary = (options.subsidiary ?? {}) as Json;
  const departments = Array.isArray(options.departments) ? options.departments as Json[] : [];
  const costs = Array.isArray(options.costs) ? options.costs as Json[] : [];
  const classes = Array.isArray(options.classes) ? options.classes as Json[] : [];
  const categories = Array.isArray(options.categories) ? options.categories as Json[] : [];
  const currencies = Array.isArray(options.currencies) ? options.currencies as Json[] : [];
  const departmentMap = new Map(departments.map(row => [String(row.id), text(row.name)]));
  const costMap = new Map(costs.map(row => [String(row.id), text(row.name)]));
  const classMap = new Map(classes.map(row => [String(row.id), text(row.name)]));
  const categoryMap = new Map(categories.map(row => [String(row.id), text(row.name)]));
  const localCurrency = currencies.find(row => String(row.id) === String(subsidiary.currencyId));
  const sourceRows = Array.isArray(report.rows) ? report.rows as Json[] : [];
  const rows: FixedAssetExportRow[] = sourceRows.map(row => ({
    number: text(row.number), name: text(row.name), description: text(row.description), serial: text(row.serial),
    category: text(row.category), location: text(row.location), purchaseDate: text(row.purchaseDate), serviceDate: text(row.serviceDate),
    department: text(row.department) || (row.departmentId == null ? '' : departmentMap.get(String(row.departmentId)) || `#${row.departmentId}`),
    costCenter: text(row.costCenter) || (row.costCenterId == null ? '' : costMap.get(String(row.costCenterId)) || `#${row.costCenterId}`),
    className: text(row.className) || (row.classId == null ? '' : classMap.get(String(row.classId)) || `#${row.classId}`),
    currency: text(row.currency), cost: amount(row.cost), accumulated: amount(row.accumulated), bookValue: amount(row.bookValue), status: text(row.status),
  }));
  const totals = rows.reduce((result, row) => ({
    count: result.count + 1,
    cost: result.cost + row.cost,
    accumulated: result.accumulated + row.accumulated,
    bookValue: result.bookValue + row.bookValue,
  }), { count: 0, cost: 0, accumulated: 0, bookValue: 0 });
  return {
    header: {
      subsidiary: text(subsidiary.name) || 'Subsidiaria activa',
      currency: text(localCurrency?.code),
      status: filters.status,
      category: filters.categoryId ? categoryMap.get(filters.categoryId) || `#${filters.categoryId}` : '',
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
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function exportFixedAssets(
  authorization: string,
  formatValue: string,
  input: Record<string, unknown>
): Promise<ExportFile> {
  const rawFormat = formatValue.toLowerCase();
  const format: FixedAssetExportFormat = rawFormat === 'excel' ? 'xlsx' : rawFormat as FixedAssetExportFormat;
  if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new Error('Seleccione un formato CSV, Excel o PDF válido.');
  const payload = await loadFixedAssetExportData(authorization, input);
  const baseName = `activos-fijos-${fileSlug(payload.header.subsidiary)}-${localDateStamp()}`;
  if (format === 'csv') return { fileName: `${baseName}.csv`, mimeType: 'text/csv; charset=utf-8', buffer: buildFixedAssetCsv(payload.rows) };
  if (format === 'xlsx') return { fileName: `${baseName}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await buildFixedAssetExcel(payload) };
  const rendered = await renderBankReconciliationPdf({ html: buildFixedAssetPdfHtml(payload), fileName: `${baseName}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}
