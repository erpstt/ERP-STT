// A direct page may hand off to the shell once. Never restore a form from a saved URL.
export function initialWorkspace() {
  const url = new URL(location.href);
  if (url.searchParams.has('workspace')) {
    url.searchParams.delete('workspace');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    sessionStorage.removeItem('nexo_workspace_redirect');
    return '';
  }
  const pending = sessionStorage.getItem('nexo_workspace_redirect');
  sessionStorage.removeItem('nexo_workspace_redirect');
  if (!pending || !(localStorage.getItem('nexo_token') || sessionStorage.getItem('nexo_token'))) return '';
  try {
    const { path, createdAt } = JSON.parse(pending);
    if (typeof path !== 'string' || !Number.isFinite(createdAt) || Date.now() - createdAt < 0 || Date.now() - createdAt > 15000) return '';
    const target = new URL(path, location.origin);
    return target.origin === location.origin && target.pathname !== '/' ? target.pathname + target.search + target.hash : '';
  } catch { return ''; }
}
