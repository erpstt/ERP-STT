import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CONTENT_FILE = path.resolve(ROOT, 'scripts/training-manual-content.mjs');
const BASE = path.resolve(ROOT, 'deliverables/manuales_capacitacion_gentia');
const IMAGES = path.join(BASE, 'imagenes');
const HTML_DIR = path.join(BASE, 'html');
const DOCX_DIR = path.join(BASE, 'manuales_word');
const INDEX_FILE = path.join(BASE, '00_Indice_Manuales_GENTIA.html');
const README_FILE = path.join(BASE, 'README_Manuales_GENTIA.md');
const ZIP_FILE = path.join(BASE, 'Manuales_Capacitacion_GENTIA.zip');
const SOFFICE = 'C:/Program Files/LibreOffice/program/soffice.com';
const MIN_DOCX_SIZE = 15_000;
const EXPECTED_MANUALS = 19;
const GENERATED_ON = '28 de octubre de 2026';

const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const pick = (source, ...keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
};
const text = (value) => value == null ? '' : String(value).trim();
const html = (value) => text(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const slug = (value) => text(value)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  .slice(0, 80);
const normalize = (value) => slug(value).toLowerCase().replaceAll('_', '');
const readableName = (value) => path.basename(value, path.extname(value))
  .replace(/^CAP[-_ ]?\d+[-_ ]*/i, '').replaceAll('_', ' ').replaceAll('-', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());
const isPng = (name) => /\.png$/i.test(name);

function normalizeManuals(module) {
  const raw = module.manuals ?? module.trainingManuals ?? module.capacitaciones ?? module.default;
  if (!Array.isArray(raw)) throw new Error('training-manual-content.mjs debe exportar un arreglo de manuales.');
  const manuals = raw.map((entry, index) => ({
    raw: entry,
    id: text(pick(entry, 'id', 'codigo', 'code')) || `CAP-${String(index + 1).padStart(2, '0')}`,
    title: text(pick(entry, 'title', 'titulo', 'tema', 'name')),
    audience: text(pick(entry, 'audience', 'audiencia', 'perfil')),
    objective: text(pick(entry, 'objective', 'objetivo', 'proposito')),
    prerequisites: asArray(pick(entry, 'prerequisites', 'prerrequisitos', 'requirements')).filter(Boolean),
    routes: asArray(pick(entry, 'routes', 'rutas', 'accessRoutes', 'rutaAcceso')).filter(Boolean),
    flow: asArray(pick(entry, 'flow', 'flujo', 'processFlow', 'proceso')).filter(Boolean),
    steps: asArray(pick(entry, 'steps', 'pasos', 'procedure', 'procedimiento')).filter(Boolean),
    controls: asArray(pick(entry, 'controls', 'controles', 'keyControls', 'controlesClave')).filter(Boolean),
    errors: asArray(pick(entry, 'commonErrors', 'erroresFrecuentes', 'errors', 'errores')).filter(Boolean),
    exercise: pick(entry, 'exercise', 'ejercicio', 'practica'),
    expected: pick(entry, 'resultExpected', 'expectedResult', 'resultadoEsperado', 'expected', 'resultado')
      || pick(entry?.exercise ?? entry?.ejercicio, 'expected', 'resultadoEsperado', 'expectedResult', 'resultado'),
    checklist: asArray(pick(entry, 'checklist', 'listaVerificacion', 'validationChecklist')).filter(Boolean),
    imageNames: asArray(pick(entry, 'imageNames', 'imagenes', 'images', 'screenshots')).filter(Boolean),
  }));
  if (manuals.length !== EXPECTED_MANUALS) {
    throw new Error(`Se esperaban ${EXPECTED_MANUALS} manuales y el contenido contiene ${manuals.length}.`);
  }
  for (const manual of manuals) {
    if (!/^CAP-\d{2}$/i.test(manual.id)) throw new Error(`Código de manual no válido: ${manual.id}`);
    if (!manual.title || !manual.audience || !manual.objective) throw new Error(`${manual.id}: faltan título, audiencia u objetivo.`);
    if (manual.steps.length < 8) throw new Error(`${manual.id}: se requieren al menos 8 pasos y solo hay ${manual.steps.length}.`);
    if (!manual.controls.length || !manual.errors.length || !manual.checklist.length) {
      throw new Error(`${manual.id}: faltan controles, errores frecuentes o checklist.`);
    }
  }
  return manuals.sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true }));
}

