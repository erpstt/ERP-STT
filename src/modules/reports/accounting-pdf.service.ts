import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRoleAccess } from '../security-catalogs/role-access-matrix.module.js';
import { accountingReportOptions, bankReconciliationAction, renderBankReconciliationPdf, runAccountingReport } from './accounting-reports.service.js';
import { incomeForecastAction } from './income-forecast.service.js';

type Row = Record<string, any>;
export type AccountingPdfKind = 'bank' | 'pending' | 'forecast';
function invalid(message = 'Envíe los filtros del informe; no se admite HTML ni contenido compilado.'): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Los parámetros del PDF no son válidos.');
  return value as Row;
}
export function validateAccountingPdfRequest(kind: AccountingPdfKind, input: unknown): Row {
  const p = object(input);
  const allowed = kind === 'bank' ? ['kind', 'filters', 'bankAccountId', 'cutoff', 'mode'] : kind === 'pending' ? ['filters', 'closed', 'periodType'] : ['configuration', 'scenarioId'];
  if (Object.keys(p).some(key => !allowed.includes(key))) return invalid();
  if (kind === 'bank' && p.kind === 'bank-reconciliation') {
    if (!Number.isSafeInteger(p.bankAccountId) || p.bankAccountId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(p.cutoff ?? '') || !['SUMMARY', 'DETAIL'].includes(p.mode)) return invalid('Seleccione una cuenta, fecha y formato de conciliación válidos.');
  } else if (kind === 'bank' && p.kind === 'bank-balances') object(p.filters);
  else if (kind === 'bank') return invalid('El tipo de informe PDF no es válido.');
  if (kind === 'pending') {
    object(p.filters);
    if (typeof p.closed !== 'boolean' || !['', 'ACTUAL', 'ANTERIOR'].includes(p.periodType ?? '')) return invalid('Seleccione una vista de pendientes válida.');
  }
  if (kind === 'forecast') {
    object(p.configuration);
    if (p.scenarioId != null && (!Number.isSafeInteger(Number(p.scenarioId)) || Number(p.scenarioId) <= 0)) return invalid('El escenario no es válido.');
  }
  return p;
}

// Módulos puros y rutas fijas del despliegue. Ninguna ruta de plantilla procede del cliente.
const templates = () => Promise.all(['bank-report-pdf.js', 'pending-invoice-pdf.js', 'income-forecast-export.js'].map(name => import(pathToFileURL(join(process.cwd(), 'public', name)).href)));
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];
const find = (value: unknown, id: unknown) => rows(value).find(row => String(row.id) === String(id));

