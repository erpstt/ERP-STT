import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'public');
const locales = ['es', 'en', 'pt'];
const bundles = ['operations', 'reports', 'admin', 'business'];

function merge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else target[key] = value;
  }
  return target;
}

function flatten(value, prefix = '', output = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.set(path, child);
    else flatten(child, path, output);
  }
  return output;
}

async function messages(locale) {
  const result = JSON.parse(await readFile(join(publicRoot, 'locales', `${locale}.json`), 'utf8'));
  for (const bundle of bundles) {
    const fragment = JSON.parse(await readFile(join(publicRoot, 'locales', 'modules', bundle, `${locale}.json`), 'utf8'));
    merge(result, fragment);
  }
  return flatten(result);
}

async function sourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(path, output);
    else if (/\.(?:html|js)$/u.test(entry.name) && entry.name !== 'i18n.js') output.push(path);
  }
  return output;
}

test('todas las claves data-i18n explícitas existen en los tres idiomas', async () => {
  const dictionaries = Object.fromEntries(await Promise.all(locales.map(async locale => [locale, await messages(locale)])));
  const references = new Map();
  for (const path of await sourceFiles(publicRoot)) {
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/data-i18n(?:-(?:placeholder|title|aria-label|alt))?\s*=\s*(["'`])([^"'`]+)\1/gu)) {
      const key = match[2].trim();
      if (!key || key.includes('${')) continue;
      if (!references.has(key)) references.set(key, []);
      references.get(key).push(path.slice(publicRoot.length + 1));
    }
  }
  assert.ok(references.size >= 100, `Cobertura explícita insuficiente: ${references.size} claves.`);
  for (const [key, files] of references) {
    for (const locale of locales) {
      assert.ok(dictionaries[locale].has(key), `Falta ${key} en ${locale}; referenciada por ${files.join(', ')}.`);
      assert.ok(dictionaries[locale].get(key).trim(), `${key} está vacía en ${locale}.`);
    }
  }
});
