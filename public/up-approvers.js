const $ = id => document.getElementById(id);
const token = localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token') || '';
const device = localStorage.getItem('nexo_device_token') || sessionStorage.getItem('nexo_device_token') || '';

if (!token) location.replace('/');

const API = '/api/v1/cost-centers';
const state = {
  options: {},
  approvers: [],
  centers: [],
  selected: new Set(),
  currentApproverId: '',
  search: '',
  pendingMode: null,
  busy: false,
  hasConsulted: false
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const first = (object, ...keys) => {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== '') return object[key];
  }
  return '';
};
const array = value => Array.isArray(value) ? value : [];
const normalizeText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');

function requestHeaders(hasBody = false) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Device-Token': device,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {})
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: requestHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { message: raw }; }
  if (!response.ok) {
    if (response.status === 401) throw Error('La sesión venció o el dispositivo no está identificado. Inicie sesión nuevamente.');
    if (response.status === 403) throw Error(payload?.error?.message || payload?.message || 'No tiene permiso para realizar esta operación.');
    throw Error(payload?.error?.message || payload?.message || 'No fue posible completar la operación.');
  }
  return payload?.data ?? payload;
}

function normalizeApprover(item) {
  const firstName = first(item, 'firstName', 'first_name', 'nombre');
  const lastName = first(item, 'lastName', 'last_name', 'apellido');
  return {
    id: String(first(item, 'id', 'userId', 'user_id', 'usuarioId', 'usuario_id') || ''),
    name: String(first(item, 'name', 'displayName', 'display_name', 'fullName', 'full_name') || [firstName, lastName].filter(Boolean).join(' ') || 'Usuario sin nombre'),
    email: String(first(item, 'email', 'correo') || ''),
    assignedCount: Number(first(item, 'assignedCount', 'assigned_count', 'costCenterCount', 'cost_center_count') || 0),
    active: first(item, 'active', 'isActive', 'is_active', 'estado') !== false
  };
}

function normalizeCenter(item) {
  const inactiveValue = first(item, 'isInactive', 'is_inactive');
  const explicitlyInactive = inactiveValue === true || ['true', '1', 'yes', 'sí', 'si'].includes(String(inactiveValue).toLocaleLowerCase('es'));
  const status = String(first(item, 'status', 'estado') || (explicitlyInactive || first(item, 'isActive', 'is_active', 'active') === false ? 'INACTIVO' : 'ACTIVO')).toUpperCase();
  return {
    id: String(first(item, 'id', 'costCenterId', 'cost_center_id', 'centroCostoId', 'centro_costo_id') || ''),
    code: String(first(item, 'code', 'codigo') || '—'),
    name: String(first(item, 'name', 'nombre') || 'Centro de costos sin nombre'),
    subsidiaryId: String(first(item, 'subsidiaryId', 'subsidiary_id', 'empresaId', 'empresa_id') || ''),
    subsidiaryName: String(first(item, 'subsidiaryName', 'subsidiary_name', 'empresa', 'companyName', 'company_name') || company().name || 'Empresa activa'),
    type: String(first(item, 'type', 'costCenterType', 'cost_center_type', 'tipo') || 'CLIENTE').toUpperCase(),
    status,
    active: !['INACTIVO', 'INACTIVE', 'FALSE', '0'].includes(status)
  };
}

