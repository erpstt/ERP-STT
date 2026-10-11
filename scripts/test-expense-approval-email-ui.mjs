import assert from 'node:assert/strict';
import {chromium} from '../.tmp/record-audit-validation/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

const template = {
  asunto_template: 'Solicitud {{numero_solicitud}} pendiente de aprobación',
  cuerpo_template: '<p>Hola <strong>{{aprobador_nombre}}</strong>, revise {{numero_solicitud}}.</p>',
  activo: true,
  updated_by_email: 'admin@example.test',
  updated_at: '2026-10-10T14:00:00.000Z'
};

const previewResponse = {
  subject: 'Solicitud SOL-PAG-2026-00128 pendiente de aprobación',
  html: `<!doctype html><html lang="es"><body>
    <h1>Solicitud de gasto SOL-PAG-2026-00128</h1>
    <p>Departamento: Operaciones</p>
    <p>Centro de costos: CC-104 · Proyecto Regional</p>
    <a href="https://erp.example.test/payment-requests.html?id=128&amp;company=7">Revisar y aprobar</a>
    <div>Ingrese a GENTIA ERP, abra Solicitudes de Pago, revise el detalle y seleccione Aprobar o Rechazar.</div>
  </body></html>`
};

function optionsFixture() {
  return {
    company: 'Empresa de pruebas',
    userId: 21,
    admin: false,
    canApprove: false,
    canExecute: false,
    baseCurrencyId: 1,
    currencies: [{id: 1, name: 'USD'}],
    users: [
      {id: 20, name: 'Carlos Solicitante'},
      {id: 21, name: 'Ana Aprobadora'}
    ],
    suppliers: [],
    customers: [{id: 31, name: 'Cliente de prueba'}],
    employees: [],
    accounts: [{id: 61, name: '614014 · Impuestos y Tasas Municipales'}],
    costCenters: [{id: 104, name: 'CC-104 · Proyecto Regional'}],
    banks: [],
    rates: []
  };
}

const detailFixture = {
  canActApproval: true,
  header: {
    id: 128,
    numero: 'SOL-PAG-2026-00128',
    estado: 'PENDIENTE_APROBACION',
    tipo_solicitud: 'OTROS',
    id_moneda: 1,
    fecha_solicitud: '2026-10-05',
    fecha_pago_programada: '2026-10-10',
    total: 4850,
    concepto: 'Servicios profesionales del proyecto regional',
    id_solicitante: 20,
    id_proveedor: null,
    assigned_approver_id: null,
    approval_route_source: 'STANDARD',
    version: 3
  },
  lines: [{
    id: 301,
    id_cuenta_contable: 61,
    tipo_tercero: 'Cliente',
    id_cliente: 31,
    id_proveedor: null,
    id_empleado: null,
    id_centro_costo: 104,
    accountName: '614014 · Impuestos y Tasas Municipales',
    party: 'Cliente de prueba',
    costCenter: 'CC-104 · Proyecto Regional',
    concepto: 'Permiso anual',
    monto: 4850
  }],
  events: [{accion: 'ENVIADO_APROBACION', user: 'Carlos Solicitante', fecha: '2026-10-05T15:00:00.000Z', nota: ''}]
};

