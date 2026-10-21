export function isEnabledFlag(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

export function supplierPayableRoute(invoiceType, isIntercompany) {
  if (invoiceType === 'Factura Expense') {
    return { accountNumber: '211003', reason: 'expense' };
  }
  if (invoiceType === 'Factura Caja Chica') {
    return { accountNumber: '211004', reason: 'petty_cash' };
  }
  if (isEnabledFlag(isIntercompany)) {
    return { accountNumber: '211002', reason: 'intercompany' };
  }
  return { accountNumber: '211001', reason: 'standard' };
}
