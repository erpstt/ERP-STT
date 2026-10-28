import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const root = process.cwd();
const base = path.resolve(root, 'deliverables/manuales_capacitacion_gentia');
const manualsDirectory = path.join(base, 'manuales_word');
const packageFile = path.join(base, 'Manuales_Capacitacion_GENTIA.zip');
const expectedManuals = 19;

const names = (await readdir(manualsDirectory))
  .filter((name) => /^CAP-\d{2}_.+\.docx$/i.test(name))
  .sort((left, right) => left.localeCompare(right, 'es', { numeric: true }));

const checks = [];
for (const name of names) {
  const file = path.join(manualsDirectory, name);
  const buffer = await readFile(file);
  const document = await JSZip.loadAsync(buffer);
  const entries = Object.keys(document.files);
  const media = entries.filter((entry) => entry.startsWith('word/media/') && !document.files[entry].dir);
  const xml = await document.file('word/document.xml')?.async('string');
  const relationships = await document.file('word/_rels/document.xml.rels')?.async('string');
  checks.push({
    name,
    bytes: buffer.length,
    media: media.length,
    textNodes: (xml?.match(/<w:t(?:\s|>)/g) ?? []).length,
    externalRelationships: /TargetMode="External"|file:\/\//i.test(relationships ?? ''),
    hasDocumentXml: Boolean(xml),
  });
}

const packageBuffer = await readFile(packageFile);
const packageZip = await JSZip.loadAsync(packageBuffer);
const packageEntries = Object.keys(packageZip.files).filter((entry) => !packageZip.files[entry].dir);
const packageDocx = packageEntries.filter((entry) => entry.toLowerCase().endsWith('.docx'));

const problems = checks.filter((check) => (
  check.bytes < 15_000
  || check.media < 1
  || check.textNodes < 100
  || check.externalRelationships
  || !check.hasDocumentXml
));
if (names.length !== expectedManuals) problems.push({ error: `Se esperaban ${expectedManuals} DOCX y existen ${names.length}.` });
if (packageDocx.length !== expectedManuals) problems.push({ error: `El ZIP contiene ${packageDocx.length} DOCX.` });
if (!packageEntries.some((entry) => ['LEEME_Manuales_GENTIA.txt', 'README_Manuales_GENTIA.md'].includes(entry))) {
  problems.push({ error: 'El ZIP no contiene el archivo de orientación.' });
}
if (!packageEntries.includes('00_Indice_Manuales_GENTIA.html')) problems.push({ error: 'El ZIP no contiene el índice HTML.' });

const result = {
  docxCount: names.length,
  packageBytes: (await stat(packageFile)).size,
  packageFileCount: packageEntries.length,
  packageDocxCount: packageDocx.length,
  totalDocxBytes: checks.reduce((total, check) => total + check.bytes, 0),
  minimumDocxBytes: Math.min(...checks.map((check) => check.bytes)),
  minimumEmbeddedImages: Math.min(...checks.map((check) => check.media)),
  maximumEmbeddedImages: Math.max(...checks.map((check) => check.media)),
  minimumTextNodes: Math.min(...checks.map((check) => check.textNodes)),
  externalRelationshipCount: checks.filter((check) => check.externalRelationships).length,
  problems,
};

console.log(JSON.stringify(result, null, 2));
if (problems.length) process.exitCode = 1;
