export interface AuthenticatedRequest {
  userId: string;
  tenantId: string;
  role: 'admin' | 'manager' | 'operator';
}

/** El guard real validará el JWT de Supabase y establecerá el contexto del tenant. */
export function hasPermission(user: AuthenticatedRequest, permission: string): boolean {
  return user.role === 'admin' || permission.startsWith('read:');
}
