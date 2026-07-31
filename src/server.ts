import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { authController } from './modules/auth/auth.module.js';
import { error, json } from './core/interceptors/http-response.js';

const publicDir = join(process.cwd(), 'public');
const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw || '{}');
}

async function serveFile(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(publicDir, relative));
  if (!file.startsWith(publicDir)) return error(response, 403, 'Acceso denegado.');
  try {
    await stat(file);
    const extension = file.slice(file.lastIndexOf('.'));
    response.writeHead(200, { 'Content-Type': `${mime[extension] ?? 'application/octet-stream'}; charset=utf-8` });
    createReadStream(file).pipe(response);
  } catch { error(response, 404, 'Recurso no encontrado.'); }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/api/auth/login') {
      const result = await authController.signIn(await body(request) as { email: string; password: string });
      return json(response, 200, result);
    }
    await serveFile(request.url?.split('?')[0] ?? '/', response);
  } catch (cause) {
    error(response, 400, cause instanceof Error ? cause.message : 'No fue posible procesar la solicitud.');
  }
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log('Nexo ERP disponible en http://localhost:3000'));