export async function renderAccountingPdf(auth: string, kind: AccountingPdfKind, input: unknown) {
  const p = validateAccountingPdfRequest(kind, input);
  await assertRoleAccess(auth, 'reports:accounting-reports', 'view');
  const [bank, pending, forecast] = await templates();
  if (kind === 'bank' && p.kind === 'bank-reconciliation') {
    const response = object(await bankReconciliationAction(auth, 'close-report', { p_bank_account_id: p.bankAccountId, p_cutoff: p.cutoff }));
    const report = object(response.result ?? response);
    const folio = String(report.header?.code ?? `CON-BAN-${report.header?.reconciliationId ?? 'REPORTE'}`);
    return renderBankReconciliationPdf({ html: bank.bankCloseReportHtml(report, p.mode), fileName: `${folio}-${p.mode === 'DETAIL' ? 'detallado' : 'resumen'}.pdf` });
  }
  if (kind === 'forecast') {
    const configuration = object(p.configuration);
    const options = object(await incomeForecastAction(auth, 'options', { consolidated: configuration.consolidated === true }));
    const report = object(await incomeForecastAction(auth, 'generate', configuration));
    const scenario = p.scenarioId == null ? null : find(options.scenarios, p.scenarioId);
    if (p.scenarioId != null && !scenario) return invalid('El escenario no está disponible para esta sesión.');
    const sources: Row = { DEPARTMENT: options.reportDepartments ?? options.departments, CLASS: options.reportClasses ?? options.classes, LOCATION: options.locations, COST_CENTER: options.reportCostCenters ?? options.costCenters, SUBSIDIARY: options.subsidiaries };
    const dimensionName = (id: unknown) => id === 'eliminations' ? 'Eliminaciones' : id === 'unassigned' ? 'Sin asignar' : id === 'total' ? 'Total' : find(sources[report.columnView], id)?.name ?? String(id);
    const label = (source: unknown, id: unknown) => find(source, id)?.name ?? String(id ?? 'Todos');
    const filters = [
      ['Sociedades', rows(report.companies).map(row => row.name).join(' / ')], ['Ejercicio', label(options.years, configuration.fiscalYearId)], ['Corte real', report.cutoff],
      ['Metodología', report.method], ['Moneda', report.currency], ['Libro', configuration.bookId ? label(options.books, configuration.bookId) : 'Principal por sociedad'],
      ['Departamento', configuration.departmentId ? label(options.reportDepartments ?? options.departments, configuration.departmentId) : 'Todos'],
      ['Ubicación', configuration.locationId ? label(options.locations, configuration.locationId) : 'Todas'], ['Clase', configuration.classId ? label(options.reportClasses ?? options.classes, configuration.classId) : 'Todas'],
      ['Centro de costo', configuration.costCenterId ? label(options.reportCostCenters ?? options.costCenters, configuration.costCenterId) : 'Todos'], ['Nivel de detalle', configuration.hierarchy], ['Excluir cierres', configuration.excludeClosing ? 'Sí' : 'No'],
    ];
    return renderBankReconciliationPdf({ html: forecast.forecastPdfHtml(report, { filters, scenario: scenario?.name ?? '', dimensionName, overrides: report.overrides ?? {} }), fileName: `resultados-proyectados-${report.cutoff}.pdf` });
  }
  const filters = object(p.filters);
  const options = await accountingReportOptions(auth) as Row;
  const company = find(options.subsidiaries, filters.subsidiaryIds?.[0]);
  if (!company) return invalid('Seleccione una subsidiaria disponible para la sesión.');
  if (kind === 'bank') {
    const report = object(await runAccountingReport(auth, 'bank-balances', filters));
    return renderBankReconciliationPdf({ html: bank.bankBalancesPdfHtml(report, company), fileName: `saldos-bancarios-${report.period?.end ?? 'periodo'}.pdf` });
  }
  const report = object(await runAccountingReport(auth, 'pending-invoice-control', filters));
  const selectedPeriod = p.periodType ?? '';
  const selectedRows = rows(report.rows).filter(row => {
    const period = String(row.periodType ?? row.tipo_periodo ?? row.period_type ?? 'ACTUAL').toUpperCase() === 'ANTERIOR' ? 'ANTERIOR' : 'ACTUAL';
    return (p.closed ? row.status === 'REVERSADO_TOTAL' : ['PENDIENTE', 'REVERSADO_PARCIAL'].includes(row.status)) && (!selectedPeriod || period === selectedPeriod);
  });
  const currency = filters.consolidated ? { code: 'USD', name: 'Dólar estadounidense', symbol: 'US$' } : find(options.currencies, company.currencyId) ?? {};
  const customer = filters.pendingCustomerId ? find(options.pendingInvoiceOptions?.customers, filters.pendingCustomerId)?.name ?? 'Cliente seleccionado' : 'Todos los clientes';
  const html = pending.pendingInvoicePdfHtml({ rows: selectedRows, company: filters.consolidated ? { name: 'Todas las empresas autorizadas' } : company, currency, from: filters.dateFrom, to: filters.dateTo, customer, closed: p.closed, periodType: selectedPeriod });
  return renderBankReconciliationPdf({ html, fileName: `control-pendientes-${p.closed ? 'reversados' : 'pendientes-parciales'}-${filters.dateTo}.pdf` });
}
