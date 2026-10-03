import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

type ReportRow = {
  requestId: string;
  requestNumber: string;
  requestType: string;
  requestTypeLabel: string;
  status: string;
  statusLabel: string;
  requestDate: string;
  plannedDate: string;
  appliedDate: string;
  thirdPartyType: string;
  thirdParty: string;
  thirdPartyTaxId: string;
  document: string;
  account: string;
  department: string;
  costCenter: string;
  concept: string;
  requester: string;
  approver: string;
  currency: string;
  symbol: string;
  amount: number;
  requestTotal: number;
  paymentMethod: string;
  paymentReference: string;
  journalNumber: string;
};

type NormalizedReport = {
  header: {
    subsidiary: string;
    legalName: string;
    taxId: string;
    currency: string;
    symbol: string;
    dateFrom: string;
    dateTo: string;
    generatedAt: string;
    filterDescription: string;
  };
  rows: ReportRow[];
  summary: {
    requestCount: number;
    lineCount: number;
    cxpCount: number;
    otherCount: number;
    draftCount: number;
    pendingApprovalCount: number;
    approvedCount: number;
    appliedCount: number;
    rejectedCount: number;
    cancelledCount: number;
    byCurrency: Array<{ currency: string; symbol: string; requestCount: number; requestAmount: number; analyzedAmount: number }>;
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
  const result: unknown = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = typeof result === 'object' && result && 'message' in result
      ? String((result as { message?: unknown }).message)
      : 'No fue posible generar el reporte de solicitudes de pago.';
    throw new Error(message);
  }
  return result as T;
}

export function paymentRequestReportOptions(authorization: string) {
  return rpc<Json>(authorization, 'payment_request_report_options');
}

export function runPaymentRequestReport(authorization: string, filters: Json) {
  return rpc<Json>(authorization, 'run_payment_request_report', { p_filters: filters });
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}

