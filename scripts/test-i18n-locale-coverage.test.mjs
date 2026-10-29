import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const locales = Object.fromEntries(await Promise.all(['es','en','pt'].map(async locale => [
  locale,
  JSON.parse(await readFile(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8'))
])));

function leafKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child) ? leafKeys(child, path) : [path];
  }).sort();
}

test('los tres idiomas mantienen exactamente las mismas claves', () => {
  const spanish = leafKeys(locales.es);
  assert.deepEqual(leafKeys(locales.en), spanish);
  assert.deepEqual(leafKeys(locales.pt), spanish);
  assert.ok(spanish.length >= 210, `Se esperaban al menos 210 textos traducibles y solo hay ${spanish.length}.`);
});

test('todos los módulos principales tienen vocabulario traducible', () => {
  const sections = [
    'core','security','organization','configuration','entities','accounting','sales','purchasing',
    'banking','fixedAssets','inventory','expenses','treasury','tax','transactionEngine','workflow',
    'documents','audit','consolidation','ai','reports'
  ];
  for (const locale of Object.keys(locales)) {
    for (const section of sections) {
      assert.ok(locales[locale][section], `Falta ${section} en ${locale}.json.`);
      assert.ok(leafKeys(locales[locale][section]).length, `${section} no contiene traducciones en ${locale}.json.`);
    }
  }
});

test('los valores de interfaz no quedan vacíos ni reutilizan español en las acciones clave', () => {
  for (const [locale, catalog] of Object.entries(locales)) {
    for (const [key, value] of Object.entries(catalog.actions)) {
      assert.equal(typeof value, 'string', `${locale}: actions.${key} no es texto.`);
      assert.ok(value.trim(), `${locale}: actions.${key} está vacío.`);
    }
  }
  assert.notEqual(locales.en.actions.delete, locales.es.actions.delete);
  assert.notEqual(locales.pt.actions.delete, locales.es.actions.delete);
  assert.equal(locales.es.meta.locale, 'es');
  assert.equal(locales.en.meta.locale, 'en');
  assert.equal(locales.pt.meta.locale, 'pt');
});
