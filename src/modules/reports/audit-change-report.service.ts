import type ExcelJS from 'exceljs';
import { createExcelWorkbook } from '../../core/export/excel-workbook.js';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };
type AuditChange = { field: string; fieldLabel: string; oldValue: string; newValue: string };
type AuditActor = { name: string; email: string; type: string; source: string };
type AuditDocumentCreator = { id: string; name: string; email: string };
type AuditRow = {
  auditId: string; executionContextId: string; timestamp: string; action: string;
  module: string; moduleLabel: string; entityType: string; entityLabel: string;
  entityKey: string; recordLabel: string; actor: AuditActor; ipAddress: string;
  transactionType: string; transactionTypeLabel: string; documentNumber: string;
  subsidiaryId: string; subsidiaryName: string; subsidiaryNames: string[]; documentCreator: AuditDocumentCreator;
  fieldsChangedCount: number; changes: AuditChange[]; deletedSnapshot: Json;
};
type AuditTransactionMetric = {
  transactionType: string; transactionTypeLabel: string; total: number;
  modified: number; deleted: number;
};
type AuditReport = {
  header: { month: string; periodLabel: string; generatedAt: string; filterDescription: string };
  summary: {
    totalEvents: number; operationCount: number; modifiedCount: number; deletedCount: number;
    fieldChanges: number; userCount: number; mostActiveUser: string;
    byUser: Array<{ name: string; email: string; events: number; operations: number; modified: number; deleted: number }>;
    byModule: Array<{ module: string; label: string; events: number; modified: number; deleted: number }>;
    byDay: Array<{ date: string; events: number; modified: number; deleted: number }>;
    byTransactionType: AuditTransactionMetric[];
  };
  rows: AuditRow[];
  total: number;
};

const resourceKey = 'audit:change-report';
const sensitiveField = /(pass(word)?|hash|token|secret|credential|smtp|api[_-]?key|authorization|session|cookie|private[_-]?key)/i;
const technicalField = /^(created_by_|updated_by_|actor_type$|actor_source$|execution_context_id$|updated_actor_|updated_execution_context_id$|created_at$|updated_at$)/i;

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
      : 'No fue posible consultar el reporte de auditoría.';
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status === 401 ? 401 : response.status === 403 ? 403 : 422;
    throw error;
  }
  return payload as T;
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}

function first(source: Json, ...keys: string[]) {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function textValue(source: Json, ...keys: string[]) {
  const value = first(source, ...keys);
  return value === undefined || value === null ? '' : String(value);
}

function numberValue(source: Json, ...keys: string[]) {
  const value = Number(first(source, ...keys) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : [];
}

function cleanScalar(field: string, value: unknown, max = 800) {
  if (sensitiveField.test(field)) return '[dato protegido]';
  if (value === undefined || value === null || value === '') return '—';
  const normalized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!normalized) return '—';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function sanitizeSnapshot(input: unknown): Json {
  let source = input;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return {}; }
  }
  const record = object(source), result: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (technicalField.test(key)) continue;
    result[key] = cleanScalar(key, value, 500);
  }
  return result;
}

function normalizeChange(input: unknown): AuditChange | null {
  const row = object(input), field = textValue(row, 'field', 'fieldName', 'field_name');
  if (!field || technicalField.test(field)) return null;
  return {
    field,
    fieldLabel: textValue(row, 'fieldLabel', 'field_label', 'label') || field.replaceAll('_', ' '),
    oldValue: cleanScalar(field, first(row, 'oldValue', 'old_value', 'before', 'previousValue')),
    newValue: cleanScalar(field, first(row, 'newValue', 'new_value', 'after', 'currentValue'))
  };
}

function normalizeActor(input: unknown, row: Json): AuditActor {
  const actor = object(input);
  return {
    name: textValue(actor, 'name', 'userName', 'user_name') || textValue(row, 'actorName', 'actor_name', 'createdByName', 'created_by_name') || 'Autor no disponible',
    email: textValue(actor, 'email') || textValue(row, 'actorEmail', 'actor_email', 'createdByEmail', 'created_by_email'),
    type: textValue(actor, 'type', 'actorType', 'actor_type') || textValue(row, 'actorType', 'actor_type') || 'HUMAN',
    source: textValue(actor, 'source', 'actorSource', 'actor_source') || textValue(row, 'actorSource', 'actor_source') || 'NEXO ERP'
  };
}