function value(source: Json, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function textValue(source: Json, ...keys: string[]) {
  const found = value(source, ...keys);
  return found === undefined ? '' : String(found);
}

function numberValue(source: Json, ...keys: string[]) {
  const found = Number(value(source, ...keys) ?? 0);
  return Number.isFinite(found) ? found : 0;
}

function nestedText(source: Json, keys: string[], nestedKeys: string[] = ['name', 'label', 'code']) {
  const found = value(source, ...keys);
  if (typeof found === 'object' && found !== null && !Array.isArray(found)) return textValue(found as Json, ...nestedKeys);
  return found === undefined || found === null ? '' : String(found);
}

function arrayNames(source: Json, ...keys: string[]) {
  const found = value(source, ...keys);
  if (!Array.isArray(found)) return '';
  return found.map(item => nestedText(object(item), ['name', 'label', 'number', 'code'])).filter(Boolean).join(', ');
}

function labelStatus(status: string) {
  const labels: Record<string, string> = {
    BORRADOR: 'Borrador', PENDIENTE_APROBACION: 'Pendiente de aprobación', APROBADO: 'Aprobada',
    APLICADO: 'Aplicada', RECHAZADO: 'Rechazada', ANULADO: 'Anulada'
  };
  return labels[status.toUpperCase()] ?? status.replaceAll('_', ' ');
}

function labelType(type: string) {
  return type.toUpperCase() === 'CXP' ? 'Pago de CxP' : type.toUpperCase() === 'OTROS' ? 'Otros pagos' : type;
}

function rawRows(payload: Json): Json[] {
  const source = value(payload, 'rows', 'details', 'data');
  if (!Array.isArray(source)) return [];
  return source.flatMap(item => {
    const parent = object(item);
    const lines = value(parent, 'lines', 'detail', 'requestLines');
    return Array.isArray(lines) && lines.length
      ? lines.map(line => ({ ...parent, requestId: value(parent, 'requestId', 'request_id', 'id'), ...object(line), lines: undefined, detail: undefined, requestLines: undefined }))
      : [parent];
  });
}

function normalizeRow(row: Json, header: NormalizedReport['header']): ReportRow {
  const requestType = textValue(row, 'requestType', 'request_type', 'tipoSolicitud', 'tipo_solicitud', 'type').toUpperCase();
  const status = textValue(row, 'status', 'estado').toUpperCase();
  const currency = nestedText(row, ['currency'], ['code', 'currencyCode', 'currency_code', 'name']) || textValue(row, 'currencyCode', 'currency_code', 'moneda') || header.currency;
  const rowCurrency = object(value(row, 'currency'));
  const amount = numberValue(row, 'lineAmount', 'line_amount', 'amount', 'monto');
  const requestTotal = numberValue(row, 'requestTotal', 'request_total', 'total');
  const accountNumber = textValue(row, 'accountNumber', 'account_number', 'numeroCuenta', 'numero_cuenta');
  const accountName = textValue(row, 'accountName', 'account_name', 'nombreCuenta', 'nombre_cuenta');
  return {
    requestId: textValue(row, 'requestId', 'request_id', 'idSolicitud', 'id_solicitud', 'id'),
    requestNumber: textValue(row, 'requestNumber', 'request_number', 'numeroSolicitud', 'numero_solicitud', 'number', 'numero'),
    requestType,
    requestTypeLabel: textValue(row, 'requestTypeLabel', 'request_type_label', 'tipoSolicitudLabel') || labelType(requestType),
    status,
    statusLabel: textValue(row, 'statusLabel', 'status_label', 'estadoLabel') || labelStatus(status),
    requestDate: textValue(row, 'requestDate', 'request_date', 'fechaSolicitud', 'fecha_solicitud'),
    plannedDate: textValue(row, 'plannedPaymentDate', 'planned_payment_date', 'plannedDate', 'fechaPagoProgramada', 'fecha_pago_programada'),
    appliedDate: textValue(row, 'appliedDate', 'applied_date', 'appliedAt', 'aplicado_at', 'paymentDate', 'payment_date') || textValue(object(value(row, 'payment')), 'appliedAt', 'applied_at'),
    thirdPartyType: textValue(row, 'thirdPartyType', 'third_party_type', 'partyType', 'party_type', 'entityType', 'entity_type', 'tipoTercero', 'tipo_tercero'),
    thirdParty: textValue(row, 'thirdParty', 'third_party', 'party', 'partyName', 'party_name', 'entityName', 'entity_name', 'supplierName', 'supplier_name', 'tercero', 'proveedor') || arrayNames(row, 'parties', 'thirdParties', 'third_parties') || 'Sin tercero',
    thirdPartyTaxId: textValue(row, 'thirdPartyTaxId', 'third_party_tax_id', 'partyTaxId', 'party_tax_id', 'taxId', 'tax_id', 'identification', 'identificacion'),
    document: textValue(row, 'document', 'documentNumber', 'document_number', 'invoiceNumber', 'invoice_number', 'factura'),
    account: [accountNumber, accountName].filter(Boolean).join(' · '),
    department: textValue(row, 'department', 'departmentName', 'department_name', 'departamento') || arrayNames(row, 'departments') || 'Sin departamento',
    costCenter: textValue(row, 'costCenter', 'cost_center', 'costCenterName', 'cost_center_name', 'centroCosto', 'centro_costo') || arrayNames(row, 'costCenters', 'cost_centers') || 'General',
    concept: textValue(row, 'lineConcept', 'line_concept', 'concept', 'concepto'),
    requester: nestedText(row, ['requester', 'solicitante']) || textValue(row, 'requesterName', 'requester_name'),
    approver: nestedText(row, ['approver', 'aprobador']) || textValue(row, 'approverName', 'approver_name') || nestedText(object(value(row, 'approval')), ['approvedBy', 'approved_by']),
    currency,
    symbol: textValue(row, 'symbol', 'currencySymbol', 'currency_symbol', 'simbolo') || textValue(rowCurrency, 'symbol'),
    amount,
    requestTotal,
    paymentMethod: textValue(row, 'paymentMethod', 'payment_method', 'method', 'metodoPago', 'metodo_pago') || textValue(object(value(row, 'payment')), 'method'),
    paymentReference: textValue(row, 'paymentReference', 'payment_reference', 'reference', 'bankReference', 'bank_reference', 'referenciaBancaria', 'referencia_bancaria') || textValue(object(value(row, 'payment')), 'reference'),
    journalNumber: textValue(row, 'journalNumber', 'journal_number', 'journalId', 'journal_id', 'asiento') || textValue(object(value(row, 'payment')), 'journalId', 'journal_id')
  };
}

function normalizeReport(payload: Json): NormalizedReport {
  const sourceHeader = object(value(payload, 'header', 'encabezado'));
  const subsidiary = object(value(sourceHeader, 'subsidiary'));
  const header: NormalizedReport['header'] = {
    subsidiary: textValue(sourceHeader, 'subsidiaryName', 'subsidiary_name', 'companyName', 'company_name', 'sociedad') || nestedText(sourceHeader, ['subsidiary'], ['name', 'companyName', 'company_name']) || textValue(subsidiary, 'name', 'companyName', 'company_name'),
    legalName: textValue(sourceHeader, 'legalName', 'legal_name', 'companyLegalName', 'company_legal_name') || textValue(subsidiary, 'legalName', 'legal_name'),
    taxId: textValue(sourceHeader, 'taxId', 'tax_id', 'identification', 'identificacion') || textValue(subsidiary, 'taxId', 'tax_id'),
    currency: textValue(sourceHeader, 'baseCurrencyCode', 'base_currency_code', 'currency', 'currencyCode', 'currency_code', 'moneda') || textValue(subsidiary, 'baseCurrencyCode', 'base_currency_code'),
    symbol: textValue(sourceHeader, 'baseCurrencySymbol', 'base_currency_symbol', 'symbol', 'currencySymbol', 'currency_symbol', 'simbolo') || textValue(subsidiary, 'baseCurrencySymbol', 'base_currency_symbol'),
    dateFrom: textValue(sourceHeader, 'dateFrom', 'date_from', 'startDate', 'start_date', 'desde'),
    dateTo: textValue(sourceHeader, 'dateTo', 'date_to', 'endDate', 'end_date', 'hasta'),
    generatedAt: textValue(sourceHeader, 'generatedAt', 'generated_at') || new Date().toISOString(),
    filterDescription: textValue(sourceHeader, 'filterDescription', 'filter_description', 'filtersLabel', 'filters_label')
  };
  const rows = rawRows(payload).map(row => normalizeRow(row, header));
  const sourceSummary = object(value(payload, 'summary', 'resumen'));
  const requestKeys = new Set(rows.map(row => row.requestId || row.requestNumber).filter(Boolean));
  const uniqueRequests = new Map<string, ReportRow>();
  for (const row of rows) uniqueRequests.set(row.requestId || row.requestNumber, row);
  const requests = [...uniqueRequests.values()];
  const countType = (type: string) => requests.filter(row => row.requestType === type).length;
  const countStatus = (status: string) => requests.filter(row => row.status === status).length;
  const rawCurrencyTotals = value(sourceSummary, 'byCurrency', 'by_currency', 'totalsByCurrency', 'totals_by_currency');
  const byCurrency = Array.isArray(rawCurrencyTotals) ? rawCurrencyTotals.map(item => {
    const total = object(item);
    return {
      currency: textValue(total, 'currency', 'currencyCode', 'currency_code', 'code'),
      symbol: textValue(total, 'symbol', 'currencySymbol', 'currency_symbol'),
      requestCount: numberValue(total, 'requestCount', 'request_count', 'count'),
      requestAmount: numberValue(total, 'requestAmount', 'request_amount', 'amount', 'total'),
      analyzedAmount: numberValue(total, 'analyzedAmount', 'analyzed_amount', 'lineAmount', 'line_amount', 'amount', 'total')
    };
  }) : [...new Set(rows.map(row => row.currency))].filter(Boolean).map(currency => {
    const currencyRows = rows.filter(row => row.currency === currency);
    const currencyRequests = [...new Map(currencyRows.map(row => [row.requestId || row.requestNumber, row])).values()];
    return { currency, symbol: currencyRows[0]?.symbol || '', requestCount: currencyRequests.length, requestAmount: currencyRequests.reduce((sum, row) => sum + row.requestTotal, 0), analyzedAmount: currencyRows.reduce((sum, row) => sum + row.amount, 0) };
  });
  return {
    header,
    rows,
    summary: {
      requestCount: numberValue(sourceSummary, 'requestCount', 'request_count', 'totalRequests', 'total_requests') || requestKeys.size,
      lineCount: numberValue(sourceSummary, 'lineCount', 'line_count', 'totalLines', 'total_lines') || rows.length,
      cxpCount: numberValue(sourceSummary, 'cxpCount', 'cxp_count') || countType('CXP'),
      otherCount: numberValue(sourceSummary, 'otherCount', 'other_count') || countType('OTROS'),
      draftCount: numberValue(sourceSummary, 'draftCount', 'draft_count') || countStatus('BORRADOR'),
      pendingApprovalCount: numberValue(sourceSummary, 'pendingApprovalCount', 'pending_approval_count') || countStatus('PENDIENTE_APROBACION'),
      approvedCount: numberValue(sourceSummary, 'approvedCount', 'approved_count') || countStatus('APROBADO'),
      appliedCount: numberValue(sourceSummary, 'appliedCount', 'applied_count') || countStatus('APLICADO'),
      rejectedCount: numberValue(sourceSummary, 'rejectedCount', 'rejected_count') || countStatus('RECHAZADO'),
      cancelledCount: numberValue(sourceSummary, 'cancelledCount', 'cancelled_count') || countStatus('ANULADO'),
      byCurrency
    }
  };
}

async function fullReport(authorization: string, filters: Json) {
  const pageSize = 5000;
  const first = await runPaymentRequestReport(authorization, { ...filters, page: 1, pageSize });
  const total = numberValue(first, 'total');
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount > 1) {
    const remaining = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => runPaymentRequestReport(authorization, { ...filters, page: index + 2, pageSize })));
    first.rows = [
      ...(Array.isArray(first.rows) ? first.rows : []),
      ...remaining.flatMap(page => Array.isArray(page.rows) ? page.rows : [])
    ];
  }
  const report = normalizeReport(first);
  const descriptions: string[] = [];
  const types = Array.isArray(filters.types) ? filters.types.map(String) : filters.type ? [String(filters.type)] : [];
  const statuses = Array.isArray(filters.statuses) ? filters.statuses.map(String) : filters.status ? [String(filters.status)] : [];
  if (types.length) descriptions.push(types.map(labelType).join(', '));
  if (statuses.length) descriptions.push(statuses.map(labelStatus).join(', '));
  if (filters.thirdPartyKey || filters.thirdPartyId) descriptions.push('Tercero específico');
  if (filters.departmentId) descriptions.push('Departamento específico');
  if (filters.costCenterId) descriptions.push('Centro de costo específico');
  if (filters.accountId) descriptions.push('Cuenta específica');
  if (filters.currencyId) descriptions.push('Moneda específica');
  if (filters.requesterId) descriptions.push('Solicitante específico');
  if (filters.approverId) descriptions.push('Aprobador específico');
  if (filters.method) descriptions.push(`Método ${String(filters.method).replaceAll('_',' ')}`);
  if (filters.search) descriptions.push(`Búsqueda: ${String(filters.search).slice(0,80)}`);
  report.header.filterDescription = descriptions.join(' · ') || 'Todos los tipos, estados y dimensiones';
  return report;
}

