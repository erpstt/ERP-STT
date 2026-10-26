import { createExcelWorkbook } from '../../core/export/excel-workbook.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { exportCostCenters } from './cost-center-export.service.js';
import {
  getOrganizationCatalog,
  listOrganizationRows,
  listSubsidiaryApprovers,
  type OrganizationCatalog,
  type OrganizationField,
} from './organization-catalogs.module.js';
import { upApproverSelectorOptions } from './up-approvers.service.js';

type Json = Record<string, unknown>;
type ExportFormat = 'csv' | 'xlsx';
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };
type ExportColumn = OrganizationField & { width: number };
type ReferenceIndex = Map<string, Map<string, string>>;

const allowedCatalogs = new Set([
  'accounting-periods',
  'fiscal-years',
  'fiscal-calendars',
  'subsidiaries',
  'branches',
  'departments',
  'classes',
  'cost-centers',
  'locations',
  'financial-creditors',
  'related-companies',
]);

const externalReferences: Record<string, { path: string; id: string }> = {
  'core/countries': { path: 'countries?select=*', id: 'country_id' },
  'core/currencies': { path: 'currencies?select=*', id: 'currency_id' },
  'core/timezones': { path: 'timezones?select=*', id: 'timezone_id' },
  'security/users': { path: 'users?select=*', id: 'user_id' },
  'accounting/chart-accounts': { path: 'chart_accounts?select=*', id: 'account_id' },
  'entities/customers': { path: 'customers?select=*', id: 'customer_id' },
};

const normalize = (value: unknown) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim();

function fileSlug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'organizacion';
}

function safeText(value: unknown) {
  const text = String(value ?? '');
  return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
}

function label(row: Json) {
  if (row.account_number || row.account_name) return [row.account_number, row.account_name].filter(Boolean).join(' · ');
  if (row.currency_code) return [row.currency_code, row.name].filter(Boolean).join(' · ');
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ');
  return String(
    row.name ?? row.company_name ?? (fullName || undefined) ?? row.email ?? row.display_name ?? row.legal_name ??
    row.calendar_name ?? row.year_name ?? row.period_name ?? row.account_name ?? row.account_number ??
    row.currency_code ?? row.code_name ?? row.code ?? Object.values(row)[1] ?? 'Registro',
  );
}

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
      : 'No fue posible preparar el catálogo de Organización.';
    throw new Error(message);
  }
  return payload as T;
}

function referencePrimaryKey(reference: string) {
  if (reference === 'organization/approver-options') return 'approver_id';
  if (reference === 'organization/up-approver-options') return 'id';
  if (reference.startsWith('organization/')) return getOrganizationCatalog(reference.split('/')[1]).primaryKey;
  return externalReferences[reference]?.id ?? 'id';
}

async function referenceRows(reference: string, authorization: string): Promise<Json[]> {
  if (reference === 'organization/approver-options') return listSubsidiaryApprovers(authorization) as Promise<Json[]>;
  if (reference === 'organization/up-approver-options') return upApproverSelectorOptions(authorization) as Promise<Json[]>;
  if (reference.startsWith('organization/')) return listOrganizationRows(getOrganizationCatalog(reference.split('/')[1]), authorization) as Promise<Json[]>;
  const spec = externalReferences[reference];
  return spec ? rest<Json[]>(authorization, spec.path) : [];
}

async function loadReferences(catalog: OrganizationCatalog, authorization: string): Promise<ReferenceIndex> {
  const references = [...new Set(catalog.fields.map(field => field.reference).filter((value): value is string => Boolean(value)))];
  const entries = await Promise.all(references.map(async reference => {
    const rows = await referenceRows(reference, authorization);
    const id = referencePrimaryKey(reference);
    return [reference, new Map(rows.map(row => [String(row[id]), label(row)]))] as const;
  }));
  return new Map(entries);
}

function columns(catalog: OrganizationCatalog): ExportColumn[] {
  const all: OrganizationField[] = [
    { key: catalog.primaryKey, label: 'ID interno', type: 'number' },
    ...catalog.fields.filter(field => field.type !== 'image'),
  ];
  return all.map(field => ({
    ...field,
    width: field.type === 'boolean' ? 16 : field.type === 'date' ? 17 : field.type === 'number' && !field.reference ? 15 : Math.min(42, Math.max(18, field.label.length + 6)),
  }));
}

function displayValue(field: OrganizationField, value: unknown, references: ReferenceIndex): string | number {
  if (field.type === 'boolean') return value ? 'Sí' : 'No';
  if (field.type === 'multi-reference') {
    const index = references.get(field.reference ?? '');
    return (Array.isArray(value) ? value : []).map(id => index?.get(String(id)) ?? `#${id}`).join(' | ');
  }
  if (field.reference && value !== null && value !== undefined && String(value) !== '') {
    return references.get(field.reference)?.get(String(value)) ?? `#${value}`;
  }
  if (value === null || value === undefined) return '';
  if (field.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  return String(value);
}

function mapRows(catalog: OrganizationCatalog, rows: Json[], exportColumns: ExportColumn[], references: ReferenceIndex) {
  return rows.map(row => Object.fromEntries(exportColumns.map(column => [column.key, displayValue(column, row[column.key], references)])));
}

function filterRows(rows: Json[], search: string) {
  const term = normalize(search);
  return term ? rows.filter(row => Object.values(row).some(value => normalize(value).includes(term))) : rows;
}

export function buildOrganizationCatalogCsv(exportColumns: ExportColumn[], rows: Json[]): Buffer {
  const quote = (value: unknown) => `"${safeText(value).replaceAll('"', '""')}"`;
  const content = [
    exportColumns.map(column => column.label),
    ...rows.map(row => exportColumns.map(column => row[column.key])),
  ].map(row => row.map(quote).join(',')).join('\r\n');
  return Buffer.from(`\uFEFF${content}`, 'utf8');
}

function tableName(slug: string) {
  const name = slug.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '');
  return `Catalogo${name}`.slice(0, 240);
}

