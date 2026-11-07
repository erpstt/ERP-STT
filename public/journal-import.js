const $ = id => document.getElementById(id);
const subsidiaryId = Number(localStorage.getItem('nexo_company') || sessionStorage.getItem('nexo_company'));
$('company').textContent = localStorage.getItem('nexo_company_name') || `Subsidiaria ${subsidiaryId}`;
let validatedPreview = null, busy = false, generation = 0, contextInvalid = false;
const contextValue = key => localStorage.getItem(key) || sessionStorage.getItem(key) || '';
const contextKey = () => JSON.stringify([window.NexoSessionRenewal?.current?.()?.generation || contextValue('nexo_token'), contextValue('nexo_company'), contextValue('nexo_role'), contextValue('nexo_device_token')]);
const openedContext = contextKey();
const money = value => Number(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const rateText = value => { const raw = String(value ?? ''); return /^\d+(?:\.\d{1,10})?$/.test(raw) && Number.isFinite(Number(raw)) && Number(raw) > 0 ? raw.replace('.', ',') : '—'; };
const rateSource = value => value === 'LOCAL' ? 'Moneda local' : value === 'DIRECT' ? 'Cotización directa' : value === 'INVERSE' ? 'Cotización inversa' : 'Origen de cotización no indicado';
function tableRow(values) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); } return row; }
const fresh = () => validatedPreview && validatedPreview.context === contextKey() && validatedPreview.file === $('file').files[0] && Date.parse(validatedPreview.expiresAt) > Date.now();
function sync() { $('file').disabled = busy || contextInvalid; $('validate').disabled = busy || contextInvalid; $('import').disabled = busy || contextInvalid || !fresh(); }
function reset() { generation++; validatedPreview = null; $('preview').hidden = true; $('result').hidden = true; $('rows').replaceChildren(); $('errors').replaceChildren(); $('message').textContent = ''; sync(); }
function checkContext() { if (contextInvalid || contextKey() !== openedContext) { contextInvalid = true; reset(); phase('upload', 'error'); $('message').textContent = 'La empresa, el rol o la sesión cambiaron. Vuelva a abrir la importación.'; return false; } return true; }
window.addEventListener('storage', checkContext); window.addEventListener('focus', checkContext);
try { window.top.addEventListener('nexo:approval-context-changed', checkContext); } catch { /* The workspace is same-origin. */ }
function updateFileLabel() {
  const file = $('file').files[0];
  if ($('fileName')) $('fileName').textContent = file?.name || 'Seleccione su archivo CSV';
  if ($('fileDetail')) $('fileDetail').textContent = file ? `${(file.size / 1024).toLocaleString('es-CR', { maximumFractionDigits: 1 })} KB \u00b7 Puede seleccionar otro archivo para reemplazarlo` : 'Haga clic para buscar un archivo en su equipo';
}
function phase(value, tone = '') { document.body?.setAttribute('data-phase', value); $('message').className = tone; }
$('file').onchange = () => { reset(); updateFileLabel(); phase('upload'); };
async function request(csv, preview, previewToken) {
  if (!checkContext()) throw Error('El contexto de la importación cambió. Vuelva a abrirla.');
  const response = await fetch('/api/accounting/journals/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || ''}`, 'X-Device-Token': localStorage.getItem('nexo_device_token') || '' },
    body: JSON.stringify({ csv, preview, subsidiaryId, ...(!preview ? { previewToken } : {}) })
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error?.message || 'No fue posible procesar el archivo.'), { status: response.status });
  return result;
}
async function processFile(preview) {
  if (busy || !checkContext()) return;
  const file = $('file').files[0];
  if (!file) { phase('upload', 'error'); $('message').textContent = 'Seleccione un archivo CSV.'; return; }
  if (!/\.csv$/i.test(file.name) || file.size > 2 * 1024 * 1024) { reset(); phase('upload', 'error'); $('message').textContent = 'Seleccione un CSV de hasta 2 MB.'; return; }
  if (!preview && !fresh()) { reset(); phase('upload', 'error'); $('message').textContent = 'La vista previa venció o cambió el archivo. Vuelva a validar antes de importar.'; return; }
  const approved = validatedPreview, requestId = ++generation, context = contextKey();
  phase('review');
  busy = true; $('file').disabled = true; $('validate').disabled = true; $('import').disabled = true;
  $('message').textContent = preview ? 'Validando archivo…' : 'Registrando asientos…'; $('errors').replaceChildren(); $('result').hidden = true;
  try {
    const csv = preview ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) : approved.csv;
    validatedPreview = null;
    if (requestId !== generation || context !== contextKey() || file !== $('file').files[0]) return;
    const result = await request(csv, preview, approved?.previewToken);
    if (requestId !== generation || context !== contextKey() || file !== $('file').files[0]) return;
    if (result.alreadyImported || result.created > 0) {
      phase('done', 'success');
      $('preview').hidden = true; $('result').hidden = false;
      $('saved').replaceChildren(...result.entries.map(entry => tableRow([entry.reference, entry.journalNumber])));
      $('message').textContent = result.alreadyImported ? 'Este archivo ya fue importado. No se crearon duplicados.' : `Importación completada: ${result.created} asientos registrados.`;
    } else {
      $('preview').hidden = false;
      $('rows').replaceChildren(...result.entries.map(entry => { const row = tableRow([entry.reference, entry.date, entry.currency, rateText(entry.exchangeRate), entry.rateSource === 'LOCAL' || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.rateDate ?? '')) ? '—' : entry.rateDate, entry.lines, money(entry.debit), money(entry.credit)]); row.cells[3].dataset.exchangeRate = ''; row.cells[3].title = rateSource(entry.rateSource); row.cells[3].setAttribute('aria-label', `${rateText(entry.exchangeRate)} · ${rateSource(entry.rateSource)}`); row.cells[4].dataset.rateDate = ''; return row; }));
      for (const error of result.errors) { const li = document.createElement('li'); li.textContent = `Registro ${error.row} · ${error.reference}: ${error.message}`; $('errors').append(li); }
      if (result.valid) {
        if (typeof result.previewToken !== 'string' || !result.previewToken || !(Date.parse(result.expiresAt) > Date.now()) || Number(result.context?.subsidiaryId) !== subsidiaryId || Number(result.context?.roleId) !== Number(contextValue('nexo_role')) || !Number.isSafeInteger(result.context?.userId) || result.context.userId <= 0 || typeof result.context.sessionId !== 'string' || !result.context.sessionId) throw Error('La validación no corresponde a la empresa o al rol activo. Vuelva a validar el archivo.');
        phase('review', 'success'); validatedPreview = { csv, file, context, previewToken: result.previewToken, expiresAt: result.expiresAt }; $('message').textContent = `${result.entries.length} asientos validados. Revise la vista previa y pulse Importar asientos.`;
      }
      else $('message').textContent = 'No se guardó ningún asiento. Corrija los errores y vuelva a validar el archivo.';
    }
  } catch (error) {
    if (requestId === generation && context === contextKey()) { reset(); phase('upload', 'error'); $('message').textContent = error.status === 409 ? `${error.message} Vuelva a validar el archivo para revisar el tipo de cambio aplicado.` : `${error.message} Puede volver a validar el mismo archivo para comprobar si ya fue importado.`; }
  } finally { busy = false; sync(); }
}
$('validate').onclick = () => processFile(true);
$('import').onclick = () => processFile(false);
