// Fixed actions only. No evaluation of attributes or document-provided code.
const documentActions = {
  print: () => window.print(),
  close: () => window.close(),
  'back-to-erp': () => window.location.assign('/'),
  'back-to-payments': () => window.history.length > 1
    ? window.history.back()
    : window.location.assign('/supplier-payments.html')
};
for (const button of document.querySelectorAll('[data-document-action]')) {
  const action = Object.hasOwn(documentActions, button.dataset.documentAction)
    ? documentActions[button.dataset.documentAction] : null;
  if (action) button.addEventListener('click', action);
}
