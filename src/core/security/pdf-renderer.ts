import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import sanitizeHtml from 'sanitize-html';

export class PdfRenderError extends Error {
  constructor(message = 'No fue posible generar el PDF de forma segura. Intente nuevamente.', readonly status = 503) {
    super(message); this.name = 'PdfRenderError';
  }
}

/** Entrega el cupo al siguiente solicitante sin permitir que otra solicitud lo ocupe. */
export class PdfRenderGate {
  private active = 0;
  private readonly waiting: Array<{ resolve: (release: () => void) => void; timer: NodeJS.Timeout }> = [];
  constructor(private readonly concurrency: number, private readonly capacity: number, private readonly waitMs = 30_000) {}
  acquire(): Promise<() => void> {
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(this.lease()); }
    if (this.waiting.length >= this.capacity) return Promise.reject(new PdfRenderError('El generador PDF está ocupado. Intente nuevamente en unos momentos.'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new PdfRenderError('La espera para generar el PDF excedió el límite. Intente nuevamente.'));
      }, this.waitMs) };
      this.waiting.push(entry);
    });
  }
  private lease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) { clearTimeout(next.timer); next.resolve(this.lease()); }
      else this.active--;
    };
  }
}

const configuredConcurrency = Number(process.env.PDF_RENDER_CONCURRENCY ?? 2);
const gate = new PdfRenderGate(Number.isInteger(configuredConcurrency) ? Math.min(4, Math.max(1, configuredConcurrency)) : 2, 8);
const raster = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/i;

/** Solo estilos locales e imágenes raster embebidas; ninguna URL externa o de archivo. */
export function preparePdfHtml(html: string): string {
  if (!/^<!doctype html>/i.test(html) || Buffer.byteLength(html, 'utf8') > 4_000_000) {
    throw new PdfRenderError('El contenido del reporte PDF no es válido.', 400);
  }
  const clean = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'html', 'head', 'body', 'style', 'img', 'header', 'footer', 'section', 'main'],
    allowedAttributes: { '*': ['class', 'style'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], col: ['span', 'style'], img: ['src', 'alt', 'width', 'height'], a: ['href'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    allowVulnerableTags: true, // CSS se conserva; CSP y la interceptación impiden cargar recursos.
    transformTags: { img: (_tag, attributes) => ({ tagName: 'img', attribs: raster.test(attributes.src ?? '') ? attributes : { alt: attributes.alt ?? '' } }) },
  }).replace(/<\/?(?:html|head|body)(?:\s[^>]*)?>/gi, '');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"></head><body>' + clean + '</body></html>';
}

/** No hereda claves, SMTP, tokens, configuración de proxy o credenciales de la aplicación. */
export function pdfProcessEnvironment(profile: string): NodeJS.ProcessEnv {
  const home = join(profile, 'home');
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'), TMP: profile, TEMP: profile, TMPDIR: profile, LANG: 'en_US.UTF-8' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'PATH', 'Path']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function executable(): Promise<string> {
  const configured = process.env.CHROME_PATH;
  const candidates = configured ? [configured] : process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { await access(candidate); return candidate; } catch {}
  }
  throw new PdfRenderError('El servicio PDF seguro no está disponible. Contacte al administrador.');
}

type ProtocolResult = Record<string, any>;
class ChromeProtocol {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: ProtocolResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as ProtocolResult;
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new PdfRenderError()); else request.resolve(message.result ?? {});
      } else if (message.method === 'Fetch.requestPaused') {
        // Todas las solicitudes se bloquean, incluidos loopback, IP literales, file y redes internas.
        void this.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(() => {});
      }
    });
    const disconnected = () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new PdfRenderError()); }
      this.pending.clear();
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
  }
  static async connect(url: string): Promise<ChromeProtocol> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new PdfRenderError()); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new PdfRenderError()); }, { once: true });
    });
    return new ChromeProtocol(socket);
  }
  send(method: string, params: ProtocolResult = {}, sessionId?: string): Promise<ProtocolResult> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new PdfRenderError()); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new PdfRenderError()); }
    });
  }
  close() { this.socket.close(); }
}

export async function renderSafePdf(html: string): Promise<Buffer> {
  const content = preparePdfHtml(html), chrome = await executable(), release = await gate.acquire();
  let profile: string | undefined, child: ReturnType<typeof spawn> | undefined, protocol: ChromeProtocol | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let stage = 'launch';
  try {
    profile = await mkdtemp(join(tmpdir(), 'gentia-pdf-'));
    await mkdir(join(profile, 'home', 'AppData', 'Local'), { recursive: true });
    await mkdir(join(profile, 'home', 'AppData', 'Roaming'), { recursive: true });
    child = spawn(chrome, ['--headless', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', 'about:blank'], {
      windowsHide: true, env: pdfProcessEnvironment(profile), stdio: 'ignore',
    });
    let failed = false;
    child.once('error', () => { failed = true; });
    deadline = setTimeout(() => { failed = true; protocol?.close(); child?.kill(); }, 60_000);
    let endpoint = '';
    for (let attempt = 0; attempt < 150; attempt++) {
      if (failed || child.exitCode !== null) throw new PdfRenderError();
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && path.startsWith('/devtools/browser/')) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!endpoint) throw new PdfRenderError();
    stage = 'connect';
    protocol = await ChromeProtocol.connect(endpoint);
    stage = 'create-target';
    const { targetId } = await protocol.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await protocol.send('Target.attachToTarget', { targetId, flatten: true });
    stage = 'configure-target';
    await protocol.send('Page.enable', {}, sessionId);
    await protocol.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
    await protocol.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await protocol.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    stage = 'frame';
    const { frameTree } = await protocol.send('Page.getFrameTree', {}, sessionId);
    // Documento en about:blank: nunca se abre un archivo local ni una URL suministrada por el usuario.
    stage = 'content';
    await protocol.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: content }, sessionId);
    stage = 'print';
    const result = await protocol.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false }, sessionId);
    const pdf = Buffer.from(result.data, 'base64');
    if (pdf.subarray(0, 4).toString() !== '%PDF') throw new PdfRenderError();
    return pdf;
  } catch (cause) {
    if (process.env.PDF_RENDER_DIAGNOSTICS === 'true') {
      console.error('[PDF]', stage, child?.exitCode, cause instanceof Error ? cause.name : 'Error');
    }
    if (cause instanceof PdfRenderError) throw cause;
    throw new PdfRenderError();
  } finally {
    if (deadline) clearTimeout(deadline);
    if (protocol) { await protocol.send('Browser.close').catch(() => {}); protocol.close(); }
    if (child && child.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child?.kill(); resolve(); }, 3_000);
        child!.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (profile && dirname(profile) === tmpdir()) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    release();
  }
}