try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nexo_token', 'expense-approval-ui-token');
      localStorage.setItem('nexo_device_token', 'expense-approval-ui-device');
      localStorage.setItem('nexo_company', '7');
    } catch { /* La vista previa del correo usa un iframe sin acceso al almacenamiento. */ }
    // El shell ERP provee esta API al workspace. Se aísla para esta prueba visual.
    window.NexoRecordAudit = {show() {}, button() { return ''; }};
  });

  const templateRequests = [];
  let savedTemplate;
  await context.route('**/api/configuration/notification-templates/**', async route => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split('/').at(-1);
    const payload = request.postDataJSON();
    templateRequests.push({action, payload});
    assert.equal(payload.kind, 'SOLICITUD_GASTO_APROBACION');
    if (action === 'get') return route.fulfill({json: {
      subsidiary: {name: 'Empresa de pruebas'},
      transport: {enabled: true},
      template,
      defaults: {subject: template.asunto_template, body: template.cuerpo_template}
    }});
    if (action === 'preview') return route.fulfill({json: previewResponse});
    if (action === 'save') {
      savedTemplate = payload;
      return route.fulfill({json: {template: {
        cuerpo_template: payload.body,
        updated_by_email: 'admin@example.test',
        updated_at: '2026-10-10T15:30:00.000Z'
      }}});
    }
    return route.fulfill({status: 404, json: {error: {message: 'Ruta de prueba no definida.'}}});
  });

  const templatePage = await context.newPage();
  const templateErrors = [];
  templatePage.on('pageerror', error => templateErrors.push(error.message));
  await templatePage.goto('http://localhost:3000/notification-templates.css', {waitUntil: 'domcontentloaded'});
  await templatePage.setContent('<iframe id="templates" src="/notification-templates.html?kind=SOLICITUD_GASTO_APROBACION" style="width:100%;height:980px;border:0"></iframe>');
  const templateHandle = await templatePage.locator('#templates').elementHandle();
  const templateView = await templateHandle.contentFrame();
  await templateView.locator('#previewSubject').getByText('Solicitud SOL-PAG-2026-00128 pendiente de aprobación', {exact: true}).waitFor();

  assert.equal(await templateView.locator('#notificationType').inputValue(), 'SOLICITUD_GASTO_APROBACION');
  assert.equal(await templateView.locator('#notificationType option:checked').textContent(), 'Solicitud de gasto pendiente de aprobación');
  assert.equal(await templateView.locator('#variables button').count(), 14);
  for (const variable of ['{{numero_solicitud}}', '{{departamentos}}', '{{centros_costo}}', '{{enlace_solicitud}}']) {
    await templateView.locator('#variables button', {hasText: variable}).waitFor();
  }
  assert.match(await templateView.locator('#automaticHelp').textContent(), /botón para revisarla/i);
  assert.match(await templateView.locator('#schedule').textContent(), /cada nuevo nivel/i);
  assert.match(await templateView.locator('#transport').textContent(), /SMTP activado/i);
  assert.equal(await templateView.locator('#active').isChecked(), true);

  const preview = templateView.frameLocator('#preview');
  await preview.getByRole('link', {name: 'Revisar y aprobar'}).waitFor();
  assert.match(await preview.locator('body').innerText(), /Departamento: Operaciones/);
  assert.match(await preview.locator('body').innerText(), /CC-104/);
  assert.match(await preview.locator('body').innerText(), /Aprobar o Rechazar/);
  assert.equal(await preview.getByRole('link', {name: 'Revisar y aprobar'}).getAttribute('href'), 'https://erp.example.test/payment-requests.html?id=128&company=7');

  await templateView.locator('#subject').fill('Aprobar ');
  await templateView.locator('#subject').focus();
  await templateView.locator('#variables button').filter({hasText: '{{numero_solicitud}}'}).click();
  assert.equal(await templateView.locator('#subject').inputValue(), 'Aprobar {{numero_solicitud}}');
  await templateView.locator('#editor').fill('<p>Hola {{aprobador_nombre}}, revise la solicitud.</p>');
  await templateView.locator('#previewButton').click();
  await templateView.getByText('Vista previa actualizada.', {exact: true}).waitFor();
  const lastPreview = templateRequests.filter(item => item.action === 'preview').at(-1)?.payload;
  assert.equal(lastPreview.subject, 'Aprobar {{numero_solicitud}}');
  assert.match(lastPreview.body, /aprobador_nombre/);

  await templateView.locator('#save').click();
  await templateView.getByText('Plantilla guardada.', {exact: true}).waitFor();
  assert.equal(savedTemplate.kind, 'SOLICITUD_GASTO_APROBACION');
  assert.equal(savedTemplate.subject, 'Aprobar {{numero_solicitud}}');
  assert.equal(savedTemplate.active, true);
  assert.match(savedTemplate.body, /aprobador_nombre/);
  assert.match(await templateView.locator('#audit').textContent(), /admin@example\.test/);

  await templatePage.setViewportSize({width: 390, height: 844});
  await templatePage.locator('#templates').evaluate(element => { element.style.width = '370px'; element.style.height = '820px'; });
  assert.equal(await templateView.locator('html').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  const layoutColumns = await templateView.locator('.layout').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  assert.equal(layoutColumns, 1);
  assert.deepEqual(templateErrors, []);

  const deepLinkRequests = [];
  await context.route('**/api/treasury/payment-requests/**', async route => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split('/').at(-1);
    const payload = request.method() === 'POST' ? request.postDataJSON() : {};
    deepLinkRequests.push({action, payload});
    if (action === 'options') return route.fulfill({json: optionsFixture()});
    if (action === 'report') return route.fulfill({json: []});
    if (action === 'detail') return route.fulfill({json: detailFixture});
    if (action === 'supports') return route.fulfill({json: []});
    return route.fulfill({status: 404, json: {error: {message: 'Ruta de prueba no definida.'}}});
  });

  const requestPage = await context.newPage();
  const requestErrors = [];
  requestPage.on('pageerror', error => requestErrors.push(error.message));
  await requestPage.goto('http://localhost:3000/notification-templates.css', {waitUntil: 'domcontentloaded'});
  await requestPage.setContent('<iframe id="request" src="/payment-requests.html?id=128&amp;company=7" style="width:100%;height:980px;border:0"></iframe>');
  const requestHandle = await requestPage.locator('#request').elementHandle();
  const requestView = await requestHandle.contentFrame();
  try {
    await requestView.locator('#editor:not([hidden])').waitFor();
  } catch (error) {
    const diagnostic = {
      frameUrl: requestView.url(),
      message: await requestView.locator('#message').textContent().catch(() => null),
      body: (await requestView.locator('body').innerText().catch(() => '')).slice(0, 1000),
      requests: deepLinkRequests,
      pageErrors: requestErrors
    };
    throw new Error(`No se abrió la solicitud desde el enlace: ${JSON.stringify(diagnostic)}`, {cause: error});
  }
  await requestView.getByText('SOL-PAG-2026-00128 · PENDIENTE APROBACION', {exact: true}).waitFor();
  assert.match(await requestView.locator('#message').textContent(), /cargada desde la notificación/i);
  assert.equal(await requestView.locator('#detailType').textContent(), 'Otros Pagos');
  assert.equal(await requestView.locator('#detailRequester').textContent(), 'Carlos Solicitante');
  assert.match(await requestView.locator('#detailConcept').textContent(), /Servicios profesionales/);
  assert.match(await requestView.locator('#detailLines').innerText(), /CC-104/);
  assert.equal(await requestView.locator('#detailUpApproverCard').isHidden(), true);
  assert.equal(await requestView.locator('[data-transition="APPROVE"]').count(), 1);
  assert.ok(deepLinkRequests.some(item => item.action === 'detail' && Number(item.payload.id) === 128));
  assert.deepEqual(requestErrors, []);

  const requestsBeforeMismatch = deepLinkRequests.length;
  const wrongCompanyPage = await context.newPage();
  await wrongCompanyPage.goto('http://localhost:3000/notification-templates.css', {waitUntil: 'domcontentloaded'});
  await wrongCompanyPage.setContent('<iframe id="wrong-company" src="/payment-requests.html?id=128&amp;company=8" style="width:100%;height:900px;border:0"></iframe>');
  const wrongCompanyHandle = await wrongCompanyPage.locator('#wrong-company').elementHandle();
  const wrongCompanyView = await wrongCompanyHandle.contentFrame();
  await wrongCompanyView.locator('#message').getByText(/empresa indicada no está activa/i).waitFor();
  assert.equal(deepLinkRequests.length, requestsBeforeMismatch, 'Una empresa distinta debe bloquearse antes de consultar la solicitud.');

  await context.close();
  console.log(JSON.stringify({
    notificationSelector: true,
    variables: 14,
    preview: true,
    save: true,
    smtpStatus: true,
    responsive: true,
    deepLinkByRequestAndCompany: true,
    roleWorkflowEligibility: true,
    foreignCompanyBlocked: true,
    realEmailsSent: 0
  }));
} finally {
  await browser.close();
}
