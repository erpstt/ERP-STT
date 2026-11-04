import { rpc } from '../notifications/email-notification.service.js';

const actions = new Set(['options', 'list', 'save', 'delete', 'save-template', 'calendar-options']);
type Action = 'view' | 'create' | 'edit' | 'delete';

function failure(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function access(authorization: string, resource: string, action: Action, capabilities: boolean) {
  if (!/^Bearer\s+\S+$/i.test(authorization || '')) failure('Debe iniciar sesión.', 401);
  // Catalog modules import each other; resolve the guard after initialization.
  const { assertRoleAccess, myRoleAccess } = await import('../security-catalogs/role-access-matrix.module.js');
  await assertRoleAccess(authorization, resource, action);
  if (!capabilities) return null;
  const current = await myRoleAccess(authorization);
  const allowed = (action: Action) => current.isAdmin || current.grants.some(grant =>
    grant.resourceKey === resource && grant.canView === true && grant[`can${action[0].toUpperCase()}${action.slice(1)}` as 'canView' | 'canCreate' | 'canEdit' | 'canDelete'] === true);
  return { view: allowed('view'), create: allowed('create'), edit: allowed('edit'), delete: allowed('delete') };
}

export async function taxObligationCatalogAction(
  authorization: string,
  action: string,
  payload: Record<string, unknown> = {}
) {
  if (!actions.has(action)) failure('Acción de configuración tributaria inválida.');
  if (!record(payload)) failure('Datos de configuración tributaria inválidos.');
  const hasId = Object.hasOwn(payload, 'id');
  if ((action === 'save' && hasId || action === 'delete') && !validId(payload.id)) failure('Obligación tributaria inválida.');
  const operation: Action = action === 'delete' ? 'delete' : action === 'save' ? hasId ? 'edit' : 'create' : action === 'save-template' ? 'edit' : 'view';
  const resource = action === 'calendar-options' ? 'tax:tax-calendar' : 'tax:tax-obligations';
  const permissions = await access(authorization, resource, operation, action === 'options');
  const result = await rpc('tax_obligation_catalog_manage', { p_action: action, p_payload: payload }, authorization);
  if (action !== 'options' || !record(result)) return result;
  const operational = record(result.permissions) ? result.permissions : {};
  return { ...result, permissions: { ...operational,
    view: operational.view === true && permissions?.view === true,
    create: operational.manage === true && permissions?.create === true,
    edit: operational.manage === true && permissions?.edit === true,
    delete: operational.manage === true && permissions?.delete === true,
  } };
}
