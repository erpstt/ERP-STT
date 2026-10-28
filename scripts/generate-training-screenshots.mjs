import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const ORIGIN = process.env.GENTIA_TRAINING_ORIGIN || 'http://localhost:3000';
const CHROME = process.env.GENTIA_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUTPUT = fileURLToPath(new URL('../deliverables/manuales_capacitacion_gentia/imagenes/', import.meta.url));
const VIEWPORT = { width: 1600, height: 1000 };
const CAPTURE_DATE = '2026-10-28';
const ONLY_CAP = process.env.GENTIA_ONLY_CAP || '';
const TRAINING_TOKEN = `e30.${Buffer.from(JSON.stringify({
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'capacitacion@example.test',
  exp: Math.floor(Date.now() / 1000) + 7200,
})).toString('base64url')}.training`;
const TRAINING_LOCAL_STORAGE = [
  { name: 'nexo_token', value: TRAINING_TOKEN },
  { name: 'nexo_device_token', value: 'training-device-safe-demo' },
  { name: 'nexo_role', value: '1' },
  { name: 'nexo_company', value: '1' },
  { name: 'nexo_company_name', value: 'EMPRESA DEMOSTRACIÓN GENTIA' },
  { name: 'nexo_location_name_1', value: 'Oficina Central' },
];

const topics = [
  ['CAP-01', 'Ingreso y espacio de trabajo'],
  ['CAP-02', 'Seguridad, usuarios, roles y permisos'],
  ['CAP-03', 'Organización y catálogos maestros'],
  ['CAP-04', 'Contabilidad y asientos de diario'],
  ['CAP-05', 'Carga de saldos iniciales'],
  ['CAP-06', 'Ventas, facturación y cobros'],
  ['CAP-07', 'Compras y cuentas por pagar'],
  ['CAP-08', 'Solicitudes de pago'],
  ['CAP-09', 'Aprobaciones y flujos de trabajo'],
  ['CAP-10', 'Bancos y conciliación bancaria'],
  ['CAP-11', 'Tesorería y lotes de pago'],
  ['CAP-12', 'Activos fijos'],
  ['CAP-13', 'Inventario y productos'],
  ['CAP-14', 'Fiscal, calendario e IVA/GCT'],
  ['CAP-15', 'Consolidación financiera'],
  ['CAP-16', 'Reportes contables y operativos'],
  ['CAP-17', 'Auditoría y control de calidad'],
  ['CAP-18', 'Documentos y comunicaciones'],
  ['CAP-19', 'Soporte, recuperación y continuidad'],
];

