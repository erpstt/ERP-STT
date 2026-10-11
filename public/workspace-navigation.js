const STORAGE_KEY = 'nexo_workspace_redirect';
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;
const STATIC_WORKSPACE_PATH = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const SPECIAL_WORKSPACE_PATHS = new Set(['/informes/contabilidad', '/apps/budget/builder', '/apps/budget/dashboard']);

function browserOrigin() {
  return globalThis.location?.origin || 'http://localhost';
}

export function normalizeWorkspacePath(rawPath, origin = browserOrigin()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  let target;
  try { target = new URL(rawPath, origin); } catch { return null; }
  if (target.origin !== origin || (!STATIC_WORKSPACE_PATH.test(target.pathname) && !SPECIAL_WORKSPACE_PATHS.has(target.pathname))) return null;

  if (target.pathname === '/payment-requests.html') {
    const id = target.searchParams.get('id');
    if (id !== null && !/^[1-9]\d*$/.test(id)) return null;
    const company = target.searchParams.get('subsidiaryId') || target.searchParams.get('company');
    if (company !== null && !/^[1-9]\d*$/.test(company)) return null;
    target.searchParams.delete('company');
    if (company !== null) target.searchParams.set('subsidiaryId', company);
  }
  return target.pathname + target.search + target.hash;
}

export function getPendingWorkspace() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw);
    const age = Date.now() - Number(pending.createdAt);
    const path = normalizeWorkspacePath(pending.path);
    if (!path || !Number.isFinite(age) || age < 0 || age > MAX_PENDING_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    const target = new URL(path, browserOrigin());
    return { path, subsidiaryId: target.searchParams.get('subsidiaryId') || null };
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearPendingWorkspace() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function consumePendingWorkspace() {
  const pending = getPendingWorkspace();
  if (pending) clearPendingWorkspace();
  return pending;
}

// A direct workspace page is resumed only after authentication, role selection
// and subsidiary access have been established by the shell.
export function initialWorkspace() {
  const url = new URL(location.href);
  if (url.searchParams.has('workspace')) {
    url.searchParams.delete('workspace');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    clearPendingWorkspace();
  }
  getPendingWorkspace(); // Discard malformed or expired values without consuming valid ones.
  return '';
}
