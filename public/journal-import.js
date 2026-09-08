const $ = id => document.getElementById(id);
const subsidiaryId = Number(localStorage.getItem('nexo_company') || sessionStorage.getItem('nexo_company'));
$('company').textContent = localStorage.getItem('nexo_company_name') || `Subsidiaria ${subsidiaryId}`;
let validatedCsv = null, busy = false;
const money = value => Number(value).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
function tableRow(values) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); } return row; }
function reset() { validatedCsv = null; $('import').disabled = true; $('preview').hidden = true; $('result').hidden = true; $('errors').replaceChildren(); $('message').textContent = ''; }
function updateFileLabel() {
  const file = $('file').files[0];
  if ($('fileName')) $('fileName').textContent = file?.name || 'Seleccione su archivo CSV';
  if ($('fileDetail')) $('fileDetail').textContent = file ? `${(file.size / 1024).toLocaleString('es-CR', { maximumFractionDigits: 1 })} KB \u00b7 Puede seleccionar otro archivo para reemplazarlo` : 'Haga clic para buscar un archivo en su equipo';
}
function phase(value, tone = '') { document.body?.setAttribute('data-phase', value); $('message').className = tone; }
$('file').onchange = () => { reset(); updateFileLabel(); phase('upload'); };
async function request(csv, preview) {
  const response = await fetch('/api/accounting/journals/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || ''}`, 'X-Device-Token': localStorage.getItem('nexo_device_token') || '' },
    body: JSON.stringify({ csv, preview, subsidiaryId })
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'No fue posible procesar el archivo.');
  return result;
}
async function processFile(preview) {
  if (busy) return;
  const file = $('file').files[0];
  if (!file) { phase('upload', 'error'); $('message').textContent = 'Seleccione un archivo CSV.'; return; }
  if (!/\.csv$/i.test(file.name) || file.size > 2 * 1024 * 1024) { reset(); phase('upload', 'error'); $('message').textContent = 'Seleccione un CSV de hasta 2 MB.'; return; }
  if (!preview && validatedCsv === null) return;
  phase('review');
  busy = true; $('file').disabled = true; $('validate').disabled = true; $('import').disabled = true;
  $('message').textContent = preview ? 'Validando archivo…' : 'Registrando asientos…'; $('errors').replaceChildren(); $('result').hidden = true;
  try {
    const csv = preview ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) : validatedCsv;
    validatedCsv = null;
    const result = await request(csv, preview);
    if (result.alreadyImported || result.created > 0) {
      phase('done', 'success');
      $('preview').hidden = true; $('result').hidden = false;
      $('saved').replaceChildren(...result.entries.map(entry => tableRow([entry.reference, entry.journalNumber])));
      $('message').textContent = result.alreadyImported ? 'Este archivo ya fue importado. No se crearon duplicados.' : `Importación completada: ${result.created} asientos registrados.`;
    } else {
      $('preview').hidden = false;
      $('rows').replaceChildren(...result.entries.map(entry => tableRow([entry.reference, entry.date, entry.currency, entry.lines, money(entry.debit), money(entry.credit)])));
      for (const error of result.errors) { const li = document.createElement('li'); li.textContent = `Registro ${error.row} · ${error.reference}: ${error.message}`; $('errors').append(li); }
      if (result.valid) { phase('review', 'success'); validatedCsv = csv; $('message').textContent = `${result.entries.length} asientos validados. Revise la vista previa y pulse Importar asientos.`; }
      else $('message').textContent = 'No se guardó ningún asiento. Corrija los errores y vuelva a validar el archivo.';
    }
  } catch (error) {
    phase('upload', 'error');
    validatedCsv = null; $('preview').hidden = true;
    $('message').textContent = `${error.message} Puede volver a validar el mismo archivo para comprobar si ya fue importado.`;
  } finally { busy = false; $('file').disabled = false; $('validate').disabled = false; $('import').disabled = validatedCsv === null; }
}
$('validate').onclick = () => processFile(true);
$('import').onclick = () => processFile(false);
