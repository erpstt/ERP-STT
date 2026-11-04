export type GenericRouteAction = 'view' | 'create' | 'edit' | 'delete';

// Only the two payment workflows expose PUT through the generic access gate.
// An unsupported method must not acquire an unrelated DELETE permission.
export function genericRouteAction(method: string | undefined, resourceKey: string): GenericRouteAction | undefined {
  switch (method) {
    case 'GET': return 'view';
    case 'PATCH': return 'edit';
    case 'POST': return resourceKey === 'security:user-subsidiaries' ? 'edit' : 'create';
    case 'DELETE': return 'delete';
    case 'PUT':
      if (resourceKey === 'purchasing:supplier-payments' || resourceKey === 'sales:customer-payments') return 'edit';
      return undefined;
    default: return undefined;
  }
}
