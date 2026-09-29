import { rpc } from '../notifications/email-notification.service.js';

const actions = new Set(['options', 'list', 'save', 'delete', 'save-template']);

export async function taxObligationCatalogAction(
  authorization: string,
  action: string,
  payload: Record<string, unknown> = {}
) {
  if (!authorization?.startsWith('Bearer ')) throw Error('Debe iniciar sesión para administrar las obligaciones tributarias.');
  if (!actions.has(action)) throw Error('Acción de configuración tributaria inválida.');
  return rpc('tax_obligation_catalog_manage', { p_action: action, p_payload: payload }, authorization);
}