function normalizeDocumentCreator(input: unknown, row: Json): AuditDocumentCreator {
  const creator = object(input);
  return {
    id: textValue(creator, 'id', 'userId', 'user_id') || textValue(row, 'documentCreatorId', 'document_creator_id'),
    name: textValue(creator, 'name', 'userName', 'user_name') || textValue(row, 'documentCreatorName', 'document_creator_name', 'originalCreatorName', 'original_creator_name'),
    email: textValue(creator, 'email', 'userEmail', 'user_email') || textValue(row, 'documentCreatorEmail', 'document_creator_email', 'originalCreatorEmail', 'original_creator_email')
  };
}

function normalizeRow(input: unknown): AuditRow {
  const row = object(input);
  const subsidiaryNames = stringArray(first(row, 'subsidiaryNames', 'subsidiary_names'));
  const changes = (Array.isArray(first(row, 'changes', 'fieldChanges', 'field_changes'))
    ? first(row, 'changes', 'fieldChanges', 'field_changes') as unknown[] : [])
    .map(normalizeChange).filter((change): change is AuditChange => Boolean(change));
  return {
    auditId: textValue(row, 'auditId', 'audit_id', 'logId', 'log_id'),
    executionContextId: textValue(row, 'executionContextId', 'execution_context_id', 'operationId', 'operation_id'),
    timestamp: textValue(row, 'timestamp', 'occurredAt', 'occurred_at', 'date'),
    action: textValue(row, 'action').toUpperCase(),
    module: textValue(row, 'module', 'moduleKey', 'module_key'),
    moduleLabel: textValue(row, 'moduleLabel', 'module_label') || textValue(row, 'module', 'moduleKey', 'module_key') || 'Otros',
    entityType: textValue(row, 'entityType', 'entity_type', 'tableName', 'table_name'),
    entityLabel: textValue(row, 'entityLabel', 'entity_label') || textValue(row, 'entityType', 'entity_type'),
    entityKey: textValue(row, 'entityKey', 'entity_key'),
    recordLabel: textValue(row, 'recordLabel', 'record_label') || textValue(row, 'entityKey', 'entity_key') || 'Registro sin referencia',
    actor: normalizeActor(first(row, 'actor'), row),
    ipAddress: textValue(row, 'ipAddress', 'ip_address'),
    transactionType: textValue(row, 'transactionType', 'transaction_type') || textValue(row, 'entityType', 'entity_type', 'tableName', 'table_name'),
    transactionTypeLabel: textValue(row, 'transactionTypeLabel', 'transaction_type_label') || textValue(row, 'entityLabel', 'entity_label') || textValue(row, 'entityType', 'entity_type'),
    documentNumber: textValue(row, 'documentNumber', 'document_number') || textValue(row, 'recordLabel', 'record_label') || textValue(row, 'entityKey', 'entity_key') || 'Documento sin número',
    subsidiaryId: textValue(row, 'subsidiaryId', 'subsidiary_id'),
    subsidiaryName: textValue(row, 'subsidiaryName', 'subsidiary_name') || subsidiaryNames.join(' · ') || 'Subsidiaria no disponible',
    subsidiaryNames,
    documentCreator: normalizeDocumentCreator(first(row, 'documentCreator', 'document_creator', 'originalCreator', 'original_creator'), row),
    fieldsChangedCount: numberValue(row, 'fieldsChangedCount', 'fields_changed_count') || changes.length,
    changes,
    deletedSnapshot: sanitizeSnapshot(first(row, 'deletedSnapshot', 'deleted_snapshot', 'recordData', 'record_data'))
  };
}

