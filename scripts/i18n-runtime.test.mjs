import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  GentiaI18n,
  GENTIA_SUPPORTED_LOCALES,
  GENTIA_TRANSLATION_BUNDLES,
  interpolateTranslation,
  normalizeGentiaLocale,
  resolveTranslation
} from '../public/i18n.js';

const localeRoot = new URL('../public/locales/', import.meta.url);
const dictionaries = Object.fromEntries(await Promise.all(GENTIA_SUPPORTED_LOCALES.map(async ({ code }) => [
  code,
  JSON.parse(await readFile(new URL(`${code}.json`, localeRoot), 'utf8'))
])));
const fragments = Object.fromEntries(await Promise.all(GENTIA_TRANSLATION_BUNDLES.map(async bundle => [
  bundle,
  Object.fromEntries(await Promise.all(GENTIA_SUPPORTED_LOCALES.map(async ({ code }) => [
    code,
    JSON.parse(await readFile(new URL(`modules/${bundle}/${code}.json`, localeRoot), 'utf8'))
  ])))
])));

function keys(value, prefix = '', result = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') result.push(path);
    else keys(child, path, result);
  }
  return result.sort();
}

test('los tres diccionarios conservan exactamente las mismas claves', () => {
  assert.deepEqual(keys(dictionaries.en), keys(dictionaries.es));
  assert.deepEqual(keys(dictionaries.pt), keys(dictionaries.es));
});

test('normaliza los códigos configurados en Core Idiomas', () => {
  assert.equal(normalizeGentiaLocale('SPA'), 'es');
  assert.equal(normalizeGentiaLocale('ENG'), 'en');
  assert.equal(normalizeGentiaLocale('POR'), 'pt');
  assert.equal(normalizeGentiaLocale('pt-BR'), 'pt');
  assert.equal(normalizeGentiaLocale('desconocido'), 'es');
});

test('resuelve claves anidadas e interpola parámetros', () => {
  assert.equal(resolveTranslation(dictionaries.en, 'header.activeCompany'), 'ACTIVE COMPANY');
  assert.equal(interpolateTranslation('{count} records', { count: 27 }), '27 records');
});

test('el motor cambia de idioma dinámicamente y conserva fallback español', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const code = String(input).match(/\/(es|en|pt)\.json/)?.[1];
    return code ? Response.json(dictionaries[code]) : new Response('', { status: 404 });
  };
  const i18n = new GentiaI18n({ baseUrl: '/locales' });
  await i18n.init('ENG');
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.t('actions.saveChanges'), 'Save changes');
  assert.deepEqual(i18n.bindingFor('29 registros'), { key: 'common.records', parameters: { count: '29' } });
  await i18n.setLocale('POR', { persist: false, broadcast: false });
  assert.equal(i18n.t('actions.saveChanges'), 'Salvar alterações');
  assert.equal(i18n.t('missing.key', {}, 'Texto alternativo'), 'Texto alternativo');
  i18n.destroy();
});

test('combina los fragmentos de cada módulo con el diccionario global', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const pathname = new URL(String(input), 'https://i18n.test').pathname;
    const fragment = pathname.match(/\/locales\/modules\/([^/]+)\/(es|en|pt)\.json$/u);
    if (fragment) return fragments[fragment[1]]?.[fragment[2]] ? Response.json(fragments[fragment[1]][fragment[2]]) : new Response('', { status: 404 });
    const base = pathname.match(/\/locales\/(es|en|pt)\.json$/u);
    return base ? Response.json(dictionaries[base[1]]) : new Response('', { status: 404 });
  };
  const i18n = new GentiaI18n({ baseUrl: '/locales' });
  await i18n.init('en');
  assert.equal(i18n.t('operations.paymentRequests.title'), 'Payment Requests');
  assert.equal(i18n.t('reports.dashboard.title'), 'Accounting Reports');
  assert.equal(i18n.t('admin.tax.calendarTitle'), 'Tax calendar');
  assert.equal(i18n.t('business.budget.title'), 'Budget management');
  i18n.destroy();
});

test('si un idioma secundario no carga, el motor conserva la interfaz en español', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const code = String(input).match(/\/(es|en|pt)\.json/)?.[1];
    if (code === 'en') return new Response('', { status: 503 });
    return code ? Response.json(dictionaries[code]) : new Response('', { status: 404 });
  };
  const i18n = new GentiaI18n({ baseUrl: '/locales' });
  await i18n.init('ENG');
  assert.equal(i18n.locale, 'es');
  assert.equal(i18n.t('actions.saveChanges'), 'Guardar cambios');
  assert.equal(await i18n.setLocale('ENG', { persist: false, broadcast: false }), 'es');
  i18n.destroy();
});
