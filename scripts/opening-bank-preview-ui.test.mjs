import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('nexo_token', 'opening-bank-preview-test');
    localStorage.setItem('nexo_device_token', 'opening-bank-preview-device');
    localStorage.setItem('nexo_company', '7');
  });

  const run = {
    id: 146,
    status: 'VALIDATED',
    opening_date: '2026-09-30',
    load_type: 'MID_YEAR',
    transition_account_id: 319999,
  };
  const options = {
    canCreate: true,
    canReverse: true,
    subsidiary: { id: 7, name: 'S.T.T. HOLDINGS LIMITED', currency: 'JMD' },
    accounts: [{ id: 319999, number: '319999', name: 'Saldos Iniciales Transitorios' }],
    assetCategories: [],
    bankAccounts: [{
      bankCode: 'JNB_JM',
      bankName: 'JN Bank Limited',
      accountNumber: '02000006419',
      currency: 'USD',
    }],
    run,
  };
  const preview = {
    run,
    summary: { count: 158, debit: 200_928_529.78, credit: 200_928_529.78, difference: 0 },
    rows: [],
    bankSummary: {
      balanced: false,
      count: 1,
      accounts: 1,
      pending: 1,
      openingLocal: 135_900,
      transitDepositsLocal: 0,
      transitChecksLocal: 0,
    },
    bankReconciliation: [{
      bankCode: 'JNB_JM',
      bankName: 'JN Bank Limited',
      accountNumber: '02000006419',
      ledgerAccountNumber: '111005',
      ledgerAccountName: 'JN Bank USD',
      currency: 'USD',
      ledger: 1_000,
      ledgerLocal: 151_000,
      auxiliary: 900,
      auxiliaryLocal: 135_900,
      difference: 100,
      localDifference: 15_100,
    }],
    bankItems: [{
      sourceRow: 2,
      bankCode: 'JNB_JM',
      bankName: 'JN Bank Limited',
      accountNumber: '02000006419',
      recordType: 'SALDO_CONCILIADO',
      transactionDate: '2026-09-30',
      valueDate: '2026-09-30',
      reference: 'SALDO-APERTURA',
      description: 'Saldo bancario inicial',
      currency: 'USD',
      originalAmount: 900,
      localEquivalent: 135_900,
      created: false,
      status: 'STAGED',
    }],
  };

  await context.route('**/api/opening-balances/**', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'options') return route.fulfill({ json: options });
    if (action === 'preview') return route.fulfill({ json: preview });
    if (action === 'validate') return route.fulfill({ json: preview });
    return route.fulfill({ status: 404, json: { error: { message: `Acción no simulada: ${action}` } } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('nexo_company', '7'));
  await page.setContent('<iframe id="opening" src="http://localhost:3000/opening-balances.html" style="width:1460px;height:960px;border:0"></iframe>');
  const app = page.frameLocator('#opening');

  await app.getByRole('heading', { name: 'Conciliación del saldo inicial por cuenta bancaria' }).waitFor();
  await app.locator('#bankStatus').getByText('Requiere corrección', { exact: true }).waitFor();
  await app.locator('body').evaluate(() => localStorage.setItem('nexo_company', '7'));
  await app.locator('#validate').click();
  await app.getByText(
    'Validación completada con diferencias bancarias. Revise la conciliación del Auxiliar de Bancos por cuenta y moneda antes de contabilizar.',
    { exact: true },
  ).waitFor();

  const headings = (await app.locator('#bankSummarySection thead').first().innerText()).replace(/\s+/g, ' ');
  for (const label of ['Cuenta contable', 'Moneda', 'Libro Mayor', 'Auxiliar bancario', 'Diferencia']) {
    assert.match(headings, new RegExp(label, 'i'), `Debe mostrarse la columna ${label}.`);
  }

  const row = app.locator('#bankReconciliation tr').filter({ hasText: '02000006419' });
  await row.waitFor();
  const rowText = (await row.innerText()).replace(/\s+/g, ' ');
  for (const value of [
    'JNB_JM',
    '02000006419',
    '111005',
    'JN Bank USD',
    'USD',
    '1 000,00',
    '151 000,00',
    '900,00',
    '135 900,00',
    '100,00',
    '15 100,00',
    'Diferencia',
  ]) {
    assert.ok(rowText.includes(value), `La fila bancaria debe mostrar ${value}. Texto recibido: ${rowText}`);
  }

  assert.equal(
    await app.locator('#post').isDisabled(),
    true,
    'No se debe permitir contabilizar mientras exista una diferencia bancaria.',
  );

  console.log(JSON.stringify({
    passed: true,
    bankDifferenceMessage: true,
    accountAndCurrencyVisible: true,
    ledgerAndAuxiliaryVisible: true,
    differencesVisible: true,
    postingBlocked: true,
  }));
} finally {
  await browser.close();
}