function periodLabel(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  const date = new Date(`${value}-01T12:00:00Z`);
  return new Intl.DateTimeFormat('es-CR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function normalizeReport(input: unknown): AuditReport {
  const payload = object(input), header = object(first(payload, 'header')), summary = object(first(payload, 'summary'));
  const rows = (Array.isArray(first(payload, 'rows', 'data')) ? first(payload, 'rows', 'data') as unknown[] : []).map(normalizeRow);
  const byUser = (Array.isArray(first(summary, 'byUser', 'by_user')) ? first(summary, 'byUser', 'by_user') as unknown[] : []).map(item => {
    const row = object(item); return { name: textValue(row, 'name', 'userName', 'user_name'), email: textValue(row, 'email'), events: numberValue(row, 'events', 'count'), operations: numberValue(row, 'operations'), modified: numberValue(row, 'modified'), deleted: numberValue(row, 'deleted') };
  });
  const byModule = (Array.isArray(first(summary, 'byModule', 'by_module')) ? first(summary, 'byModule', 'by_module') as unknown[] : []).map(item => {
    const row = object(item); return { module: textValue(row, 'module'), label: textValue(row, 'label', 'moduleLabel', 'module_label') || textValue(row, 'module'), events: numberValue(row, 'events', 'count'), modified: numberValue(row, 'modified'), deleted: numberValue(row, 'deleted') };
  });
  const byDay = (Array.isArray(first(summary, 'byDay', 'by_day')) ? first(summary, 'byDay', 'by_day') as unknown[] : []).map(item => {
    const row = object(item); return { date: textValue(row, 'date', 'day'), events: numberValue(row, 'events', 'count'), modified: numberValue(row, 'modified'), deleted: numberValue(row, 'deleted') };
  });
  const byTransactionType = (Array.isArray(first(summary, 'byTransactionType', 'by_transaction_type')) ? first(summary, 'byTransactionType', 'by_transaction_type') as unknown[] : []).map(item => {
    const row = object(item);
    return {
      transactionType: textValue(row, 'transactionType', 'transaction_type', 'type', 'code'),
      transactionTypeLabel: textValue(row, 'transactionTypeLabel', 'transaction_type_label', 'label', 'name') || textValue(row, 'transactionType', 'transaction_type', 'type', 'code'),
      total: numberValue(row, 'total', 'events', 'documents', 'count'),
      modified: numberValue(row, 'modified', 'modifiedCount', 'modified_count'),
      deleted: numberValue(row, 'deleted', 'deletedCount', 'deleted_count')
    };
  });
  const month = textValue(header, 'month') || textValue(payload, 'month');
  return {
    header: {
      month,
      periodLabel: periodLabel(textValue(header, 'periodLabel', 'period_label') || month),
      generatedAt: textValue(header, 'generatedAt', 'generated_at') || new Date().toISOString(),
      filterDescription: textValue(header, 'filterDescription', 'filter_description') || 'Todos los usuarios, módulos y acciones'
    },
    summary: {
      totalEvents: numberValue(summary, 'totalEvents', 'total_events') || numberValue(payload, 'total'),
      operationCount: numberValue(summary, 'operationCount', 'operation_count', 'operations'),
      modifiedCount: numberValue(summary, 'modifiedCount', 'modified_count', 'modified'),
      deletedCount: numberValue(summary, 'deletedCount', 'deleted_count', 'deleted'),
      fieldChanges: numberValue(summary, 'fieldChanges', 'field_changes'),
      userCount: numberValue(summary, 'userCount', 'user_count'),
      mostActiveUser: textValue(summary, 'mostActiveUser', 'most_active_user'),
      byUser, byModule, byDay, byTransactionType
    },
    rows,
    total: numberValue(payload, 'total') || rows.length
  };
}

export async function auditChangeReportOptions(authorization: string) {
  await assertRoleAccess(authorization, resourceKey, 'view');
  return rpc<Json>(authorization, 'audit_change_report_options');
}

export async function runAuditChangeReport(authorization: string, filters: Json) {
  await assertRoleAccess(authorization, resourceKey, 'view');
  return rpc<Json>(authorization, 'run_audit_change_report', { p_filters: filters });
}

async function fullReport(authorization: string, filters: Json, maxRecords = 25_000) {
  const pageSize = 500, firstPage = normalizeReport(await runAuditChangeReport(authorization, { ...filters, page: 1, pageSize }));
  if (firstPage.total > maxRecords) throw new Error(`El reporte supera ${maxRecords.toLocaleString('es-CR')} transacciones. Aplique un filtro por subsidiaria, usuario, acción o tipo de transacción antes de descargarlo.`);
  const pages = Math.ceil(firstPage.total / pageSize);
  for (let start = 2; start <= pages; start += 5) {
    const end = Math.min(pages, start + 4);
    const batch = await Promise.all(Array.from({ length: end - start + 1 }, (_, index) => runAuditChangeReport(authorization, { ...filters, page: start + index, pageSize })));
    firstPage.rows.push(...batch.flatMap(page => normalizeReport(page).rows));
  }
  return firstPage;
}

function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function actionLabel(action: string) { return action === 'ELIMINACION' ? 'Eliminado' : 'Modificado'; }
function actorTypeLabel(type: string) { return ({ HUMAN: 'Usuario', AI_AGENT: 'Agente IA', SYSTEM_JOB: 'Proceso automático', EXTERNAL_API: 'Integración' } as Record<string, string>)[type] || type; }
function dateTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('es-CR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Costa_Rica' }); }

