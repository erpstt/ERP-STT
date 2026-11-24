// Register reports here once: the dashboard and role matrix use this same catalog.
// New entries start without grants; access must be assigned explicitly.
export interface ReportDefinition {key:string;title:string;group:string;description:string;url?:string;path?:string}
export const reportCatalog:ReportDefinition[] = [
  {
    "group": "financial",
    "key": "balance-sheet",
    "title": "Estado de Situación Financiera",
    "description": "Foto patrimonial en Activos, Pasivos y Patrimonio.",
    "path": "/api/reports/accounting/balance-sheet"
  },
  {
    "group": "financial",
    "key": "income-statement",
    "title": "Estado de Resultados Integral",
    "description": "Ingresos, costos, gastos y resultado del período.",
    "path": "/api/reports/accounting/income-statement"
  },
  {
    "group": "financial",
    "key": "cash-flow",
    "title": "Estado de Flujos de Efectivo",
    "description": "Movimientos de las cuentas de efectivo y bancos.",
    "path": "/api/reports/accounting/cash-flow"
  },
  {
    "group": "financial",
    "key": "equity-changes",
    "title": "Estado de Cambios en el Patrimonio",
    "description": "Variaciones de las cuentas patrimoniales entre fechas.",
    "path": "/api/reports/accounting/equity-changes"
  },
  {
    "group": "operational",
    "key": "trial-balance",
    "title": "Balance de Comprobación",
    "description": "Saldos iniciales, débitos, créditos, saldos finales y validación de cuadre.",
    "path": "/api/reports/accounting/trial-balance"
  },
  {
    "group": "operational",
    "key": "general-ledger",
    "title": "Libro Mayor",
    "description": "Movimientos cronológicos por cuenta y saldo acumulado.",
    "path": "/api/reports/accounting/general-ledger"
  },
  {
    "group": "operational",
    "key": "journal",
    "title": "Libro Diario",
    "description": "Registro cronológico de transacciones y asientos.",
    "path": "/api/reports/accounting/journal"
  },
  {
    "group": "operational",
    "key": "pending-invoice-control",
    "title": "Control de Pendientes de Facturar",
    "description": "Saldo disponible e historial de reversiones de los asientos ASI_PEN.",
    "path": "/api/reports/accounting/pending-invoice-control"
  },
  {
    "group": "operational",
    "key": "sales-transactions",
    "title": "Ventas Transaccionales",
    "description": "Facturas, notas de crédito y notas de débito con conciliación de ventas netas.",
    "path": "/api/reports/accounting/sales-transactions"
  },
  {
    "group": "operational",
    "key": "purchase-transactions",
    "title": "Compras Transaccionales",
    "description": "Facturas de proveedor, notas de crédito y notas de débito con compras netas.",
    "path": "/api/reports/accounting/purchase-transactions"
  },
  {
    "group": "operational",
    "key": "receivables-aging",
    "title": "Cuentas por Cobrar",
    "description": "Auxiliar de clientes y antigüedad de saldos por factura.",
    "path": "/api/reports/accounting/receivables-aging"
  },
  {
    "group": "operational",
    "key": "payables-aging",
    "title": "Cuentas por Pagar",
    "description": "Auxiliar de proveedores y antigüedad de saldos por factura.",
    "path": "/api/reports/accounting/payables-aging"
  },
  {
    "group": "operational",
    "key": "payroll-journals",
    "title": "Asientos de Nóminas",
    "description": "ASI_NOM y ASI_LIQ por cuenta del grupo 223, nota y departamento.",
    "path": "/api/reports/accounting/payroll-journals"
  },
  {
    "group": "operational",
    "key": "accrued-payroll-payables",
    "title": "Gasto Acumulado por Pagar",
    "description": "Grupo 223 · Nóminas y pagos por cuenta, moneda, departamento y centro de costos.",
    "path": "/api/reports/accounting/accrued-payroll-payables"
  },
  {
    "group": "operational",
    "key": "supplier-advances",
    "title": "Adelantos a Proveedores",
    "description": "Adelantos pendientes de aplicar a facturas, separados por moneda y proveedor.",
    "path": "/api/reports/accounting/supplier-advances"
  },
  {
    "group": "operational",
    "key": "bank-reconciliation",
    "title": "Bancos y Conciliación",
    "description": "Entradas y salidas por cuentas de caja y bancos.",
    "path": "/api/reports/accounting/bank-reconciliation"
  },
  {
    "group": "operational",
    "key": "bank-balances",
    "title": "Saldos Bancarios por Período",
    "description": "Cuentas bancarias en moneda local y extranjera conciliadas contra el Balance General.",
    "path": "/api/reports/accounting/bank-balances"
  },
  {
    "key": "classified-receivables",
    "title": "Cuentas por Cobrar · Clasificación",
    "group": "operational",
    "url": "/classified-receivables.html",
    "path": "/api/reports/accounting/classified-receivables",
    "description": "Cuentas por Cobrar · Clasificación"
  },
  {
    "key": "income-forecast",
    "title": "Estado de Resultados Proyectado",
    "group": "financial",
    "url": "/income-forecast.html",
    "path": "/api/reports/income-forecast",
    "description": "Estado de Resultados Proyectado"
  },
  {
    "key": "vat-declaration",
    "title": "Declaración de IVA / GCT",
    "group": "fiscal",
    "url": "/vat-declaration-report.html",
    "path": "/api/v1/reports/tax/vat-declaration",
    "description": "Declaración de IVA / GCT"
  },
  {
    "key": "eight-column-balance",
    "title": "Balance General de 8 Columnas",
    "group": "fiscal",
    "url": "/eight-column-balance.html",
    "path": "/api/v1/reports/accounting/eight-column-balance",
    "description": "Balance General de 8 Columnas"
  },
  {
    "key": "fx-revaluation",
    "title": "Análisis de revaluación",
    "group": "operational",
    "url": "/fx-revaluation.html?view=report",
    "path": "/api/accounting/fx-revaluation/report",
    "description": "Análisis de revaluación"
  },
  {
    "key": "intercompany-loans",
    "title": "Préstamos intercompany",
    "group": "operational",
    "url": "/intercompany-loans-report.html",
    "path": "/api/v1/reports/accounting/intercompany-loans",
    "description": "Préstamos intercompany"
  },
  {
    "key": "intercompany-commercial",
    "title": "Cuentas comerciales intercompany",
    "group": "operational",
    "url": "/intercompany-commercial-report.html",
    "path": "/api/v1/reports/accounting/intercompany-commercial",
    "description": "Cuentas comerciales intercompany"
  },
  {
    "key": "settled-sales-invoices",
    "title": "Facturas de venta liquidadas",
    "group": "operational",
    "url": "/settled-sales-invoices.html",
    "path": "/api/v1/reports/sales/settled-invoices",
    "description": "Facturas de venta liquidadas"
  },
  {
    "key": "settled-supplier-invoices",
    "title": "Facturas de proveedor liquidadas",
    "group": "operational",
    "url": "/settled-supplier-invoices.html",
    "path": "/api/v1/reports/purchases/settled-invoices",
    "description": "Facturas de proveedor liquidadas"
  },
  {
    "key": "payment-requests",
    "title": "Solicitudes de pago",
    "group": "operational",
    "url": "/payment-request-report.html",
    "path": "/api/v1/reports/treasury/payment-requests",
    "description": "Solicitudes de pago"
  },
  {
    "key": "customer-payment-fees",
    "title": "Comisiones bancarias de cobros",
    "group": "operational",
    "url": "/customer-payment-fees.html",
    "path": "/api/reports/customer-payment-fees",
    "description": "Comisiones bancarias de cobros"
  },
  {
    "key": "asset-depreciation",
    "title": "Tabla de Depreciación Mensual / Anual",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=depreciation",
    "description": "Tabla de Depreciación Mensual / Anual"
  },
  {
    "key": "asset-summary",
    "title": "Resumen por Categoría / Ubicación",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=summary",
    "description": "Resumen por Categoría / Ubicación"
  },
  {
    "key": "asset-history",
    "title": "Kardex o Historial Individual",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=history",
    "description": "Kardex o Historial Individual"
  },
  {
    "key": "asset-movements",
    "title": "Altas, Bajas y Revaluaciones",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=movements",
    "description": "Altas, Bajas y Revaluaciones"
  },
  {
    "key": "asset-reconciliation",
    "title": "Conciliación de Activos Fijos vs. Libro Mayor",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=reconciliation",
    "description": "Conciliación de Activos Fijos vs. Libro Mayor"
  },
  {
    "key": "asset-projection",
    "title": "Proyección Fiscal y Financiera de Depreciaciones",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=projection",
    "description": "Proyección Fiscal y Financiera de Depreciaciones"
  },
  {
    "key": "asset-impairment",
    "title": "Deterioro de Valor (NIC 36) y Bajas",
    "group": "fixedAssets",
    "url": "/fixed-assets-reports.html?report=impairment",
    "description": "Deterioro de Valor (NIC 36) y Bajas"
  }
];
export const reportResource=(key:string)=>`reports:${key}`;