export async function buildOrganizationCatalogExcel(
  catalog: OrganizationCatalog,
  exportColumns: ExportColumn[],
  rows: Json[],
  scope: string,
  search = '',
): Promise<Buffer> {
  const workbook = await createExcelWorkbook();
  workbook.creator = 'GENTIA ERP';
  workbook.company = scope || 'GENTIA';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = `Catálogo de ${catalog.title}`;

  const sheet = workbook.addWorksheet(catalog.title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 5, activeCell: 'A6' }],
    pageSetup: { orientation: exportColumns.length > 6 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 20 },
  });
  const last = sheet.getColumn(exportColumns.length).letter;
  sheet.mergeCells(`A1:${last}1`);
  sheet.getCell('A1').value = `GENTIA · ${catalog.title.toLocaleUpperCase('es')}`;
  sheet.getCell('A1').font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  sheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(`A2:${last}2`);
  sheet.getCell('A2').value = `Alcance: ${scope}`;
  sheet.getCell('A2').font = { name: 'Aptos', size: 11, bold: true, color: { argb: 'FF15375F' } };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F6EF' } };
  sheet.getCell('A2').alignment = { vertical: 'middle' };
  sheet.getRow(2).height = 24;

  sheet.mergeCells(`A3:${last}3`);
  const appliedSearch = search.trim() ? ` · Filtro aplicado: “${search.trim()}”` : '';
  sheet.getCell('A3').value = `${rows.length.toLocaleString('es-CR')} registro${rows.length === 1 ? '' : 's'} · Generado el ${new Date().toLocaleDateString('es-CR')}${appliedSearch}`;
  sheet.getCell('A3').font = { name: 'Aptos', size: 10, color: { argb: 'FF52657D' } };
  sheet.getCell('A3').alignment = { vertical: 'middle' };
  sheet.getRow(3).height = 22;

  sheet.addTable({
    name: tableName(catalog.slug),
    ref: 'A5',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true, showColumnStripes: false },
    columns: exportColumns.map(column => ({ name: column.label, filterButton: true })),
    rows: rows.map(row => exportColumns.map(column => typeof row[column.key] === 'string' ? safeText(row[column.key]) : row[column.key])),
  });
  exportColumns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.width;
    if (column.type === 'number' && !column.reference) excelColumn.numFmt = '#,##0.######';
    else excelColumn.numFmt = '@';
  });
  const header = sheet.getRow(5);
  header.height = 30;
  header.eachCell(cell => {
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10845F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  for (let row = 6; row <= sheet.rowCount; row++) {
    sheet.getRow(row).alignment = { vertical: 'top', wrapText: true };
    sheet.getRow(row).height = 22;
  }
  sheet.autoFilter = { from: 'A5', to: `${last}5` };
  sheet.headerFooter.oddFooter = '&LGENTIA ERP&C&P de &N&RConfidencial';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function scopeLabel(catalog: OrganizationCatalog, mappedRows: Json[], references: ReferenceIndex) {
  if (catalog.slug === 'subsidiaries') return 'Subsidiarias autorizadas';
  const names = new Set<string>();
  const direct = catalog.fields.find(field => field.key === 'subsidiary_id');
  const multiple = catalog.fields.find(field => field.key === 'subsidiary_ids');
  for (const row of mappedRows) {
    if (direct && row[direct.key]) names.add(String(row[direct.key]));
    if (multiple && row[multiple.key]) String(row[multiple.key]).split(' | ').filter(Boolean).forEach(name => names.add(name));
  }
  if (names.size === 1) return [...names][0];
  if (names.size > 1) return `${names.size.toLocaleString('es-CR')} subsidiarias autorizadas`;
  const subsidiaryCount = references.get('organization/subsidiaries')?.size ?? 0;
  return subsidiaryCount ? `${subsidiaryCount.toLocaleString('es-CR')} subsidiarias autorizadas` : 'Alcance autorizado del usuario';
}

export async function exportOrganizationCatalog(
  authorization: string,
  slug: string,
  formatValue: string,
  search = '',
): Promise<ExportFile> {
  const format = formatValue.toLowerCase() as ExportFormat;
  if (!allowedCatalogs.has(slug)) throw new Error('El catálogo de Organización no admite exportación.');
  if (!['csv', 'xlsx'].includes(format)) throw new Error('Seleccione un formato CSV o Excel válido.');
  if (slug === 'cost-centers') return exportCostCenters(authorization, format, search);

  const catalog = getOrganizationCatalog(slug);
  const [sourceRows, references] = await Promise.all([
    listOrganizationRows(catalog, authorization) as Promise<Json[]>,
    loadReferences(catalog, authorization),
  ]);
  const exportColumns = columns(catalog);
  const mapped = mapRows(catalog, sourceRows, exportColumns, references);
  const rows = filterRows(mapped, search);
  const scope = scopeLabel(catalog, mapped, references);
  const baseName = `${fileSlug(catalog.title)}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') return { fileName: `${baseName}.csv`, mimeType: 'text/csv; charset=utf-8', buffer: buildOrganizationCatalogCsv(exportColumns, rows) };
  return {
    fileName: `${baseName}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await buildOrganizationCatalogExcel(catalog, exportColumns, rows, scope, search),
  };
}
