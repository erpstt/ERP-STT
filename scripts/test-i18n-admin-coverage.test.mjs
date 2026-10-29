import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const locales = ['es', 'en', 'pt'];
const base = new URL('../public/locales/modules/admin/', import.meta.url);

function flatten(value, prefix = '', result = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result.set(path, child);
    else if (child && typeof child === 'object') flatten(child, path, result);
  }
  return result;
}

async function load(locale) {
  return JSON.parse(await readFile(new URL(`${locale}.json`, base), 'utf8'));
}

test('el paquete administrativo conserva paridad exacta en los tres idiomas', async () => {
  const dictionaries = await Promise.all(locales.map(load));
  const keys = dictionaries.map(dictionary => [...flatten(dictionary).keys()].sort());
  assert.deepEqual(keys[1], keys[0]);
  assert.deepEqual(keys[2], keys[0]);
  assert.ok(keys[0].length >= 160, `Cobertura insuficiente: ${keys[0].length} claves`);
});

test('activos, fiscal, tesorería, workflow, documentos y seguridad tienen cobertura', async () => {
  const dictionaries = await Promise.all(locales.map(load));
  const required = [
    'admin.fixedAssets.title',
    'admin.tax.calendarTitle',
    'admin.tax.vatTitle',
    'admin.treasury.title',
    'admin.workflow.inboxTitle',
    'admin.documents.pdfTemplates',
    'admin.security.rolePermissions'
  ];
  for (const dictionary of dictionaries) {
    const messages = flatten(dictionary);
    for (const key of required) assert.ok(messages.get(key)?.trim(), `${key} no puede quedar vacío`);
  }
});

test('las vistas críticas usan claves explícitas sin marcar datos de negocio', async () => {
  const cases = [
    ['../public/asset-categories.html', 'admin.fixedAssets.categoriesTitle'],
    ['../public/tax-calendar.html', 'admin.tax.calendarTitle'],
    ['../public/tax-obligations.html', 'admin.tax.obligationsTitle'],
    ['../public/vat-declaration-report.html', 'admin.tax.vatTitle'],
    ['../public/permission-catalog.html', 'admin.security.permissionCatalog'],
    ['../public/role-access-matrix.html', 'admin.security.rolePermissions'],
    ['../public/up-approvers.html', 'admin.security.upApprovers']
  ];
  for (const [path, key] of cases) {
    const html = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`data-i18n=["']${key.replaceAll('.', '\\.')}["']`));
  }
});
