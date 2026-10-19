import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { getOrganizationCatalog, listOrganizationRows } from './organization-catalogs.module.js';

type Json = Record<string, unknown>;
type ExportFormat = 'csv' | 'xlsx';
export type CostCenterExportRow = {
  id: number;
  name: string;
  subsidiary: string;
  type: string;
  customer: string;
  className: string;
  code: string;
};
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

const columns = [
  { header: 'ID interno', key: 'id', width: 14 },
  { header: 'Nombre del centro de costos', key: 'name', width: 34 },
  { header: 'Subsidiaria', key: 'subsidiary', width: 30 },
  { header: 'Tipo de centro de costo', key: 'type', width: 24 },
  { header: 'Cliente', key: 'customer', width: 30 },
  { header: 'Clase', key: 'className', width: 22 },
  { header: 'Código', key: 'code', width: 18 },
] as const;

async function rest<T>(authorization: string, path: string): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase no está configurado.');
  const response = await fetchSupabase(new URL(`/rest/v1/${path}`, config.url), {
    headers: { apikey: config.anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
  });
  const raw = await response.text();
  const payload: unknown = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload
      ? String(payload.message)
      : 'No fue posible preparar el catálogo de centros de costos.';
    throw new Error(message);
  }
  return payload as T;
}

const normalize = (value: unknown) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim();

function fileSlug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'subsidiaria';
}

function safeCell(value: unknown) {
  const text = String(value ?? '');
  return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
}

function filterRows(rows: CostCenterExportRow[], search: string) {
  const term = normalize(search);
  if (!term) return rows;
  return rows.filter(row => Object.values(row).some(value => normalize(value).includes(term)));
}

export function buildCostCenterCsv(rows: CostCenterExportRow[]): Buffer {
  const quote = (value: unknown) => `"${safeCell(value).replaceAll('"', '""')}"`;
  const content = [
    columns.map(column => column.header),
    ...rows.map(row => columns.map(column => row[column.key])),
  ].map(row => row.map(quote).join(',')).join('\r\n');
  return Buffer.from(`\uFEFF${content}`, 'utf8');
}

export async function buildCostCenterExcel(rows: CostCenterExportRow[], subsidiary: string, search = ''): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = subsidiary || 'GENTIA';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'Catálogo de centros de costos';

  const sheet = workbook.addWorksheet('Centros de costos', {
    views: [{ state: 'frozen', ySplit: 5, activeCell: 'A6' }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 20 },
  });
  sheet.mergeCells('A1:G1');
  sheet.getCell('A1').value = 'GENTIA · CATÁLOGO DE CENTROS DE COSTOS';
  sheet.getCell('A1').font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells('A2:G2');
  sheet.getCell('A2').value = `Subsidiaria: ${subsidiary || 'Subsidiaria activa'}`;
  sheet.getCell('A2').font = { name: 'Aptos', size: 11, bold: true, color: { argb: 'FF15375F' } };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F6EF' } };
  sheet.getCell('A2').alignment = { vertical: 'middle' };
  sheet.getRow(2).height = 24;

  sheet.mergeCells('A3:G3');
  const appliedSearch = search.trim() ? ` · Filtro aplicado: “${search.trim()}”` : '';
  sheet.getCell('A3').value = `${rows.length.toLocaleString('es-CR')} registro${rows.length === 1 ? '' : 's'} · Generado el ${new Date().toLocaleDateString('es-CR')}${appliedSearch}`;
  sheet.getCell('A3').font = { name: 'Aptos', size: 10, color: { argb: 'FF52657D' } };
  sheet.getCell('A3').alignment = { vertical: 'middle' };
  sheet.getRow(3).height = 22;

  sheet.addTable({
    name: 'CatalogoCentrosCostos',
    ref: 'A5',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false },
    columns: columns.map(column => ({ name: column.header, filterButton: true })),
    rows: rows.map(row => columns.map(column => safeCell(row[column.key]))),
  });
  columns.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });
  const header = sheet.getRow(5);
  header.height = 28;
  header.eachCell(cell => {
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10845F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  for (let row = 6; row <= sheet.rowCount; row++) {
    sheet.getRow(row).alignment = { vertical: 'top', wrapText: true };
    sheet.getRow(row).height = 22;
  }
  sheet.getColumn(1).numFmt = '0';
  for (let column = 2; column <= columns.length; column++) sheet.getColumn(column).numFmt = '@';
  sheet.autoFilter = { from: 'A5', to: 'G5' };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&C&P de &N&RConfidencial';

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function exportCostCenters(authorization: string, formatValue: string, search = ''): Promise<ExportFile> {
  const format = formatValue.toLowerCase() as ExportFormat;
  if (!['csv', 'xlsx'].includes(format)) throw new Error('Seleccione un formato CSV o Excel válido.');
  const catalog = getOrganizationCatalog('cost-centers');
  const [costCenters, subsidiaries, customers, classes] = await Promise.all([
    listOrganizationRows(catalog, authorization),
    rest<Json[]>(authorization, 'subsidiaries?select=subsidiary_id,name'),
    rest<Json[]>(authorization, 'customers?select=customer_id,company_name'),
    rest<Json[]>(authorization, 'classes?select=class_id,name'),
  ]);
  const subsidiaryMap = new Map(subsidiaries.map(row => [String(row.subsidiary_id), String(row.name ?? '')]));
  const customerMap = new Map(customers.map(row => [String(row.customer_id), String(row.company_name ?? '')]));
  const classMap = new Map(classes.map(row => [String(row.class_id), String(row.name ?? '')]));
  const mapped: CostCenterExportRow[] = (costCenters as Json[]).map(row => ({
    id: Number(row.cost_center_id),
    name: String(row.name ?? ''),
    subsidiary: subsidiaryMap.get(String(row.subsidiary_id)) || `#${row.subsidiary_id ?? ''}`,
    type: String(row.cost_center_type ?? ''),
    customer: row.customer_id == null ? '' : customerMap.get(String(row.customer_id)) || `#${row.customer_id}`,
    className: row.class_id == null ? '' : classMap.get(String(row.class_id)) || `#${row.class_id}`,
    code: String(row.code ?? ''),
  }));
  const rows = filterRows(mapped, search);
  const subsidiary = rows[0]?.subsidiary || mapped[0]?.subsidiary || 'Subsidiaria activa';
  const date = new Date().toISOString().slice(0, 10);
  const baseName = `centros-de-costos-${fileSlug(subsidiary)}-${date}`;
  if (format === 'csv') return { fileName: `${baseName}.csv`, mimeType: 'text/csv; charset=utf-8', buffer: buildCostCenterCsv(rows) };
  return {
    fileName: `${baseName}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await buildCostCenterExcel(rows, subsidiary, search),
  };
}
