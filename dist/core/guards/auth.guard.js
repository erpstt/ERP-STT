/** El guard real validará el JWT de Supabase y establecerá el contexto del tenant. */
export function hasPermission(user, permission) {
    return user.role === 'admin' || permission.startsWith('read:');
}
