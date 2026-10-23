import assert from 'node:assert/strict';
import { chromium } from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('nexo_token', 'opening-post-confirmation-test');
    localStorage.setItem('nexo_device_token', 'opening-post-confirmation-device');
    localStorage.setItem('nexo_company', '7');
  });

  const validatedRun = {
    id: 146,
    status: 'VALIDATED',
    opening_date: '2026-09-30',
    load_type: 'MID_YEAR',
    transition_account_id: 319999,
  };
  const postedRun = { ...validatedRun, status: 'POSTED' };
  const options = {
    canCreate: true,
    canReverse: true,
    subsidiary: { id: 7, name: 'S.T.T. HOLDINGS LIMITED', currency: 'JMD' },
    accounts: [{ id: 319999, number: '319999', name: 'Saldos Iniciales Transitorios' }],
    assetCategories: [],
    bankAccounts: [],
    run: validatedRun,
  };
  const preview = run => ({
    run,
    summary: { count: 158, debit: 200_928_529.66, credit: 200_928_529.66, difference: 0 },
    rows: [],
    assetSummary: { count: 2, pending: run.status === 'POSTED' ? 0 : 2, cost: 312_775.19, accumulated: 292_834.75, bookValue: 19_940.44, balanced: true },
    assets: [],
    pendingSummary: { count: 1, currentLocal: 246_619, previousLocal: 0, reversed: 0, balance: 246_619, balanced: true },
    pendingItems: [{
      row: 2,
      reference: 'PEN-ACTUAL-001',
      customerName: 'GLOBALIZATION PARTNERS INC',
      originDate: '2026-07-30',
      periodType: 'ACTUAL',
      currency: 'JMD',
      rate: 1,
      initial: 246_619,
      reversed: 0,
      balance: 246_619,
      created: run.status === 'POSTED',
    }],
    pendingReconciliation: [],
    bankSummary: { count: 3, accounts: 2, pending: run.status === 'POSTED' ? 0 : 3, openingLocal: 173_984.52, transitDepositsLocal: 0, transitChecksLocal: 0, balanced: true },
    bankItems: [{
      sourceRow: 2,
      bankCode: 'JNB_JM',
      bankName: 'JN Bank Limited',
      accountNumber: '02000006419',
      recordType: 'SALDO_CONCILIADO',
      transactionDate: '2026-09-30',
      currency: 'JMD',
      originalAmount: 173_984.52,
      localEquivalent: 173_984.52,
      created: run.status === 'POSTED',
    }],
    bankReconciliation: [],
  });

  let postCalls = 0;
  let postBody = null;
  let posted = false;
  let postFailure = false;
  let servePostedAuxiliary = false;
  let releasePost;
  const postGate = new Promise(resolve => { releasePost = resolve; });

  await context.route('**/api/opening-balances/**', async route => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'options') return route.fulfill({ json: { ...options, run: posted ? postedRun : validatedRun } });
    if (action === 'preview') {
      const response = preview(posted ? postedRun : validatedRun);
      if (servePostedAuxiliary) {
        response.assetSummary = { ...response.assetSummary, count: 3, pending: 1 };
        response.assets = [{ number: 'AF-APERTURA-003', name: 'Equipo por cargar', created: false }];
      }
      return route.fulfill({ json: response });
    }
    if (action === 'post') {
      postCalls += 1;
      postBody = route.request().postDataJSON();
      if (postFailure) {
        return route.fulfill({
          status: 500,
          json: { error: { message: 'No se pudo contabilizar el lote de prueba.' } },
        });
      }
      await postGate;
      posted = true;
      return route.fulfill({
        json: {
          journalNumber: 'ASI-2026-000146',
          assetsCreated: 2,
          pendingCreated: 1,
          banksCreated: 3,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Acción no simulada: ${action}` } } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  let nativeDialogs = 0;
  page.on('dialog', async dialog => {
    nativeDialogs += 1;
    await dialog.dismiss();
  });

  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('nexo_company', '7'));
  await page.setContent('<iframe id="opening" src="http://localhost:3000/opening-balances.html" style="width:1460px;height:960px;border:0"></iframe>');
  const app = page.frameLocator('#opening');
  const postButton = app.locator('#post');
  const dialog = app.locator('#postConfirmationDialog');
  const cancelButton = app.locator('#postConfirmCancel');
  const closeButton = app.locator('#postConfirmClose');
  const confirmButton = app.locator('#postConfirmSubmit');
  const progress = app.locator('#postConfirmProgress');

  await postButton.waitFor();
  await app.locator('body').evaluate(() => localStorage.setItem('nexo_company', '7'));
  assert.equal(await postButton.isEnabled(), true, 'Una apertura validada y conciliada debe permitir iniciar la contabilización.');

  await postButton.click();
  await page.waitForTimeout(100);
  assert.equal(
    await dialog.isVisible(),
    true,
    `El modal debe abrirse al pulsar Contabilizar. Mensaje: ${await app.locator('#message').innerText()}`,
  );
  assert.equal(nativeDialogs, 0, 'La confirmación debe ser un modal de la aplicación, no window.confirm().');
  assert.equal(await app.locator('#postConfirmTitle').innerText(), 'Contabilizar saldos iniciales');
  assert.equal(await app.locator('#postConfirmCompany').innerText(), 'S.T.T. HOLDINGS LIMITED');
  assert.match(await app.locator('#postConfirmDate').innerText(), /30.*(?:09|septiembre).*2026|2026.*09.*30/i);
  assert.equal((await app.locator('#postConfirmLines').innerText()).trim(), '158');
  for (const id of ['postConfirmDebit', 'postConfirmCredit']) {
    assert.match((await app.locator(`#${id}`).innerText()).replace(/\s/g, ''), /200928529[,.]66/);
  }
  const auxiliaryText = (await app.locator('#postConfirmAuxiliaries').innerText()).replace(/\s+/g, ' ').trim();
  for (const expected of ['2', '1', '3']) {
    assert.ok(auxiliaryText.includes(expected), `El resumen de auxiliares debe incluir ${expected}. Texto recibido: ${auxiliaryText}`);
  }
  if (process.env.OPENING_POST_MODAL_SCREENSHOT) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: process.env.OPENING_POST_MODAL_SCREENSHOT, fullPage: false });
  }

  await cancelButton.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(postCalls, 0, 'Cancelar no debe invocar el endpoint de contabilización.');

  await postButton.click();
  await dialog.waitFor({ state: 'visible' });
  await app.locator('body').press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(postCalls, 0, 'Escape debe cerrar el modal sin contabilizar.');

  postFailure = true;
  await postButton.click();
  await dialog.waitFor({ state: 'visible' });
  await confirmButton.click();
  await app.locator('#postConfirmProgress.error').waitFor({ state: 'visible' });
  assert.equal(await dialog.isVisible(), true, 'Un error del servidor debe conservar el modal abierto para que el usuario pueda revisar o reintentar.');
  assert.match(await progress.innerText(), /No se pudo contabilizar el lote de prueba/i);
  assert.equal(await confirmButton.isEnabled(), true, 'Confirmar debe habilitarse nuevamente después de un error.');
  assert.equal(await cancelButton.isEnabled(), true, 'Cancelar debe habilitarse nuevamente después de un error.');
  assert.equal(await closeButton.isEnabled(), true, 'Cerrar debe habilitarse nuevamente después de un error.');
  assert.equal(postCalls, 1, 'El fallo simulado debe corresponder a un solo intento de contabilización.');
  await cancelButton.click();
  await dialog.waitFor({ state: 'hidden' });

  postFailure = false;
  postCalls = 0;
  postBody = null;
  await postButton.click();
  await dialog.waitFor({ state: 'visible' });
  await confirmButton.click();
  await page.waitForFunction(() => true);
  await app.locator('#postConfirmProgress:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(postCalls, 1, 'Confirmar debe invocar el endpoint exactamente una vez.');
  assert.deepEqual(postBody, { runId: 146 });
  assert.equal(await confirmButton.isDisabled(), true, 'Confirmar debe bloquearse mientras se procesa la contabilización.');
  assert.equal(await cancelButton.isDisabled(), true, 'Cancelar debe bloquearse mientras se procesa la contabilización.');
  assert.equal(await closeButton.isDisabled(), true, 'El cierre debe bloquearse mientras se procesa la contabilización.');
  assert.equal(await progress.isVisible(), true, 'El modal debe mostrar el estado de procesamiento.');

  await confirmButton.click({ force: true }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(postCalls, 1, 'Una segunda interacción durante el proceso no debe duplicar la contabilización.');

  releasePost();
  await dialog.waitFor({ state: 'hidden' });
  await app.getByText(/Apertura contabilizada: ASI-2026-000146/).waitFor();
  assert.equal(postCalls, 1);

  servePostedAuxiliary = true;
  await page.setContent('<iframe id="opening" src="http://localhost:3000/opening-balances.html?mode=auxiliary" style="width:1460px;height:960px;border:0"></iframe>');
  const auxiliaryApp = page.frameLocator('#opening');
  const auxiliaryPostButton = auxiliaryApp.locator('#post');
  const auxiliaryDialog = auxiliaryApp.locator('#postConfirmationDialog');
  await auxiliaryPostButton.waitFor();
  await auxiliaryApp.locator('body').evaluate(() => localStorage.setItem('nexo_company', '7'));
  assert.equal(await auxiliaryPostButton.innerText(), 'Cargar auxiliares validados');
  assert.equal(await auxiliaryPostButton.isEnabled(), true, 'Una apertura contabilizada con auxiliares pendientes debe permitir la carga complementaria.');
  await auxiliaryPostButton.click();
  await auxiliaryDialog.waitFor({ state: 'visible' });
  assert.equal(await auxiliaryApp.locator('#postConfirmTitle').innerText(), 'Cargar auxiliares validados');
  assert.match(await auxiliaryApp.locator('#postConfirmNotice').innerText(), /El Libro Mayor no se contabilizará nuevamente/i);
  assert.match(await auxiliaryApp.locator('#postConfirmAuxiliaries').innerText(), /1\s+Activos fijos/i);
  await auxiliaryApp.locator('#postConfirmCancel').click();
  await auxiliaryDialog.waitFor({ state: 'hidden' });
  assert.equal(postCalls, 1, 'Revisar el modal complementario sin confirmar no debe crear otra solicitud POST.');

  console.log(JSON.stringify({
    passed: true,
    customModal: true,
    summaryVisible: true,
    cancelSafe: true,
    escapeSafe: true,
    serverErrorRecoverable: true,
    singlePost: true,
    processingLocked: true,
    postedAuxiliaryMode: true,
  }));
} finally {
  await browser.close();
}
