import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const locales = ['es', 'en', 'pt'];
const dictionaries = Object.fromEntries(await Promise.all(locales.map(async locale => [
  locale,
  JSON.parse(await readFile(new URL(`public/locales/modules/operations/${locale}.json`, root), 'utf8')),
])));

function flatten(value, prefix = '', output = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.set(path, child);
    else flatten(child, path, output);
  }
  return output;
}

const flattened = Object.fromEntries(locales.map(locale => [locale, flatten(dictionaries[locale])]));

test('los fragmentos operativos conservan paridad exacta entre idiomas', () => {
  const expected = [...flattened.es.keys()].sort();
  assert.ok(expected.length >= 180, `Se esperaban al menos 180 textos operativos y se encontraron ${expected.length}.`);
  for (const locale of ['en', 'pt']) assert.deepEqual([...flattened[locale].keys()].sort(), expected);
});

test('las seis áreas operativas críticas tienen vocabulario propio', () => {
  for (const area of ['paymentRequests', 'openingBalances', 'customerPayments', 'supplierPayments', 'salesInvoice', 'supplierInvoice']) {
    assert.ok(dictionaries.es.operations[area]);
    assert.ok(dictionaries.en.operations[area]);
    assert.ok(dictionaries.pt.operations[area]);
  }
});

test('las vistas con contenido dinámico usan claves explícitas y protegen datos', async () => {
  const paymentRequests = await readFile(new URL('public/payment-requests.html', root), 'utf8');
  const openingBalances = await readFile(new URL('public/opening-balances.html', root), 'utf8');
  assert.match(paymentRequests, /data-i18n="operations\.paymentRequests\.title"/);
  assert.match(paymentRequests, /id="company" data-i18n-ignore/);
  assert.match(openingBalances, /data-i18n="operations\.openingBalances\.title"/);
  assert.match(openingBalances, /id="company" data-i18n-ignore/);
});

test('las traducciones operativas no están vacías', () => {
  for (const locale of locales) {
    for (const [key, value] of flattened[locale]) assert.ok(value.trim(), `${locale}:${key} está vacío`);
  }
});