function imageReference(value) {
  if (typeof value === 'string') return { name: value, caption: '' };
  return {
    name: text(pick(value, 'file', 'archivo', 'name', 'nombre', 'src', 'path')),
    caption: text(pick(value, 'caption', 'pie', 'description', 'descripcion', 'title', 'titulo')),
  };
}

async function loadManifest() {
  const file = path.join(IMAGES, 'manifest.json');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

function manifestImages(manifest, manualId) {
  if (!manifest) return [];
  const matchesManual = (item) => text(
    item?.id ?? item?.manualId ?? item?.manual_id ?? item?.topicCode ?? item?.topic_code
  ).toLowerCase() === manualId.toLowerCase();
  const rows = Array.isArray(manifest)
    ? manifest.filter(matchesManual)
    : Array.isArray(manifest.images)
      ? manifest.images.filter(matchesManual)
      : [];
  if (rows.length) {
    return rows.flatMap((row) => {
      const nested = row?.images ?? row?.screenshots;
      return nested ? asArray(nested).map(imageReference) : [imageReference(row)];
    });
  }
  const manualRows = Array.isArray(manifest.manuals) ? manifest.manuals : [];
  const row = manualRows.find((item) => text(item?.id ?? item?.manualId).toLowerCase() === manualId.toLowerCase());
  const looseRows = asArray(manifest.images ?? manifest.screenshots)
    .filter((item) => text(item?.manualId ?? item?.manual_id ?? item?.id).toLowerCase() === manualId.toLowerCase());
  const value = manifest[manualId]
    ?? manifest[manualId.toLowerCase()]
    ?? (!Array.isArray(manifest.manuals) ? manifest.manuals?.[manualId] : undefined)
    ?? row
    ?? looseRows;
  return asArray(value?.images ?? value?.screenshots ?? value).map(imageReference);
}

async function resolveImages(manual, allFiles, manifest) {
  const byLowerName = new Map(allFiles.map((file) => [file.toLowerCase(), file]));
  const chosen = [];
  const add = (reference) => {
    const ref = imageReference(reference);
    if (!ref.name) return;
    const base = path.basename(ref.name);
    const exact = byLowerName.get(base.toLowerCase());
    const fuzzy = exact ?? allFiles.find((file) => normalize(file).includes(normalize(base)) || normalize(base).includes(normalize(file)));
    if (fuzzy && !chosen.some((item) => item.file === fuzzy)) {
      chosen.push({ file: fuzzy, caption: ref.caption || readableName(fuzzy) });
    }
  };
  for (const reference of [...manual.imageNames, ...manifestImages(manifest, manual.id)]) add(reference);
  const idPrefix = manual.id.toLowerCase();
  for (const file of allFiles.filter((name) => name.toLowerCase().startsWith(`${idPrefix}-`) || name.toLowerCase().startsWith(`${idPrefix}_`))) {
    add({ name: file, caption: readableName(file) });
  }
  if (!chosen.length) {
    const titleTokens = slug(manual.title).toLowerCase().split('_').filter((token) => token.length > 3);
    for (const file of allFiles.filter((name) => titleTokens.some((token) => slug(name).toLowerCase().includes(token))).slice(0, 3)) add(file);
  }
  if (!chosen.length) throw new Error(`${manual.id}: no se encontró ninguna captura PNG. Use el prefijo ${manual.id}- o declare imageNames.`);
  for (const item of chosen) {
    const filePath = path.join(IMAGES, item.file);
    const metadata = await stat(filePath);
    const buffer = await readFile(filePath);
    const signature = buffer.subarray(0, 8).toString('hex');
    if (metadata.size < 2_000 || signature !== '89504e470d0a1a0a') throw new Error(`${manual.id}: ${item.file} no es una captura PNG válida.`);
    item.path = filePath;
    item.dataUri = `data:image/png;base64,${buffer.toString('base64')}`;
  }
  return chosen;
}

function listItems(items, cssClass = '') {
  if (!items.length) return '<p class="muted">No aplica.</p>';
  return `<ul class="${cssClass}">${items.map((item) => {
    const value = typeof item === 'object' ? pick(item, 'text', 'texto', 'description', 'descripcion', 'title', 'titulo', 'name') : item;
    return `<li>${html(value)}</li>`;
  }).join('')}</ul>`;
}

function routeItems(routes) {
  if (!routes.length) return '<p class="muted">Acceso desde el menú autorizado para el rol.</p>';
  return `<ol class="routes">${routes.map((route) => {
    if (typeof route === 'object') {
      const label = pick(route, 'label', 'title', 'titulo', 'name', 'nombre');
      const value = pick(route, 'route', 'ruta', 'path', 'url', 'text', 'texto');
      return `<li><strong>${html(label || 'Ruta')}</strong>${value ? `: <code>${html(value)}</code>` : ''}</li>`;
    }
    return `<li><code>${html(route)}</code></li>`;
  }).join('')}</ol>`;
}

function stepValue(step, number) {
  if (typeof step === 'string') return { title: `Paso ${number}`, detail: step, bullets: [], verification: '' };
  const title = text(pick(step, 'title', 'titulo', 'name', 'actividad')) || `Paso ${number}`;
  const detail = text(pick(step, 'detail', 'detalle', 'description', 'descripcion', 'instruction', 'instruccion', 'text', 'texto'));
  const bullets = asArray(pick(step, 'bullets', 'items', 'acciones', 'substeps', 'subpasos')).filter(Boolean);
  const verification = text(pick(step, 'verification', 'verificacion', 'validation', 'validacion', 'expected', 'resultadoEsperado'));
  return { title, detail, bullets, verification };
}

function renderImage(item, sequence) {
  return `<figure><img src="${item.dataUri}" alt="Captura ${sequence}: ${html(item.caption)}"><figcaption>Figura ${sequence}. ${html(item.caption)}</figcaption></figure>`;
}

function renderSteps(manual, images) {
  const insertion = new Map();
  images.forEach((image, index) => {
    const stepIndex = Math.min(manual.steps.length - 1, Math.max(0, Math.floor(((index + 1) * manual.steps.length) / (images.length + 1))));
    const values = insertion.get(stepIndex) ?? [];
    values.push({ ...image, sequence: index + 1 });
    insertion.set(stepIndex, values);
  });
  return manual.steps.map((raw, index) => {
    const step = stepValue(raw, index + 1);
    const bullets = step.bullets.length ? listItems(step.bullets, 'substeps') : '';
    const verification = step.verification
      ? `<p class="step-verification"><strong>Verifique:</strong> ${html(step.verification)}</p>`
      : '';
    const figures = (insertion.get(index) ?? []).map((item) => renderImage(item, item.sequence)).join('');
    return `<section class="step"><div class="step-number">${index + 1}</div><div class="step-copy"><h3>${html(step.title)}</h3><p>${html(step.detail)}</p>${bullets}${verification}</div></section>${figures}`;
  }).join('');
}

function errorRows(errors) {
  return errors.map((raw) => {
    if (typeof raw === 'string') return `<tr><td>${html(raw)}</td><td>Revise permisos, datos obligatorios y configuración antes de reintentar. Si persiste, registre un ticket con evidencia.</td></tr>`;
    const issue = pick(raw, 'error', 'issue', 'problema', 'message', 'mensaje', 'title', 'titulo');
    const cause = pick(raw, 'cause', 'causa');
    const solution = pick(raw, 'solution', 'solucion', 'action', 'accion', 'resolution', 'resolucion');
    return `<tr><td><strong>${html(issue)}</strong>${cause ? `<br><span class="muted">Causa: ${html(cause)}</span>` : ''}</td><td>${html(solution)}</td></tr>`;
  }).join('');
}

function exerciseBlock(manual) {
  const exercise = manual.exercise;
  if (typeof exercise === 'object' && exercise !== null) {
    const title = pick(exercise, 'title', 'titulo', 'name') || 'Ejercicio práctico';
    const scenario = pick(exercise, 'scenario', 'escenario', 'description', 'descripcion', 'text', 'texto');
    const actions = asArray(pick(exercise, 'steps', 'pasos', 'actions', 'acciones', 'tasks', 'tareas')).filter(Boolean);
    return `<h3>${html(title)}</h3><p>${html(scenario)}</p>${listItems(actions)}`;
  }
  return `<h3>Ejercicio práctico</h3><p>${html(exercise || `Ejecute el proceso completo de ${manual.title} en el ambiente de capacitación y conserve la evidencia.`)}</p>`;
}

function expectedBlock(expected) {
  if (Array.isArray(expected)) return listItems(expected);
  if (typeof expected === 'object' && expected !== null) return listItems(Object.values(expected));
  return `<p>${html(expected || 'El proceso finaliza sin errores, cumple los controles y deja trazabilidad verificable.')}</p>`;
}

function buildHtml(manual, images) {
  const fileTitle = `${manual.id} · Manual de ${manual.title}`;
  const toc = [
    'Objetivo y alcance', 'Prerrequisitos', 'Ruta de acceso', 'Flujo general',
    'Procedimiento paso a paso', 'Controles clave', 'Errores frecuentes',
    'Ejercicio práctico', 'Checklist de validación',
  ];
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${html(fileTitle)}</title>
<style>
@page { size: A4; margin: 1.45cm 1.55cm 1.45cm 1.55cm; }
* { box-sizing: border-box; }
body { margin:0; color:#172033; font-family:Arial,Helvetica,sans-serif; font-size:10.5pt; line-height:1.42; }
.cover { min-height:24.5cm; padding:1.2cm; color:white; background:#082f6b; page-break-after:always; position:relative; }
.brand { font-size:30pt; font-weight:800; letter-spacing:4px; margin-bottom:2.5cm; }
.cover .eyebrow { color:#9fe1cf; font-weight:700; font-size:10pt; letter-spacing:1.5px; }
.cover h1 { font-size:25pt; line-height:1.15; margin:.35cm 0 .55cm; }
.cover .subtitle { font-size:13pt; color:#dbeafe; max-width:15cm; }
.cover-card { margin-top:2.2cm; padding:.55cm; border:1px solid #4c73a9; background:#0c3c7f; }
.cover-card table { width:100%; border-collapse:collapse; color:white; }
.cover-card td { padding:.18cm .12cm; border:0; }
.cover-card td:first-child { width:32%; color:#9fe1cf; font-weight:700; }
.confidential { margin-top:2cm; color:#c8d7ee; font-size:9pt; }
h1,h2,h3 { color:#082f6b; page-break-after:avoid; }
h1 { font-size:22pt; border-bottom:3px solid #f26a3d; padding-bottom:.18cm; }
h2 { margin-top:.7cm; font-size:16pt; border-left:5px solid #078464; padding-left:.25cm; }
h3 { font-size:12pt; margin:.15cm 0 .12cm; }
p { margin:.12cm 0 .28cm; }
ul,ol { margin:.15cm 0 .35cm .55cm; padding-left:.35cm; }
li { margin-bottom:.13cm; }
code { font-family:Consolas,monospace; font-size:9.5pt; color:#082f6b; background:#eef4fb; padding:1px 4px; }
.toc { padding:.35cm .55cm; background:#f3f7fb; border:1px solid #d7e1ec; }
.toc li { color:#082f6b; }
.intro-grid { width:100%; border-collapse:collapse; margin:.3cm 0; }
.intro-grid td { border:1px solid #d7e1ec; padding:.25cm; vertical-align:top; }
.intro-grid td:first-child { width:28%; font-weight:700; color:#082f6b; background:#eef4fb; }
.callout { padding:.35cm .45cm; margin:.35cm 0; border-left:5px solid #f26a3d; background:#fff7f2; }
.control { border-left-color:#078464; background:#effaf6; }
.step { width:100%; display:table; margin:.3cm 0; padding:.25cm 0; border-bottom:1px solid #d7e1ec; page-break-inside:avoid; }
.step-number { display:table-cell; vertical-align:top; width:.85cm; height:.85cm; background:#078464; color:#fff; font-weight:700; font-size:13pt; text-align:center; padding:.15cm; }
.step-copy { display:table-cell; vertical-align:top; padding-left:.28cm; }
.step-copy p { margin:.05cm 0 .15cm; }
.step-verification { margin-top:.16cm !important; padding:.15cm .2cm; color:#075d4c; background:#effaf6; border-left:3px solid #078464; }
figure { margin:.4cm auto .55cm; page-break-inside:avoid; text-align:center; }
figure img { max-width:17.2cm; max-height:11cm; width:auto; height:auto; border:1px solid #cbd7e5; }
figcaption { color:#64748b; font-size:8.5pt; font-style:italic; margin-top:.12cm; }
table.data { width:100%; border-collapse:collapse; margin:.3cm 0; page-break-inside:auto; }
table.data th { background:#082f6b; color:#fff; padding:.22cm; text-align:left; }
table.data td { border:1px solid #d7e1ec; padding:.22cm; vertical-align:top; }
table.data tr:nth-child(even) td { background:#f8fafc; }
.checklist { list-style:none; margin-left:0; padding-left:0; }
.checklist li { border-bottom:1px solid #d7e1ec; padding:.17cm 0; }
.checklist li:before { content:'☐'; color:#078464; font-size:13pt; margin-right:.2cm; }
.muted { color:#64748b; }
.page-break { page-break-before:always; }
.revision { margin-top:.7cm; font-size:8.5pt; color:#64748b; text-align:right; }
</style></head><body>
<section class="cover"><div class="brand">GENTIA</div><div class="eyebrow">MANUAL DE CAPACITACIÓN · ${html(manual.id)}</div><h1>${html(manual.title)}</h1><p class="subtitle">Guía operativa paso a paso para ejecutar el proceso de forma controlada y auditable en GENTIA ERP.</p><div class="cover-card"><table><tr><td>Audiencia</td><td>${html(manual.audience)}</td></tr><tr><td>Versión</td><td>1.0</td></tr><tr><td>Fecha</td><td>${GENERATED_ON}</td></tr><tr><td>Ambiente</td><td>Capacitación / Pruebas</td></tr><tr><td>Clasificación</td><td>Uso interno</td></tr></table></div><p class="confidential">Las imágenes utilizan datos ficticios de capacitación. No contienen credenciales ni información productiva.</p></section>
<p style="page-break-before:always;break-before:page;font-size:1pt;line-height:1pt;margin:0">&nbsp;</p>
<h1>${html(fileTitle)}</h1>
<div class="toc"><strong>Contenido</strong><ol>${toc.map((item) => `<li>${html(item)}</li>`).join('')}</ol></div>
<h2>1. Objetivo y alcance</h2><table class="intro-grid"><tr><td>Objetivo</td><td>${html(manual.objective)}</td></tr><tr><td>Audiencia</td><td>${html(manual.audience)}</td></tr><tr><td>Alcance</td><td>Configuración, operación, controles, excepciones, evidencia y validación del tema ${html(manual.title)}.</td></tr></table>
<div class="callout"><strong>Regla de seguridad:</strong> confirme siempre la empresa activa, el rol activo y el período antes de guardar una operación. Nunca comparta contraseñas, enlaces de recuperación ni secretos técnicos.</div>
<h2>2. Prerrequisitos</h2>${listItems(manual.prerequisites)}
<h2>3. Ruta de acceso</h2>${routeItems(manual.routes)}
<h2>4. Flujo general</h2>${manual.flow.length ? listItems(manual.flow) : `<p>${html(manual.title)} se ejecuta siguiendo el orden de preparación, registro, validación, aprobación, contabilización y revisión de evidencia.</p>`}
<h2 class="page-break">5. Procedimiento paso a paso</h2>${renderSteps(manual, images)}
<h2>6. Controles clave</h2><div class="callout control">${listItems(manual.controls)}</div>
<h2>7. Errores frecuentes y solución</h2><table class="data"><thead><tr><th>Situación</th><th>Acción recomendada</th></tr></thead><tbody>${errorRows(manual.errors)}</tbody></table>
<h2>8. Ejercicio práctico</h2>${exerciseBlock(manual)}<h3>Resultado esperado</h3>${expectedBlock(manual.expected)}
<h2>9. Checklist de validación</h2><ul class="checklist">${manual.checklist.map((item) => `<li>${html(typeof item === 'object' ? pick(item, 'text', 'texto', 'description', 'descripcion', 'title', 'titulo') : item)}</li>`).join('')}</ul>
<p class="revision">GENTIA ERP · ${html(manual.id)} · Versión 1.0 · ${GENERATED_ON}</p>
</body></html>`;
}

async function convertToDocx(htmlFile, profileDir) {
  const outputFile = path.join(DOCX_DIR, `${path.basename(htmlFile, '.html')}.docx`);
  await rm(outputFile, { force: true });
  const profileUrl = pathToFileURL(profileDir).href;
  const { stdout, stderr } = await execFileAsync(SOFFICE, [
    '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
    `-env:UserInstallation=${profileUrl}`,
    '--convert-to', 'docx:Office Open XML Text',
    '--outdir', DOCX_DIR,
    htmlFile,
  ], { windowsHide: true, timeout: 120_000, maxBuffer: 2_000_000 });
  try { await access(outputFile); } catch {
    throw new Error(`LibreOffice no creó ${path.basename(outputFile)}. ${stdout}\n${stderr}`);
  }
  const size = (await stat(outputFile)).size;
  if (size < MIN_DOCX_SIZE) throw new Error(`${path.basename(outputFile)} parece incompleto (${size} bytes).`);
  return { outputFile, size };
}

function indexHtml(manuals, generated) {
  const rows = manuals.map((manual) => {
    const result = generated.find((item) => item.id === manual.id);
    return `<tr><td>${html(manual.id)}</td><td>${html(manual.title)}</td><td>${html(manual.audience)}</td><td>${result.images}</td><td><a href="manuales_word/${encodeURIComponent(path.basename(result.outputFile))}">Abrir Word</a></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Índice de manuales GENTIA</title><style>body{font:14px Arial;color:#172033;margin:32px;background:#f4f7fb}main{max-width:1100px;margin:auto;background:white;padding:32px;border-radius:12px}h1{color:#082f6b;border-bottom:4px solid #f26a3d;padding-bottom:12px}table{border-collapse:collapse;width:100%}th{background:#082f6b;color:#fff;text-align:left}th,td{padding:10px;border:1px solid #d7e1ec}tr:nth-child(even){background:#f8fafc}a{color:#078464;font-weight:bold}</style></head><body><main><h1>GENTIA · Manuales de capacitación</h1><p>19 manuales operativos generados con capturas reales de la interfaz y datos ficticios seguros.</p><table><thead><tr><th>Código</th><th>Tema</th><th>Audiencia</th><th>Imágenes</th><th>Documento</th></tr></thead><tbody>${rows}</tbody></table><p>Versión 1.0 · ${GENERATED_ON}</p></main></body></html>`;
}

async function createZip(manuals, generated, readme) {
  const zip = new JSZip();
  zip.file('README_Manuales_GENTIA.md', readme);
  zip.file('00_Indice_Manuales_GENTIA.html', await readFile(INDEX_FILE));
  for (const manual of manuals) {
    const result = generated.find((item) => item.id === manual.id);
    zip.file(`manuales_word/${path.basename(result.outputFile)}`, await readFile(result.outputFile));
  }
  await writeFile(ZIP_FILE, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 7 } }));
  if ((await stat(ZIP_FILE)).size < 100_000) throw new Error('El ZIP final parece incompleto.');
}

async function removePreviousGeneratedFiles() {
  for (const directory of [HTML_DIR, DOCX_DIR]) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^CAP-\d{2}_.+\.(?:html|docx)$/i.test(entry.name)) {
        await rm(path.join(directory, entry.name), { force: true });
      }
    }
  }
  await rm(INDEX_FILE, { force: true });
  await rm(README_FILE, { force: true });
  await rm(ZIP_FILE, { force: true });
}

async function main() {
  await access(CONTENT_FILE).catch(() => { throw new Error(`Falta ${CONTENT_FILE}. Genere primero el contenido de los 19 manuales.`); });
  await access(SOFFICE).catch(() => { throw new Error(`No se encontró LibreOffice en ${SOFFICE}.`); });
  await mkdir(HTML_DIR, { recursive: true });
  await mkdir(DOCX_DIR, { recursive: true });
  await mkdir(IMAGES, { recursive: true });
  await removePreviousGeneratedFiles();
  const module = await import(`${pathToFileURL(CONTENT_FILE).href}?v=${Date.now()}`);
  const manuals = normalizeManuals(module);
  const allImages = (await readdir(IMAGES)).filter(isPng).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  const manifest = await loadManifest();
  if (!allImages.length) throw new Error(`No hay capturas PNG en ${IMAGES}.`);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'gentia-manuales-lo-'));
  const generated = [];
  try {
    for (const manual of manuals) {
      const images = await resolveImages(manual, allImages, manifest);
      const baseName = `${manual.id}_${slug(manual.title)}`;
      const htmlFile = path.join(HTML_DIR, `${baseName}.html`);
      await writeFile(htmlFile, buildHtml(manual, images), 'utf8');
      const converted = await convertToDocx(htmlFile, profile);
      generated.push({ id: manual.id, ...converted, images: images.length });
      process.stdout.write(`✓ ${manual.id}: ${path.basename(converted.outputFile)} (${images.length} imágenes)\n`);
    }
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  const readme = [
    '# GENTIA ERP — Manuales de capacitación',
    '',
    `**Versión:** 1.0  `,
    `**Generados:** ${GENERATED_ON}  `,
    `**Contenido:** ${EXPECTED_MANUALS} manuales Word independientes`,
    '',
    '| Código | Tema | Documento | Capturas |',
    '|---|---|---|---:|',
    ...manuals.map((manual) => {
      const result = generated.find((item) => item.id === manual.id);
      const name = path.basename(result.outputFile);
      return `| ${manual.id} | ${manual.title} | [${name}](manuales_word/${encodeURIComponent(name)}) | ${result.images} |`;
    }),
    '',
    '> Las capturas corresponden a la interfaz real de GENTIA con datos ficticios de capacitación.',
    '',
    'Antes de distribuir, confirme rutas, permisos, responsables y políticas de cada subsidiaria.',
  ].join('\r\n');
  await writeFile(README_FILE, readme, 'utf8');
  await writeFile(INDEX_FILE, indexHtml(manuals, generated), 'utf8');
  await createZip(manuals, generated, readme);
  const missing = generated.filter((item) => item.size < MIN_DOCX_SIZE);
  const docxFiles = (await readdir(DOCX_DIR)).filter((name) => /^CAP-\d{2}_.+\.docx$/i.test(name));
  if (generated.length !== EXPECTED_MANUALS || docxFiles.length !== EXPECTED_MANUALS || missing.length) {
    throw new Error(`La validación final falló: ${generated.length} generados y ${docxFiles.length} DOCX encontrados.`);
  }
  console.log(JSON.stringify({
    outputDirectory: DOCX_DIR,
    zip: ZIP_FILE,
    manuals: generated.length,
    screenshotsUsed: generated.reduce((sum, item) => sum + item.images, 0),
    totalDocxBytes: generated.reduce((sum, item) => sum + item.size, 0),
  }, null, 2));
}

await main();
