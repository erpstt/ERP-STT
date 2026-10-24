import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const publicRoot = join(process.cwd(), 'public');
const entryFile = join(publicRoot, 'index.html');
const strict = process.argv.includes('--strict');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path;
  }));
  return nested.flat();
}

function localPath(reference) {
  if (!reference.startsWith('/') || reference.startsWith('//')) return null;
  return join(publicRoot, reference.split(/[?#]/, 1)[0].slice(1));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch { return 0; }
}

const files = await walk(publicRoot);
const inventory = new Map();
for (const file of files) {
  const extension = extname(file).toLowerCase() || '(none)';
  const current = inventory.get(extension) ?? { count: 0, bytes: 0 };
  current.count += 1;
  current.bytes += await sizeOf(file);
  inventory.set(extension, current);
}

const pageWeights = [];
const missingAssets = [];
for (const file of files.filter(file => extname(file).toLowerCase() === '.html')) {
  const pageHtml = await readFile(file, 'utf8');
  const references = [...pageHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1])
    .filter(reference => reference.startsWith('/') && !reference.startsWith('//'));
  let assetBytes = 0;
  for (const reference of new Set(references)) {
    const path = localPath(reference);
    const bytes = path ? await sizeOf(path) : 0;
    assetBytes += bytes;
    if (!bytes) missingAssets.push(`${relative(publicRoot, file)} -> ${reference}`);
  }
  pageWeights.push({ page: relative(publicRoot, file), bytes: await sizeOf(file) + assetBytes, resources: new Set(references).size });
}

const html = await readFile(entryFile, 'utf8');
const headHtml = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const styleRefs = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
const scriptTags = [...html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi)].map(match => ({
  attributes: `${match[1]} ${match[3]}`,
  reference: match[2]
}));
const imageTags = [...html.matchAll(/<img\b([^>]*)>/gi)].map(match => match[1]);
const videoTags = [...html.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)].map(match => ({ attributes: match[1], body: match[2] }));
const initialReferences = [...styleRefs, ...scriptTags.map(item => item.reference)];

const moduleQueue = scriptTags
  .filter(item => /\btype\s*=\s*["']module["']/i.test(item.attributes))
  .map(item => item.reference);
const discoveredModules = new Set();
while (moduleQueue.length) {
  const reference = moduleQueue.shift();
  if (discoveredModules.has(reference)) continue;
  discoveredModules.add(reference);
  const path = localPath(reference);
  if (!path) continue;
  let source;
  try { source = await readFile(path, 'utf8'); } catch { continue; }
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g)) {
    if (match[1].startsWith('/')) moduleQueue.push(match[1]);
  }
}

const entryAssets = [...new Set([...initialReferences, ...discoveredModules])];
const entryAssetSizes = await Promise.all(entryAssets.map(async reference => ({ reference, bytes: await sizeOf(localPath(reference) ?? '') })));
const cssBytes = entryAssetSizes.filter(item => extname(item.reference.split('?')[0]) === '.css').reduce((sum, item) => sum + item.bytes, 0);
const jsBytes = entryAssetSizes.filter(item => extname(item.reference.split('?')[0]) === '.js').reduce((sum, item) => sum + item.bytes, 0);
const warnings = [];

const headScriptReferences = new Set([...headHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]));
for (const script of scriptTags.filter(item => headScriptReferences.has(item.reference))) {
  if (!/\b(?:defer|async)\b|\btype\s*=\s*["']module["']/i.test(script.attributes)) {
    warnings.push(`Script que bloquea el parser: ${script.reference}`);
  }
}
for (const video of videoTags) {
  if (!/\bautoplay\b/i.test(video.attributes)) continue;
  for (const source of video.body.matchAll(/<source\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const path = localPath(source[1]);
    const bytes = path ? await sizeOf(path) : 0;
    if (bytes > 2 * 1024 ** 2) warnings.push(`Video autoplay grande: ${source[1]} (${formatBytes(bytes)})`);
  }
}
const imagesWithoutDimensions = imageTags.filter(attributes => !/\bwidth\s*=/i.test(attributes) || !/\bheight\s*=/i.test(attributes)).length;
if (imagesWithoutDimensions) warnings.push(`${imagesWithoutDimensions} imagen(es) del shell sin width/height explícitos`);
if (jsBytes > 400 * 1024) warnings.push(`JavaScript inicial sobre el presupuesto de 400 KiB: ${formatBytes(jsBytes)}`);
if (cssBytes > 160 * 1024) warnings.push(`CSS inicial sobre el presupuesto de 160 KiB: ${formatBytes(cssBytes)}`);

console.log('Auditoría de rendimiento frontend');
console.log(`Entrada: public/index.html (${formatBytes(await sizeOf(entryFile))})`);
console.log(`JavaScript inicial local: ${formatBytes(jsBytes)}`);
console.log(`CSS inicial local: ${formatBytes(cssBytes)}`);
console.log(`Módulos locales descubiertos: ${discoveredModules.size}`);
console.log('\nInventario de public/');
for (const [extension, value] of [...inventory].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${extension.padEnd(8)} ${String(value.count).padStart(3)} archivo(s)  ${formatBytes(value.bytes)}`);
}
console.log('\nRecursos iniciales más pesados');
for (const item of entryAssetSizes.sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
  console.log(`  ${formatBytes(item.bytes).padStart(10)}  ${item.reference}`);
}
console.log('\nPáginas más pesadas (HTML + JS/CSS directos, sin compresión)');
for (const item of pageWeights.sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
  console.log(`  ${formatBytes(item.bytes).padStart(10)}  ${String(item.resources).padStart(2)} recurso(s)  ${item.page}`);
}
if (missingAssets.length) warnings.push(`${missingAssets.length} referencia(s) locales sin archivo: ${missingAssets.slice(0, 3).join(', ')}`);
console.log('\nObservaciones');
if (!warnings.length) console.log('  Sin advertencias según los presupuestos actuales.');
else warnings.forEach(warning => console.log(`  - ${warning}`));

if (strict && warnings.length) process.exitCode = 1;

