import ExcelJS from 'exceljs';
import { fetchSupabase, getSupabaseConfig } from '../../core/database/supabase.client.js';
import { renderBankReconciliationPdf } from './accounting-reports.service.js';

type Json = Record<string, unknown>;
type ExportFile = { fileName: string; mimeType: string; buffer: Buffer };

type TaxRow = {
  id: string;
  side: 'SALES' | 'PURCHASES';
  documentType: string;
  documentNumber: string;
  date: string;
  partyName: string;
  partyTaxId: string;
  taxCode: string;
  taxDescription: string;
  taxRate: number;
  currency: string;
  symbol: string;
  exchangeRate: number;
  taxableBase: number;
  exemptAmount: number;
  taxAmount: number;
  grossAmount: number;
  originalBase: number;
  originalTax: number;
  originalGross: number;
  journalId: string;
  sourceLineId: string;
  account: string;
  department: string;
  costCenter: string;
  status: string;
  note: string;
};

type RateSummary = {
  label: string;
  rate: number;
  salesBase: number;
  outputTax: number;
  purchaseBase: number;
  inputTax: number;
  balance: number;
};

type NormalizedReport = {
  header: {
    subsidiary: string;
    legalName: string;
    taxId: string;
    country: string;
    taxName: string;
    periodLabel: string;
    dateFrom: string;
    dateTo: string;
    currency: string;
    symbol: string;
    generatedAt: string;
    includeAdjustments: boolean;
    documentStatuses: string;
  };
  summary: {
    salesDocumentCount: number;
    purchaseDocumentCount: number;
    salesTaxableBase: number;
    salesExemptBase: number;
    salesGrossAmount: number;
    outputTax: number;
    purchaseTaxableBase: number;
    purchaseExemptBase: number;
    purchaseGrossAmount: number;
    inputTax: number;
    debitAdjustments: number;
    creditAdjustments: number;
    grossTax: number;
    vatWithheldSuffered: number;
    vatWithheldPracticed: number;
    priorPeriodCredit: number;
    netTax: number;
    position: string;
    taxPayable: number;
    taxCreditBalance: number;
    warnings: string[];
  };
  rates: RateSummary[];
  sales: TaxRow[];
  purchases: TaxRow[];
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
      : 'No fue posible generar el reporte de IVA/GCT.';
    throw new Error(message);
  }
  return result as T;
}

export function vatDeclarationReportOptions(authorization: string) {
  return rpc<Json>(authorization, 'vat_declaration_report_options');
}

export function runVatDeclarationReport(authorization: string, filters: Json) {
  return rpc<Json>(authorization, 'run_vat_declaration_report', { p_filters: filters });
}

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}

