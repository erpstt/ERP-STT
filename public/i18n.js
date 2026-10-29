export const GENTIA_LANGUAGE_STORAGE_KEY = 'gentia_language';
export const GENTIA_SUPPORTED_LOCALES = Object.freeze([
  { code: 'es', isoCode: 'SPA', name: 'Español' },
  { code: 'en', isoCode: 'ENG', name: 'English' },
  { code: 'pt', isoCode: 'POR', name: 'Português' }
]);
export const GENTIA_TRANSLATION_BUNDLES = Object.freeze(['operations', 'reports', 'admin', 'business']);

const aliases = new Map([
  ['es', 'es'], ['es-es', 'es'], ['es-cr', 'es'], ['spa', 'es'], ['spanish', 'es'], ['espanol', 'es'],
  ['en', 'en'], ['en-us', 'en'], ['en-gb', 'en'], ['eng', 'en'], ['english', 'en'], ['ingles', 'en'],
  ['pt', 'pt'], ['pt-br', 'pt'], ['pt-pt', 'pt'], ['por', 'pt'], ['portuguese', 'pt'], ['portugues', 'pt']
]);
const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'SVG', 'PATH']);
const translatedAttributes = ['placeholder', 'title', 'aria-label', 'alt'];
const automaticUiSelector = [
  'button', '[role="button"]', 'label', 'legend', 'summary', 'title',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th',
  'nav a', 'header a', 'footer a', '.toolbar a', '.actions a', '.tabs a',
  'a.button', 'a.primary-button', 'a.secondary-button', 'a.icon-action',
  '.status', '.badge', '.state', '.tag', '.eyebrow', '.notice', '[data-i18n-auto]'
].join(',');

function normalized(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('en');
}

export function normalizeGentiaLocale(value, fallback = 'es') {
  const candidate = normalized(value).replaceAll('_', '-');
  return aliases.get(candidate) ?? aliases.get(candidate.split('-')[0]) ?? fallback;
}

export function resolveTranslation(messages, key) {
  return String(key ?? '').split('.').reduce((value, segment) => value && typeof value === 'object' ? value[segment] : undefined, messages);
}

export function interpolateTranslation(template, parameters = {}) {
  return String(template ?? '').replace(/\{([\w.-]+)\}/g, (match, key) => parameters[key] ?? match);
}

function flattenMessages(value, prefix = '', output = new Map()) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output.set(path, child);
    else if (child && typeof child === 'object') flattenMessages(child, path, output);
  }
  return output;
}

function mergeMessages(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = target[key];
      target[key] = mergeMessages(current && typeof current === 'object' && !Array.isArray(current) ? current : {}, value);
    } else target[key] = value;
  }
  return target;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateMatcher(key, template) {
  const parameters = [];
  let cursor = 0, pattern = '';
  for (const match of template.matchAll(/\{([\w.-]+)\}/g)) {
    pattern += escapePattern(template.slice(cursor, match.index));
    pattern += '(.+?)';
    parameters.push(match[1]);
    cursor = Number(match.index) + match[0].length;
  }
  pattern += escapePattern(template.slice(cursor));
  return parameters.length ? { key, parameters, expression: new RegExp(`^${pattern}$`, 'u') } : null;
}

function preservedWhitespace(source, translated) {
  const leading = source.match(/^\s*/u)?.[0] ?? '';
  const trailing = source.match(/\s*$/u)?.[0] ?? '';
  return `${leading}${translated}${trailing}`;
}

function parseParameters(element) {
  try { return JSON.parse(element?.dataset?.i18nParams || '{}'); }
  catch { return {}; }
}

function canTranslateElement(element) {
  if (!element || ignoredTags.has(element.tagName)) return false;
  if (element.isContentEditable || element.closest?.('[data-i18n-ignore]')) return false;
  return true;
}

function canAutoTranslateElement(element) {
  if (!canTranslateElement(element)) return false;
  const uiElement = element.closest?.(automaticUiSelector);
  if (!uiElement) return false;
  const dataCell = element.closest?.('tbody td');
  if (!dataCell) return true;
  return Boolean(element.closest?.('button,[role="button"],.row-actions,.actions,.status,.badge,.state,.tag,[data-i18n-auto]'));
}

function canAutoTranslateAttribute(element, attribute) {
  if (!canTranslateElement(element)) return false;
  if (attribute === 'placeholder') return element.matches?.('input,textarea');
  if (attribute === 'alt') return element.matches?.('img,input[type="image"]');
  if (attribute === 'aria-label' || attribute === 'title') {
    return Boolean(element.matches?.('button,a,input,select,textarea,summary,[role="button"],[data-i18n-auto]'));
  }
  return false;
}