const fieldLabels: Record<string, string> = {
  invoice_number: 'Número de factura', cn_number: 'Número de nota de crédito', dn_number: 'Número de nota de débito',
  payment_number: 'Número de pago', journal_number: 'Número de asiento', document_number: 'Número de documento', numero: 'Número de solicitud',
  invoice_date: 'Fecha de factura', note_date: 'Fecha de nota', payment_date: 'Fecha de pago', journal_date: 'Fecha de asiento',
  document_date: 'Fecha del documento', due_date: 'Fecha de vencimiento', status: 'Estado', status_id: 'Estado', memo: 'Nota', note: 'Nota', notes: 'Notas',
  total_amount: 'Importe total', subtotal_amount: 'Subtotal', tax_total: 'Impuestos', withholding_total: 'Retenciones', amount: 'Importe',
  amount_received: 'Importe recibido', amount_paid: 'Importe pagado', exchange_rate: 'Tipo de cambio', customer_id: 'Cliente', supplier_id: 'Proveedor',
  subsidiary_id: 'Subsidiaria', currency_id: 'Moneda', fiscal_period_id: 'Periodo contable', department_id: 'Departamento', cost_center_id: 'Centro de costos',
  class_id: 'Clase', location_id: 'Ubicación', account_id: 'Cuenta contable'
};