function first(source: Json, ...keys: string[]) {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function string(source: Json, ...keys: string[]) {
  const found = first(source, ...keys);
  return found === undefined || found === null ? '' : String(found);
}

function number(source: Json, ...keys: string[]) {
  const parsed = Number(first(source, ...keys) ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(source: Json, ...keys: string[]) {
  const found = first(source, ...keys);
  return found === true || found === 1 || String(found).toLowerCase() === 'true';
}

function has(source: Json, ...keys: string[]) {
  return keys.some(key => source[key] !== undefined && source[key] !== null && source[key] !== '');
}

function nestedString(source: Json, keys: string[], nestedKeys: string[] = ['name', 'label', 'code']) {
  const found = first(source, ...keys);
  if (typeof found === 'object' && found !== null && !Array.isArray(found)) return string(found as Json, ...nestedKeys);
  return found === undefined || found === null ? '' : String(found);
}

function arrayLabel(source: Json, keys: string[]) {
  const found = first(source, ...keys);
  if (!Array.isArray(found)) return '';
  return found.map(item => nestedString(object(item), ['name', 'label', 'code', 'number'])).filter(Boolean).join(', ');
}

function asArray(value: unknown): Json[] {
  if (Array.isArray(value)) return value.map(object);
  const source = object(value);
  const rows = first(source, 'rows', 'data', 'details', 'items', 'lines');
  if (Array.isArray(rows)) return rows.map(object);
  return [];
}

function asNestedArray(value: unknown): Json[] {
  const direct = asArray(value);
  if (direct.length) return direct;
  const source = object(value);
  return Object.values(source).flatMap(item => Array.isArray(item) ? item.map(object) : asArray(item));
}

function detailRows(payload: Json, side: 'SALES' | 'PURCHASES') {
  const sectionKeys = side === 'SALES' ? ['sales', 'ventas', 'outputTax', 'output_tax'] : ['purchases', 'compras', 'inputTax', 'input_tax'];
  const sectionValue = first(payload, ...sectionKeys), section = object(sectionValue);
  const candidates: Json[][] = [asNestedArray(first(section, 'details', 'drilldown', 'lines'))];
  for (const containerKey of ['details', 'drilldown']) {
    const container = first(payload, containerKey);
    if (Array.isArray(container)) {
      candidates.push(container.map(object).filter(row => {
        const kind = string(row, 'side', 'kind', 'type', 'section', 'source').toUpperCase();
        return side === 'SALES' ? /SALE|VENTA|OUTPUT|D[EÉ]BITO/.test(kind) : /PURCHASE|COMPRA|INPUT|CR[EÉ]DITO/.test(kind);
      }));
    } else {
      const nested = object(container);
      candidates.push(asNestedArray(first(nested, ...sectionKeys)));
    }
  }
  const detailed = candidates.find(rows => rows.length);
  if (detailed?.length) return detailed;
  const sectionRows = asNestedArray(first(section, 'rows', 'data', 'items'));
  return sectionRows.length ? sectionRows : asNestedArray(sectionValue);
}

function normalizeRow(source: Json, side: 'SALES' | 'PURCHASES', header: NormalizedReport['header']): TaxRow {
  const currencyObject = object(first(source, 'currency', 'moneda'));
  const accountNumber = string(source, 'accountNumber', 'account_number', 'numeroCuenta', 'numero_cuenta');
  const accountName = string(source, 'accountName', 'account_name', 'nombreCuenta', 'nombre_cuenta');
  const rawBase = number(source, 'taxableBaseLocal', 'taxable_base_local', 'baseAmountLocal', 'base_amount_local', 'localTaxableBase', 'local_taxable_base', 'taxableBase', 'taxable_base', 'baseAmount', 'base_amount', 'netAmount', 'net_amount', 'base');
  const tax = number(source, 'taxAmountLocal', 'tax_amount_local', 'localTaxAmount', 'local_tax_amount', 'taxAmount', 'tax_amount', 'vatAmount', 'vat_amount', 'gctAmount', 'gct_amount', 'impuesto');
  const rate = number(source, 'taxRate', 'tax_rate', 'ratePercentage', 'rate_percentage', 'rate', 'tasa');
  const explicitExempt = number(source, 'exemptAmountLocal', 'exempt_amount_local', 'localExemptAmount', 'local_exempt_amount', 'exemptAmount', 'exempt_amount', 'zeroRatedAmount', 'zero_rated_amount', 'montoExento');
  const exempt = explicitExempt || (rate === 0 && tax === 0 ? rawBase : 0), base = exempt && !explicitExempt ? 0 : rawBase;
  const total = number(source, 'grossAmountLocal', 'gross_amount_local', 'localGrossAmount', 'local_gross_amount', 'grossAmount', 'gross_amount', 'totalAmount', 'total_amount', 'total') || base + exempt + tax;
  const hasLocalBase = has(source, 'taxableBaseLocal', 'taxable_base_local', 'baseAmountLocal', 'base_amount_local', 'localTaxableBase', 'local_taxable_base');
  const hasLocalTax = has(source, 'taxAmountLocal', 'tax_amount_local', 'localTaxAmount', 'local_tax_amount');
  return {
    id: string(source, 'lineId', 'line_id', 'detailId', 'detail_id', 'id'),
    side,
    documentType: string(source, 'documentTypeLabel', 'document_type_label', 'documentType', 'document_type', 'typeLabel', 'type_label', 'tipoDocumento', 'tipo_documento'),
    documentNumber: string(source, 'documentNumber', 'document_number', 'invoiceNumber', 'invoice_number', 'noteNumber', 'note_number', 'numeroDocumento', 'numero_documento', 'number'),
    date: string(source, 'documentDate', 'document_date', 'invoiceDate', 'invoice_date', 'noteDate', 'note_date', 'date', 'fecha'),
    partyName: string(source, 'partyName', 'party_name', side === 'SALES' ? 'customerName' : 'supplierName', side === 'SALES' ? 'customer_name' : 'supplier_name', 'thirdParty', 'third_party', 'tercero'),
    partyTaxId: string(source, 'partyTaxId', 'party_tax_id', side === 'SALES' ? 'customerTaxId' : 'supplierTaxId', side === 'SALES' ? 'customer_tax_id' : 'supplier_tax_id', 'taxId', 'tax_id', 'identification'),
    taxCode: string(source, 'taxCode', 'tax_code', 'taxCodeName', 'tax_code_name', 'codeName', 'code_name', 'codigoImpuesto', 'codigo_impuesto') || (tax === 0 ? 'Exento / 0%' : 'Impuesto'),
    taxDescription: string(source, 'taxDescription', 'tax_description', 'description', 'descripcion'),
    taxRate: rate,
    currency: string(source, 'currencyCode', 'currency_code') || string(currencyObject, 'code', 'currencyCode', 'currency_code') || header.currency,
    symbol: string(source, 'currencySymbol', 'currency_symbol', 'symbol') || string(currencyObject, 'symbol') || header.symbol,
    exchangeRate: number(source, 'exchangeRate', 'exchange_rate', 'rateOfExchange', 'rate_of_exchange', 'tipoCambio', 'tipo_cambio') || 1,
    taxableBase: base,
    exemptAmount: exempt,
    taxAmount: tax,
    grossAmount: total,
    originalBase: number(source, 'originalBase', 'original_base', 'taxableBaseOriginal', 'taxable_base_original', 'originalTaxableBase', 'original_taxable_base', 'foreignTaxableBase', 'foreign_taxable_base') || (hasLocalBase ? number(source, 'taxableBase', 'taxable_base', 'baseAmount', 'base_amount', 'netAmount', 'net_amount', 'base') : rawBase),
    originalTax: number(source, 'originalTax', 'original_tax', 'taxAmountOriginal', 'tax_amount_original', 'originalTaxAmount', 'original_tax_amount', 'foreignTaxAmount', 'foreign_tax_amount') || (hasLocalTax ? number(source, 'taxAmount', 'tax_amount', 'vatAmount', 'vat_amount', 'gctAmount', 'gct_amount', 'impuesto') : tax),
    originalGross: number(source, 'originalGross', 'original_gross', 'grossAmountOriginal', 'gross_amount_original', 'originalGrossAmount', 'original_gross_amount', 'foreignGrossAmount', 'foreign_gross_amount') || total,
    journalId: string(source, 'journalNumber', 'journal_number', 'journalId', 'journal_id', 'asiento'),
    sourceLineId: string(source, 'sourceLineId', 'source_line_id', 'lineId', 'line_id'),
    account: [accountNumber, accountName].filter(Boolean).join(' · ') || arrayLabel(source, ['accounts']),
    department: string(source, 'departmentName', 'department_name', 'department', 'departamento') || arrayLabel(source, ['departments']) || 'Sin departamento',
    costCenter: string(source, 'costCenterName', 'cost_center_name', 'costCenter', 'cost_center', 'centroCosto', 'centro_costo') || arrayLabel(source, ['costCenters', 'cost_centers']) || 'General',
    status: string(source, 'statusLabel', 'status_label', 'status', 'estado'),
    note: string(source, 'description', 'concept', 'concepto', 'note', 'nota', 'memo')
  };
}

function uniqueDocuments(rows: TaxRow[]) {
  return new Set(rows.map(row => `${row.documentType}\u0000${row.documentNumber}`).filter(value => value !== '\u0000')).size;
}

function monthLabel(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) return value;
  const parsed = new Date(`${value}-01T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleDateString('es-CR', { month: 'long', year: 'numeric' });
}

function rateSummaries(summary: Json, sales: TaxRow[], purchases: TaxRow[], payload: Json) {
  const source = first(summary, 'byTaxRate', 'by_tax_rate', 'taxRates', 'tax_rates', 'byRate', 'by_rate', 'rates');
  if (Array.isArray(source) && source.length) return source.map(item => {
    const row = object(item), salesBase = number(row, 'salesBase', 'sales_base', 'outputBase', 'output_base', 'ventasBase', 'ventas_base'), outputTax = number(row, 'outputTax', 'output_tax', 'salesTax', 'sales_tax', 'debitoFiscal', 'debito_fiscal'), purchaseBase = number(row, 'purchaseBase', 'purchase_base', 'inputBase', 'input_base', 'comprasBase', 'compras_base'), inputTax = number(row, 'inputTax', 'input_tax', 'purchaseTax', 'purchase_tax', 'creditoFiscal', 'credito_fiscal');
    return { label: string(row, 'label', 'taxCode', 'tax_code', 'code', 'name'), rate: number(row, 'rate', 'taxRate', 'tax_rate'), salesBase, outputTax, purchaseBase, inputTax, balance: has(row, 'balance', 'netTax', 'net_tax') ? number(row, 'balance', 'netTax', 'net_tax') : outputTax - inputTax };
  });
  const salesRates = asArray(first(object(first(payload, 'sales', 'ventas')), 'rows', 'data', 'items'));
  const purchaseRates = asArray(first(object(first(payload, 'purchases', 'compras')), 'rows', 'data', 'items'));
  if (salesRates.length || purchaseRates.length) {
    const grouped = new Map<string, RateSummary>();
    const add = (sourceRow: Json, side: 'SALES' | 'PURCHASES') => {
      const label = string(sourceRow, 'taxCode', 'tax_code', 'code', 'label', 'description'), rate = number(sourceRow, 'rate', 'taxRate', 'tax_rate'), key = `${label}\u0000${rate}`;
      const current = grouped.get(key) ?? { label, rate, salesBase: 0, outputTax: 0, purchaseBase: 0, inputTax: 0, balance: 0 };
      if (side === 'SALES') { current.salesBase += number(sourceRow, 'baseAmount', 'base_amount', 'salesBase', 'sales_base'); current.outputTax += number(sourceRow, 'taxAmount', 'tax_amount', 'salesTax', 'sales_tax'); }
      else { current.purchaseBase += number(sourceRow, 'baseAmount', 'base_amount', 'purchaseBase', 'purchase_base'); current.inputTax += number(sourceRow, 'taxAmount', 'tax_amount', 'purchaseTax', 'purchase_tax'); }
      current.balance = current.outputTax - current.inputTax; grouped.set(key, current);
    };
    salesRates.forEach(row => add(row, 'SALES')); purchaseRates.forEach(row => add(row, 'PURCHASES'));
    return [...grouped.values()].sort((left, right) => right.rate - left.rate || left.label.localeCompare(right.label, 'es'));
  }
  const grouped = new Map<string, RateSummary>();
  for (const row of [...sales, ...purchases]) {
    const key = `${row.taxCode}\u0000${row.taxRate}`, current = grouped.get(key) ?? { label: row.taxCode, rate: row.taxRate, salesBase: 0, outputTax: 0, purchaseBase: 0, inputTax: 0, balance: 0 };
    if (row.side === 'SALES') { current.salesBase += row.taxableBase; current.outputTax += row.taxAmount; }
    else { current.purchaseBase += row.taxableBase; current.inputTax += row.taxAmount; }
    current.balance = current.outputTax - current.inputTax; grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) => right.rate - left.rate || left.label.localeCompare(right.label, 'es'));
}

function normalizeReport(payload: Json): NormalizedReport {
  const sourceHeader = object(first(payload, 'header', 'encabezado'));
  const subsidiary = object(first(sourceHeader, 'subsidiary', 'company', 'sociedad'));
  const currency = object(first(sourceHeader, 'currency', 'moneda'));
  const rawPeriod = string(sourceHeader, 'periodMonth', 'period_month', 'periodLabel', 'period_label', 'period', 'periodo');
  const statuses = first(sourceHeader, 'documentStatuses', 'document_statuses');
  const header: NormalizedReport['header'] = {
    subsidiary: string(sourceHeader, 'subsidiaryName', 'subsidiary_name', 'companyName', 'company_name') || nestedString(sourceHeader, ['subsidiary', 'company', 'sociedad']),
    legalName: string(sourceHeader, 'legalName', 'legal_name') || string(subsidiary, 'legalName', 'legal_name', 'name'),
    taxId: string(sourceHeader, 'taxId', 'tax_id', 'identification', 'identificacion') || string(subsidiary, 'taxId', 'tax_id'),
    country: string(sourceHeader, 'countryName', 'country_name', 'countryCode', 'country_code', 'country', 'pais'),
    taxName: string(sourceHeader, 'taxName', 'tax_name', 'taxTypeName', 'tax_type_name', 'taxLabel', 'tax_label', 'taxType', 'tax_type') || 'IVA / GCT',
    periodLabel: monthLabel(rawPeriod),
    dateFrom: string(sourceHeader, 'dateFrom', 'date_from', 'periodStart', 'period_start', 'startDate', 'start_date', 'desde'),
    dateTo: string(sourceHeader, 'dateTo', 'date_to', 'periodEnd', 'period_end', 'endDate', 'end_date', 'hasta'),
    currency: string(sourceHeader, 'currencyCode', 'currency_code', 'baseCurrencyCode', 'base_currency_code') || string(currency, 'code', 'currencyCode', 'currency_code'),
    symbol: string(sourceHeader, 'currencySymbol', 'currency_symbol', 'baseCurrencySymbol', 'base_currency_symbol', 'symbol') || string(currency, 'symbol'),
    generatedAt: string(sourceHeader, 'generatedAt', 'generated_at') || new Date().toISOString(),
    includeAdjustments: boolean(sourceHeader, 'includeAdjustments', 'include_adjustments'),
    documentStatuses: Array.isArray(statuses) ? statuses.map(String).join(', ') : String(statuses ?? '')
  };
  const sales = detailRows(payload, 'SALES').map(row => normalizeRow(row, 'SALES', header));
  const purchases = detailRows(payload, 'PURCHASES').map(row => normalizeRow(row, 'PURCHASES', header));
  const sourceSummary = object(first(payload, 'summary', 'resumen'));
  const salesTaxableBase = sales.length
    ? sales.reduce((sum, row) => sum + row.taxableBase, 0)
    : number(sourceSummary, 'salesTaxableBase', 'sales_taxable_base', 'outputTaxableBase', 'output_taxable_base', 'salesBase', 'sales_base', 'ventasGravadas', 'ventas_gravadas');
  const salesExemptBase = sales.length
    ? sales.reduce((sum, row) => sum + row.exemptAmount, 0)
    : number(sourceSummary, 'salesExemptBase', 'sales_exempt_base', 'salesExemptAmount', 'sales_exempt_amount', 'ventasExentas', 'ventas_exentas');
  const outputTax = has(sourceSummary, 'salesTax', 'sales_tax', 'outputTax', 'output_tax', 'salesTaxAmount', 'sales_tax_amount', 'taxCollected', 'tax_collected', 'debitoFiscal', 'debito_fiscal') ? number(sourceSummary, 'salesTax', 'sales_tax', 'outputTax', 'output_tax', 'salesTaxAmount', 'sales_tax_amount', 'taxCollected', 'tax_collected', 'debitoFiscal', 'debito_fiscal') : sales.reduce((sum, row) => sum + row.taxAmount, 0);
  const purchaseTaxableBase = purchases.length
    ? purchases.reduce((sum, row) => sum + row.taxableBase, 0)
    : number(sourceSummary, 'purchaseTaxableBase', 'purchase_taxable_base', 'inputTaxableBase', 'input_taxable_base', 'purchaseBase', 'purchase_base', 'comprasGravadas', 'compras_gravadas');
  const purchaseExemptBase = purchases.length
    ? purchases.reduce((sum, row) => sum + row.exemptAmount, 0)
    : number(sourceSummary, 'purchaseExemptBase', 'purchase_exempt_base', 'purchaseExemptAmount', 'purchase_exempt_amount', 'comprasExentas', 'compras_exentas');
  const inputTax = has(sourceSummary, 'purchaseTax', 'purchase_tax', 'inputTax', 'input_tax', 'purchaseTaxAmount', 'purchase_tax_amount', 'taxPaid', 'tax_paid', 'creditoFiscal', 'credito_fiscal') ? number(sourceSummary, 'purchaseTax', 'purchase_tax', 'inputTax', 'input_tax', 'purchaseTaxAmount', 'purchase_tax_amount', 'taxPaid', 'tax_paid', 'creditoFiscal', 'credito_fiscal') : purchases.reduce((sum, row) => sum + row.taxAmount, 0);
  const debitAdjustments = number(sourceSummary, 'debitAdjustments', 'debit_adjustments', 'debitNoteTax', 'debit_note_tax', 'ajustesDebito', 'ajustes_debito');
  const creditAdjustments = number(sourceSummary, 'creditAdjustments', 'credit_adjustments', 'creditNoteTax', 'credit_note_tax', 'ajustesCredito', 'ajustes_credito');
  const grossTax = has(sourceSummary, 'grossTax', 'gross_tax') ? number(sourceSummary, 'grossTax', 'gross_tax') : outputTax - inputTax;
  const vatWithheldSuffered = number(sourceSummary, 'vatWithheldSuffered', 'vat_withheld_suffered', 'withheldSuffered', 'withheld_suffered');
  const vatWithheldPracticed = number(sourceSummary, 'vatWithheldPracticed', 'vat_withheld_practiced', 'withheldPracticed', 'withheld_practiced');
  const priorPeriodCredit = number(sourceSummary, 'priorPeriodCredit', 'prior_period_credit', 'previousCredit', 'previous_credit');
  const calculatedNet = grossTax - vatWithheldSuffered - vatWithheldPracticed - priorPeriodCredit + debitAdjustments - creditAdjustments;
  const netTax = has(sourceSummary, 'netTax', 'net_tax') ? number(sourceSummary, 'netTax', 'net_tax') : calculatedNet;
  const taxPayable = has(sourceSummary, 'payableAmount', 'payable_amount', 'taxPayable', 'tax_payable', 'amountPayable', 'amount_payable', 'impuestoPorPagar', 'impuesto_por_pagar') ? number(sourceSummary, 'payableAmount', 'payable_amount', 'taxPayable', 'tax_payable', 'amountPayable', 'amount_payable', 'impuestoPorPagar', 'impuesto_por_pagar') : Math.max(netTax, 0);
  const taxCreditBalance = has(sourceSummary, 'favorAmount', 'favor_amount', 'taxCreditBalance', 'tax_credit_balance', 'creditBalance', 'credit_balance', 'saldoFavor', 'saldo_favor') ? number(sourceSummary, 'favorAmount', 'favor_amount', 'taxCreditBalance', 'tax_credit_balance', 'creditBalance', 'credit_balance', 'saldoFavor', 'saldo_favor') : Math.max(-netTax, 0);
  const summary: NormalizedReport['summary'] = {
    salesDocumentCount: number(sourceSummary, 'salesDocumentCount', 'sales_document_count', 'salesCount', 'sales_count') || uniqueDocuments(sales),
    purchaseDocumentCount: number(sourceSummary, 'purchaseDocumentCount', 'purchase_document_count', 'purchaseCount', 'purchase_count') || uniqueDocuments(purchases),
    salesTaxableBase, salesExemptBase,
    salesGrossAmount: has(sourceSummary, 'salesGross', 'sales_gross', 'salesGrossAmount', 'sales_gross_amount', 'grossSales', 'gross_sales') ? number(sourceSummary, 'salesGross', 'sales_gross', 'salesGrossAmount', 'sales_gross_amount', 'grossSales', 'gross_sales') : sales.reduce((sum, row) => sum + row.grossAmount, 0),
    outputTax, purchaseTaxableBase, purchaseExemptBase,
    purchaseGrossAmount: has(sourceSummary, 'purchaseGross', 'purchase_gross', 'purchaseGrossAmount', 'purchase_gross_amount', 'grossPurchases', 'gross_purchases') ? number(sourceSummary, 'purchaseGross', 'purchase_gross', 'purchaseGrossAmount', 'purchase_gross_amount', 'grossPurchases', 'gross_purchases') : purchases.reduce((sum, row) => sum + row.grossAmount, 0),
    inputTax, debitAdjustments, creditAdjustments, grossTax, vatWithheldSuffered, vatWithheldPracticed, priorPeriodCredit, netTax,
    position: string(sourceSummary, 'position', 'positionCode', 'position_code'), taxPayable, taxCreditBalance,
    warnings: Array.isArray(first(sourceSummary, 'warnings', 'alertas')) ? (first(sourceSummary, 'warnings', 'alertas') as unknown[]).map(String) : []
  };
  return { header, summary, rates: rateSummaries(sourceSummary, sales, purchases, payload), sales, purchases };
}

async function fullReport(authorization: string, filters: Json) {
  const payload = await runVatDeclarationReport(authorization, { ...filters, export: true, includeDetails: true, page: 1, pageSize: 100000, limit: 100000 });
  return normalizeReport(payload);
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
  return Math.abs(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money(value: number, header: NormalizedReport['header']) {
  const prefix = header.symbol || header.currency;
  return value < 0 ? `(${prefix} ${formatNumber(value)})` : `${prefix} ${formatNumber(value)}`.trim();
}

function safeDatePart(value: string) {
  return value.replace(/[^0-9A-Za-z_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'periodo';
}

function pdfRows(rows: TaxRow[], header: NormalizedReport['header']) {
  return rows.map(row => `<tr><td>${esc(date(row.date))}</td><td><b>${esc(row.documentNumber || '—')}</b><small>${esc(row.documentType)}</small></td><td><b>${esc(row.partyName || '—')}</b><small>${esc(row.partyTaxId)}</small></td><td>${esc(row.taxCode)}<small>${row.taxRate.toLocaleString('es-CR',{maximumFractionDigits:4})}%</small></td><td class="num">${esc(money(row.taxableBase,header))}</td><td class="num">${esc(money(row.exemptAmount,header))}</td><td class="num tax">${esc(money(row.taxAmount,header))}</td><td class="num">${esc(money(row.grossAmount,header))}</td></tr>`).join('');
}

function pdfHtml(report: NormalizedReport) {
  const { header: h, summary: s } = report, net = s.netTax;
  const rateRows = report.rates.map(row => `<tr><td><b>${esc(row.label || 'Sin código')}</b><small>${row.rate.toLocaleString('es-CR',{maximumFractionDigits:4})}%</small></td><td class="num">${esc(money(row.salesBase,h))}</td><td class="num">${esc(money(row.outputTax,h))}</td><td class="num">${esc(money(row.purchaseBase,h))}</td><td class="num">${esc(money(row.inputTax,h))}</td><td class="num result">${esc(money(row.balance,h))}</td></tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(h.taxName)} · ${esc(h.periodLabel)}</title><style>
  @page{size:A4 landscape;margin:9mm 8mm 14mm}*{box-sizing:border-box}body{font:7.5pt Arial,sans-serif;color:#14233b;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}header{display:flex;justify-content:space-between;gap:24px;border-bottom:4px solid #f26a3d;padding-bottom:9px}.brand{font-size:20pt;font-weight:900;letter-spacing:4px;color:#063b79}.company{margin-top:5px;line-height:1.4}.title{text-align:right}.title h1{font-size:16pt;color:#063b79;margin:0}.title p{margin:3px 0;color:#5f6f85}.meta{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:7px;margin:9px 0}.meta div,.metric{border:1px solid #d8e2ec;border-radius:7px;padding:7px 9px;background:#f8fbfd}.meta small,.meta b,.metric small,.metric b,td small{display:block}.meta small,.metric small,td small{color:#64748b}.meta b,.metric b{margin-top:3px}.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin:8px 0}.metric{background:#fff}.metric b{font-size:10pt}.metric.output{background:#fff4e8;border-color:#edc594}.metric.input{background:#eef6ff;border-color:#bdd5ee}.metric.net{background:${net>0?'#fff0ef':'#eaf7f2'};border-color:${net>0?'#efb5af':'#abd8c9'}}.reconciliation{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;border:1px solid #cbd9e6;border-left:4px solid #0d9272;border-radius:7px;background:#f8fbfd;padding:8px 10px;margin-bottom:10px}.reconciliation h3{font-size:8pt;margin:0 0 5px;color:#063b79;text-transform:uppercase}.reconciliation p{display:flex;justify-content:space-between;margin:3px 0}.reconciliation .total{border-top:1px solid #cbd5e1;padding-top:4px;font-weight:800}.reconciliation .net{font-size:9pt;color:${net>0?'#b42318':'#08654d'}}.warnings{border:1px solid #e7c675;border-left:4px solid #c78a00;border-radius:6px;background:#fff8df;padding:6px 9px;margin:7px 0;color:#765200}.warnings b{display:block;margin-bottom:2px}h2{font-size:10.5pt;color:#063b79;margin:12px 0 5px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{page-break-inside:avoid}th{background:#063b79;color:#fff;padding:6px 4px;text-align:left}td{border-bottom:1px solid #dce4ed;padding:5px 4px;vertical-align:top;overflow-wrap:anywhere}.num{text-align:right;white-space:nowrap}.tax{font-weight:800;color:#8a4a0d}.result{font-weight:800}.empty{text-align:center;padding:18px;color:#64748b}.note{margin:8px 0;color:#69788d;font-size:6.8pt}.footer{position:fixed;bottom:-9mm;left:0;right:0;border-top:1px solid #cbd5e1;padding-top:3px;color:#718096;font-size:7pt;display:flex;justify-content:space-between}
  </style></head><body><header><div><div class="brand">GENTIA</div><div class="company"><b>${esc(h.legalName || h.subsidiary)}</b><br>Identificación fiscal: ${esc(h.taxId || 'No registrada')}</div></div><div class="title"><h1>DECLARACIÓN ${esc(h.taxName)}</h1><p><b>${esc(h.periodLabel || `${date(h.dateFrom)} al ${date(h.dateTo)}`)}</b></p><p>Valores en ${esc(h.currency)}</p></div></header>
  <section class="meta"><div><small>Sociedad</small><b>${esc(h.subsidiary)}</b></div><div><small>Jurisdicción</small><b>${esc(h.country || 'No especificada')}</b></div><div><small>Período</small><b>${esc(date(h.dateFrom))} al ${esc(date(h.dateTo))}</b></div><div><small>Documentos</small><b>${esc(h.documentStatuses || 'Aprobados')} · ${h.includeAdjustments?'con':'sin'} ajustes</b></div></section>
  <section class="summary"><div class="metric"><small>Documentos de venta</small><b>${s.salesDocumentCount}</b></div><div class="metric output"><small>Base gravada ventas</small><b>${esc(money(s.salesTaxableBase,h))}</b></div><div class="metric output"><small>Débito fiscal</small><b>${esc(money(s.outputTax,h))}</b></div><div class="metric"><small>Documentos de compra</small><b>${s.purchaseDocumentCount}</b></div><div class="metric input"><small>Base gravada compras</small><b>${esc(money(s.purchaseTaxableBase,h))}</b></div><div class="metric input"><small>Crédito fiscal</small><b>${esc(money(s.inputTax,h))}</b></div></section>
  <section class="reconciliation"><div><h3>IVA/GCT generado en ventas</h3><p><span>Base gravada</span><b>${esc(money(s.salesTaxableBase,h))}</b></p><p><span>Operaciones exentas / 0%</span><b>${esc(money(s.salesExemptBase,h))}</b></p><p class="total"><span>Débito fiscal</span><b>${esc(money(s.outputTax,h))}</b></p></div><div><h3>IVA/GCT acreditable en compras</h3><p><span>Base gravada</span><b>${esc(money(s.purchaseTaxableBase,h))}</b></p><p><span>Compras exentas / 0%</span><b>${esc(money(s.purchaseExemptBase,h))}</b></p><p class="total"><span>Crédito fiscal</span><b>${esc(money(s.inputTax,h))}</b></p></div><div><h3>Liquidación del período</h3><p><span>Impuesto bruto</span><b>${esc(money(s.grossTax,h))}</b></p><p><span>Retenido sufrido (−)</span><b>${esc(money(s.vatWithheldSuffered,h))}</b></p><p><span>Retenido practicado (−)</span><b>${esc(money(s.vatWithheldPracticed,h))}</b></p><p><span>Crédito período anterior (−)</span><b>${esc(money(s.priorPeriodCredit,h))}</b></p><p class="total net"><span>${net>0?'Impuesto por pagar':net<0?'Saldo a favor':'Posición neta'}</span><b>${esc(money(Math.abs(net),h))}</b></p></div></section>
  ${s.warnings.length?`<div class="warnings"><b>Advertencias de control</b>${s.warnings.map(item=>`<div>• ${esc(item)}</div>`).join('')}</div>`:''}
  <h2>Resumen por código y tarifa</h2><table><thead><tr><th>Código / tarifa</th><th class="num">Base ventas</th><th class="num">Débito fiscal</th><th class="num">Base compras</th><th class="num">Crédito fiscal</th><th class="num">Saldo</th></tr></thead><tbody>${rateRows || '<tr><td colspan="6" class="empty">No hay movimientos tributarios en el período.</td></tr>'}</tbody></table>
  <h2>Detalle de ventas</h2><table><colgroup><col style="width:8%"><col style="width:12%"><col style="width:16%"><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:14%"></colgroup><thead><tr><th>Fecha</th><th>Documento</th><th>Cliente</th><th>Código / tarifa</th><th class="num">Base gravada</th><th class="num">Exento / 0%</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead><tbody>${pdfRows(report.sales,h) || '<tr><td colspan="8" class="empty">No hay ventas con incidencia tributaria.</td></tr>'}</tbody></table>
  <h2>Detalle de compras</h2><table><colgroup><col style="width:8%"><col style="width:12%"><col style="width:16%"><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:14%"></colgroup><thead><tr><th>Fecha</th><th>Documento</th><th>Proveedor</th><th>Código / tarifa</th><th class="num">Base gravada</th><th class="num">Exento / 0%</th><th class="num">Impuesto</th><th class="num">Total</th></tr></thead><tbody>${pdfRows(report.purchases,h) || '<tr><td colspan="8" class="empty">No hay compras con incidencia tributaria.</td></tr>'}</tbody></table>
  <p class="note">Este reporte se genera a partir de los documentos y códigos tributarios registrados en GENTIA. Revise los movimientos sin código, exentos y los ajustes antes de presentar la declaración ante la autoridad fiscal.</p><div class="footer"><span>GENTIA · Fiscal y cumplimiento</span><span>Soporte de declaración ${esc(h.taxName)}</span></div></body></html>`;
}

export async function exportVatDeclarationReportPdf(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), period = safeDatePart(report.header.periodLabel || `${report.header.dateFrom}-${report.header.dateTo}`);
  const rendered = await renderBankReconciliationPdf({ html: pdfHtml(report), fileName: `declaracion-iva-gct-${period}.pdf` });
  return { fileName: rendered.fileName, mimeType: rendered.mimeType, buffer: Buffer.from(rendered.base64, 'base64') };
}

function border(color = 'D8E2EC'): Partial<ExcelJS.Borders> {
  const edge = { style: 'thin' as const, color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function excelDate(value: string) {
  if (!value) return '';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.valueOf()) ? value : parsed;
}

function title(sheet: ExcelJS.Worksheet, text: string, lastColumn: string) {
  sheet.mergeCells(`A1:${lastColumn}1`); const cell = sheet.getCell('A1'); cell.value = text; cell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF063B79' } }; cell.alignment = { vertical: 'middle' }; sheet.getRow(1).height = 32;
}

function headerRow(row: ExcelJS.Row, color = 'FF063B79') {
  row.height = 28; row.eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = border(color.slice(2)); });
}

function detailSheet(workbook: ExcelJS.Workbook, name: string, rows: TaxRow[], header: NormalizedReport['header'], partyLabel: string) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: .2, right: .2, top: .45, bottom: .45, header: .2, footer: .2 } } });
  sheet.properties.tabColor = { argb: name.includes('Ventas') ? 'FFF26A3D' : 'FF0D9272' };
  sheet.columns = [{width:14},{width:19},{width:18},{width:27},{width:20},{width:18},{width:12},{width:12},{width:14},{width:18},{width:18},{width:18},{width:18},{width:18},{width:18},{width:24},{width:22},{width:22},{width:18},{width:30}];
  title(sheet, `GENTIA · ${name.toUpperCase()} · ${header.taxName}`, 'T');
  sheet.mergeCells('A2:L2'); sheet.getCell('A2').value = header.legalName || header.subsidiary; sheet.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF14233B' } };
  sheet.mergeCells('M2:T2'); sheet.getCell('M2').value = `${date(header.dateFrom)} al ${date(header.dateTo)} · Presentación ${header.currency}`; sheet.getCell('M2').alignment = { horizontal: 'right' }; sheet.getCell('M2').font = { bold: true, color: { argb: 'FF063B79' } };
  const columns = ['Fecha','Tipo documento','N.º documento',partyLabel,'Identificación fiscal','Código impuesto','Descripción fiscal','Tarifa %','Moneda origen','Tipo de cambio','Base origen','Impuesto origen','Total origen','Base local','Impuesto local','Total local','ID línea origen','ID asiento','Estado','Nota / concepto'];
  headerRow(sheet.addRow(columns));
  for (const item of rows) {
    const record = sheet.addRow([excelDate(item.date),item.documentType,item.documentNumber,item.partyName,item.partyTaxId,item.taxCode,item.taxDescription,item.taxRate,item.currency,item.exchangeRate,item.originalBase,item.originalTax,item.originalGross,item.taxableBase+item.exemptAmount,item.taxAmount,item.grossAmount,item.sourceLineId,item.journalId,item.status,item.note]);
    record.eachCell(cell => { cell.border = border(); cell.alignment = { vertical: 'top', wrapText: true }; }); record.getCell(1).numFmt = 'dd/mm/yyyy'; record.getCell(8).numFmt = '0.0000'; record.getCell(10).numFmt = '#,##0.000000';
    for (let column = 11; column <= 13; column++) record.getCell(column).numFmt = '#,##0.00;[Red](#,##0.00)';
    for (let column = 14; column <= 16; column++) record.getCell(column).numFmt = `"${header.symbol || header.currency}" #,##0.00;[Red]("${header.symbol || header.currency}" #,##0.00)`;
    if (Math.abs(item.taxAmount) > .005) { record.getCell(15).font = { bold: true, color: { argb: 'FF8A4A0D' } }; record.getCell(15).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E8' } }; }
  }
  if (!rows.length) { sheet.mergeCells('A5:T6'); const empty = sheet.getCell('A5'); empty.value = `No hay movimientos en ${name.toLowerCase()} para el período seleccionado.`; empty.alignment = { horizontal: 'center', vertical: 'middle' }; empty.font = { italic: true, color: { argb: 'FF64748B' } }; }
  sheet.autoFilter = 'A3:T3'; sheet.headerFooter.oddFooter = `GENTIA · ${name}                                      Página &P de &N`;
  return sheet;
}

export async function exportVatDeclarationReportExcel(authorization: string, filters: Json): Promise<ExportFile> {
  const report = await fullReport(authorization, filters), { header: h, summary: s } = report;
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'GENTIA ERP'; workbook.company = h.legalName || h.subsidiary || 'GENTIA'; workbook.created = new Date();
  const summary = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 10 }], pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  summary.properties.tabColor = { argb: 'FF063B79' }; summary.columns = Array.from({length:12},() => ({width:18})); title(summary, `GENTIA · DECLARACIÓN ${h.taxName}`, 'L');
  summary.mergeCells('A2:G2'); summary.getCell('A2').value = h.legalName || h.subsidiary; summary.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF14233B' } };
  summary.mergeCells('H2:L2'); summary.getCell('H2').value = h.periodLabel || `${date(h.dateFrom)} al ${date(h.dateTo)}`; summary.getCell('H2').alignment = { horizontal: 'right' }; summary.getCell('H2').font = { bold: true, color: { argb: 'FF063B79' } };
  summary.mergeCells('A3:L3'); summary.getCell('A3').value = `Sociedad: ${h.subsidiary} · Identificación fiscal: ${h.taxId || 'No registrada'} · Jurisdicción: ${h.country || 'No especificada'} · Moneda: ${h.currency} · ${h.includeAdjustments?'Incluye':'Excluye'} ajustes`; summary.getCell('A3').font = { italic: true, color: { argb: 'FF64748B' } };
  const metrics: Array<[string, number, boolean, string]> = [['Documentos venta',s.salesDocumentCount,false,'FFF2F6FA'],['Débito fiscal',s.outputTax,true,'FFFFF4E8'],['Documentos compra',s.purchaseDocumentCount,false,'FFF2F6FA'],['Crédito fiscal',s.inputTax,true,'FFEEF6FF']];
  metrics.forEach(([label, amount, isMoney, color], index) => { const start = 1 + index * 3; summary.mergeCells(5,start,5,start+2); summary.mergeCells(6,start,6,start+2); const labelCell=summary.getCell(5,start), amountCell=summary.getCell(6,start); labelCell.value=label; amountCell.value=amount; labelCell.fill=amountCell.fill={type:'pattern',pattern:'solid',fgColor:{argb:color}}; labelCell.font={bold:true,color:{argb:'FF607086'}}; amountCell.font={bold:true,size:14,color:{argb:'FF14233B'}}; labelCell.alignment=amountCell.alignment={horizontal:'center'}; if(isMoney) amountCell.numFmt=`"${h.symbol||h.currency}" #,##0.00;[Red]("${h.symbol||h.currency}" #,##0.00)`; });
  summary.mergeCells('A8:L8'); const net=s.netTax, netCell=summary.getCell('A8'); netCell.value=`${net>0?'IMPUESTO POR PAGAR':net<0?'SALDO A FAVOR':'POSICIÓN NETA CERO'}: ${money(Math.abs(net),h)}`; netCell.font={bold:true,size:13,color:{argb:net>0?'FFB42318':'FF08654D'}}; netCell.fill={type:'pattern',pattern:'solid',fgColor:{argb:net>0?'FFFFEFEE':'FFEAF7F2'}}; netCell.alignment={horizontal:'center',vertical:'middle'}; summary.getRow(8).height=28;
  const declarationHeader=summary.addRow(['Concepto','Base / referencia','Impuesto / movimiento','Efecto en posición','','','','','','','','']); summary.mergeCells(declarationHeader.number,4,declarationHeader.number,12); headerRow(declarationHeader);
  const positionRows=[
    summary.addRow(['Ventas / débito fiscal',s.salesTaxableBase,s.outputTax,s.outputTax]),
    summary.addRow(['Compras / crédito fiscal',s.purchaseTaxableBase,s.inputTax,-s.inputTax]),
    summary.addRow(['Impuesto bruto',null,s.grossTax,s.grossTax]),
    summary.addRow(['Retenido sufrido',null,s.vatWithheldSuffered,-s.vatWithheldSuffered]),
    summary.addRow(['Retenido practicado',null,s.vatWithheldPracticed,-s.vatWithheldPracticed]),
    summary.addRow(['Crédito del período anterior',null,s.priorPeriodCredit,-s.priorPeriodCredit]),
    summary.addRow(['Posición neta',null,s.netTax,s.netTax])
  ];
  for(const row of positionRows){row.eachCell(cell=>{cell.border=border();cell.alignment={vertical:'middle'}});for(let column=2;column<=4;column++)row.getCell(column).numFmt=`"${h.symbol||h.currency}" #,##0.00;[Red]("${h.symbol||h.currency}" #,##0.00)`;}
  const finalPosition=positionRows[positionRows.length-1];finalPosition.font={bold:true,color:{argb:net>0?'FFB42318':'FF08654D'}};finalPosition.fill={type:'pattern',pattern:'solid',fgColor:{argb:net>0?'FFFFEFEE':'FFEAF7F2'}};
  if(s.warnings.length){summary.addRow([]);const warningRow=summary.addRow([`Advertencias: ${s.warnings.join(' · ')}`]);summary.mergeCells(warningRow.number,1,warningRow.number,12);warningRow.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF8DF'}};warningRow.getCell(1).font={bold:true,color:{argb:'FF765200'}};warningRow.getCell(1).alignment={wrapText:true};}
  summary.addRow([]); const rateTitle=summary.addRow(['Resumen por código y tarifa']); summary.mergeCells(rateTitle.number,1,rateTitle.number,12); rateTitle.getCell(1).font={bold:true,size:12,color:{argb:'FF063B79'}};
  const rateHeader=summary.addRow(['Código / tarifa','Tarifa %','Base ventas','Débito fiscal','Base compras','Crédito fiscal','Saldo']); summary.mergeCells(rateHeader.number,7,rateHeader.number,12); headerRow(rateHeader,'FF0D9272');
  for(const item of report.rates){const row=summary.addRow([item.label,item.rate,item.salesBase,item.outputTax,item.purchaseBase,item.inputTax,item.balance]);row.eachCell(cell=>{cell.border=border();cell.alignment={vertical:'middle',wrapText:true}});row.getCell(2).numFmt='0.0000';for(let column=3;column<=7;column++)row.getCell(column).numFmt=`"${h.symbol||h.currency}" #,##0.00;[Red]("${h.symbol||h.currency}" #,##0.00)`;}
  summary.headerFooter.oddFooter='GENTIA · Resumen declaración fiscal                                      Página &P de &N';
  detailSheet(workbook,'Detalle Ventas',report.sales,h,'Cliente'); detailSheet(workbook,'Detalle Compras',report.purchases,h,'Proveedor');
  const content=await workbook.xlsx.writeBuffer(),period=safeDatePart(h.periodLabel||`${h.dateFrom}-${h.dateTo}`);
  return { fileName:`declaracion-iva-gct-${period}.xlsx`,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(content) };
}
