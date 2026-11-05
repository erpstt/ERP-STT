import {escapeHtml} from './html-safety.js?v=20261101-a03-1';
export function feeActionMarkup(row, access = {}) {
 const id=String(row.id??'');if(!/^[1-9]\d*$/.test(id))return '';
 const actions=row._actions||{};
 return `<div class="fee-actions"><a target="_blank" rel="noopener" href="/bank-fee-view.html?id=${escapeHtml(id)}&print=1">Ver PDF</a>${access.canEdit!==false&&actions.canEdit!==false?`<button type="button" data-edit="${escapeHtml(id)}">Editar</button>`:''}${access.canDelete!==false&&actions.canDelete!==false?`<button type="button" data-delete="${escapeHtml(id)}">Eliminar</button>`:''}</div>`;
}