const currencies = [
  { currency_id: 1, id: 1, currency_code: 'JMD', code: 'JMD', name: 'Dólar jamaicano', symbol: 'J$' },
  { currency_id: 2, id: 2, currency_code: 'USD', code: 'USD', name: 'Dólar estadounidense', symbol: 'US$' },
];
const subsidiaries = [{
  subsidiary_id: 1, id: 1, subsidiaryId: 1, name: 'EMPRESA DEMOSTRACIÓN GENTIA',
  legal_name: 'EMPRESA DEMOSTRACIÓN GENTIA, S.A.', legalName: 'EMPRESA DEMOSTRACIÓN GENTIA, S.A.',
  country_id: 1, currency_id: 1, currencyId: 1, currencyCode: 'JMD',
  allowed_currency_ids: [1, 2], secondary_currency_ids: [2], logo_url: null,
}];
const departments = [
  { department_id: 11, id: 11, name: 'ADMINISTRATIVO', type: 'Interno', subsidiary_id: 1, subsidiary_ids: [1], is_inactive: false },
  { department_id: 12, id: 12, name: 'OPERACIONES CLIENTES', type: 'Cliente', subsidiary_id: 1, subsidiary_ids: [1], is_inactive: false },
  { department_id: 13, id: 13, name: 'CONTABILIDAD REGIONAL', type: 'Interno', subsidiary_id: 1, subsidiary_ids: [1], is_inactive: false },
];
const classes = [
  { class_id: 21, id: 21, name: 'SERVICIOS PROFESIONALES', subsidiary_id: 1, subsidiary_ids: [1] },
  { class_id: 22, id: 22, name: 'ADMINISTRACIÓN', subsidiary_id: 1, subsidiary_ids: [1] },
];
const costCenters = [
  { cost_center_id: 31, id: 31, name: 'CC-CLIENTE-001 · IMPLEMENTACIÓN', type: 'CLIENTE', departmentId: 12, department_id: 12, customer_id: 1, class_id: 21, subsidiary_id: 1, subsidiary_ids: [1] },
  { cost_center_id: 32, id: 32, name: 'CC-ADM-001 · ADMINISTRACIÓN', type: 'INTERNO', departmentId: 11, department_id: 11, class_id: 22, subsidiary_id: 1, subsidiary_ids: [1] },
];
const periods = [{
  fiscal_period_id: 101, id: 101, subsidiary_id: 1, subsidiaryId: 1, period_name: 'octubre 2026', name: 'octubre 2026',
  start_date: '2026-10-01', end_date: '2026-10-31', start: '2026-10-01', end: '2026-10-31', is_closed: false, ar_closed: false, ap_closed: false,
}];
const locations = [{ location_id: 41, id: 41, name: 'Oficina Central', subsidiary_id: 1, subsidiary_ids: [1] }];
const accounts = [
  { account_id: 501, id: 501, account_number: '111005', number: '111005', account_name: 'Bancos moneda extranjera', name: 'Bancos moneda extranjera', category: 'Activo', nature: 'Deudora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 502, id: 502, account_number: '113001', number: '113001', account_name: 'Cuentas por Cobrar Clientes', name: 'Cuentas por Cobrar Clientes', category: 'Activo', nature: 'Deudora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 503, id: 503, account_number: '211001', number: '211001', account_name: 'Cuentas por Pagar Proveedores', name: 'Cuentas por Pagar Proveedores', category: 'Pasivo', nature: 'Acreedora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 504, id: 504, account_number: '411001', number: '411001', account_name: 'Ingresos por Servicios', name: 'Ingresos por Servicios', category: 'Ingreso', nature: 'Acreedora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 505, id: 505, account_number: '613010', number: '613010', account_name: 'Servicios profesionales', name: 'Servicios profesionales', category: 'Gasto', nature: 'Deudora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 506, id: 506, account_number: '631002', number: '631002', account_name: 'Comisiones y Gastos Bancarios', name: 'Comisiones y Gastos Bancarios', category: 'Gasto', nature: 'Deudora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 507, id: 507, account_number: '214001', number: '214001', account_name: 'Impuestos por pagar', name: 'Impuestos por pagar', category: 'Pasivo', nature: 'Acreedora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
  { account_id: 508, id: 508, account_number: '319999', number: '319999', account_name: 'Saldos Iniciales Transitorios', name: 'Saldos Iniciales Transitorios', category: 'Patrimonio', nature: 'Acreedora', accepts_entries: true, is_inactive: false, subsidiary_id: 1, subsidiary_ids: [1] },
];
const customers = [{
  customer_id: 1, id: 1, company_name: 'CLIENTE DEMOSTRACIÓN, S.A.', name: 'CLIENTE DEMOSTRACIÓN, S.A.',
  subsidiary_id: 1, subsidiary_ids: [1], currency_ids: [1, 2], payment_term_id: 1, department_id: 12,
  is_intercompany: false, tax_id: 'DEMO-CLI-001', withholding_rules: [],
}];
const suppliers = [{
  supplier_id: 1, id: 1, company_name: 'PROVEEDOR DEMOSTRACIÓN, S.A.', name: 'PROVEEDOR DEMOSTRACIÓN, S.A.',
  subsidiary_id: 1, subsidiary_ids: [1], currency_ids: [1, 2], payment_term_id: 1,
  is_intercompany: false, tax_id: 'DEMO-PRO-001',
}];
const products = [
  { product_id: 1, id: 1, item_code: 'SRV-001', display_name: 'Servicio de implementación ERP', product_usage: 'Ambas', item_type_id: 1, sales_account_id: 504, purchase_account_id: 505, sales_price: 125000, purchase_cost: 85000, uom_id: 1, is_active: true, subsidiary_id: 1, subsidiary_ids: [1] },
  { product_id: 2, id: 2, item_code: 'SRV-002', display_name: 'Soporte funcional mensual', product_usage: 'Venta', item_type_id: 1, sales_account_id: 504, sales_price: 45000, uom_id: 1, is_active: true, subsidiary_id: 1, subsidiary_ids: [1] },
];
const taxCodes = [{ tax_code_id: 1, id: 1, code_name: 'JAM_GCT_15%', name: 'JAM_GCT_15% · GCT 15%', rate_percentage: 15, tax_type_id: 1, is_withholding: false, subsidiary_id: 1, subsidiary_ids: [1] }];
const exchangeRates = [{ rate_id: 1, from_currency_id: 2, to_currency_id: 1, effective_date: '2026-10-27', spot_rate: 156.42 }];
const trainingCompany = { subsidiaryId: 1, name: subsidiaries[0].name, legalName: subsidiaries[0].legal_name, currencyCode: 'JMD', logoUrl: null };

const reportOptions = {
  subsidiaries: [{ id: 1, name: subsidiaries[0].name, legalName: subsidiaries[0].legal_name, currencyId: 1, logoUrl: null }],
  currencies: currencies.map(row => ({ id: row.id, code: row.code, name: row.name, symbol: row.symbol })),
  books: [{ id: 1, name: 'Fiscal local', subsidiaryId: 1 }],
  periods: [{ id: 101, name: 'octubre 2026', subsidiaryId: 1, start: '2026-10-01', end: '2026-10-31' }],
  departments: departments.map(row => ({ id: row.id, name: row.name, displayName: row.name, type: row.type, subsidiaryId: 1 })),
  reportDepartments: departments.map(row => ({ id: row.id, name: row.name, displayName: row.name, type: row.type, subsidiaryId: 1 })),
  classes: classes.map(row => ({ id: row.id, name: row.name, displayName: row.name, subsidiaryId: 1, departmentIds: [11, 12] })),
  reportClasses: classes.map(row => ({ id: row.id, name: row.name, displayName: row.name, subsidiaryId: 1, departmentIds: [11, 12] })),
  costCenters: costCenters.map(row => ({ id: row.id, name: row.name, displayName: row.name, subsidiaryId: 1, departmentId: row.department_id, classId: row.class_id })),
  reportCostCenters: costCenters.map(row => ({ id: row.id, name: row.name, displayName: row.name, subsidiaryId: 1, departmentId: row.department_id, classId: row.class_id })),
  locations: [{ id: 41, name: 'Oficina Central', subsidiaryId: 1 }],
  accounts: accounts.map(row => ({ id: row.id, code: row.number, name: row.name, subsidiaryId: 1 })),
  thirdParties: [{ id: 1, name: customers[0].name, type: 'Cliente', subsidiaryId: 1 }],
  journalOptions: { canReverse: true, modules: ['Ventas', 'Compras', 'Contabilidad', 'Tesorería'] },
  agingOptions: { customers: [{ id: 1, name: customers[0].name, subsidiaryId: 1 }], suppliers: [{ id: 1, name: suppliers[0].name, subsidiaryId: 1 }], salesRepresentatives: [], supplierCategories: ['Servicios'] },
  pendingInvoiceOptions: { customers: [{ id: 1, name: customers[0].name }], canViewReclassification: true, canReclassify: true },
  bankOptions: {
    accounts: [{ id: 71, bankId: 7, bankName: 'JN Bank Limited', name: 'JN Bank Limited - 02000006419', number: '02000006419', currencyId: 1, currencyCode: 'JMD', currencyName: 'Dólar jamaicano', subsidiaryId: 1 }],
    reconciliations: [{ bankAccountId: 71, date: '2026-10-27', period: 'octubre 2026', bankName: 'JN Bank Limited', accountNumber: '02000006419', currencyCode: 'JMD', bookBalance: 168585.50, transitPayments: 0, transitDeposits: 0, adjustments: 0, statementBalance: 168585.50, difference: 0, status: 'CERRADA', closedBy: 'Usuario de capacitación', closedAt: '2026-10-27T18:00:00Z' }],
  },
};

const openingPreview = {
  run: { id: 146, status: 'VALIDATED', opening_date: '2026-09-30', load_type: 'MID_YEAR', transition_account_id: 508 },
  summary: { count: 158, debit: 200928529.66, credit: 200928529.66, difference: 0 }, rows: [],
  assetSummary: { count: 2, pending: 2, cost: 312775.19, accumulated: 292834.75, bookValue: 19940.44, balanced: true },
  assets: [], assetReconciliation: [{ type: 'Costo histórico', accountNumber: '131004', accountName: 'Equipo de cómputo', ledger: 312775.19, existing: 0, staged: 312775.19, auxiliary: 312775.19, difference: 0 }],
  pendingSummary: { count: 1, currentLocal: 246619, previousLocal: 0, reversed: 0, balance: 246619, balanced: true },
  pendingItems: [{ row: 2, reference: 'PEN-ACTUAL-001', customerName: 'CLIENTE DEMOSTRACIÓN, S.A.', originDate: '2026-07-30', periodType: 'ACTUAL', currency: 'JMD', rate: 1, initial: 246619, reversed: 0, balance: 246619, created: false }],
  pendingReconciliation: [{ accountNumber: '113003', accountName: 'Facturación Pendiente de Emitir', currency: 'JMD', ledger: 246619, existing: 0, staged: 246619, auxiliary: 246619, difference: 0, periodType: 'ACTUAL' }],
  bankSummary: { count: 3, accounts: 2, pending: 3, openingLocal: 173984.52, transitDepositsLocal: 0, transitChecksLocal: 0, balanced: true },
  bankItems: [{ sourceRow: 2, bankCode: 'JNB_JM', bankName: 'JN Bank Limited', accountNumber: '02000006419', recordType: 'SALDO_CONCILIADO', transactionDate: '2026-09-30', currency: 'JMD', originalAmount: 173984.52, localEquivalent: 173984.52, created: false }],
  bankReconciliation: [],
};

const customerPaymentOptions = {
  subsidiary: { id: 1, name: subsidiaries[0].name, currencyId: 1 }, location: { id: 41, name: 'Oficina Central' },
  customers: [{ id: 1, name: customers[0].name }],
  accounts: [{ id: 71, bank: 'JN Bank Limited', number: '02000006419', currencyId: 2, currency: 'USD', balance: 100000 }],
  bankFeeAccount: { id: 506, number: '631002', name: 'Comisiones y Gastos Bancarios' },
  periods: [{ id: 101, name: 'octubre 2026', start: '2026-10-01', end: '2026-10-31' }],
  rates: [{ fromCurrencyId: 2, toCurrencyId: 1, date: '2026-10-27', rate: 156.42 }], advances: [],
  invoices: [{ id: 672, number: 'FAC-00000672', customerId: 1, date: '2026-10-19', dueDate: '2026-11-18', currencyId: 2, currency: 'USD', total: 35916.70, receivable: 35916.70, debitNotes: 0, creditNotes: 0, paid: 0, currentApplied: 0, balance: 35916.70, editableBalance: 35916.70 }],
};

const paymentRequestOptions = {
  company: subsidiaries[0].name, baseCurrencyId: 1, userId: 7, admin: true, canApprove: true, canExecute: true,
  currencies: [{ id: 1, name: 'JMD' }, { id: 2, name: 'USD' }], users: [{ id: 7, name: 'Usuario de capacitación' }, { id: 8, name: 'Supervisora tributaria' }],
  suppliers: [{ id: 1, name: suppliers[0].name }], customers: [{ id: 1, name: customers[0].name }], employees: [{ id: 1, name: 'Colaborador demostración' }], taxAgencies: [{ id: 301, name: 'TAJ · Tax Administration Jamaica' }],
  departments: departments.map(row => ({ id: row.id, name: row.name, type: row.type })),
  costCenters: costCenters.map(row => ({ id: row.id, name: row.name, type: row.type, departmentId: row.department_id })),
  banks: [{ id: 71, name: 'JN Bank Limited · 02000006419' }], rates: exchangeRates,
  accounts: [{ id: 507, name: '214001 / Impuestos por pagar' }, { id: 505, name: '613010 / Servicios profesionales' }],
};

const auditOptions = {
  defaultMonth: '2026-10', timeZone: 'America/Costa_Rica', subsidiaries: [{ id: '1', name: subsidiaries[0].name }],
  users: [{ id: 7, name: 'Usuario de capacitación', email: 'capacitacion@example.test' }],
  modules: [{ id: 'sales', label: 'Ventas y cuentas por cobrar' }, { id: 'purchases', label: 'Compras y cuentas por pagar' }],
  transactionTypes: [{ id: 'sales_invoice', label: 'Facturas de venta' }, { id: 'vendor_bill', label: 'Facturas de proveedor' }],
  months: [{ id: '2026-10', label: 'octubre de 2026' }],
};
const auditReport = {
  header: { month: '2026-10', periodLabel: 'octubre de 2026', scopeLabel: 'Auditoría autorizada' },
  summary: { totalEvents: 3, operationCount: 3, modifiedCount: 2, deletedCount: 1, fieldChanges: 4, userCount: 1, mostActiveUser: 'Usuario de capacitación', byTransactionType: [{ transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', total: 2, modified: 2, deleted: 0 }, { transactionType: 'vendor_bill', transactionTypeLabel: 'Facturas de proveedor', total: 1, modified: 0, deleted: 1 }] },
  total: 3,
  rows: [
    { auditId: 101, timestamp: '2026-10-18T16:20:00Z', action: 'MODIFICACION', transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', documentNumber: 'FAC-00000672', subsidiaryName: subsidiaries[0].name, documentCreator: { name: 'Usuario solicitante', email: 'solicitante@example.test' }, module: 'sales', moduleLabel: 'Ventas y cuentas por cobrar', entityType: 'invoice', entityLabel: 'Factura de venta', entityKey: 'invoice_id=672', recordLabel: 'FAC-00000672', actor: { name: 'Usuario de capacitación', email: 'capacitacion@example.test', type: 'HUMAN', source: 'GENTIA ERP' }, fieldsChangedCount: 2, changes: [{ field: 'status', fieldLabel: 'Estado', oldValue: 'BORRADOR', newValue: 'APROBADO' }, { field: 'memo', fieldLabel: 'Nota', oldValue: 'Borrador', newValue: 'Servicio confirmado' }] },
    { auditId: 102, timestamp: '2026-10-19T13:05:00Z', action: 'ELIMINACION', transactionType: 'vendor_bill', transactionTypeLabel: 'Facturas de proveedor', documentNumber: 'FAC-PRO-000014', subsidiaryName: subsidiaries[0].name, module: 'purchases', moduleLabel: 'Compras y cuentas por pagar', entityType: 'vendor_bill', entityLabel: 'Factura de proveedor', entityKey: 'bill_id=14', recordLabel: 'FAC-PRO-000014', actor: { name: 'Usuario de capacitación', email: 'capacitacion@example.test', type: 'HUMAN', source: 'GENTIA ERP' }, fieldsChangedCount: 0, changes: [], deletedSnapshot: { description: 'Documento de capacitación eliminado', amount: '125.00' } },
    { auditId: 103, timestamp: '2026-10-20T10:00:00Z', action: 'MODIFICACION', transactionType: 'sales_invoice', transactionTypeLabel: 'Facturas de venta', documentNumber: 'FAC-00000673', subsidiaryName: subsidiaries[0].name, module: 'sales', moduleLabel: 'Ventas y cuentas por cobrar', entityType: 'invoice', entityLabel: 'Factura de venta', entityKey: 'invoice_id=673', recordLabel: 'FAC-00000673', actor: { name: 'Usuario de capacitación', email: 'capacitacion@example.test', type: 'HUMAN', source: 'GENTIA ERP' }, fieldsChangedCount: 2, changes: [{ field: 'exchange_rate', fieldLabel: 'Tipo de cambio', oldValue: '1', newValue: '156.42' }] },
  ],
};

function roleMatrix() {
  const modules = [
    ['Contabilidad', [['accounting:journal-entry', 'Asientos de diario', ['view', 'create', 'edit']], ['accounting:opening-balances', 'Saldos iniciales', ['view', 'create']]]],
    ['Ventas', [['sales:invoices', 'Facturas de venta', ['view', 'create', 'edit', 'delete']], ['sales:customer-payments', 'Cobros de clientes', ['view', 'create', 'edit']]]],
    ['Compras', [['purchasing:supplier-invoices', 'Facturas de proveedores', ['view', 'create', 'edit']], ['purchasing:supplier-payments', 'Pagos a proveedores', ['view', 'create']]]],
    ['Informes', [['reports:accounting', 'Reportes contables', ['view']], ['reports:audit', 'Reporte de auditoría', ['view']]]],
  ].map(([name, resources], index) => ({ key: `module-${index + 1}`, name, resources: resources.map(([key, optionName, actions]) => ({ key, optionName, actions })) }));
  return {
    roles: [{ roleId: 1, name: 'Administrador', description: 'Acceso total protegido' }, { roleId: 2, name: 'Contabilidad', description: 'Gestión contable y financiera' }, { roleId: 3, name: 'Cuentas por Pagar', description: 'Compras, pagos y proveedores' }],
    selectedRoleId: 2, isAdministratorRole: false, modules,
    grants: modules.flatMap(module => module.resources.map(resource => ({ resourceKey: resource.key, canView: true, canCreate: resource.actions.includes('create'), canEdit: resource.actions.includes('edit'), canDelete: false }))),
    specialPermissions: [{ permissionId: 901, module: 'Contabilidad', code: 'ACCOUNTING_POST', description: 'Contabilizar transacciones', enabled: true }, { permissionId: 902, module: 'Tesorería', code: 'PAYMENT_REQUEST_APPROVE', description: 'Aprobar solicitudes de pago', enabled: false }, { permissionId: 903, module: 'Bancos', code: 'BANK_RECONCILIATION_CLOSE', description: 'Finalizar conciliaciones bancarias', enabled: true }],
  };
}

function vatOptions() {
  return {
    subsidiary: { id: 1, name: subsidiaries[0].name, currency: 'JMD', countryName: 'Jamaica' },
    country: { name: 'Jamaica', code: 'JAM' }, currency: { code: 'JMD', name: 'Dólar jamaicano', symbol: 'J$' }, taxLabel: 'GCT',
    periods: ['2026-10', '2026-09'], defaultPeriod: '2026-10', documentStatuses: [{ value: 'APROBADO', label: 'Aprobado' }, { value: 'CONTABILIZADO', label: 'Contabilizado' }], defaultDocumentStatuses: ['APROBADO', 'CONTABILIZADO'],
  };
}
function vatReport() {
  const detail = (number, party, base, tax) => ({ date: '2026-10-15', documentNumber: number, partyName: party, partyTaxId: 'DEMO-001', status: 'CONTABILIZADO', taxableBase: base, taxAmount: tax, totalAmount: base + tax });
  return {
    header: { periodMonth: '2026-10', currency: 'JMD', currencyName: 'Dólar jamaicano', symbol: 'J$' },
    sales: { rows: [{ key: 'JAM_GCT_15', code: 'JAM_GCT_15%', label: 'JAM_GCT_15% · Tarifa general', rate: 15, documentCount: 8, taxableBase: 10140544.80, taxAmount: 1521081.72, adjustments: 0, details: [detail('FAC-00000672', customers[0].name, 35916.70, 5387.51)] }, { key: 'JAM_GCT_0', code: 'JAM_GCT_0%', label: 'JAM_GCT_0% · Tasa cero', rate: 0, documentCount: 2, taxableBase: 265000, taxAmount: 0, adjustments: 0 }] },
    purchases: { rows: [{ key: 'JAM_GCT_15', code: 'JAM_GCT_15%', label: 'Compras locales · 15%', rate: 15, documentCount: 5, taxableBase: 4200000, taxAmount: 630000, adjustments: 0, details: [detail('FAC-PRO-000014', suppliers[0].name, 200000, 30000)] }, { key: 'JAM_GCT_0', code: 'JAM_GCT_0%', label: 'Compras exentas', rate: 0, documentCount: 1, taxableBase: 100000, taxAmount: 0, adjustments: 0 }] },
    retentions: { suffered: [{ amount: 25000 }], practiced: [{ amount: 12000 }] },
    summary: { salesTaxableBase: 10405544.80, purchaseTaxableBase: 4300000, salesTax: 1521081.72, purchaseTax: 630000, grossTax: 891081.72, vatWithheldSuffered: 25000, vatWithheldPracticed: 12000, priorPeriodCredit: 50000, netTax: 804081.72, documentCount: 16, warnings: ['Revise 1 documento sin código fiscal antes de presentar la declaración.'] },
  };
}

function fixtureFor(path, method, url) {
  const common = {
    '/api/security/turnstile/config': { enabled: false },
    '/api/auth/roles': [{ roleId: 1, role_id: 1, name: 'Administrador', role_name: 'Administrador' }],
    '/api/auth/select-role': { roleId: 1, name: 'Administrador' },
    '/api/security/my-role-access': { isAdmin: true, grants: [], modules: [] },
    '/api/auth/companies': [trainingCompany], '/api/auth/select-company': trainingCompany,
    '/api/organization/subsidiaries': subsidiaries, '/api/core/currencies': currencies,
    '/api/core/countries': [{ country_id: 1, id: 1, country_code_iso2: 'JM', name: 'Jamaica' }],
    '/api/organization/departments': departments, '/api/organization/classes': classes,
    '/api/organization/cost-centers': costCenters, '/api/organization/locations': locations,
    '/api/organization/accounting-periods': periods,
    '/api/organization/financial-creditors': [{ financial_creditor_id: 1, id: 1, name: 'Banco de desarrollo', subsidiary_id: 1, subsidiary_ids: [1] }],
    '/api/organization/related-companies': [{ related_company_id: 1, id: 1, name: 'Compañía relacionada demostración', country_id: 1, subsidiary_id: 1, subsidiary_ids: [1] }],
    '/api/accounting/chart-accounts': accounts, '/api/accounting/account-groups': [], '/api/accounting/gl-impacts': [], '/api/accounting/journal-supports': [],
    '/api/entities/customers': customers, '/api/entities/suppliers': suppliers, '/api/entities/employees': [{ employee_id: 1, id: 1, first_name: 'Colaborador', last_name: 'Demostración', name: 'Colaborador Demostración', subsidiary_id: 1, subsidiary_ids: [1] }],
    '/api/inventory/products': products, '/api/inventory/item-types': [{ item_type_id: 1, id: 1, type_code: 'SERV', type_name: 'Servicio', is_inventory: false, is_assembled: false }],
    '/api/configuration/uom': [{ uom_id: 1, id: 1, code: 'UND', name: 'Unidad' }],
    '/api/configuration/tax-codes': taxCodes, '/api/configuration/tax-types': [{ tax_type_id: 1, id: 1, type_name: 'GCT', asset_account_id: 502, liability_account_id: 507 }],
    '/api/configuration/payment-terms': [{ term_id: 1, id: 1, term_name: 'Neto 30', days_due: 30 }],
    '/api/configuration/exchange-rates': exchangeRates,
    '/api/core/transaction-types': [{ transaction_type_id: 1, abbreviation: 'ASI_DIA', name: 'Asiento de diario', module_category: 'Contabilidad' }, { transaction_type_id: 2, abbreviation: 'ASI_PEN', name: 'Pendiente de facturar', module_category: 'Contabilidad' }, { transaction_type_id: 3, abbreviation: 'ASI_NOM', name: 'Asiento de nómina', module_category: 'Contabilidad' }, { transaction_type_id: 4, abbreviation: 'ASI_LIQ', name: 'Asiento de liquidación', module_category: 'Contabilidad' }],
    '/api/sales/invoices': [], '/api/sales/sales-invoice-lines': [], '/api/sales/sales-invoice-withholdings': [],
    '/api/purchasing/supplier-invoices': [], '/api/purchasing/supplier-invoice-lines': [],
    '/api/security/users': [{ user_id: 7, id: 7, email: 'capacitacion@example.test', first_name: 'Usuario', last_name: 'Capacitación', timezone: 'America/Costa_Rica', is_active: true }],
    '/api/security/roles': [{ role_id: 1, id: 1, role_name: 'Administrador' }, { role_id: 2, id: 2, role_name: 'Contabilidad' }, { role_id: 3, id: 3, role_name: 'Cuentas por Pagar' }],
    '/api/security/role-permissions': [{ role_id: 2, permission_id: 1 }],
    '/api/security/permissions': [{ permission_id: 1, code: 'ACCOUNTING_JOURNAL_VIEW', module: 'Contabilidad', description: 'Consultar asientos de diario', is_operational: true }, { permission_id: 2, code: 'PAYMENT_REQUEST_APPROVE', module: 'Tesorería', description: 'Aprobar solicitudes de pago', is_operational: true }, { permission_id: 3, code: 'CORE_COUNTRIES_VIEW', module: 'CORE', description: 'Consultar el catálogo de países', is_operational: false }],
    '/api/inventory/product-categories': [{ category_id: 1, id: 1, category_name: 'Servicios' }],
    '/api/inventory/product-brands': [{ brand_id: 1, id: 1, brand_name: 'GENTIA Servicios' }],
    '/api/documents/documents': [{ document_id: 1, file_name: 'Politica-contable-demostracion.pdf', file_path: '/capacitacion/politica.pdf', folder_id: 1, type_id: 1, uploaded_by_user_id: 7, file_size: 256000, mime_type: 'application/pdf' }],
    '/api/documents/folders': [{ folder_id: 1, id: 1, folder_name: 'Políticas y procedimientos', subsidiary_id: 1 }],
    '/api/documents/document-types': [{ type_id: 1, id: 1, type_name: 'PDF', allowed_extensions: '.pdf', max_file_size_mb: 5 }],
  };
  if (Object.hasOwn(common, path)) return common[path];

  if (path === '/api/security/role-access-matrix') return roleMatrix();
  if (path === '/api/opening-balances/options') return { canCreate: true, canReverse: true, subsidiary: { id: 1, name: subsidiaries[0].name, currency: 'JMD' }, accounts: [{ id: 508, number: '319999', name: 'Saldos Iniciales Transitorios' }], assetCategories: [{ id: 1, code: 'CAT-ACT-000001', name: 'Equipo de cómputo' }], bankAccounts: [{ id: 71, bank: 'JN Bank Limited', number: '02000006419', currency: 'JMD' }], run: openingPreview.run };
  if (path === '/api/opening-balances/preview') return openingPreview;

  if (path === '/api/sales/customer-payments/options') return customerPaymentOptions;
  if (path === '/api/sales/customer-payments/report') return { rows: [{ id: 27, date: '2026-10-22', number: 'COB-CLI-00000027', customer: customers[0].name, bank: 'JN Bank Limited', account: '02000006419', reference: 'TRF-DEMO-2026', currency: 'USD', amount: 35887.09, grossTotal: 35916.70, bankFeeTotal: 29.61, advanceTotal: 0, status: 'APROBADO' }] };

  if (path === '/api/purchasing/supplier-payments/options') return { subsidiary: { id: 1, name: subsidiaries[0].name, currencyId: 1 }, location: { id: 41, name: 'Oficina Central' }, suppliers: [{ id: 1, name: suppliers[0].name }], accounts: [{ id: 71, bank: 'JN Bank Limited', number: '02000006419', currencyId: 1, currency: 'JMD' }], invoices: [{ id: 14, number: 'FAC-PRO-000014', supplierId: 1, date: '2026-10-12', dueDate: '2026-11-11', currencyId: 1, currency: 'JMD', total: 230000, balance: 230000 }], advances: [], periods: [{ id: 101, name: 'octubre 2026', start: '2026-10-01', end: '2026-10-31' }], paymentRequestLocks: [] };
  if (path === '/api/purchasing/supplier-payments/report') return { rows: [{ id: 9, date: '2026-10-21', number: 'PAG-PRO-00000009', supplier: suppliers[0].name, bank: 'JN Bank Limited', account: '02000006419', reference: 'PAGO-DEMO-09', currency: 'JMD', amount: 230000, advanceTotal: 0 }] };

  if (path === '/api/treasury/payment-requests/options') return paymentRequestOptions;
  if (path === '/api/treasury/payment-requests/report') return [{ id: 93, numero: 'SOL-PAG-00000093', concepto: 'Pago de impuestos de octubre', solicitante: 'Usuario de capacitación', proveedor: 'TAJ', tipo_solicitud: 'OTROS', fecha_solicitud: '2026-10-27', fecha_pago_programada: '2026-10-30', moneda: 'JMD', total: 1250000, estado: 'PENDIENTE_APROBACION' }, { id: 94, numero: 'SOL-PAG-00000094', concepto: 'Servicios profesionales', solicitante: 'Usuario de capacitación', proveedor: suppliers[0].name, tipo_solicitud: 'CXP', fecha_solicitud: '2026-10-27', fecha_pago_programada: '2026-10-31', moneda: 'JMD', total: 230000, estado: 'BORRADOR' }];
  if (path === '/api/treasury/payment-requests/detail') return { header: { id: 93, numero: 'SOL-PAG-00000093', estado: 'PENDIENTE_APROBACION', id_solicitante: 7, tipo_solicitud: 'OTROS', id_moneda: 1, fecha_solicitud: '2026-10-27', fecha_pago_programada: '2026-10-30', concepto: 'Pago de impuestos de octubre', total: 1250000, version: 1, assigned_approver_id: 8, approval_route_source: 'TAX_SUPERVISOR' }, lines: [{ id: 1, id_cuenta_contable: 507, tipo_tercero: 'Agencia Tributaria', id_agencia_tributaria: 301, id_departamento: 11, id_centro_costo: 32, departmentType: 'Interno', department: 'ADMINISTRATIVO', costCenter: 'CC-ADM-001 · ADMINISTRACIÓN', concepto: 'Impuesto principal', monto: 1250000, accountName: '214001 / Impuestos por pagar', party: 'TAJ' }], events: [] };
  if (path === '/api/treasury/payment-requests/supports') return [];

  if (path === '/api/approval-engine/inbox') return [{ instanceId: 5001, number: 'SOL-PAG-00000093', entityType: 'PAYMENT_REQUEST', level: 1, levelName: 'Supervisión tributaria', policy: 'CUALQUIERA', requestedAt: '2026-10-27T15:20:00Z', amount: 1250000, deepLink: '/payment-requests.html?id=93&company=1' }, { instanceId: 5002, number: 'ORD-COM-00000018', entityType: 'PURCHASE_ORDER', level: 2, levelName: 'Aprobación financiera', policy: 'TODOS', requestedAt: '2026-10-27T17:10:00Z', amount: 230000, deepLink: '/purchase-documents.html?id=18' }];
  if (path === '/api/approval-engine/options') return { isAdmin: true, entityTypes: [{ id: 'PAYMENT_REQUEST', name: 'Solicitudes de Pago' }, { id: 'PURCHASE_ORDER', name: 'Órdenes de Compra' }], roles: [{ id: 2, name: 'Contabilidad' }, { id: 3, name: 'Cuentas por Pagar' }], users: [{ id: 7, name: 'Usuario de capacitación' }, { id: 8, name: 'Supervisora tributaria' }], departments: departments.map(row => ({ id: row.id, name: row.name })), costCenters: costCenters.map(row => ({ id: row.id, name: row.name })) };
  if (path === '/api/approval-engine/workflows') return [{ id: 1, nombre: 'Aprobación de solicitudes de pago', entity_type: 'PAYMENT_REQUEST', estado_activo: true, descripcion: 'Ruta según tercero y dimensiones', rules: [{ id: 1, nombre_nivel: 'Supervisión tributaria', rol_aprobador_id: 2, politica: 'CUALQUIERA', condicion_monto_min: 0, tipo_desembolso: 'OTROS' }, { id: 2, nombre_nivel: 'Aprobación financiera', rol_aprobador_id: 3, politica: 'TODOS', condicion_monto_min: 1000000 }] }];

  if (path === '/api/reports/accounting/options') return reportOptions;
  if (path === '/api/reports/accounting/bank-reconciliation') return { rows: [{ bank_tran_id: 101, reconciliation_status: 'PENDIENTE', date: '2026-10-27', value_date: '2026-10-27', transaction_type: 'COBRO', reference: 'COB-CLI-00000027', beneficiary: customers[0].name, description: 'Cobro de factura', note: 'Transferencia de cliente', deposits: 35887.09, withdrawals: 0, running_balance: 168585.50, amount: 35887.09 }], statementLines: [{ statement_line_id: 201, reconciliation_status: 'PENDIENTE', bank_date: '2026-10-27', reference: 'COM-BAN-1027', description: 'Comisión transferencia internacional', amount: -29.61 }, { statement_line_id: 202, reconciliation_status: 'PENDIENTE', bank_date: '2026-10-27', reference: 'TRF-DEMO-2026', description: 'Cobro cliente demostración', amount: 35887.09 }], summary: { bookBalance: 168585.50, statementBalance: 168585.50, transitPayments: 0, transitDeposits: 0, adjustments: 0, difference: 0 }, reconciliation: { status: 'ABIERTA' }, total: 2 };
  if (path === '/api/reports/accounting/journal') return { rows: [{ journal_id: 1001, journal_number: 'ASI-DIA-00001001', date: '2026-10-22', status: 'CONTABILIZADO', transaction_code: 'ASI_DIA', module_category: 'Contabilidad', document_number: 'CAP-DEMO-001', created_by: 'Usuario de capacitación', memo: 'Registro de capacitación balanceado', debit: 230000, credit: 230000, difference: 0, lines: [{ account_number: '613010', account_name: 'Servicios profesionales', entity_type: 'Proveedor', entity_name: suppliers[0].name, cost_center: 'CC-ADM-001', note: 'Servicio de implementación', debit: 230000, credit: 0 }, { account_number: '211001', account_name: 'Cuentas por Pagar Proveedores', entity_type: 'Proveedor', entity_name: suppliers[0].name, cost_center: '—', note: 'Contrapartida CxP', debit: 0, credit: 230000 }] }], total: 1, summary: { debit: 230000, credit: 230000 } };

  if (path === '/api/treasury/workspace') return { subsidiary: { id: 1, name: subsidiaries[0].name, currency: 'JMD' }, position: { banks: 3250000, cash: 175000, available: 3425000 }, bankAccounts: [{ id: 71, bank: 'JN Bank Limited', number: '02000006419', currency: 'JMD', balance: 3250000 }], cashboxes: [{ id: 1, name: 'Caja administrativa', location: 'Oficina Central', currency: 'JMD', balance: 175000, status: 'ABIERTA' }], movements: [{ id: 1, date: '2026-10-27', cashbox: 'Caja administrativa', type: 'EGRESO', concept: 'Mensajería', reference: 'CAJ-00018', amount: -4500 }], schedules: [{ id: 1, plannedDate: '2026-10-30', type: 'PAYMENT', party: suppliers[0].name, document: 'FAC-PRO-000014', dueDate: '2026-11-11', currency: 'JMD', amount: 230000, priority: 'NORMAL', status: 'PROGRAMADO' }], forecast: [{ date: '2026-10-29', collections: 500000, payments: 230000 }, { date: '2026-10-30', collections: 350000, payments: 1250000 }], payables: [], receivables: [], currencies: [{ id: 1, code: 'JMD' }], accounts, location: { id: 41, name: 'Oficina Central' } };
  if (path === '/api/treasury/payment-batches/options') return { company: { id: 1, name: subsidiaries[0].name }, permissions: { manage: true, execute: true }, accounts: [{ id: 71, bankId: 7, bank: 'JN Bank Limited', name: 'JN Bank Limited', number: '02000006419', currencyId: 1, currencyCode: 'JMD', balance: 3250000, iban: 'JM-DEMO-02000006419' }], formats: [{ id: 1, bankId: 7, currencyId: 1, name: 'Archivo de pagos JN Bank', code: 'JNB_JM_PAYMENTS', extension: '.csv', verified: true }], currencies: [{ id: 1, code: 'JMD', name: 'JMD' }], suppliers: [{ id: 1, name: suppliers[0].name }] };
  if (path === '/api/treasury/payment-batches/candidates') return { rows: [{ id: 93, number: 'SOL-PAG-00000093', plannedDate: '2026-10-30', supplier: 'TAJ · Tax Administration Jamaica', taxId: 'TAJ-DEMO', invoices: [{ number: 'DECL-GCT-2026-10', amount: 1250000 }], dueDate: '2026-10-30', iban: 'JM-DEMO-TAX-001', ibanValid: true, taxIdValid: true, valid: true, amount: 1250000, applicationAmount: 1250000, currency: 'JMD' }, { id: 94, number: 'SOL-PAG-00000094', plannedDate: '2026-10-31', supplier: suppliers[0].name, taxId: 'DEMO-PRO-001', invoices: [{ number: 'FAC-PRO-000014', amount: 230000 }], dueDate: '2026-11-11', iban: 'JM-DEMO-PRO-001', ibanValid: true, taxIdValid: true, valid: true, amount: 230000, applicationAmount: 230000, currency: 'JMD' }] };
  if (path === '/api/treasury/payment-batches/report') return { rows: [{ id: 8, number: 'PAY-BATCH-2026-000008', executionDate: '2026-10-25', createdAt: '2026-10-24T10:00:00Z', bank: 'JN Bank Limited', account: '02000006419', currency: 'JMD', itemCount: 3, total: 1480000, status: 'SENT_TO_BANK', bankReference: 'JNB-DEMO-008', createdBy: 'Usuario de capacitación', fileName: 'PAY-BATCH-2026-000008.csv' }] };

  if (path === '/api/fixed-assets/workflow-options') return { subsidiary: { id: 1, name: subsidiaries[0].name }, currency: { id: 1, code: 'JMD', name: 'Dólar jamaicano' }, categories: [{ id: 1, code: 'CAT-ACT-000001', name: 'Equipo de cómputo', life: 36 }], locations: [{ id: 41, name: 'Oficina Central' }], departments: departments.map(row => ({ id: row.id, name: row.name, type: row.type })), costs: costCenters.map(row => ({ id: row.id, name: row.name, departmentId: row.department_id, classId: row.class_id })), classes: classes.map(row => ({ id: row.id, name: row.name })) };
  if (path === '/api/fixed-assets/workflow-report') return { rows: [{ id: 1, number: 'ACT-000001', name: 'Laptop de capacitación', serial: 'DEMO-SN-001', category: 'Equipo de cómputo', categoryId: 1, location: 'Oficina Central', locationId: 41, currency: 'JMD', serviceDate: '2026-01-01', purchaseDate: '2026-01-01', cost: 312775.19, accumulated: 292834.75, bookValue: 19940.44, status: 'ACTIVO', departmentId: 11, costCenterId: 32 }] };
  if (path === '/api/fixed-assets/asset-category-options') {
    const categoryAccounts = accounts.map(row => ({ id: row.id, name: row.name, number: row.number }));
    return { subsidiary: { id: 1, name: subsidiaries[0].name }, assetAccounts: categoryAccounts, depreciationAccounts: categoryAccounts, expenseAccounts: categoryAccounts, permissions: { manage: true } };
  }
  if (path === '/api/fixed-assets/asset-category-report') return { rows: [{ id: 1, code: 'CAT-ACT-000001', name: 'Equipo de cómputo', description: 'Equipos tecnológicos de uso administrativo', assetAccount: '131004 · Equipo de cómputo', depreciationAccount: '132004 · Depreciación acumulada', expenseAccount: '632004 · Depreciación equipo', method: 'Línea Recta', usefulLife: 36, residual: 0, assets: 2, active: true }] };

  if (path === '/api/tax-obligations/options') return { permissions: { view: true, manage: true }, countries: [{ id: 1, name: 'Jamaica' }, { id: 2, name: 'Costa Rica' }], placeholders: [{ token: 'obligacion', label: 'Obligación' }, { token: 'responsable', label: 'Responsable' }, { token: 'fecha_vencimiento', label: 'Fecha de vencimiento' }] };
  if (path === '/api/tax-obligations/list') return { obligations: [{ id: 'tax-jm-gct', countryId: 1, countryName: 'Jamaica', code: 'GCT_MENSUAL', name: 'Declaración mensual de GCT', frequency: 'monthly', description: 'Declaración del impuesto general al consumo.', isActive: true }, { id: 'tax-jm-paye', countryId: 1, countryName: 'Jamaica', code: 'PAYE_MENSUAL', name: 'Retenciones PAYE', frequency: 'monthly', description: 'Retenciones de nómina.', isActive: true }], templates: [{ id: 'template-reminder-jm', countryId: 1, countryName: 'Jamaica', kind: 'reminder', subjectTemplate: 'Recordatorio {{obligacion}}', bodyTemplate: 'El vencimiento es {{fecha_vencimiento}}.', isActive: true }] };
  if (path === '/api/tax-calendar/options') return { activeSubsidiaryId: 1, permissions: { view: true, manage: true, file: true }, subsidiaries: [{ id: 1, name: subsidiaries[0].name, countryId: 1 }], users: [{ id: 7, name: 'Usuario de capacitación', email: 'capacitacion@example.test', subsidiaryIds: [1] }], taxTypes: [{ code: 'JAM_GCT_15%', name: 'JAM_GCT_15% · GCT · 15%', subsidiaryIds: [1] }] };
  if (path === '/api/tax-calendar/list') return { events: [{ id: 'event-demo-1', subsidiaryId: 1, subsidiaryName: subsidiaries[0].name, taxTypeCode: 'JAM_GCT_15%', taxTypeName: 'GCT', period: '2026-10', dueDate: CAPTURE_DATE, assignedUserId: 7, assignedUserName: 'Usuario de capacitación', assignedUserEmail: 'capacitacion@example.test', status: 'in_review', documentType: 'file_upload', notes: 'Declaración mensual GCT', followersCount: 1, reminderDays: [7, 3, 1, 0], createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-27T15:00:00Z' }], metrics: { total: 1, pending: 0, inReview: 1, upcoming: 1, overdue: 0, filed: 0, exempt: 0 }, notifications: [{ id: 'notification-demo-1', eventId: 'event-demo-1', kind: 'reminder', priority: 'normal', title: 'Recordatorio tributario · JAM_GCT_15%', message: 'La declaración vence hoy.', deepLink: '/tax-calendar.html?event=event-demo-1', readAt: null, createdAt: '2026-10-28T08:00:00Z', taxTypeCode: 'JAM_GCT_15%', dueDate: CAPTURE_DATE, subsidiaryName: subsidiaries[0].name }] };
  if (path === '/api/v1/reports/tax/vat-declaration/options') return vatOptions();
  if (path === '/api/v1/reports/tax/vat-declaration') return vatReport();

  if (path === '/api/v1/accounting/consolidation' && method === 'GET') return { holding: { id: 1, name: 'GENTIA HOLDING DEMOSTRACIÓN' }, currency: { id: 2, code: 'USD' }, periods: ['2026-09', '2026-10'], runs: [], canRun: true };
  if (path === '/api/v1/accounting/consolidation' && method === 'POST') return { ready: true, id: 7, status: 'VALIDADO' };
  if (path.endsWith('/run-translation')) return { id: 7, status: 'CONVERTIDO', rows: 8 };
  if (path.endsWith('/auto-eliminate')) return { id: 7, status: 'PROCESADO', cta: 28450 };
  if (path.endsWith('/publish')) return { id: 7, status: 'PUBLICADO' };
  if (path.endsWith('/worksheet')) return { run: { total_assets: 1850000, total_liabilities: 720000, total_equity: 1101550, cta_oci: 28450 }, subsidiaries: [{ id: 1, name: 'Jamaica' }, { id: 2, name: 'Costa Rica' }], rows: [{ code: '1105', name: 'Efectivo y equivalentes', companies: { 1: 950000, 2: 425000 }, summed: 1375000, eliminationDebit: 0, eliminationCredit: 0, consolidated: 1375000 }, { code: '1130', name: 'Cuentas por cobrar', companies: { 1: 354000, 2: 220000 }, summed: 574000, eliminationDebit: 0, eliminationCredit: 99000, consolidated: 475000 }, { code: '2110', name: 'Cuentas por pagar', companies: { 1: 420000, 2: 399000 }, summed: 819000, eliminationDebit: 99000, eliminationCredit: 0, consolidated: 720000 }] };

  if (path === '/api/v1/reports/audit/changes/options') return auditOptions;
  if (path === '/api/v1/reports/audit/changes') return auditReport;

  if (path === '/api/pdf-templates/options') return { subsidiary: { id: 1, name: subsidiaries[0].name }, templates: [{ id: 1, name: 'Factura de venta ejecutiva', documentType: 'FAC_VEN', pageSize: 'A4', orientation: 'PORTRAIT', branchId: null, isDefault: true, isSystem: true }, { id: 2, name: 'Solicitud de pago', documentType: 'SOL_PAG', pageSize: 'A4', orientation: 'PORTRAIT', branchId: null, isDefault: true, isSystem: false }, { id: 3, name: 'Voucher contable', documentType: 'ASI_DIA', pageSize: 'LETTER', orientation: 'LANDSCAPE', branchId: null, isDefault: false, isSystem: true }] };
  if (path === '/api/configuration/notification-templates/get') return { canEdit: true, subsidiary: { name: subsidiaries[0].name }, transport: { enabled: true }, template: { asunto_template: 'Solicitud {{numero_solicitud}} pendiente de aprobación', cuerpo_template: '<p>Hola {{aprobador_nombre}}, tiene una solicitud pendiente.</p><p><b>{{numero_solicitud}}</b> · {{monto_total}} {{moneda}}</p>', activo: true, updated_by_email: 'capacitacion@example.test', updated_at: '2026-10-27T15:30:00Z' }, defaults: { subject: 'Solicitud pendiente', body: '<p>Revise la solicitud.</p>' } };
  if (path === '/api/configuration/notification-templates/preview') return { subject: 'Solicitud SOL-PAG-00000093 pendiente de aprobación', html: '<!doctype html><html><body style="font-family:Arial;color:#0f2445;padding:28px"><div style="max-width:620px;margin:auto;border:1px solid #d8e0eb;border-radius:16px;overflow:hidden"><header style="background:#042e72;color:white;padding:24px"><h1 style="margin:0">GENTIA</h1><p style="margin:6px 0 0">Solicitud pendiente de aprobación</p></header><main style="padding:26px"><h2>SOL-PAG-00000093</h2><p>Pago de impuestos de octubre</p><table style="width:100%;border-collapse:collapse"><tr><td>Departamento</td><td><b>ADMINISTRATIVO</b></td></tr><tr><td>Centro de costo</td><td><b>CC-ADM-001</b></td></tr><tr><td>Monto</td><td><b>J$ 1 250 000,00</b></td></tr></table><p><a style="display:inline-block;background:#0d8b67;color:white;padding:12px 20px;border-radius:8px;text-decoration:none">Revisar y aprobar</a></p></main></div></body></html>' };

  if (path === '/api/reports/schedules/list') return { company: { id: 1, name: subsidiaries[0].name }, transport: { enabled: true }, reports: [{ code: 'income-statement', name: 'Estado de Resultados Integral', category: 'Estados financieros' }, { code: 'journal', name: 'Libro Diario', category: 'Control contable' }, { code: 'bank-reconciliation', name: 'Conciliación bancaria', category: 'Bancos', requires_bank: true }], books: [{ id: 1, name: 'Fiscal local' }], banks: [{ id: 71, name: 'JN Bank Limited · 02000006419' }], schedules: [{ id: 1, revision: 2, name: 'Cierre contable mensual', report_kind: 'income-statement', format: 'BOTH', frequency: 'MONTHLY', weekday: 1, month_day: 3, send_time: '08:00:00', recipients: ['contabilidad@example.test', 'gerencia@example.test'], active: true, next_run_at: '2026-11-03T14:00:00Z', lastStatus: 'ENVIADO', cutoff_rule: 'PREVIOUS_MONTH_END', period_mode: 'YEAR_TO_DATE', report_options: { bookId: 1 } }], history: [{ name: 'Cierre contable mensual', report_kind: 'income-statement', occurrence: '2026-10-03T14:00:00Z', cutoff: '2026-09-30', recipient: 'contabilidad@example.test', status: 'ENVIADO', last_error: '' }] };

  // Los catálogos genéricos usan el mismo endpoint para listar y guardar. Para la
  // captura únicamente se atienden lecturas; los datos son sintéticos.
  if (method === 'GET' && /^\/api\/(organization|inventory|documents|security)\//.test(path)) return [];
  if (url.searchParams.has('format')) return [];
  return [];
}

async function routeApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const payload = fixtureFor(url.pathname, request.method(), url);
  await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
}

function initTrainingStorage() {
  const payload = btoa(JSON.stringify({
    sub: '00000000-0000-4000-8000-000000000001',
    email: 'capacitacion@example.test',
    exp: Math.floor(Date.now() / 1000) + 7200,
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  localStorage.setItem('nexo_token', `e30.${payload}.training`);
  localStorage.setItem('nexo_device_token', 'training-device-safe-demo');
  localStorage.setItem('nexo_role', '1');
  localStorage.setItem('nexo_company', '1');
  localStorage.setItem('nexo_company_name', 'EMPRESA DEMOSTRACIÓN GENTIA');
  localStorage.setItem('nexo_location_name_1', 'Oficina Central');
  window.NexoRecordAudit = window.NexoRecordAudit || { show() {}, button() { return ''; } };
}

const badgeCss = `
  *,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}
  html{scroll-behavior:auto!important}
  .gentia-training-badge{position:fixed;right:18px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid rgba(4,46,114,.22);border-radius:999px;background:rgba(255,255,255,.96);box-shadow:0 8px 24px rgba(15,35,68,.14);color:#042e72;font:700 11px/1.2 Arial,sans-serif;letter-spacing:.45px;text-transform:uppercase;pointer-events:none}
  .gentia-training-badge::before{content:"";width:8px;height:8px;border-radius:50%;background:#0c9b72;box-shadow:0 0 0 4px rgba(12,155,114,.12)}
`;

async function polish(scope, page) {
  await scope.addStyleTag({ content: badgeCss }).catch(() => {});
  await scope.evaluate(() => {
    document.querySelector('.gentia-training-badge')?.remove();
    const badge = document.createElement('div');
    badge.className = 'gentia-training-badge';
    badge.textContent = 'Entorno de capacitación · Datos ficticios';
    document.body.append(badge);
    window.scrollTo(0, 0);
  }).catch(() => {});
  await scope.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(350);
}

const manifest = [];
const failures = [];

async function saveScreenshot(page, spec, scope = page) {
  await polish(scope, page);
  if (spec.afterPolish) await spec.afterPolish(scope, page);
  const filePath = `${OUTPUT}${spec.file}`;
  await page.screenshot({ path: filePath, fullPage: false, animations: 'disabled' });
  const buffer = await import('node:fs/promises').then(({ readFile }) => readFile(filePath));
  const info = await stat(filePath);
  if (info.size < 12_000) throw new Error(`La captura ${spec.file} es demasiado pequeña (${info.size} bytes).`);
  manifest.push({
    topicCode: spec.file.slice(0, 6), topic: topics.find(([code]) => spec.file.startsWith(code))?.[1] || '',
    file: spec.file, title: spec.title, source: spec.url, width: VIEWPORT.width, height: VIEWPORT.height,
    bytes: info.size, sha256: createHash('sha256').update(buffer).digest('hex'), generatedAt: new Date().toISOString(), syntheticData: true,
  });
  console.log(`OK ${spec.file} · ${Math.round(info.size / 1024)} KB`);
}

async function capture(context, spec) {
  if (ONLY_CAP && !spec.file.startsWith(ONLY_CAP)) return;
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (ONLY_CAP) page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log(`NAV ${spec.file}: ${frame.url()}`); });
  try {
    let scope = page;
    if (spec.url === '/') {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.setContent(`<style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#f5f7fb}iframe{display:block;width:100%;height:100%;border:0}</style><iframe id="trainingFrame" title="Vista GENTIA" src="${ORIGIN}${spec.url}"></iframe>`);
      const handle = await page.locator('#trainingFrame').elementHandle();
      scope = await handle.contentFrame();
      await scope.waitForLoadState('domcontentloaded');
    }
    if (spec.wait) await scope.locator(spec.wait).first().waitFor({ state: 'visible' });
    if (spec.prepare) await spec.prepare(scope);
    await saveScreenshot(page, spec, scope);
    if (errors.length) console.warn(`Aviso ${spec.file}: ${errors.join(' | ')}`);
  } catch (error) {
    const diagnostic = await page.frames().at(-1).evaluate(() => ({
      title: document.title,
      body: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 260) || '',
    })).catch(() => ({ title: '', body: '' }));
    failures.push({ file: spec.file, error: error.message, pageErrors: errors, url: page.url(), diagnostic });
    console.error(`FALLO ${spec.file}: ${error.message}\n  URL ${page.url()} · ${diagnostic.title} · ${diagnostic.body}\n  PAGEERROR ${errors.join(' | ')}`);
  } finally {
    await page.close();
  }
}

async function capturePublic(browser, spec) {
  if (ONLY_CAP && !spec.file.startsWith(ONLY_CAP)) return;
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'es-CR', timezoneId: 'America/Costa_Rica', colorScheme: 'light', reducedMotion: 'reduce' });
  await context.route('**/api/**', routeApi);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(`${ORIGIN}${spec.url}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (spec.wait) await page.locator(spec.wait).first().waitFor({ state: 'visible' });
    if (spec.prepare) await spec.prepare(page);
    await saveScreenshot(page, spec);
  } catch (error) {
    failures.push({ file: spec.file, error: error.message, pageErrors: [] });
    console.error(`FALLO ${spec.file}: ${error.message}`);
  } finally {
    await context.close();
  }
}

async function captureCatalog(context, { file, title, module, section }) {
  await capture(context, {
    file, title, url: '/', wait: '.workspace',
    prepare: async page => {
      await page.locator('.nav-link').filter({ hasText: module }).click();
      await page.locator('.nav-children a').getByText(section, { exact: true }).click();
      await page.getByRole('heading', { name: section, exact: true }).waitFor();
      await page.waitForTimeout(250);
    },
  });
}

await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: CHROME });

try {
  const context = await browser.newContext({
    viewport: VIEWPORT, locale: 'es-CR', timezoneId: 'America/Costa_Rica', colorScheme: 'light',
    reducedMotion: 'reduce', acceptDownloads: true, deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: TRAINING_LOCAL_STORAGE }] },
  });
  await context.addInitScript(initTrainingStorage);
  await context.route('**/api/**', routeApi);

  await capturePublic(browser, { file: 'CAP-01-01-login.png', title: 'Inicio de sesión seguro', url: '/', wait: '.auth-panel h2' });
  await capture(context, { file: 'CAP-01-02-workspace.png', title: 'Espacio de trabajo GENTIA', url: '/', wait: '.workspace' });

  await capture(context, { file: 'CAP-02-01-permisos-por-rol.png', title: 'Matriz de permisos por rol', url: '/role-access-matrix.html', wait: '.module-card' });
  await capture(context, { file: 'CAP-02-02-acciones-especiales.png', title: 'Acciones especiales de seguridad', url: '/role-access-matrix.html', wait: '.module-card', prepare: async page => { await page.getByRole('button', { name: /Acciones especiales/ }).click(); await page.locator('.special-card').first().waitFor(); } });

  await captureCatalog(context, { file: 'CAP-03-01-departamentos.png', title: 'Catálogo de departamentos', module: 'Organización', section: 'Departamentos' });
  await captureCatalog(context, { file: 'CAP-03-02-centros-costos.png', title: 'Catálogo de centros de costos', module: 'Organización', section: 'Centros de costos' });

  await capture(context, { file: 'CAP-04-01-asiento-diario.png', title: 'Registro de asiento de diario', url: '/journal-entry.html', wait: '#lines tr', prepare: async page => {
    await page.locator('#memo').fill('Registro contable de capacitación');
    const rows = page.locator('#lines tr');
    await rows.nth(0).locator('.account-search').fill('613010'); await rows.nth(0).locator('.account-search').dispatchEvent('change'); await rows.nth(0).locator('[data-key="debit"]').fill('230000'); await rows.nth(0).locator('[data-key="debit"]').dispatchEvent('input');
    await rows.nth(1).locator('.account-search').fill('211001'); await rows.nth(1).locator('.account-search').dispatchEvent('change'); await rows.nth(1).locator('[data-key="credit"]').fill('230000'); await rows.nth(1).locator('[data-key="credit"]').dispatchEvent('input');
  } });
  await capture(context, { file: 'CAP-04-02-importar-asientos.png', title: 'Importación masiva de asientos', url: '/journal-import.html', wait: 'h1' });

  await capture(context, { file: 'CAP-05-01-saldos-iniciales.png', title: 'Carga y validación de saldos iniciales', url: '/opening-balances.html', wait: '#post' });
  await capture(context, { file: 'CAP-05-02-confirmar-apertura.png', title: 'Confirmación profesional de la apertura', url: '/opening-balances.html', wait: '#post', prepare: async page => { await page.locator('#post').click(); await page.locator('#postConfirmationDialog').waitFor({ state: 'visible' }); } });

  await capture(context, { file: 'CAP-06-01-factura-venta.png', title: 'Creación de factura de venta', url: '/sales-invoice-entry.html', wait: '#lines tr', prepare: async page => {
    await page.locator('#customer').selectOption('1'); await page.locator('#memo').fill('Servicios de implementación ERP · octubre 2026');
    const row = page.locator('#lines tr').first(); await row.locator('[data-k="product_id"]').selectOption('1'); await row.locator('[data-k="unit_price"]').fill('125000'); await row.locator('[data-k="unit_price"]').dispatchEvent('blur'); await row.locator('[data-k="tax_code_id"]').selectOption('1');
    await page.locator('#unifyPdfLines').check({ force: true }); await page.locator('#unifiedPdfDescription').fill('Servicios profesionales según detalle adjunto');
  } });
  await capture(context, { file: 'CAP-06-02-cobro-comision-bancaria.png', title: 'Cobro a cliente con comisión bancaria', url: '/customer-payments.html', wait: '#new', prepare: async page => {
    await page.locator('#new').click(); await page.locator('#modal:not([hidden])').waitFor(); await page.locator('#customer').selectOption('1'); await page.locator('#currency').selectOption('2'); await page.locator('#account').selectOption('71'); await page.locator('#reference').fill('TRF-DEMO-2026');
    await page.locator('#invoiceRows .apply').fill('35916.70'); await page.locator('#bankFeeEnabled').check(); await page.locator('#bankFeeAmount').fill('29.61');
  } });

  await capture(context, { file: 'CAP-07-01-factura-proveedor.png', title: 'Creación de factura de proveedor', url: '/supplier-invoice-entry.html', wait: '#lines tr', prepare: async page => {
    await page.locator('#invoiceNumber').fill('FAC-PRO-DEMO-001'); await page.locator('#supplier').selectOption('1'); await page.locator('#paymentTerm').selectOption('1'); await page.locator('#memo').fill('Servicios profesionales de implementación');
    const row = page.locator('#lines tr').first(); await row.locator('.account-search').fill('613010'); await row.locator('.account-search').dispatchEvent('change'); await row.locator('[data-key="unit_price"]').fill('200000'); await row.locator('[data-key="unit_price"]').dispatchEvent('blur');
  } });
  await capture(context, { file: 'CAP-07-02-pagos-proveedores.png', title: 'Pagos a proveedores y cuentas por pagar', url: '/supplier-payments.html', wait: '#rows tr' });

  await capture(context, { file: 'CAP-08-01-lista-solicitudes-pago.png', title: 'Seguimiento de solicitudes de pago', url: '/payment-requests.html', wait: '#rows tr' });
  await capture(context, { file: 'CAP-08-02-solicitud-imputacion-directa.png', title: 'Solicitud de pago por imputación directa', url: '/payment-requests.html', wait: '#new', prepare: async page => {
    await page.locator('#new').click(); await page.locator('#type').selectOption('OTROS'); await page.locator('#planned').fill('2026-10-30'); await page.locator('#concept').fill('Pago de impuestos de octubre');
    const row = page.locator('#directLines tr').first(); await row.locator('.account').selectOption('507'); await row.locator('.entityType').selectOption('Agencia Tributaria'); await row.locator('.entity').selectOption('301'); await row.locator('.departmentType').selectOption('Interno'); await row.locator('.department').selectOption('11'); await row.locator('.center').selectOption('32'); await row.locator('.concept').fill('GCT del periodo'); await row.locator('.amount').fill('1250000');
  } });

  await capture(context, { file: 'CAP-09-01-bandeja-aprobaciones.png', title: 'Bandeja central de aprobaciones', url: '/approval-inbox.html', wait: '#rows tr' });
  await capture(context, { file: 'CAP-09-02-flujos-aprobacion.png', title: 'Configuración de flujos de aprobación', url: '/approval-workflows.html', wait: '.workflow-row' });

  await capture(context, { file: 'CAP-10-01-auxiliar-bancario.png', title: 'Auxiliar de bancos', url: '/accounting-reports.html?reporte=bank-reconciliation', wait: '#bankControls' });
  await capture(context, { file: 'CAP-10-02-hoja-conciliacion.png', title: 'Hoja de conciliación y comisiones del extracto', url: '/accounting-reports.html?reporte=bank-reconciliation', wait: '#bankView', prepare: async page => { await page.locator('#bankView').selectOption('WORKSPACE'); await page.locator('#bankView').dispatchEvent('change'); await page.locator('.bank-fee-panel').waitFor(); } });

  await capture(context, { file: 'CAP-11-01-posicion-tesoreria.png', title: 'Posición de tesorería y proyección', url: '/treasury.html', wait: '#metrics .metric' });
  await capture(context, { file: 'CAP-11-02-lotes-pago.png', title: 'Generador de archivos de pago masivo', url: '/payment-batches.html?view=generator', wait: '#bankAccount', prepare: async page => { await page.locator('#bankAccount').selectOption('71'); await page.locator('#bankAccount').dispatchEvent('change'); await page.locator('#findCandidates').click(); await page.locator('#candidateRows .candidate-row').first().waitFor(); } });

  await capture(context, { file: 'CAP-12-01-activos-fijos.png', title: 'Auxiliar y control de activos fijos', url: '/fixed-assets.html', wait: '#rows tr' });
  await capture(context, { file: 'CAP-12-02-categorias-activos.png', title: 'Categorías de activos fijos', url: '/asset-categories.html', wait: '#rows tr' });

  await captureCatalog(context, { file: 'CAP-13-01-productos.png', title: 'Catálogo maestro de productos', module: 'Inventario', section: 'Productos' });
  await captureCatalog(context, { file: 'CAP-13-02-tipos-articulos.png', title: 'Tipos de artículos y servicios', module: 'Inventario', section: 'Tipos de artículos' });

  await capture(context, { file: 'CAP-14-01-obligaciones-tributarias.png', title: 'Catálogo de obligaciones tributarias', url: '/tax-obligations.html', wait: '#obligationRows tr' });
  await capture(context, { file: 'CAP-14-02-calendario-tributario.png', title: 'Calendario tributario y alertas', url: '/tax-calendar.html', wait: '#monthGrid [data-event]' });
  await capture(context, { file: 'CAP-14-03-declaracion-iva-gct.png', title: 'Declaración de IVA/GCT por tarifa', url: '/vat-declaration-report.html', wait: '#salesTable .rate-row' });

  await capture(context, { file: 'CAP-15-01-iniciar-consolidacion.png', title: 'Parámetros de consolidación financiera', url: '/consolidation.html', wait: '#init' });
  await capture(context, { file: 'CAP-15-02-hoja-consolidacion.png', title: 'Conversión, eliminaciones y hoja consolidada', url: '/consolidation.html', wait: '#init', prepare: async page => { await page.locator('#period').selectOption('2026-10'); await page.locator('#init').click(); await page.locator('#translate').click(); await page.locator('#eliminate').click(); await page.locator('#tbody tr').first().waitFor(); } });

  await capture(context, { file: 'CAP-16-01-catalogo-reportes.png', title: 'Catálogo de reportes contables', url: '/accounting-reports.html', wait: '#dashboard .card' });
  await capture(context, { file: 'CAP-16-02-libro-diario.png', title: 'Libro Diario cuadrado y auditable', url: '/accounting-reports.html?reporte=journal', wait: '.journal-header' });

  await capture(context, { file: 'CAP-17-01-reporte-auditoria.png', title: 'Reporte de registros modificados y eliminados', url: '/audit-change-report.html', wait: '.transaction-group' });
  await capture(context, { file: 'CAP-17-02-detalle-cambio.png', title: 'Detalle de valores anteriores y nuevos', url: '/audit-change-report.html', wait: '[data-expand="101"]', prepare: async page => { await page.locator('[data-expand="101"]').click(); await page.getByText('BORRADOR', { exact: true }).waitFor(); }, afterPolish: async page => { await page.locator('.detail-row:not([hidden])').first().scrollIntoViewIfNeeded(); } });

  await capture(context, { file: 'CAP-18-01-plantillas-pdf.png', title: 'Plantillas profesionales de PDF', url: '/pdf-templates.html', wait: '#rows tr' });
  await capture(context, { file: 'CAP-18-02-plantilla-notificacion.png', title: 'Plantilla editable de correo de aprobación', url: '/notification-templates.html?kind=SOLICITUD_GASTO_APROBACION', wait: '#previewSubject' });

  await capturePublic(browser, { file: 'CAP-19-01-recuperar-contrasena.png', title: 'Recuperación segura de contraseña', url: '/', wait: '.auth-panel h2', prepare: async page => { await page.getByText('¿Olvidaste tu contraseña?', { exact: true }).click(); await page.locator('#recovery-email').waitFor(); } });
  await capture(context, { file: 'CAP-19-02-reportes-programados.png', title: 'Programación y continuidad de reportes', url: '/scheduled-reports.html', wait: '#schedules tr' });

  const topicCoverage = topics.map(([code, name]) => ({ code, name, files: manifest.filter(item => item.topicCode === code).map(item => item.file) }));
  const validation = {
    generatedAt: new Date().toISOString(), origin: ORIGIN, safeSyntheticFixtures: true,
    expectedTopics: topics.length, coveredTopics: topicCoverage.filter(item => item.files.length).length,
    totalImages: manifest.length, failures,
  };
  await writeFile(`${OUTPUT}manifest.json`, `${JSON.stringify({ validation, topics: topicCoverage, images: manifest }, null, 2)}\n`, 'utf8');
  if ((!ONLY_CAP && (failures.length || validation.coveredTopics !== topics.length || manifest.length < 25)) || (ONLY_CAP && failures.length)) {
    throw new Error(`Capturas incompletas: ${manifest.length} PNG, ${validation.coveredTopics}/${topics.length} temas, ${failures.length} fallos. Consulte ${OUTPUT}manifest.json.`);
  }
  console.log(JSON.stringify(validation, null, 2));
} finally {
  await browser.close();
}
