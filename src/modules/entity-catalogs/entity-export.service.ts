import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from '../reports/accounting-reports.service.js';

export type EntityExportCatalog = 'customers' | 'suppliers' | 'employees' | 'entity-subsidiaries';
export type EntityExportFormat = 'csv' | 'xlsx' | 'pdf';
export type EntityExportRow = Record<string, unknown>;
export type EntityExportPayload = {
  header: {
    catalog: EntityExportCatalog;
    subsidiaryId: number;
    subsidiary: string;
    legalName: string;
    taxId: string;
    search: string;
    generatedAt: string;
  };
  rows: EntityExportRow[];
  total: number;
};

type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };
type ColumnKind = 'text' | 'number' | 'boolean';
type ExportColumn = { header: string; key: string; width: number; kind?: ColumnKind };
type CatalogDefinition = {
  title: string;
  filePrefix: string;
  sheetName: string;
  columns: ExportColumn[];
};

export const ENTITY_EXPORT_CATALOGS: readonly EntityExportCatalog[] = [
  'customers', 'suppliers', 'employees', 'entity-subsidiaries'
] as const;

const definitions: Record<EntityExportCatalog, CatalogDefinition> = {
  customers: {
    title: 'Catálogo de clientes', filePrefix: 'clientes', sheetName: 'Clientes',
    columns: [
      { header: 'Subsidiaria', key: 'subsidiary', width: 28 },
      { header: 'Número', key: 'code', width: 18 },
      { header: 'Nombre / razón social', key: 'name', width: 34 },
      { header: 'Tipo', key: 'entityType', width: 15 },
      { header: 'Identificación fiscal', key: 'taxId', width: 22 },
      { header: 'País', key: 'country', width: 19 },
      { header: 'Correo electrónico', key: 'email', width: 31 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Dirección', key: 'address', width: 38 },
      { header: 'Departamento', key: 'department', width: 23 },
      { header: 'Representante de ventas', key: 'salesRepresentative', width: 28 },
      { header: 'Término de pago', key: 'paymentTerm', width: 20 },
      { header: 'Monedas', key: 'currencies', width: 16 },
      { header: 'Límite de crédito', key: 'creditLimit', width: 20, kind: 'number' },
      { header: 'Asignación principal', key: 'isPrimary', width: 19, kind: 'boolean' },
      { header: 'Intercompany', key: 'isIntercompany', width: 16, kind: 'boolean' },
      { header: 'Aplica retención', key: 'appliesWithholding', width: 18, kind: 'boolean' },
      { header: 'Estado de cuenta automático', key: 'automaticStatement', width: 25, kind: 'boolean' },
      { header: 'Comentarios', key: 'comments', width: 38 },
    ]
  },
  suppliers: {
    title: 'Catálogo de proveedores', filePrefix: 'proveedores', sheetName: 'Proveedores',
    columns: [
      { header: 'Subsidiaria', key: 'subsidiary', width: 28 },
      { header: 'Número', key: 'code', width: 18 },
      { header: 'Nombre / razón social', key: 'name', width: 34 },
      { header: 'Tipo', key: 'entityType', width: 15 },
      { header: 'Categoría', key: 'category', width: 22 },
      { header: 'Identificación fiscal', key: 'taxId', width: 22 },
      { header: 'Correo electrónico', key: 'email', width: 31 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Dirección', key: 'address', width: 38 },
      { header: 'Término de pago', key: 'paymentTerm', width: 20 },
      { header: 'Monedas', key: 'currencies', width: 16 },
      { header: 'Asignación principal', key: 'isPrimary', width: 19, kind: 'boolean' },
      { header: 'Intercompany', key: 'isIntercompany', width: 16, kind: 'boolean' },
      { header: 'Aplica retención', key: 'appliesWithholding', width: 18, kind: 'boolean' },
      { header: 'Beneficiario bancario', key: 'beneficiary', width: 28 },
      { header: 'Banco', key: 'bank', width: 25 },
      { header: 'IBAN', key: 'iban', width: 28 },
      { header: 'Comentarios', key: 'comments', width: 38 },
    ]
  },
  employees: {
    title: 'Catálogo de empleados', filePrefix: 'empleados', sheetName: 'Empleados',
    columns: [
      { header: 'Subsidiaria', key: 'subsidiary', width: 28 },
      { header: 'Número', key: 'code', width: 18 },
      { header: 'Identificación', key: 'identification', width: 21 },
      { header: 'Nombre completo', key: 'name', width: 32 },
      { header: 'Puesto de trabajo', key: 'jobTitle', width: 27 },
      { header: 'Correo electrónico', key: 'email', width: 31 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Departamento', key: 'department', width: 23 },
      { header: 'Ubicación', key: 'location', width: 23 },
      { header: 'Usuario vinculado', key: 'linkedUser', width: 34 },
      { header: 'Representante de ventas', key: 'isSalesRepresentative', width: 24, kind: 'boolean' },
      { header: 'Activo', key: 'isActive', width: 13, kind: 'boolean' },
    ]
  },
  'entity-subsidiaries': {
    title: 'Entidades por subsidiaria', filePrefix: 'entidades-por-subsidiaria', sheetName: 'Entidades',
    columns: [
      { header: 'Subsidiaria', key: 'subsidiary', width: 28 },
      { header: 'Tipo de entidad', key: 'entityKind', width: 18 },
      { header: 'Número', key: 'code', width: 18 },
      { header: 'Nombre / razón social', key: 'name', width: 34 },
      { header: 'Identificación fiscal', key: 'taxId', width: 22 },
      { header: 'Correo electrónico', key: 'email', width: 31 },
      { header: 'Teléfono', key: 'phone', width: 18 },
      { header: 'Monedas', key: 'currencies', width: 16 },
      { header: 'Asignación principal', key: 'isPrimary', width: 19, kind: 'boolean' },
      { header: 'Límite de crédito', key: 'creditLimit', width: 20, kind: 'number' },
    ]
  }
};

export function isEntityExportCatalog(value: string): value is EntityExportCatalog {
  return ENTITY_EXPORT_CATALOGS.includes(value as EntityExportCatalog);
}

function definition(catalog: EntityExportCatalog) {
  return definitions[catalog];
}

function normalizeSearch(value: unknown) {
  const search = String(value ?? '').trim();
  if (search.length > 200) throw new Error('La búsqueda no puede superar 200 caracteres.');
  return search;
}

function spreadsheetText(value: unknown) {
  const text = String(value ?? '');
  return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
}

function displayValue(column: ExportColumn, row: EntityExportRow, protectSpreadsheet = false): string | number {
  const value = row[column.key];
  if (column.kind === 'boolean') return value === true ? 'Sí' : 'No';
  if (column.kind === 'number') {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
  }
  return protectSpreadsheet ? spreadsheetText(value) : String(value ?? '');
}

function csvCell(value: string | number) {
  const text = typeof value === 'number' ? String(value) : value;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildEntityCatalogCsv(catalog: EntityExportCatalog, rows: EntityExportRow[]): Buffer {
  const columns = definition(catalog).columns;
  const matrix: Array<Array<string | number>> = [
    columns.map(column => column.header),
    ...rows.map(row => columns.map(column => displayValue(column, row, true)))
  ];
  return Buffer.from(`\uFEFF${matrix.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'utf8');
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: `FF${color}` } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function generatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('es-CR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Costa_Rica' });
}

export async function buildEntityCatalogExcel(catalog: EntityExportCatalog, payload: EntityExportPayload): Promise<Buffer> {
  const config = definition(catalog), columns = config.columns;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = payload.header.legalName || payload.header.subsidiary || 'GENTIA';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = config.title;

  const sheet = workbook.addWorksheet(config.sheetName, {
    views: [{ state: 'frozen', ySplit: 5, activeCell: 'A6' }],
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: .2, right: .2, top: .45, bottom: .45, header: .2, footer: .2 }
    },
    properties: { defaultRowHeight: 20 }
  });
  sheet.properties.tabColor = { argb: 'FF0D9272' };
  columns.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });

  sheet.mergeCells(1, 1, 1, columns.length);
  const title = sheet.getCell(1, 1);
  title.value = `GENTIA · ${config.title.toUpperCase()}`;
  title.font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, columns.length);
  const company = sheet.getCell(2, 1);
  company.value = `${payload.header.legalName || payload.header.subsidiary} · Subsidiaria: ${payload.header.subsidiary}${payload.header.taxId ? ` · Identificación fiscal: ${payload.header.taxId}` : ''}`;
  company.font = { name: 'Aptos', size: 11, bold: true, color: { argb: 'FF15375F' } };
  company.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F6EF' } };
  company.alignment = { vertical: 'middle' };
  sheet.getRow(2).height = 25;

  sheet.mergeCells(3, 1, 3, columns.length);
  const metadata = sheet.getCell(3, 1);
  const filterLabel = payload.header.search ? ` · Búsqueda aplicada: “${payload.header.search}”` : '';
  metadata.value = `${payload.total.toLocaleString('es-CR')} registro${payload.total === 1 ? '' : 's'} · Generado ${generatedLabel(payload.header.generatedAt)}${filterLabel}`;
  metadata.font = { name: 'Aptos', size: 10, color: { argb: 'FF52657D' } };
  metadata.alignment = { vertical: 'middle' };
  sheet.getRow(3).height = 23;

  const header = sheet.getRow(5);
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10845F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = border('10845F');
  });
  header.height = 30;

  payload.rows.forEach((item, rowIndex) => {
    const row = sheet.getRow(rowIndex + 6);
    columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = displayValue(column, item, true);
      cell.border = border();
      cell.alignment = { vertical: 'top', horizontal: column.kind === 'number' ? 'right' : 'left', wrapText: true };
      if (column.kind === 'number') cell.numFmt = '#,##0.00;[Red](#,##0.00);-';
      if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
    });
    row.height = 23;
  });

  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: columns.length } };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&CInformación confidencial&RPágina &P de &N';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character] || character));

function pdfValue(column: ExportColumn, row: EntityExportRow) {
  const value = displayValue(column, row);
  if (column.kind === 'number') return Number(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(value);
}

export function buildEntityCatalogPdfHtml(catalog: EntityExportCatalog, payload: EntityExportPayload): string {
  const config = definition(catalog), columns = config.columns;
  const rows = payload.rows.map(row => `<tr>${columns.map(column => `<td class="${column.kind === 'number' ? 'number' : ''}">${escapeHtml(pdfValue(column, row))}</td>`).join('')}</tr>`).join('');
  const search = payload.header.search ? `<span><small>Búsqueda aplicada</small><b>${escapeHtml(payload.header.search)}</b></span>` : '';
  const size = columns.length > 12 ? 'A3' : 'A4';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(config.title)}</title><style>
  @page{size:${size} landscape;margin:9mm 7mm 14mm}*{box-sizing:border-box}body{font:7pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.company{margin-top:4px;color:#4f6178}.title{text-align:right}.title h1{font-size:16pt;margin:0;color:#063b79;text-transform:uppercase}.title p{margin:3px 0;color:#63738a}.meta{display:flex;gap:24px;align-items:center;background:#eef5fa;border:1px solid #d5e0ea;border-radius:8px;padding:7px 10px;margin:9px 0}.meta span{min-width:160px}.meta small,.meta b{display:block}.meta small{color:#65758a;margin-bottom:2px}.count{margin-left:auto;text-align:right}.count b{font-size:13pt;color:#0b7a5d}table{width:100%;border-collapse:collapse;table-layout:auto}thead{display:table-header-group}th{background:#063b79;color:#fff;padding:6px 4px;text-align:left;vertical-align:bottom;overflow-wrap:anywhere}td{border-bottom:1px solid #dbe4ed;padding:5px 4px;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f6f8fb}tr{page-break-inside:avoid}.number{text-align:right;white-space:nowrap}.empty{text-align:center;padding:35px;color:#64748b}.footer{position:fixed;bottom:-10mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;display:flex;justify-content:space-between}
  </style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${escapeHtml(payload.header.legalName || payload.header.subsidiary)}</b>${payload.header.taxId ? `<br>Identificación fiscal: ${escapeHtml(payload.header.taxId)}` : ''}</div></div><div class="title"><h1>${escapeHtml(config.title)}</h1><p>Subsidiaria: ${escapeHtml(payload.header.subsidiary)}</p><p>Generado ${escapeHtml(generatedLabel(payload.header.generatedAt))}</p></div></header><section class="meta"><span><small>Alcance</small><b>Subsidiaria activa</b></span>${search}<span class="count"><small>Total de registros</small><b>${payload.total.toLocaleString('es-CR')}</b></span></section><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column.header)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${columns.length}" class="empty">No hay registros que coincidan con los filtros seleccionados.</td></tr>`}</tbody></table><div class="footer"><span>GENTIA · Módulo de Entidades</span><span>${escapeHtml(config.title)} · Información confidencial</span></div></body></html>`;
}

async function loadEntityExportData(authorization: string, catalog: EntityExportCatalog, search: string): Promise<EntityExportPayload> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL('/rest/v1/rpc/entity_catalog_export_data', config.url), {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_catalog: catalog, p_search: search })
  });
  const raw = await response.text();
  let payload: unknown = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload
      ? String(payload.message)
      : 'No fue posible preparar la exportación del catálogo.';
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status === 401 ? 401 : response.status === 403 ? 403 : 400;
    throw error;
  }
  const data = payload as Partial<EntityExportPayload> | null;
  if (!data?.header || !Array.isArray(data.rows)) throw new Error('El catálogo exportable devolvió una respuesta incompleta.');
  return { ...data, rows: data.rows, total: Number(data.total ?? data.rows.length) } as EntityExportPayload;
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

export async function exportEntityCatalog(
  authorization: string,
  catalogValue: string,
  formatValue: string,
  searchValue: unknown = ''
): Promise<ExportFile> {
  const catalog = catalogValue.toLowerCase();
  if (!isEntityExportCatalog(catalog)) throw new Error('El catálogo solicitado no admite exportación.');
  const rawFormat = formatValue.toLowerCase(), format: EntityExportFormat = rawFormat === 'excel' ? 'xlsx' : rawFormat as EntityExportFormat;
  if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new Error('Seleccione un formato CSV, Excel o PDF válido.');
  const search = normalizeSearch(searchValue);
  const payload = await loadEntityExportData(authorization, catalog, search);
  const config = definition(catalog), baseName = `${config.filePrefix}-${fileSlug(payload.header.subsidiary)}-${localDateStamp()}`;
  if (format === 'csv') return { fileName: `${baseName}.csv`, mimeType: 'text/csv; charset=utf-8', buffer: buildEntityCatalogCsv(catalog, payload.rows) };
  if (format === 'xlsx') return { fileName: `${baseName}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await buildEntityCatalogExcel(catalog, payload) };
  const rendered = await renderBankReconciliationPdf({ html: buildEntityCatalogPdfHtml(catalog, payload), fileName: `${baseName}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}
