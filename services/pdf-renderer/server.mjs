import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { renderSafePdf } from '../../dist/core/security/pdf-renderer.js';

const MAX_BODY = 6 * 1024 * 1024;
const MAX_PDF = 24 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();
const sample = '<!doctype html><html><body><p>GENTIA sandbox readiness check</p></body></html>';

/** Solo recibe contenido generado por el ERP mediante una credencial privada independiente. */
export function createPdfWorker({ token, render = renderSafePdf }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error('Configure un token de renderer válido.');
  const expected = digest(token);
  let state = 'starting';
  const ready = Promise.resolve().then(() => render(sample)).then(pdf => {
    if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 4).toString() !== '%PDF') throw Error('Invalid readiness result');
    state = 'ready';
  }).catch(() => { state = 'blocked'; });
  const reply = (response, status, error) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error }));
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(state === 'ready' ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: state, sandboxRequired: true })); return;
    }
    if (request.url !== '/render') { reply(response, 404, 'Ruta no disponible.'); request.resume(); return; }
    const authorization = request.headers.authorization ?? '';
    const provided = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization)?.[1];
    if (!provided || !timingSafeEqual(digest(provided), expected)) { reply(response, 401, 'No autorizado.'); request.resume(); return; }
    if (request.method !== 'POST') { reply(response, 405, 'Método no permitido.'); request.resume(); return; }
    if (state !== 'ready') { reply(response, 503, 'El renderer seguro no está listo.'); request.resume(); return; }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { reply(response, 415, 'Se requiere JSON.'); request.resume(); return; }
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) { reply(response, 413, 'Solicitud demasiado grande.'); request.resume(); return; }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { reply(response, 413, 'Solicitud demasiado grande.'); request.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(response, 400, 'JSON inválido.'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.html !== 'string') { reply(response, 400, 'Contenido no válido.'); return; }
      const pdf = await render(body.html);
      if (!Buffer.isBuffer(pdf) || pdf.length > MAX_PDF || pdf.subarray(0, 4).toString() !== '%PDF') throw Error('Invalid PDF result');
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(pdf);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) reply(response, [400, 413, 503].includes(error?.status) ? error.status : 503, 'No fue posible generar el PDF seguro.');
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return { server, ready, getState: () => state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) throw Error('El renderer debe ejecutarse sin root.');
    for (const name of Object.keys(process.env)) {
      if (/^(?:SUPABASE_|SMTP_|BCCR_|DATABASE_URL$|PGPASSWORD$)/.test(name)) throw Error('El renderer no debe recibir credenciales del ERP.');
    }
    const { server, ready, getState } = createPdfWorker({ token: process.env.PDF_RENDERER_TOKEN });
    server.listen(Number(process.env.PORT ?? 8080), process.env.BIND_HOST ?? '::', () => console.log('[PDF renderer] listening; readiness requires sandbox'));
    void ready.then(async () => {
      // Solo estado operativo; no registrar documentos, tokens o errores internos de Chrome.
      console.log('[PDF renderer] sandbox readiness:', getState());
    });
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close); process.on('SIGINT', close);
  } catch { console.error('[PDF renderer] invalid isolation or startup configuration'); process.exitCode = 1; }
}
