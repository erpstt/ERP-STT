import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

class StorageMock {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

class ElementMock {
  constructor(tagName) {
    this.tagName = tagName;
    this.hidden = false;
    this.removed = false;
    this.count = { textContent: '' };
  }
  setAttribute() {}
  querySelector(selector) { return selector === 'b' ? this.count : null; }
  remove() { this.removed = true; }
}

function environment() {
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const appended = [];
  const fetches = [];
  const localStorage = new StorageMock();
  const sessionStorage = new StorageMock();
  const document = {
    hidden: false,
    body: { append: (...elements) => appended.push(...elements) },
    head: { append: element => appended.push(element) },
    createElement: tagName => new ElementMock(tagName),
    addEventListener: (type, listener) => listeners.set(`document:${type}`, listener)
  };
  const window = {
    document,
    localStorage,
    sessionStorage,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
    dispatchEvent() {}
  };
  window.top = window;
  const clearTimeout = id => timers.delete(id);
  const fetch = async (url, options) => {
    fetches.push({ url, options });
    return {
      ok: true,
      json: async () => url.includes('inbox') ? [{ approvalId: 1 }] : { notifications: [{ readAt: null }] }
    };
  };
  return { appended, clearTimeout, document, fetch, fetches, listeners, localStorage, sessionStorage, timers, window };
}

async function runNextTimer(state) {
  const next = [...state.timers.entries()].sort((a, b) => a[0] - b[0])[0];
  assert.ok(next, 'se esperaba una tarea programada');
  state.timers.delete(next[0]);
  next[1].callback();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return next[1].delay;
}

test('las notificaciones esperan la sesión, consultan al autenticarse y se pausan en segundo plano', async () => {
  const state = environment();
  const source = await readFile(new URL('../public/approval-notifications.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    AbortController,
    CustomEvent: class {},
    Intl,
    Promise,
    clearTimeout: state.clearTimeout,
    document: state.document,
    fetch: state.fetch,
    localStorage: state.localStorage,
    sessionStorage: state.sessionStorage,
    window: state.window
  });

  assert.equal(await runNextTimer(state), 0);
  assert.equal(state.fetches.length, 0);
  assert.equal(state.appended.length, 0);
  assert.equal([...state.timers.values()][0].delay, 5_000);

  state.localStorage.setItem('nexo_token', 'token-prueba');
  state.localStorage.setItem('nexo_device_token', 'dispositivo-prueba');
  assert.equal(await runNextTimer(state), 5_000);
  assert.equal(state.fetches.length, 2);
  assert.equal(state.appended.filter(item => item.tagName === 'button').length, 2);
  assert.equal(state.appended.find(item => item.tagName === 'button').count.textContent, '1');
  assert.equal([...state.timers.values()][0].delay, 60_000);

  state.document.hidden = true;
  state.listeners.get('document:visibilitychange')();
  assert.equal(state.timers.size, 0);

  state.document.hidden = false;
  state.listeners.get('document:visibilitychange')();
  assert.equal([...state.timers.values()][0].delay, 0);
});

