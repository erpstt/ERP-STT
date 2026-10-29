import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const locales = {};
for (const locale of ['es', 'en', 'pt']) {
  locales[locale] = JSON.parse(await readFile(new URL(`public/locales/modules/reports/${locale}.json`, root), 'utf8'));
}

function flatten(value, prefix = '', output = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.set(path, child);
    else flatten(child, path, output);
  }
  return output;
}

const flat = Object.fromEntries(Object.entries(locales).map(([locale, messages]) => [locale, flatten(messages)]));

test('los fragmentos de reportes mantienen paridad exacta', () => {
  const spanishKeys = [...flat.es.keys()].sort();
  assert.ok(spanishKeys.length >= 120, `Se esperaban al menos 120 claves, se encontraron ${spanishKeys.length}.`);
  assert.deepEqual([...flat.en.keys()].sort(), spanishKeys);
  assert.deepEqual([...flat.pt.keys()].sort(), spanishKeys);
});

test('todas las claves explícitas de las vistas cubiertas existen en los tres idiomas', async () => {
  const sources = await Promise.all([
    'public/accounting-reports.html',
    'public/accounting-reports.js',
    'public/journal-import.html',
    'public/eight-column-balance.html'
  ].map(path => readFile(new URL(path, root), 'utf8')));
  const referenced = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/data-i18n(?:-[a-z-]+)?=["'`]([^"'`]+)["'`]/gu)) {
      if (!match[1].includes('${') && match[1].startsWith('reports.')) referenced.add(match[1]);
    }
  }
  assert.ok(referenced.size >= 45, `Cobertura explícita insuficiente: ${referenced.size} claves.`);
  for (const key of referenced) {
    for (const locale of ['es', 'en', 'pt']) assert.ok(flat[locale].has(key), `Falta ${key} en ${locale}.`);
  }
});

test('los títulos y acciones principales tienen traducciones reales', () => {
  const important = [
    'reports.dashboard.title',
    'reports.catalog.income-statement.title',
    'reports.catalog.bank-reconciliation.title',
    'reports.journalImport.title',
    'reports.journalImport.validateFile',
    'reports.eightColumn.title',
    'reports.eightColumn.generate'
  ];
  for (const key of important) {
    assert.notEqual(flat.en.get(key), flat.es.get(key), `${key} no se tradujo al inglés.`);
    assert.notEqual(flat.pt.get(key), flat.es.get(key), `${key} no se tradujo al portugués.`);
  }
});