function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function date(value: string) {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleDateString('es-CR');
}

function formatNumber(value: number) {
  return value.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money(value: number, symbol: string, currency: string) {
  const prefix = symbol || currency;
  return value < 0 ? `(${prefix} ${formatNumber(Math.abs(value))})` : `${prefix} ${formatNumber(value)}`.trim();
}

function currencyTotals(rows: ReportRow[]) {
  const totals = new Map<string, { currency: string; symbol: string; amount: number }>();
  for (const row of rows) {
    const key = row.currency || 'N/D', current = totals.get(key) ?? { currency: key, symbol: row.symbol, amount: 0 };
    current.amount += row.amount; totals.set(key, current);
  }
  return [...totals.values()];
}

function currencyTotalsLabel(rows: ReportRow[]) {
  return currencyTotals(rows).map(total => money(total.amount, total.symbol, total.currency)).join(' · ') || 'Sin importes';
}

function statusClass(status: string) {
  return ['APLICADO', 'APROBADO'].includes(status) ? 'success' : ['RECHAZADO', 'ANULADO'].includes(status) ? 'danger' : 'pending';
}

function pdfHtml(report: NormalizedReport) {
  const { header: h, summary: s } = report;
  const rowHtml = (items: ReportRow[]) => items.map(row => `<tr>
    <td><b>${esc(row.requestNumber)}</b><small>${esc(row.requestTypeLabel)}</small></td>
    <td><span class="badge ${statusClass(row.status)}">${esc(row.statusLabel)}</span></td>
    <td>${esc(date(row.requestDate))}<small>Programada: ${esc(date(row.plannedDate))}</small></td>
    <td><b>${esc(row.thirdParty)}</b><small>${esc([row.thirdPartyType, row.thirdPartyTaxId].filter(Boolean).join(' · '))}</small></td>
    <td>${esc(row.document || row.account || '—')}<small>${esc(row.journalNumber ? `Asiento: ${row.journalNumber}` : '')}</small></td>
    <td>${esc(row.department)}</td><td>${esc(row.costCenter)}</td>
    <td>${esc(row.concept || '—')}<small>${esc(row.requester ? `Solicita: ${row.requester}` : '')}</small></td>
    <td class="num"><b>${esc(money(row.amount, row.symbol, row.currency))}</b></td>
    <td>${esc(row.paymentMethod || '—')}<small>${esc(row.paymentReference)}</small></td>
  </tr>`).join('');
  const groups = [
    ['CXP', 'PAGOS DE CUENTAS POR PAGAR'],
    ['OTROS', 'OTROS PAGOS']
  ] as const;
  const body = groups.map(([type, label]) => {
    const rows = report.rows.filter(row => row.requestType === type);
    if (!rows.length) return '';
    const requests = new Set(rows.map(row => row.requestId || row.requestNumber)).size;
    return `<tr class="group"><td colspan="10">${label}<b>${requests} solicitud${requests === 1 ? '' : 'es'} · ${esc(currencyTotalsLabel(rows))}</b></td></tr>${rowHtml(rows)}`;
  }).join('') || rowHtml(report.rows);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Solicitudes de pago</title><style>
    @page{size:A4 landscape;margin:9mm 8mm 14mm}*{box-sizing:border-box}body{font:7.5pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    header{display:flex;justify-content:space-between;gap:22px;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.company{margin-top:4px;line-height:1.4}.title{text-align:right}.title h1{font-size:16pt;color:#063b79;margin:0}.title p{margin:3px 0;color:#5f6f85}
    .meta{display:flex;justify-content:space-between;gap:14px;background:#f2f6fa;border:1px solid #d9e2ec;border-radius:8px;padding:7px 10px;margin:9px 0}.meta b,.meta small,.metric b,.metric small,td small{display:block}.meta small,.metric small,td small{color:#64748b;margin-top:2px}
    .summary{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:8px 0}.metric{border:1px solid #d8e2ec;border-radius:7px;padding:7px 8px;background:#fff}.metric b{font-size:9.5pt;margin-top:3px}.metric.accent{background:#eaf5f2;border-color:#a9d6c9}.metric.type{background:#f3f0fb;border-color:#d5c9ef}.currency-summary{display:flex;gap:10px;flex-wrap:wrap;border:1px solid #cbd9e6;border-left:4px solid #0d9272;border-radius:7px;background:#f8fbfd;padding:7px 10px;margin:0 0 10px}.currency-summary span{font-weight:800;color:#063b79}
    table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#063b79;color:#fff;padding:6px 4px;text-align:left}td{border-bottom:1px solid #dce4ed;padding:5px 4px;vertical-align:top;overflow-wrap:anywhere}tr{page-break-inside:avoid}.num{text-align:right}.badge{display:inline-block;border-radius:99px;padding:3px 5px;font-size:6.5pt;font-weight:800}.success{background:#dff5ec;color:#08654d}.danger{background:#fde9e7;color:#b42318}.pending{background:#fff0d0;color:#8a5a00}.group td{background:#e9eff6;color:#063b79;font-weight:800;border-top:2px solid #91a5bb;padding:6px}.group b{float:right}.empty{text-align:center;padding:30px;color:#64748b}.note{margin:7px 0;color:#69788d;font-size:6.7pt}.footer{position:fixed;bottom:-9mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;font-size:7pt;display:flex;justify-content:space-between}
  </style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${esc(h.legalName || h.subsidiary)}</b><br>Identificación fiscal: ${esc(h.taxId || 'No registrada')}</div></div><div class="title"><h1>SOLICITUDES DE PAGO</h1><p>${esc(date(h.dateFrom))} al ${esc(date(h.dateTo))}</p><p>Importes separados por moneda</p></div></header>
  <div class="meta"><div><small>Sociedad</small><b>${esc(h.subsidiary)}</b></div><div><small>Filtros aplicados</small><b>${esc(h.filterDescription || 'Todos los tipos, estados y dimensiones')}</b></div><div><small>Generado</small><b>${esc(new Date(h.generatedAt).toLocaleString('es-CR'))}</b></div></div>
  <section class="summary"><div class="metric"><small>Solicitudes</small><b>${s.requestCount}</b></div><div class="metric"><small>Líneas analizadas</small><b>${s.lineCount}</b></div><div class="metric type"><small>Pagos de CxP</small><b>${s.cxpCount}</b></div><div class="metric type"><small>Otros pagos</small><b>${s.otherCount}</b></div><div class="metric"><small>Aprobadas</small><b>${s.approvedCount}</b></div><div class="metric accent"><small>Aplicadas</small><b>${s.appliedCount}</b></div></section>
  <div class="currency-summary"><b>Totales por moneda:</b>${s.byCurrency.map(total => `<span>${esc(total.currency)}: ${esc(money(total.requestAmount,total.symbol,total.currency))} (${total.requestCount} solicitudes)${Math.abs(total.requestAmount-total.analyzedAmount)>.005?` · selección ${esc(money(total.analyzedAmount,total.symbol,total.currency))}`:''}</span>`).join('') || '<span>Sin importes</span>'}</div>
  <table><colgroup><col style="width:10%"><col style="width:8%"><col style="width:8%"><col style="width:13%"><col style="width:11%"><col style="width:9%"><col style="width:9%"><col style="width:14%"><col style="width:10%"><col style="width:8%"></colgroup><thead><tr><th>Solicitud / tipo</th><th>Estado</th><th>Fechas</th><th>Tercero</th><th>Documento / cuenta</th><th>Departamento</th><th>Centro de costo</th><th>Concepto / solicitante</th><th class="num">Importe</th><th>Pago / referencia</th></tr></thead><tbody>${body || '<tr><td colspan="10" class="empty">No hay solicitudes que coincidan con los filtros seleccionados.</td></tr>'}</tbody></table>
  <p class="note">El detalle se presenta por línea para conservar la trazabilidad por tercero, departamento y centro de costo. Los totales se mantienen separados por moneda para evitar sumar importes que no son comparables.</p><div class="footer"><span>GENTIA · Tesorería</span><span>Reporte de solicitudes de pago</span></div></body></html>`;
}

export async function exportPaymentRequestReportPdf(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters);
  const rendered = await renderBankReconciliationPdf({
    html: pdfHtml(report),
    fileName: `solicitudes-de-pago-${report.header.dateFrom || 'inicio'}-${report.header.dateTo || 'corte'}.pdf`
  });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

function excelDate(value: string) {
  if (!value) return '';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : parsed;
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function dimensionSummary(rows: ReportRow[], label: string, selector: (row: ReportRow) => string) {
  const grouped = new Map<string, { dimension: string; currency: string; symbol: string; requests: Set<string>; lines: number; amount: number }>();
  for (const row of rows) {
    const dimension = selector(row) || 'Sin asignar', key = `${dimension}\u0000${row.currency}`;
    const current = grouped.get(key) ?? { dimension, currency: row.currency, symbol: row.symbol, requests: new Set<string>(), lines: 0, amount: 0 };
    current.requests.add(row.requestId || row.requestNumber);
    current.lines += 1;
    current.amount += row.amount;
    grouped.set(key, current);
  }
  return [...grouped.values()].map(totals => ({ label, dimension: totals.dimension, currency: totals.currency, symbol: totals.symbol, requests: totals.requests.size, lines: totals.lines, amount: totals.amount }));
}

export async function exportPaymentRequestReportExcel(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), { header: h, summary: s } = report;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'GENTIA ERP'; workbook.company = h.legalName || h.subsidiary || 'GENTIA'; workbook.created = new Date();
  const sheet = workbook.addWorksheet('Solicitudes de pago', {
    views: [{ state: 'frozen', ySplit: 8 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .2, right: .2, top: .45, bottom: .45, header: .2, footer: .2 } }
  });
  sheet.properties.tabColor = { argb: 'FF063B79' };
  sheet.columns = [{width:20},{width:18},{width:16},{width:14},{width:16},{width:29},{width:18},{width:26},{width:22},{width:22},{width:28},{width:24},{width:23},{width:16},{width:17},{width:18},{width:18},{width:18},{width:20},{width:15}];
  sheet.mergeCells('A1:T1'); const title = sheet.getCell('A1'); title.value = 'GENTIA · REPORTE DE SOLICITUDES DE PAGO'; title.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }; title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; title.alignment = { vertical: 'middle' }; sheet.getRow(1).height = 32;
  sheet.mergeCells('A2:L2'); sheet.getCell('A2').value = h.legalName || h.subsidiary; sheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF14233B' } };
  sheet.mergeCells('M2:T2'); sheet.getCell('M2').value = `Período: ${date(h.dateFrom)} al ${date(h.dateTo)}`; sheet.getCell('M2').alignment = { horizontal: 'right' }; sheet.getCell('M2').font = { bold: true, color: { argb: 'FF063B79' } };
  sheet.mergeCells('A3:T3'); sheet.getCell('A3').value = `Filtros: ${h.filterDescription || 'Todos'} · Totales separados por moneda · Generado ${new Date(h.generatedAt).toLocaleString('es-CR')}`; sheet.getCell('A3').font = { italic: true, color: { argb: 'FF64748B' } };
  const metrics: Array<[string, number]> = [['Solicitudes',s.requestCount],['Líneas',s.lineCount],['Pagos de CxP',s.cxpCount],['Otros pagos',s.otherCount],['Aprobadas',s.approvedCount],['Aplicadas',s.appliedCount]];
  metrics.forEach(([label, amount], index) => {
    const start = 1 + index * 3;
    sheet.mergeCells(5,start,5,start+2); sheet.mergeCells(6,start,6,start+2);
    const labelCell = sheet.getCell(5,start), amountCell = sheet.getCell(6,start);
    labelCell.value = label; amountCell.value = amount;
    labelCell.fill = amountCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 1 ? 'FFEAF5F2' : index === 2 || index === 3 ? 'FFF3F0FB' : 'FFF2F6FA' } };
    labelCell.font = { bold: true, color: { argb: 'FF607086' } }; amountCell.font = { bold: true, size: 13, color: { argb: index === 1 ? 'FF08654D' : 'FF14233B' } };
    labelCell.alignment = amountCell.alignment = { horizontal: 'center' };
  });
  sheet.mergeCells('A7:T7'); sheet.getCell('A7').value = `Totales por moneda: ${s.byCurrency.map(total => `${total.currency} ${formatNumber(total.requestAmount)} (${total.requestCount} solicitudes)${Math.abs(total.requestAmount-total.analyzedAmount)>.005?` · selección ${formatNumber(total.analyzedAmount)}`:''}`).join(' · ') || 'Sin importes'}`; sheet.getCell('A7').font = { italic: true, color: { argb: 'FF52657D' } }; sheet.getCell('A7').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FBFD' } }; sheet.getCell('A7').alignment = { vertical: 'middle', wrapText: true };
  const headers = ['Tipo','N.º solicitud','Estado','Fecha solicitud','Pago programado','Tercero','Tipo tercero','Documento / factura','Cuenta contable','Departamento','Centro de costo','Concepto','Solicitante','Aprobador','Moneda','Importe línea','Total solicitud','Método de pago','Referencia / asiento','Fecha aplicación'];
  const headerRow = sheet.addRow(headers); headerRow.height = 29;
  headerRow.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = border('063B79'); });
  const exportedRequests = new Set<string>();
  for (const row of report.rows) {
    const requestKey = row.requestId || row.requestNumber, firstRequestLine = !exportedRequests.has(requestKey); exportedRequests.add(requestKey);
    const record = sheet.addRow([row.requestTypeLabel,row.requestNumber,row.statusLabel,excelDate(row.requestDate),excelDate(row.plannedDate),row.thirdParty,row.thirdPartyType,row.document,row.account,row.department,row.costCenter,row.concept,row.requester,row.approver,row.currency,row.amount,firstRequestLine?row.requestTotal:null,row.paymentMethod,[row.paymentReference,row.journalNumber && `Asiento ${row.journalNumber}`].filter(Boolean).join(' · '),excelDate(row.appliedDate)]);
    record.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; });
    for (const column of [4,5,20]) record.getCell(column).numFmt = 'dd/mm/yyyy';
    record.getCell(16).numFmt = record.getCell(17).numFmt = '#,##0.00;[Red](#,##0.00)';
    const fill = row.status === 'APLICADO' ? 'FFDFF5EC' : row.status === 'APROBADO' ? 'FFE8F1FA' : ['RECHAZADO','ANULADO'].includes(row.status) ? 'FFFDE9E7' : 'FFFFF4D6';
    record.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; record.getCell(3).font = { bold: true, color: { argb: ['RECHAZADO','ANULADO'].includes(row.status) ? 'FFB42318' : 'FF14233B' } };
    record.getCell(1).font = { bold: true, color: { argb: row.requestType === 'CXP' ? 'FF563C8C' : 'FF08654D' } };
  }
  if (!report.rows.length) { const start = sheet.rowCount + 1; sheet.mergeCells(`A${start}:T${start+1}`); const empty = sheet.getCell(`A${start}`); empty.value = 'No hay solicitudes que coincidan con los filtros seleccionados.'; empty.alignment = { horizontal: 'center', vertical: 'middle' }; empty.font = { italic: true, color: { argb: 'FF64748B' } }; }
  sheet.autoFilter = 'A8:T8'; sheet.headerFooter.oddFooter = 'GENTIA · Solicitudes de pago                                      Página &P de &N';

  const analytics = workbook.addWorksheet('Resumen analítico', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  analytics.properties.tabColor = { argb: 'FF0D9272' }; analytics.columns = [{width:24},{width:42},{width:14},{width:18},{width:16},{width:22}];
  analytics.mergeCells('A1:F1'); analytics.getCell('A1').value = 'RESUMEN POR DIMENSIONES'; analytics.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }; analytics.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; analytics.getRow(1).height = 30;
  const analyticalHeader = analytics.addRow(['Dimensión','Valor','Moneda','Solicitudes','Líneas','Importe']); analyticalHeader.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D9272' } }; cell.border = border('0D9272'); });
  const dimensionRows = [
    ...dimensionSummary(report.rows,'Tipo de solicitud',row => row.requestTypeLabel),
    ...dimensionSummary(report.rows,'Estado',row => row.statusLabel),
    ...dimensionSummary(report.rows,'Tercero',row => row.thirdParty),
    ...dimensionSummary(report.rows,'Departamento',row => row.department),
    ...dimensionSummary(report.rows,'Centro de costo',row => row.costCenter)
  ];
  for (const item of dimensionRows) { const record = analytics.addRow([item.label,item.dimension,item.currency,item.requests,item.lines,item.amount]); record.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; }); record.getCell(6).numFmt = '#,##0.00;[Red](#,##0.00)'; }
  analytics.autoFilter = 'A2:F2'; analytics.headerFooter.oddFooter = 'GENTIA · Resumen analítico                                      Página &P de &N';
  const content = await workbook.xlsx.writeBuffer();
  return { fileName: `solicitudes-de-pago-${h.dateFrom || 'inicio'}-${h.dateTo || 'corte'}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(content) };
}
