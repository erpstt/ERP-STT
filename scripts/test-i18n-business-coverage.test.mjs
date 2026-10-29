import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const localeCodes = ['es', 'en', 'pt'];
const dictionaries = Object.fromEntries(await Promise.all(localeCodes.map(async locale => [
  locale,
  JSON.parse(await readFile(new URL(`public/locales/modules/business/${locale}.json`, root), 'utf8')),
])));

function flatten(value, prefix = '', output = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.set(path, child);
    else flatten(child, path, output);
  }
  return output;
}

const flat = Object.fromEntries(localeCodes.map(locale => [locale, flatten(dictionaries[locale])]));

test('los fragmentos de negocio mantienen paridad exacta entre idiomas', () => {
  const expected = [...flat.es.keys()].sort();
  assert.ok(expected.length >= 170, `Se esperaban al menos 170 claves y se encontraron ${expected.length}.`);
  assert.deepEqual([...flat.en.keys()].sort(), expected);
  assert.deepEqual([...flat.pt.keys()].sort(), expected);
});

test('las seis áreas de negocio tienen vocabulario propio', () => {
  for (const area of ['purchase', 'sales', 'budget', 'consolidation', 'fx', 'forecast']) {
    for (const locale of localeCodes) assert.ok(dictionaries[locale].business[area], `Falta ${area} en ${locale}.`);
  }
});

test('todas las claves explícitas agregadas a las vistas existen en los tres idiomas', async () => {
  const paths = [
    'public/purchase-documents.html',
    'public/purchase-document-view.html',
    'public/sales-documents.html',
    'public/sales-document-view.html',
    'public/budget.html',
    'public/consolidation.html',
    'public/fx-revaluation.html',
    'public/income-forecast.html',
  ];
  const sources = await Promise.all(paths.map(path => readFile(new URL(path, root), 'utf8')));
  const referenced = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/data-i18n(?:-[a-z-]+)?=["']([^"']+)["']/gu)) {
      if (match[1].startsWith('business.')) referenced.add(match[1]);
    }
  }
  assert.ok(referenced.size >= 25, `Cobertura explícita insuficiente: ${referenced.size} claves.`);
  for (const key of referenced) {
    for (const locale of localeCodes) assert.ok(flat[locale].has(key), `Falta ${key} en ${locale}.`);
  }
});

test('los valores dinámicos sensibles quedan fuera de la traducción automática', async () => {
  const purchase = await readFile(new URL('public/purchase-document-view.html', root), 'utf8');
  const sales = await readFile(new URL('public/sales-document-view.html', root), 'utf8');
  const fx = await readFile(new URL('public/fx-revaluation.html', root), 'utf8');
  assert.match(purchase, /id="number" data-i18n-ignore/);
  assert.match(sales, /id="header" data-i18n-ignore/);
  assert.match(fx, /id="company" data-i18n-ignore/);
});