function unwrapApprovers(options) {
  const rows = array(options?.approvers).length ? options.approvers
    : array(options?.users).length ? options.users
      : array(options?.userOptions).length ? options.userOptions
        : array(options?.upApprovers).length ? options.upApprovers
          : array(options?.up_approvers);
  const currentRows = array(options?.currentApprovers).length ? options.currentApprovers : array(options?.current_approvers);
  const unique = new Map();
  [...rows, ...currentRows].map(normalizeApprover).filter(item => item.id).forEach(item => unique.set(item.id, { ...unique.get(item.id), ...item }));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

function unwrapCenters(payload) {
  if (Array.isArray(payload)) return payload.map(normalizeCenter).filter(item => item.id);
  const rows = payload?.costCenters || payload?.cost_centers || payload?.centers || payload?.rows || payload?.items || payload?.results || [];
  return array(rows).map(normalizeCenter).filter(item => item.id);
}

function company() {
  const item = state.options?.subsidiary || state.options?.company || state.options?.activeSubsidiary || state.options?.active_subsidiary || {};
  return {
    id: String(first(item, 'id', 'subsidiaryId', 'subsidiary_id') || first(state.options, 'subsidiaryId', 'subsidiary_id') || localStorage.getItem('nexo_company') || ''),
    name: String(first(item, 'name', 'companyName', 'company_name') || first(state.options, 'subsidiaryName', 'subsidiary_name') || localStorage.getItem('nexo_company_name') || 'Empresa activa')
  };
}

function canView() {
  const permissions = state.options?.permissions;
  if (permissions === undefined || permissions === null) return true;
  if (typeof permissions === 'boolean') return permissions;
  return Boolean(first(permissions, 'view', 'canView', 'can_view', 'manage', 'canManage', 'can_manage'));
}

function canManage() {
  const permissions = state.options?.permissions;
  if (permissions === undefined || permissions === null) return true;
  if (typeof permissions === 'boolean') return permissions;
  return Boolean(first(permissions, 'manage', 'canManage', 'can_manage', 'reassign', 'canReassign', 'can_reassign'));
}

function approver(id) {
  return state.approvers.find(item => item.id === String(id)) || { id: String(id || ''), name: 'Usuario no disponible', email: '' };
}

function visibleCenters() {
  const term = normalizeText(state.search);
  if (!term) return state.centers;
  return state.centers.filter(item => normalizeText([item.code, item.name, item.subsidiaryName, item.type, item.status].join(' ')).includes(term));
}

function setMessage(text = '', kind = '') {
  $('message').textContent = text;
  $('message').className = `page-message${kind ? ` ${kind}` : ''}`;
  if (text && kind === 'error') $('message').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('is-busy', value);
  $('upApproversApp').setAttribute('aria-busy', String(value));
  $('refresh').disabled = value;
  $('consult').disabled = value || !$('currentApprover').value;
  updateActions();
}

function optionLabel(item) {
  const suffix = item.email ? ` · ${item.email}` : '';
  const count = item.assignedCount ? ` (${item.assignedCount})` : '';
  return `${item.name}${suffix}${count}`;
}

function approverMatches(item, term) {
  return !term || normalizeText([item.name, item.email].join(' ')).includes(term);
}

function renderApproverOptions() {
  const currentValue = $('currentApprover').value;
  const newValue = $('newApprover').value;
  const currentTerm = normalizeText($('currentApproverSearch').value);
  const newTerm = normalizeText($('newApproverSearch').value);
  $('currentApprover').replaceChildren(new Option('Seleccione un aprobador', ''));
  $('newApprover').replaceChildren(new Option('Seleccione el nuevo aprobador', ''));
  for (const item of state.approvers) {
    if (item.id === currentValue || approverMatches(item, currentTerm)) $('currentApprover').append(new Option(optionLabel(item), item.id));
    if (!item.active) continue;
    if (item.id !== newValue && !approverMatches(item, newTerm)) continue;
    const option = new Option(optionLabel(item), item.id);
    option.disabled = item.id === String(state.currentApproverId || $('currentApprover').value);
    $('newApprover').append(option);
  }
  if (state.approvers.some(item => item.id === currentValue)) $('currentApprover').value = currentValue;
  if (state.approvers.some(item => item.id === newValue)) $('newApprover').value = newValue;
}

function renderRows() {
  const rows = visibleCenters();
  $('centerRows').innerHTML = rows.map(item => `
    <tr class="${state.selected.has(item.id) ? 'selected' : ''}">
      <td class="check-column"><input type="checkbox" data-center-id="${esc(item.id)}" aria-label="Seleccionar ${esc(item.code)} · ${esc(item.name)}" ${state.selected.has(item.id) ? 'checked' : ''}></td>
      <td><span class="center-code">${esc(item.code)}</span></td>
      <td><span class="center-name">${esc(item.name)}</span><small class="cell-note">ID ${esc(item.id)}</small></td>
      <td>${esc(item.subsidiaryName)}</td>
      <td><span class="type-chip">${esc(item.type)}</span></td>
      <td><span class="status-chip ${item.active ? 'active' : 'inactive'}">${item.active ? 'ACTIVO' : 'INACTIVO'}</span></td>
    </tr>`).join('');

  $('resultCount').textContent = `${state.centers.length.toLocaleString('es-CR')} centro${state.centers.length === 1 ? '' : 's'}`;
  $('tableRegion').hidden = !rows.length;
  $('emptyState').hidden = Boolean(rows.length);
  if (!rows.length) {
    const searched = Boolean(state.search);
    $('emptyState').querySelector('h3').textContent = searched ? 'No hay coincidencias' : state.hasConsulted ? 'Sin centros de costos asignados' : 'Seleccione un aprobador UP';
    $('emptyState').querySelector('p').textContent = searched
      ? 'Cambie el texto de búsqueda para volver a mostrar las asignaciones.'
      : state.hasConsulted
        ? 'Este aprobador no tiene centros CLIENTE asignados en la empresa activa.'
        : 'La consulta mostrará aquí todos los centros de costos CLIENTE que tiene asignados.';
  }
  updateSelectAll();
  updateActions();
}

function updateSelectAll() {
  const visible = visibleCenters();
  const checked = visible.length > 0 && visible.every(item => state.selected.has(item.id));
  const partly = visible.some(item => state.selected.has(item.id)) && !checked;
  $('selectAll').checked = checked;
  $('selectAll').indeterminate = partly;
  $('selectAll').disabled = !visible.length || !canManage();
}

function updateActions() {
  const selectedCount = state.selected.size;
  const centerCount = state.centers.length;
  const hasNew = Boolean($('newApprover')?.value);
  const sameApprover = hasNew && $('newApprover').value === state.currentApproverId;
  const manageable = canManage() && !state.busy;
  $('selectedCount').textContent = selectedCount.toLocaleString('es-CR');
  $('selectedButtonCount').textContent = selectedCount.toLocaleString('es-CR');
  $('allButtonCount').textContent = centerCount.toLocaleString('es-CR');
  $('newApprover').disabled = !state.currentApproverId || !centerCount || !canManage() || state.busy;
  $('newApproverSearch').disabled = !state.currentApproverId || !centerCount || !canManage() || state.busy;
  $('replaceSelected').disabled = !manageable || !selectedCount || !hasNew || sameApprover;
  $('replaceAll').disabled = !manageable || !centerCount || !hasNew || sameApprover;
}

function resetResults({ preserveSearch = false } = {}) {
  state.centers = [];
  state.selected.clear();
  state.hasConsulted = false;
  if (!preserveSearch) {
    state.search = '';
    $('centerSearch').value = '';
  }
  $('centerSearch').disabled = true;
  $('newApprover').value = '';
  $('newApproverSearch').value = '';
  $('resultsCaption').textContent = 'Seleccione un aprobador para cargar sus asignaciones.';
  renderRows();
}

async function loadCenters({ announce = true, preserveMessage = false } = {}) {
  const approverId = $('currentApprover').value;
  state.currentApproverId = approverId;
  resetResults({ preserveSearch: true });
  renderApproverOptions();
  $('currentApprover').value = approverId;
  if (!approverId) return;

  if (!preserveMessage) setMessage('');
  $('loadingState').hidden = false;
  $('emptyState').hidden = true;
  $('tableRegion').hidden = true;
  setBusy(true);
  try {
    const payload = await api(`${API}/up-approver/${encodeURIComponent(approverId)}`);
    state.centers = unwrapCenters(payload).filter(item => item.type === 'CLIENTE');
    state.selected.clear();
    state.hasConsulted = true;
    state.search = '';
    $('centerSearch').value = '';
    $('centerSearch').disabled = !state.centers.length;
    const current = approver(approverId);
    $('resultsCaption').textContent = state.centers.length
      ? `Asignaciones de ${current.name} en ${company().name}.`
      : `${current.name} no tiene centros CLIENTE asignados en ${company().name}.`;
    if (announce) setMessage(`Consulta actualizada: ${state.centers.length} centro${state.centers.length === 1 ? '' : 's'} de costos encontrado${state.centers.length === 1 ? '' : 's'}.`, 'info');
  } catch (error) {
    state.hasConsulted = true;
    setMessage(error.message, 'error');
  } finally {
    $('loadingState').hidden = true;
    setBusy(false);
    renderRows();
  }
}

function centersForMode(mode) {
  return mode === 'all' ? state.centers : state.centers.filter(item => state.selected.has(item.id));
}

function openConfirmation(mode) {
  const current = approver(state.currentApproverId);
  const next = approver($('newApprover').value);
  const centers = centersForMode(mode);
  if (!state.currentApproverId) return setMessage('Seleccione y consulte el aprobador actual.', 'error');
  if (!next.id) return setMessage('Seleccione el nuevo Aprobador UP.', 'error');
  if (current.id === next.id) return setMessage('El nuevo aprobador debe ser diferente del aprobador actual.', 'error');
  if (!centers.length) return setMessage(mode === 'all' ? 'El aprobador actual no tiene centros para reasignar.' : 'Seleccione al menos un centro de costos.', 'error');

  state.pendingMode = mode;
  $('confirmCurrent').textContent = current.name;
  $('confirmCurrentEmail').textContent = current.email || 'Sin correo registrado';
  $('confirmNew').textContent = next.name;
  $('confirmNewEmail').textContent = next.email || 'Sin correo registrado';
  $('confirmCount').textContent = centers.length.toLocaleString('es-CR');
  $('confirmScope').textContent = mode === 'all' ? 'Todos los centros del aprobador' : 'Centros seleccionados';
  $('confirmScopeHelp').textContent = mode === 'all'
    ? `Se reasignarán todas las asignaciones de ${current.name} en ${company().name}, aunque haya una búsqueda aplicada.`
    : `Se reasignarán únicamente los ${centers.length} centros marcados en la tabla.`;
  $('confirmDetailsCount').textContent = `(${centers.length})`;
  $('confirmCenters').innerHTML = centers.map(item => `<li><strong>${esc(item.code)}</strong> · ${esc(item.name)}</li>`).join('');
  $('dialogError').textContent = '';
  $('confirmDetails').open = centers.length <= 8;
  $('confirmDialog').showModal();
  setTimeout(() => $('cancelDialog').focus(), 0);
}

async function reassign() {
  const mode = state.pendingMode;
  const centers = centersForMode(mode);
  const subsidiaryId = company().id || centers[0]?.subsidiaryId;
  if (!subsidiaryId) throw Error('No fue posible identificar la empresa activa. Actualice la pantalla e intente nuevamente.');
  const payload = {
    subsidiary_id: subsidiaryId,
    current_approver_id: state.currentApproverId,
    new_approver_id: $('newApprover').value,
    reassign_all: mode === 'all',
    cost_center_ids: mode === 'all' ? [] : centers.map(item => item.id)
  };

  const submit = $('confirmReassign');
  const previousLabel = submit.textContent;
  submit.textContent = 'Reasignando…';
  submit.disabled = true;
  $('dialogError').textContent = '';
  setBusy(true);
  try {
    const result = await api(`${API}/reassign-up-approver`, { method: 'POST', body: payload });
    const updated = Number(first(result, 'updatedCount', 'updated_count', 'count', 'affectedRows', 'affected_rows') || centers.length);
    $('confirmDialog').close();
    state.pendingMode = null;
    setMessage(`${updated.toLocaleString('es-CR')} centro${updated === 1 ? '' : 's'} de costos reasignado${updated === 1 ? '' : 's'} correctamente a ${approver(payload.new_approver_id).name}.`);
    await reloadOptions({ preserveMessage: true, reloadCenters: true });
  } catch (error) {
    $('dialogError').textContent = error.message;
  } finally {
    setBusy(false);
    submit.textContent = previousLabel;
    submit.disabled = false;
  }
}

async function reloadOptions({ preserveMessage = false, reloadCenters = false } = {}) {
  if (!preserveMessage) setMessage('');
  const current = $('currentApprover').value || state.currentApproverId;
  setBusy(true);
  try {
    state.options = await api(`${API}/up-approver-options`);
    state.approvers = unwrapApprovers(state.options);
    $('activeCompany').textContent = company().name;
    if (!canView()) throw Error('No tiene permiso para consultar el mantenimiento de Aprobadores UP.');
    $('accessDenied').hidden = true;
    $('workspace').hidden = false;
    renderApproverOptions();
    if (state.approvers.some(item => item.id === String(current))) $('currentApprover').value = String(current);
    else if (state.currentApproverId && !state.approvers.some(item => item.id === state.currentApproverId)) {
      state.approvers.push(normalizeApprover({ id: state.currentApproverId, name: approver(state.currentApproverId).name }));
      renderApproverOptions();
      $('currentApprover').value = state.currentApproverId;
    }
    if (!canManage()) setMessage('Puede consultar las asignaciones, pero no tiene permiso para reasignar Aprobadores UP.', 'info');
  } catch (error) {
    $('workspace').hidden = true;
    $('accessDenied').hidden = false;
    $('accessDenied').querySelector('p').textContent = error.message;
    throw error;
  } finally {
    setBusy(false);
  }
  if (reloadCenters && $('currentApprover').value) await loadCenters({ announce: false, preserveMessage });
}

$('currentApprover').addEventListener('change', () => {
  state.currentApproverId = $('currentApprover').value;
  resetResults();
  renderApproverOptions();
  $('currentApprover').value = state.currentApproverId;
  $('consult').disabled = !state.currentApproverId;
});
$('currentApproverSearch').addEventListener('input', renderApproverOptions);
$('newApproverSearch').addEventListener('input', renderApproverOptions);
$('consult').addEventListener('click', () => void loadCenters());
$('refresh').addEventListener('click', () => void reloadOptions({ reloadCenters: Boolean(state.currentApproverId) }).catch(error => setMessage(error.message, 'error')));
$('centerSearch').addEventListener('input', () => { state.search = $('centerSearch').value; renderRows(); });
$('centerRows').addEventListener('change', event => {
  const checkbox = event.target.closest('[data-center-id]');
  if (!checkbox) return;
  checkbox.checked ? state.selected.add(checkbox.dataset.centerId) : state.selected.delete(checkbox.dataset.centerId);
  renderRows();
});
$('selectAll').addEventListener('change', () => {
  for (const item of visibleCenters()) $('selectAll').checked ? state.selected.add(item.id) : state.selected.delete(item.id);
  renderRows();
});
$('newApprover').addEventListener('change', updateActions);
$('replaceSelected').addEventListener('click', () => openConfirmation('selected'));
$('replaceAll').addEventListener('click', () => openConfirmation('all'));
$('confirmForm').addEventListener('submit', event => { event.preventDefault(); void reassign(); });
for (const id of ['closeDialog', 'cancelDialog']) $(id).addEventListener('click', () => { if (!state.busy) $('confirmDialog').close(); });
$('confirmDialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });

async function initialize() {
  try {
    await reloadOptions();
    resetResults();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    $('upApproversApp').setAttribute('aria-busy', 'false');
  }
}

void initialize();