function displayFieldLabel(field: string) {
  return fieldLabels[field.toLowerCase()] || field.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function transactionMetrics(report: AuditReport) {
  if (report.summary.byTransactionType.length) return report.summary.byTransactionType;
  const grouped = new Map<string, AuditTransactionMetric>();
  for (const row of report.rows) {
    const key = row.transactionType || row.entityType || 'other';
    const metric = grouped.get(key) || { transactionType: key, transactionTypeLabel: row.transactionTypeLabel || row.entityLabel || 'Otras transacciones', total: 0, modified: 0, deleted: 0 };
    metric.total += 1;
    if (row.action === 'ELIMINACION') metric.deleted += 1; else metric.modified += 1;
    grouped.set(key, metric);
  }
  return [...grouped.values()].sort((left, right) => right.total - left.total || left.transactionTypeLabel.localeCompare(right.transactionTypeLabel, 'es'));
}

function groupedTransactions(rows: AuditRow[]) {
  const grouped = new Map<string, { label: string; rows: AuditRow[] }>();
  for (const row of rows) {
    const key = row.transactionType || row.entityType || 'other';
    const group = grouped.get(key) || { label: row.transactionTypeLabel || row.entityLabel || 'Otras transacciones', rows: [] };
    group.rows.push(row); grouped.set(key, group);
  }
  return [...grouped.values()].sort((left, right) => left.label.localeCompare(right.label, 'es'));
}

function changeSummary(row: AuditRow, limit = 4) {
  if (row.action === 'ELIMINACION') {
    const entries = Object.entries(row.deletedSnapshot).slice(0, limit);
    return entries.length ? entries.map(([field, value]) => `${displayFieldLabel(field)}: ${value}`).join(' · ') : 'Documento completo eliminado';
  }
  const visible = row.changes.slice(0, limit).map(change => `${change.fieldLabel}: ${change.oldValue} → ${change.newValue}`);
  return `${visible.join(' · ')}${row.changes.length > limit ? ` · +${row.changes.length - limit} cambios` : ''}` || 'Cambio registrado';
}

function pdfHtml(report: AuditReport) {
  const groups = groupedTransactions(report.rows).map(group => `<section class="transaction-group">
    <div class="group-title"><b>${esc(group.label)}</b><span>${group.rows.length} transacción${group.rows.length === 1 ? '' : 'es'}</span></div>
    <table><colgroup><col style="width:13%"><col style="width:16%"><col style="width:15%"><col style="width:10%"><col style="width:17%"><col style="width:29%"></colgroup>
      <thead><tr><th>Fecha del cambio</th><th>Documento</th><th>Subsidiaria</th><th>Acción</th><th>Responsable</th><th>Información modificada</th></tr></thead>
      <tbody>${group.rows.map(row => `<tr>
        <td><b>${esc(dateTime(row.timestamp))}</b></td>
        <td><b>${esc(row.documentNumber)}</b></td>
        <td>${esc(row.subsidiaryName)}</td>
        <td><span class="badge ${row.action === 'ELIMINACION' ? 'deleted' : 'modified'}">${esc(actionLabel(row.action))}</span></td>
        <td><b>${esc(row.actor.name)}</b><small>${esc(row.actor.email)}</small>${row.documentCreator.name ? `<small>Registrado por: ${esc(row.documentCreator.name)}</small>` : ''}</td>
        <td>${esc(changeSummary(row, 6))}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`).join('');
  const s = report.summary, h = report.header;
  const typeCount = transactionMetrics(report).length;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Transacciones modificadas y eliminadas</title><style>
  @page{size:A4 landscape;margin:10mm 8mm 14mm}*{box-sizing:border-box}body{font:8pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.title{text-align:right}.title h1{font-size:15pt;margin:0;color:#063b79}.title p{margin:3px 0;color:#65748a}.meta{background:#f3f6fa;border:1px solid #d8e2ec;border-radius:8px;padding:8px 10px;margin:9px 0;display:flex;justify-content:space-between;gap:18px}.meta b,.meta small,.metric b,.metric small,td small{display:block}.meta small,.metric small,td small{color:#64748b;margin-top:2px}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-bottom:10px}.metric{border:1px solid #d8e2ec;border-radius:8px;padding:8px;background:#fff}.metric b{font-size:12pt;margin-top:3px}.metric.changed{background:#eaf6f2;border-color:#afd9cc}.metric.deleted{background:#fff0ed;border-color:#f4c1b3}.transaction-group{margin:0 0 10px;page-break-inside:auto}.group-title{display:flex;align-items:center;justify-content:space-between;border-left:4px solid #f26a3d;background:#edf3f9;padding:7px 9px;color:#063b79}.group-title b{font-size:10pt}.group-title span{font-weight:700;color:#5f7085}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#063b79;color:#fff;padding:7px 5px;text-align:left}td{border-bottom:1px solid #dbe4ed;padding:6px 5px;vertical-align:top;overflow-wrap:anywhere}tr{page-break-inside:avoid}.badge{display:inline-block;padding:4px 7px;border-radius:99px;font-size:7pt;font-weight:800}.badge.modified{background:#ddf5ec;color:#08705a}.badge.deleted{background:#fde8e5;color:#b42318}.footer{position:fixed;bottom:-10mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;display:flex;justify-content:space-between}.empty{text-align:center;padding:35px;color:#64748b}
  </style></head><body><header><div><div class="brand">GENTIA</div><b>NEXO ERP · CONTROL DE TRANSACCIONES</b></div><div class="title"><h1>TRANSACCIONES MODIFICADAS Y ELIMINADAS</h1><p>${esc(h.periodLabel)}</p><p>Generado ${esc(dateTime(h.generatedAt))}</p></div></header><div class="meta"><div><small>Alcance</small><b>${esc(h.filterDescription)}</b></div><div><small>Usuario con mayor actividad</small><b>${esc(s.mostActiveUser || 'Sin actividad')}</b></div></div><section class="metrics"><div class="metric"><small>Transacciones con cambios</small><b>${s.totalEvents}</b></div><div class="metric changed"><small>Modificadas</small><b>${s.modifiedCount}</b></div><div class="metric deleted"><small>Eliminadas</small><b>${s.deletedCount}</b></div><div class="metric"><small>Campos cambiados</small><b>${s.fieldChanges}</b></div><div class="metric"><small>Usuarios responsables</small><b>${s.userCount}</b></div><div class="metric"><small>Tipos de transacción</small><b>${typeCount}</b></div></section>${groups || '<div class="empty">No hay transacciones modificadas ni eliminadas para los filtros seleccionados.</div>'}<div class="footer"><span>GENTIA · Control de transacciones</span><span>Información de auditoría</span></div></body></html>`;
}

export async function exportAuditChangeReportPdf(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters, 5_000);
  const rendered = await renderBankReconciliationPdf({ html: pdfHtml(report), fileName: `auditoria-transacciones-${report.header.month || 'periodo'}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function styleHeader(row: ExcelJS.Row, color = '063B79') {
  row.height = 28;
  row.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = border(color); });
}

function styleRecord(row: ExcelJS.Row) { row.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; }); }

export async function exportAuditChangeReportExcel(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), workbook = await createExcelWorkbook();
  workbook.creator = 'GENTIA ERP'; workbook.company = 'GENTIA'; workbook.created = new Date();
  const summary = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 7 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  summary.columns = [{ width: 25 }, { width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  summary.mergeCells('A1:F1'); summary.getCell('A1').value = 'GENTIA · TRANSACCIONES MODIFICADAS Y ELIMINADAS'; summary.getCell('A1').font = { bold: true, size: 17, color: { argb: 'FFFFFFFF' } }; summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; summary.getRow(1).height = 33;
  summary.mergeCells('A2:F2'); summary.getCell('A2').value = `${report.header.periodLabel} · ${report.header.filterDescription}`; summary.getCell('A2').font = { italic: true, color: { argb: 'FF586A82' } };
  const typeMetrics = transactionMetrics(report);
  const metrics: Array<[string, number]> = [['Transacciones con cambios', report.summary.totalEvents], ['Modificadas', report.summary.modifiedCount], ['Eliminadas', report.summary.deletedCount], ['Campos cambiados', report.summary.fieldChanges], ['Usuarios responsables', report.summary.userCount], ['Tipos de transacción', typeMetrics.length]];
  metrics.forEach(([label, value], index) => { const cell = summary.getCell(4, index + 1), amount = summary.getCell(5, index + 1); cell.value = label; amount.value = value; cell.font = { bold: true, color: { argb: 'FF5D6E84' } }; amount.font = { bold: true, size: 14, color: { argb: index === 3 ? 'FFB42318' : 'FF14233B' } }; cell.alignment = amount.alignment = { horizontal: 'center' }; cell.fill = amount.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 3 ? 'FFFFECE8' : index === 2 ? 'FFEEF4FF' : 'FFF3F6FA' } }; });
  const typeHeader = summary.addRow(['Tipo de transacción', 'Código', 'Total', 'Modificadas', 'Eliminadas', '% del total']); styleHeader(typeHeader, 'F26A3D');
  for (const metric of typeMetrics) {
    const row = summary.addRow([metric.transactionTypeLabel, metric.transactionType, metric.total, metric.modified, metric.deleted, report.summary.totalEvents ? metric.total / report.summary.totalEvents : 0]);
    styleRecord(row); row.getCell(6).numFmt = '0.0%';
  }
  summary.addRow([]);
  const userHeader = summary.addRow(['Usuario que realizó el cambio', 'Correo', 'Transacciones', 'Operaciones', 'Modificadas', 'Eliminadas']); styleHeader(userHeader, '0D9272');
  for (const user of report.summary.byUser) { const row = summary.addRow([user.name, user.email, user.events, user.operations, user.modified, user.deleted]); styleRecord(row); }

  const transactions = workbook.addWorksheet('Transacciones', { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  transactions.columns = [{ width: 30 }, { width: 25 }, { width: 30 }, { width: 21 }, { width: 16 }, { width: 30 }, { width: 34 }, { width: 30 }, { width: 34 }, { width: 55 }];
  transactions.mergeCells('A1:J1'); transactions.getCell('A1').value = `TRANSACCIONES CON CAMBIOS · ${report.header.periodLabel}`; transactions.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }; transactions.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } };
  const transactionHeader = transactions.addRow(['Tipo de transacción', 'Número de documento', 'Subsidiaria', 'Fecha del cambio', 'Acción', 'Modificado/Eliminado por', 'Correo responsable', 'Registrado por', 'Correo del creador', 'Información modificada']); styleHeader(transactionHeader);
  for (const item of report.rows) {
    const row = transactions.addRow([item.transactionTypeLabel, item.documentNumber, item.subsidiaryName, new Date(item.timestamp), actionLabel(item.action), item.actor.name, item.actor.email, item.documentCreator.name, item.documentCreator.email, changeSummary(item, 12)]);
    styleRecord(row); row.getCell(4).numFmt = 'dd/mm/yyyy hh:mm'; const actionCell = row.getCell(5); actionCell.font = { bold: true, color: { argb: item.action === 'ELIMINACION' ? 'FFB42318' : 'FF08705A' } }; actionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.action === 'ELIMINACION' ? 'FFFFECE8' : 'FFECF8F4' } };
  }
  transactions.autoFilter = 'A2:J2';

  const changes = workbook.addWorksheet('Cambios', { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  changes.columns = [{ width: 30 }, { width: 25 }, { width: 30 }, { width: 21 }, { width: 16 }, { width: 30 }, { width: 29 }, { width: 48 }, { width: 48 }];
  changes.mergeCells('A1:I1'); changes.getCell('A1').value = 'DETALLE DE VALORES ANTERIORES Y NUEVOS'; changes.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } }; changes.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9272' } };
  const changeHeader = changes.addRow(['Tipo de transacción', 'Número de documento', 'Subsidiaria', 'Fecha del cambio', 'Acción', 'Usuario responsable', 'Dato modificado', 'Valor anterior', 'Valor nuevo']); styleHeader(changeHeader, '0D9272');
  for (const item of report.rows) {
    if (item.action === 'ELIMINACION') {
      for (const [field, value] of Object.entries(item.deletedSnapshot)) { const row = changes.addRow([item.transactionTypeLabel, item.documentNumber, item.subsidiaryName, new Date(item.timestamp), 'Eliminado', item.actor.name, displayFieldLabel(field), value, '[documento eliminado]']); styleRecord(row); row.getCell(4).numFmt = 'dd/mm/yyyy hh:mm'; }
    } else for (const change of item.changes) { const row = changes.addRow([item.transactionTypeLabel, item.documentNumber, item.subsidiaryName, new Date(item.timestamp), 'Modificado', item.actor.name, change.fieldLabel || displayFieldLabel(change.field), change.oldValue, change.newValue]); styleRecord(row); row.getCell(4).numFmt = 'dd/mm/yyyy hh:mm'; }
  }
  changes.autoFilter = 'A2:I2';
  summary.headerFooter.oddFooter = 'GENTIA · Control de transacciones                                      Página &P de &N';
  transactions.headerFooter.oddFooter = changes.headerFooter.oddFooter = 'GENTIA · Auditoría de transacciones                                      Página &P de &N';
  const content = await workbook.xlsx.writeBuffer();
  return { fileName: `auditoria-transacciones-${report.header.month || 'periodo'}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(content) };
}
