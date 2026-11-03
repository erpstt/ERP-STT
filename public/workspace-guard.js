// Parser-blocking: keep the previous redirect/class decision before page scripts run.
if (window === window.top) {
  sessionStorage.setItem('nexo_workspace_redirect', JSON.stringify({
    path: location.pathname + location.search + location.hash,
    createdAt: Date.now()
  }));
  location.replace('/');
} else {
  document.documentElement.classList.add('inside-erp-workspace');
}
