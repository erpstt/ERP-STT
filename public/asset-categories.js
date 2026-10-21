const $ = (id) => document.getElementById(id);
const token = localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token');
const device = localStorage.getItem('nexo_device_token') || sessionStorage.getItem('nexo_device_token');
const esc = (value) => String(value ?? '—').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

if (!token) location.replace('/');

let data;
let rows = [];
let editing = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Device-Token': device || '',
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw Error(text);
  }
  if (!response.ok) throw Error(result?.error?.message || result?.message || 'No fue posible procesar la categoría.');
  return result;
}

const accountOptions = (accounts, emptyLabel) => `<option value="">${emptyLabel}</option>` + accounts
  .map((account) => `<option value="${account.id}">${esc(account.number)} · ${esc(account.name)}</option>`)
  .join('');

async function init() {
  data = await api('/api/fixed-assets/asset-category-options');
  $('assetAccount').innerHTML = accountOptions(data.assetAccounts, 'Seleccione cuenta de activo');
  $('depreciationAccount').innerHTML = accountOptions(data.depreciationAccounts, 'Seleccione depreciación acumulada');
  $('expenseAccount').innerHTML = accountOptions(data.expenseAccounts, 'Seleccione cuenta de gasto');
  await load();
}

async function load() {
  try {
    const result = await api('/api/fixed-assets/asset-category-report', {
      method: 'POST',
      body: JSON.stringify({ search: $('search').value.trim(), status: $('filterStatus').value })
    });
    rows = result.rows || [];
    $('count').textContent = `${rows.length} registro${rows.length === 1 ? '' : 's'}`;
    $('rows').innerHTML = rows.map((row) => `<tr>
      <td><b>${esc(row.code)}</b></td>
      <td><b>${esc(row.name)}</b><small>${row.description ? `<br>${esc(row.description)}` : ''}</small></td>
      <td>${row.method === 'No Depreciable' ? 'No aplica' : `${row.usefulLife} meses`}</td>
      <td>${esc(row.method)}</td>
      <td>${Number(row.residual || 0).toFixed(2)}%</td>
      <td>${esc(row.assetAccount)}</td>
      <td>${esc(row.depreciationAccount)}</td>
      <td>${esc(row.expenseAccount)}</td>
      <td>${row.assets}</td>
      <td><span class="status ${row.active ? 'open' : ''}">${row.active ? 'ACTIVA' : 'INACTIVA'}</span></td>
      <td><div class="row-actions"><button data-edit="${row.id}">Editar</button><button class="delete" data-delete="${row.id}" data-assets="${row.assets}">Eliminar</button></div></td>
    </tr>`).join('') || '<tr><td colspan="11">No se encontraron categorías.</td></tr>';

    document.querySelectorAll('[data-edit]').forEach((button) => {
      button.onclick = () => open(button.dataset.edit);
    });
    document.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = async () => {
        try {
          if (Number(button.dataset.assets) > 0) throw Error('La categoría tiene activos asociados. Márquela como inactiva.');
          if (confirm('¿Eliminar esta categoría de activos?')) {
            await api(`/api/fixed-assets/asset-category-manage/${button.dataset.delete}`, { method: 'DELETE' });
            $('message').textContent = 'Categoría eliminada correctamente.';
            await load();
          }
        } catch (error) {
          alert(error.message);
        }
      };
    });
  } catch (error) {
    $('message').textContent = error.message;
  }
}

async function downloadCategories(format) {
  const buttons = [$('exportCsv'), $('exportExcel'), $('exportPdf')];
  if (buttons.some((button) => button.disabled)) return;
  const selected = format === 'xlsx' ? $('exportExcel') : format === 'pdf' ? $('exportPdf') : $('exportCsv');
  const label = selected.textContent;
  buttons.forEach((button) => { button.disabled = true; });
  selected.textContent = 'Preparando…';
  $('message').textContent = '';
  try {
    const query = new URLSearchParams({
      format,
      status: $('filterStatus').value,
      search: $('search').value.trim()
    });
    const response = await fetch(`/api/fixed-assets/asset-categories/export?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Device-Token': device || '' }
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* La respuesta puede no ser JSON. */ }
      throw Error(payload?.error?.message || payload?.message || 'No fue posible preparar la descarga de categorías de activos.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    const extension = format === 'xlsx' ? 'xlsx' : format;
    const fileName = encoded ? decodeURIComponent(encoded[1]) : plain?.[1] || `categorias-activos-${new Date().toISOString().slice(0, 10)}.${extension}`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (error) {
    $('message').textContent = error.message;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    selected.textContent = label;
  }
}

function updateMethod() {
  const disabled = $('method').value === 'No Depreciable';
  $('life').disabled = disabled;
  $('life').required = !disabled;
  if (disabled) $('life').value = 1;
}

function open(id = null) {window.NexoRecordAudit.show('asset_category',id,'#entry');
  editing = id;
  const current = rows.find((row) => String(row.id) === String(id));
  $('entry').reset();
  $('formTitle').textContent = current ? `Editar ${current.name}` : 'Nueva categoría';
  $('code').value = current?.code || 'Se asignará al guardar';
  $('name').value = current?.name || '';
  $('description').value = current?.description || '';
  $('method').value = current?.method || 'Línea Recta';
  $('life').value = current?.usefulLife || 60;
  $('residual').value = current?.residual || 0;
  $('assetAccount').value = current?.assetAccountId || '';
  $('depreciationAccount').value = current?.depreciationAccountId || '';
  $('expenseAccount').value = current?.expenseAccountId || '';
  $('active').value = String(current?.active ?? true);
  updateMethod();
  $('modal').hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => $('name').focus());
}

$('method').onchange = updateMethod;
$('exportCsv').onclick = () => downloadCategories('csv');
$('exportExcel').onclick = () => downloadCategories('xlsx');
$('exportPdf').onclick = () => downloadCategories('pdf');
$('new').onclick = () => open();
$('close').onclick = $('cancel').onclick = () => { $('modal').hidden = true; document.body.classList.remove('modal-open'); };
$('filters').onsubmit = (event) => { event.preventDefault(); load(); };
$('entry').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('save');
  try {
    button.disabled = true;
    button.textContent = 'Guardando…';
    const payload = {
      code: editing ? $('code').value : 'AUTO',
      name: $('name').value,
      description: $('description').value,
      method: $('method').value,
      useful_life_months: $('life').value,
      residual: $('residual').value,
      asset_account_id: $('assetAccount').value,
      depreciation_account_id: $('depreciationAccount').value,
      expense_account_id: $('expenseAccount').value,
      active: $('active').value
    };
    const result = await api(
      editing ? `/api/fixed-assets/asset-category-manage/${editing}` : '/api/fixed-assets/asset-category-save',
      { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) }
    );
    $('modal').hidden = true;
    document.body.classList.remove('modal-open');
    $('message').textContent = result.message;
    await load();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Guardar categoría';
  }
};

await init();