export class GentiaI18n extends EventTarget {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl ?? '/locales';
    this.storageKey = options.storageKey ?? GENTIA_LANGUAGE_STORAGE_KEY;
    this.defaultLocale = normalizeGentiaLocale(options.defaultLocale ?? 'es');
    this.locale = this.defaultLocale;
    this.messages = new Map();
    this.flatMessages = new Map();
    this.reverseMessages = new Map();
    this.templateMatchers = [];
    this.textBindings = new WeakMap();
    this.attributeBindings = new WeakMap();
    this.observer = null;
    this.initialized = false;
    this.initializing = null;
    this.broadcastChannel = null;
    this.onStorage = event => {
      if (event.key === this.storageKey && event.newValue) void this.setLocale(event.newValue, { persist: false, broadcast: false });
    };
    this.onMessage = event => {
      if (event.origin && globalThis.location && event.origin !== location.origin) return;
      if (event.data?.type === 'gentia:language' && event.data.locale) void this.setLocale(event.data.locale, { persist: true, broadcast: false });
    };
  }

  storedLocale() {
    try { return normalizeGentiaLocale(globalThis.localStorage?.getItem(this.storageKey), this.defaultLocale); }
    catch { return this.defaultLocale; }
  }

  async load(locale) {
    const code = normalizeGentiaLocale(locale, this.defaultLocale);
    if (this.messages.has(code)) return this.messages.get(code);
    const response = await fetch(`${this.baseUrl}/${code}.json?v=20261029-i18n`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`No fue posible cargar el idioma ${code}.`);
    const messages = await response.json();
    const fragments = await Promise.allSettled(GENTIA_TRANSLATION_BUNDLES.map(async bundle => {
      const fragmentResponse = await fetch(`${this.baseUrl}/modules/${bundle}/${code}.json?v=20261029-i18n`, { headers: { Accept: 'application/json' } });
      if (!fragmentResponse.ok) throw new Error(`No fue posible cargar el fragmento ${bundle}/${code}.`);
      return fragmentResponse.json();
    }));
    for (const fragment of fragments) if (fragment.status === 'fulfilled') mergeMessages(messages, fragment.value);
    this.messages.set(code, messages);
    this.flatMessages.set(code, flattenMessages(messages));
    this.rebuildReverseIndex();
    return messages;
  }

  rebuildReverseIndex() {
    const reverse = new Map(), templates = [];
    const locales = [this.defaultLocale, ...GENTIA_SUPPORTED_LOCALES.map(item => item.code).filter(code => code !== this.defaultLocale)];
    for (const locale of locales) {
      for (const [key, value] of this.flatMessages.get(locale) ?? []) {
        const exact = normalized(value);
        if (!value.includes('{') && exact && !reverse.has(exact)) reverse.set(exact, key);
        const matcher = templateMatcher(key, value);
        if (matcher) templates.push(matcher);
      }
    }
    this.reverseMessages = reverse;
    this.templateMatchers = templates;
  }

  async init(requestedLocale) {
    if (this.initialized) {
      if (requestedLocale) await this.setLocale(requestedLocale);
      return this;
    }
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await this.load(this.defaultLocale);
      await Promise.allSettled(
        GENTIA_SUPPORTED_LOCALES
          .filter(item => item.code !== this.defaultLocale)
          .map(item => this.load(item.code))
      );
      this.installListeners();
      await this.setLocale(requestedLocale ?? this.storedLocale(), { persist: true, broadcast: false });
      this.observe();
      this.initialized = true;
      return this;
    })();
    try { return await this.initializing; }
    finally { this.initializing = null; }
  }

  installListeners() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('storage', this.onStorage);
    window.removeEventListener('message', this.onMessage);
    window.addEventListener('storage', this.onStorage);
    window.addEventListener('message', this.onMessage);
    if ('BroadcastChannel' in window && !this.broadcastChannel) {
      this.broadcastChannel = new BroadcastChannel('gentia-language');
      this.broadcastChannel.onmessage = event => {
        if (event.data?.locale) void this.setLocale(event.data.locale, { persist: true, broadcast: false });
      };
    }
  }

  t(key, parameters = {}, fallback) {
    const primary = resolveTranslation(this.messages.get(this.locale), key);
    const base = resolveTranslation(this.messages.get(this.defaultLocale), key);
    const value = typeof primary === 'string' ? primary : typeof base === 'string' ? base : fallback ?? key;
    return interpolateTranslation(value, parameters);
  }

  bindingFor(source) {
    const value = String(source ?? '').trim();
    const exactKey = this.reverseMessages.get(normalized(value));
    if (exactKey) return { key: exactKey, parameters: {} };
    for (const matcher of this.templateMatchers) {
      const match = value.match(matcher.expression);
      if (!match) continue;
      return { key: matcher.key, parameters: Object.fromEntries(matcher.parameters.map((key, index) => [key, match[index + 1]])) };
    }
    return null;
  }

  translateTextNode(node) {
    const parent = node?.parentElement;
    if (!parent || !canAutoTranslateElement(parent)) return;
    const source = node.nodeValue ?? '';
    if (!source.trim()) return;
    let binding = this.textBindings.get(node);
    if (!binding || (source.trim() !== binding.lastValue && source.trim() !== binding.source)) {
      const detected = this.bindingFor(source);
      if (!detected) return;
      binding = { ...detected, source: source.trim(), lastValue: source.trim() };
    }
    const translated = this.t(binding.key, binding.parameters, binding.source);
    this.textBindings.set(node, { ...binding, lastValue: translated });
    if (source.trim() !== translated) node.nodeValue = preservedWhitespace(source, translated);
  }

  translateAttribute(element, attribute) {
    if (!canAutoTranslateAttribute(element, attribute) || !element.hasAttribute(attribute)) return;
    const source = element.getAttribute(attribute) ?? '';
    if (!source.trim()) return;
    let bindings = this.attributeBindings.get(element);
    if (!bindings) { bindings = new Map(); this.attributeBindings.set(element, bindings); }
    let binding = bindings.get(attribute);
    if (!binding || (source !== binding.lastValue && source !== binding.source)) {
      const detected = this.bindingFor(source);
      if (!detected) return;
      binding = { ...detected, source, lastValue: source };
    }
    const translated = this.t(binding.key, binding.parameters, binding.source);
    bindings.set(attribute, { ...binding, lastValue: translated });
    if (source !== translated) element.setAttribute(attribute, translated);
  }

  translateExplicit(element) {
    if (!canTranslateElement(element)) return;
    const parameters = parseParameters(element);
    if (element.dataset.i18n) element.textContent = this.t(element.dataset.i18n, parameters, element.textContent);
    for (const attribute of translatedAttributes) {
      const dataName = `i18n${attribute.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
      const key = element.dataset[dataName];
      if (key) element.setAttribute(attribute, this.t(key, parameters, element.getAttribute(attribute)));
    }
  }

  translateRoot(root = document) {
    if (!root || typeof document === 'undefined') return;
    const rootElement = root.nodeType === Node.ELEMENT_NODE ? root : null;
    const explicitSelector = '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],[data-i18n-alt]';
    if (rootElement?.matches?.(explicitSelector)) this.translateExplicit(rootElement);
    root.querySelectorAll?.(explicitSelector).forEach(element => this.translateExplicit(element));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) this.translateTextNode(walker.currentNode);
    const attributed = [];
    if (rootElement && translatedAttributes.some(attribute => rootElement.hasAttribute(attribute))) attributed.push(rootElement);
    root.querySelectorAll?.(translatedAttributes.map(attribute => `[${attribute}]`).join(',')).forEach(element => attributed.push(element));
    attributed.forEach(element => translatedAttributes.forEach(attribute => this.translateAttribute(element, attribute)));
  }

  observe() {
    if (typeof document === 'undefined' || !document.documentElement || this.observer) return;
    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') this.translateTextNode(mutation.target);
        else if (mutation.type === 'attributes') {
          if (mutation.attributeName?.startsWith('data-i18n')) this.translateExplicit(mutation.target);
          else this.translateAttribute(mutation.target, mutation.attributeName);
        } else for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) this.translateTextNode(node);
          else if (node.nodeType === Node.ELEMENT_NODE) this.translateRoot(node);
        }
      }
    });
    this.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...translatedAttributes, 'data-i18n', 'data-i18n-placeholder', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-alt', 'data-i18n-params'] });
  }

  async setLocale(locale, options = {}) {
    const requestedCode = normalizeGentiaLocale(locale, this.defaultLocale);
    let code = requestedCode, loadError = null;
    try { await this.load(requestedCode); }
    catch (cause) {
      if (requestedCode === this.defaultLocale) throw cause;
      loadError = cause;
      code = this.defaultLocale;
      await this.load(code);
    }
    this.locale = code;
    if (options.persist !== false) {
      try { globalThis.localStorage?.setItem(this.storageKey, code); } catch { /* Storage can be unavailable. */ }
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = code;
      this.translateRoot(document);
    }
    const detail = {
      locale: code,
      requestedLocale: requestedCode,
      fallback: code !== requestedCode,
      error: loadError instanceof Error ? loadError.message : loadError ? String(loadError) : '',
      language: GENTIA_SUPPORTED_LOCALES.find(item => item.code === code)
    };
    this.dispatchEvent(new CustomEvent('change', { detail }));
    globalThis.window?.dispatchEvent(new CustomEvent('gentia:language-changed', { detail }));
    if (options.broadcast !== false && typeof window !== 'undefined') {
      this.broadcastChannel?.postMessage({ locale: code });
      if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'gentia:language', locale: code }, window.location.origin);
      document.querySelectorAll?.('iframe').forEach(frame => frame.contentWindow?.postMessage({ type: 'gentia:language', locale: code }, window.location.origin));
    }
    return code;
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.broadcastChannel?.close();
    this.broadcastChannel = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage);
      window.removeEventListener('message', this.onMessage);
    }
  }
}

export const gentiaI18n = new GentiaI18n();

if (typeof window !== 'undefined') {
  window.GentiaI18n = gentiaI18n;
  window.gentiaT = (key, parameters, fallback) => gentiaI18n.t(key, parameters, fallback);
  const initialize = () => void gentiaI18n.init().catch(error => console.error('[i18n]', error));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}
