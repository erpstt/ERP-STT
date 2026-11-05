(() => {
  'use strict';
  if (window.NexoSessionRenewal) return;
  const nativeFetch = window.fetch.bind(window);
  const META_KEY = 'nexo_session_renewal';
  const CHANNEL = 'nexo-session-renewal';
  const publicAuth = new Set(['login', 'logout', 'refresh', 'request-password-recovery', 'continue-password-access', 'complete-password-recovery', 'complete-password-invitation', 'turnstile-config']);
  const timestamp = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '');
  const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const remove = (storage, key) => { try { storage.removeItem(key); } catch { /* Unavailable storage cannot hold a session. */ } };
  const jwt = token => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };
  const identity = token => { const claims = jwt(token); return claims?.sub && claims?.session_id ? `${claims.sub}/${claims.session_id}` : ''; };
  const random = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const error = (message, status = 503) => Object.assign(new Error(message), { status, sessionRenewal: true });
  const sessionError = () => error('La sesión venció o fue revocada. Inicie sesión nuevamente.', 401);

  function createCoordinator() {
    let epoch = 0, timer = null, pending = null, active = null, retryAt = 0, channel = null;
    let aliases = new Set();
    const retired = new Set();
    const broadcast = data => { try { channel?.postMessage(data); } catch { /* Other tabs can still synchronize through storage. */ } };
    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
    const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    function stored() {
      const local = read(localStorage, 'nexo_token'), storage = local ? localStorage : sessionStorage;
      const token = local || read(sessionStorage, 'nexo_token');
      if (!token) return null;
      let meta; try { meta = JSON.parse(read(storage, META_KEY) || 'null'); } catch { /* Legacy access-only session. */ }
      const owner = identity(token);
      if (!meta || meta.identity !== owner || !meta.generation) {
        const expiresAt = Number(jwt(token)?.exp || 0) * 1000;
        meta = { identity: owner, generation: random(), expiresAt, erpSessionExpiresAt: expiresAt, refreshAt: expiresAt, refreshable: false };
        try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* Keep the legacy session in memory. */ }
      }
      return { token, storage, rememberMe: storage === localStorage, ...meta };
    }
    function current() {
      const next = stored();
      if (next?.generation !== active?.generation) { if (active?.identity) retired.add(active.identity); epoch += 1; aliases = new Set(); retryAt = 0; }
      active = next;
      if (next) aliases.add(next.token);
      return next;
    }
    function matches(snapshot) {
      const state = current();
      return Boolean(state && snapshot && state.generation === snapshot.generation && state.identity === snapshot.identity);
    }
    function schedule() {
      clearTimer();
      const state = current();
      if (!state || document.hidden || !Number.isFinite(state.refreshAt) || state.refreshAt <= 0) return;
      const delay = Math.max(250, Math.max(state.refreshAt, retryAt) - Date.now());
      timer = setTimeout(() => { timer = null; void ensureFresh().catch(() => {}); }, Math.min(delay, 2147483647));
    }
    function save(data, { rememberMe, generation, refresh = false } = {}) {
      if (typeof data?.accessToken !== 'string' || !data.accessToken) throw error('No fue posible renovar la sesión. Reintente.', 502);
      const owner = identity(data.accessToken), expiresAt = timestamp(data.expiresAt) || Number(jwt(data.accessToken)?.exp || 0) * 1000;
      const erpSessionExpiresAt = timestamp(data.erpSessionExpiresAt), suppliedRefreshAt = timestamp(data.refreshAt);
      const refreshable = Boolean(owner && expiresAt > 0 && erpSessionExpiresAt > 0 && Number.isFinite(suppliedRefreshAt));
      if (refresh && !refreshable) throw error('La respuesta de renovación no es válida. Reintente.', 502);
      const meta = { identity: owner, generation: generation || random(), expiresAt, erpSessionExpiresAt: refreshable ? erpSessionExpiresAt : expiresAt,
        refreshAt: refreshable ? Math.min(suppliedRefreshAt, expiresAt - 60000, erpSessionExpiresAt - 60000) : expiresAt, refreshable };
      const storage = rememberMe ? localStorage : sessionStorage, other = rememberMe ? sessionStorage : localStorage;
      storage.setItem('nexo_token', data.accessToken);
      storage.setItem(META_KEY, JSON.stringify(meta));
      remove(other, 'nexo_token'); remove(other, META_KEY);
      retryAt = 0; current(); schedule();
      return active;
    }
    function end(snapshot, reason = 'expired', { notify = true, publish = true } = {}) {
      if (snapshot && !matches(snapshot)) return false;
      const previous = current();
      if (previous?.identity) retired.add(previous.identity);
      epoch += 1; clearTimer(); pending = null; aliases.clear(); active = null; retryAt = 0;
      for (const storage of [localStorage, sessionStorage]) {
        const token = read(storage, 'nexo_token');
        if (!snapshot || token === previous?.token) {
          remove(storage, 'nexo_token'); remove(storage, META_KEY);
          for (const key of ['nexo_company', 'nexo_role']) remove(storage, key);
        }
      }
      if (publish && previous) broadcast({ type: 'ended', generation: previous.generation, identity: previous.identity, reason });
      if (notify) emit('nexo:session-ended', { reason, generation: previous?.generation });
      return true;
    }
    const due = state => Number.isFinite(state.refreshAt) && state.refreshAt > 0 && Date.now() >= state.refreshAt;
    async function renew(snapshot, capturedEpoch) {
      let response, data;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!matches(snapshot) || epoch !== capturedEpoch) throw sessionError();
        if (current().token !== snapshot.token) return current();
        try {
          response = await nativeFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { Authorization: `Bearer ${snapshot.token}`, 'X-Device-Token': read(localStorage, 'nexo_device_token') || read(sessionStorage, 'nexo_device_token') || '', 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
          data = await response.json().catch(() => null);
        } catch (cause) {
          if (attempt === 0 && matches(snapshot) && epoch === capturedEpoch) continue;
          throw error('No fue posible renovar la sesión por un problema de conexión. Sus datos permanecen en el formulario.');
        }
        if (!matches(snapshot) || epoch !== capturedEpoch) throw sessionError();
        if (current().token !== snapshot.token) return current();
        if ([401, 403].includes(response.status)) { end(snapshot); throw sessionError(); }
        if (response.ok) break;
        if (attempt === 0 && [409, 502, 503, 504].includes(response.status)) continue;
        throw error(data?.error?.message || 'No fue posible renovar la sesión. Sus datos permanecen en el formulario. Reintente.', response.status);
      }
      const latest = current();
      if (!matches(snapshot) || epoch !== capturedEpoch) throw sessionError();
      // A rotation received from another tab wins over a late response.
      if (latest.token !== snapshot.token) return latest;
      if (typeof data?.accessToken !== 'string' || !identity(data.accessToken)) throw error('La respuesta de renovación no es válida. Reintente.', 502);
      if (identity(data.accessToken) !== snapshot.identity || !snapshot.identity) { end(snapshot); throw sessionError(); }
      const result = save(data, { rememberMe: snapshot.rememberMe, generation: snapshot.generation, refresh: true });
      broadcast({ type: 'renewed', generation: result.generation, identity: result.identity, data: { accessToken: result.token, expiresAt: result.expiresAt, erpSessionExpiresAt: result.erpSessionExpiresAt, refreshAt: result.refreshAt } });
      emit('nexo:session-renewed', { generation: result.generation });
      return result;
    }
    async function ensureFresh({ force = false } = {}) {
      const snapshot = current();
      if (!snapshot) throw sessionError();
      if (!force && !due(snapshot)) { schedule(); return snapshot; }
      if (pending?.generation === snapshot.generation) return pending.promise;
      const capturedEpoch = epoch;
      const run = async () => {
        const latest = current();
        if (!matches(snapshot) || epoch !== capturedEpoch) throw sessionError();
        if (latest.token !== snapshot.token || !force && !due(latest)) return latest;
        return renew(latest, capturedEpoch);
      };
      const task = { generation: snapshot.generation };
      pending = task;
      task.promise = (async () => {
        try {
          return await (navigator.locks?.request ? navigator.locks.request('nexo-session-renewal', run) : run());
        } catch (cause) {
          if (matches(snapshot)) {
            retryAt = Date.now() + (cause.status === 429 ? 60000 : 15000);
            emit('nexo:session-renewal-error', { message: cause.message, status: cause.status || 503 });
          }
          throw cause;
        } finally { if (pending === task) pending = null; schedule(); }
      })();
      return task.promise;
    }
    function acceptLogin(data, { rememberMe = false, attempt } = {}) {
      if (attempt !== undefined && attempt !== epoch) return false;
      save(data, { rememberMe });
      return true;
    }
    function beginLogin() { end(null, 'login', { notify: false }); return epoch; }
    async function logout() {
      const state = current(), device = read(localStorage, 'nexo_device_token') || read(sessionStorage, 'nexo_device_token') || '';
      end(state, 'logout', { notify: false });
      const endedEpoch = epoch;
      if (state) try {
        const response = await nativeFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { Authorization: `Bearer ${state.token}`, 'X-Device-Token': device } });
        if (!response.ok) throw Error('Revocation failed');
      } catch {
        if (epoch === endedEpoch && !current()) emit('nexo:session-revocation-error', { message: 'La sesión se cerró en este navegador, pero no fue posible confirmar su revocación en el servidor.', generation: state.generation });
      }
    }
    function permits(token, frame) {
      const state = current();
      return Boolean(state && (aliases.has(token) || frame?.generation === state.generation && frame.identity && frame.identity === state.identity && identity(token) === state.identity));
    }
    try {
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = event => {
          const message = event.data, state = current();
          if (!state || message?.generation !== state.generation || message.identity !== state.identity) return;
          if (message.type === 'ended') end(state, message.reason, { publish: false });
          if (message.type === 'renewed' && identity(message.data?.accessToken || '') === state.identity && timestamp(message.data.erpSessionExpiresAt) >= state.erpSessionExpiresAt) {
            save(message.data, { rememberMe: state.rememberMe, generation: state.generation, refresh: true });
          }
        };
      }
    } catch { /* Storage synchronization and server CAS remain available. */ }
    window.addEventListener('storage', event => {
      if (!['nexo_token', META_KEY, null].includes(event.key)) return;
      const previous = active, next = current();
      if (previous && next?.generation !== previous.generation) emit('nexo:session-ended', { reason: next ? 'changed' : 'logout', generation: previous.generation });
      schedule();
    });
    window.addEventListener('focus', () => { if (current()) void ensureFresh().catch(() => {}); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimer(); else if (current()) void ensureFresh().catch(() => {}); });
    current(); schedule();
    return { current, ensureFresh, acceptLogin, beginLogin, logout, permits, end, isRetired: token => Boolean(identity(token) && retired.has(identity(token))), isAttemptCurrent: attempt => attempt === epoch };
  }

  let coordinator;
  try { if (window !== window.top) coordinator = window.top.NexoSessionRenewal; } catch { /* Only same-origin frames share the coordinator. */ }
  coordinator ||= createCoordinator();
  window.NexoSessionRenewal = coordinator;
  const initial = coordinator.current(), frame = initial && { generation: initial.generation, identity: initial.identity };
  window.fetch = async (resource, init) => {
    let url; try { url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url, location.href); } catch { return nativeFetch(resource, init); }
    const action = url.pathname.startsWith('/api/auth/') ? url.pathname.slice('/api/auth/'.length) : '';
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || publicAuth.has(action) || url.pathname.startsWith('/api/security/turnstile/')) return nativeFetch(resource, init);
    const headers = new Headers(init?.headers ?? (typeof resource === 'object' ? resource.headers : undefined) ?? {});
    const bearer = /^Bearer (.+)$/i.exec(headers.get('Authorization') || '')?.[1];
    if (!bearer) return nativeFetch(resource, init);
    if (!coordinator.permits(bearer, frame)) { if (coordinator.isRetired(bearer)) throw sessionError(); return nativeFetch(resource, init); }
    const before = coordinator.current(), signal = init?.signal || resource?.signal;
    if (signal?.aborted) throw new DOMException('La solicitud fue cancelada.', 'AbortError');
    const fresh = await coordinator.ensureFresh();
    if (signal?.aborted) throw new DOMException('La solicitud fue cancelada.', 'AbortError');
    if (!before || fresh.generation !== before.generation || !coordinator.permits(bearer, frame)) throw sessionError();
    headers.set('Authorization', `Bearer ${fresh.token}`);
    const response = await nativeFetch(resource, { ...init, headers });
    // Refresh only the session for the next request. Never replay the financial request.
    if (response.status === 401 && coordinator.current()?.generation === fresh.generation && coordinator.current()?.token === fresh.token) {
      await coordinator.ensureFresh({ force: true }).catch(() => {});
    }
    return response;
  };
})();
