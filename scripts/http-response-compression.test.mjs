import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { json } from '../dist/core/interceptors/http-response.js';

const payload = { rows: Array.from({ length: 250 }, (_, index) => ({ id: index + 1, name: `Subsidiaria ${index + 1}` })) };

async function server(...input) {
  const responsePayload = input.length ? input[0] : payload;
  const instance = createServer((_request, response) => json(response, 200, responsePayload));
  await new Promise((resolve, reject) => instance.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('No fue posible iniciar el servidor de prueba.');
  return { instance, url: `http://127.0.0.1:${address.port}` };
}

function rawRequest(url, acceptEncoding) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { headers: { 'Accept-Encoding': acceptEncoding } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('comprime respuestas JSON grandes cuando el cliente acepta gzip', async t => {
  const fixture = await server();
  t.after(() => fixture.instance.close());
  const raw = await rawRequest(fixture.url, 'gzip');
  assert.equal(raw.headers['content-encoding'], 'gzip');
  assert.match(raw.headers.vary ?? '', /Accept-Encoding/i);
  assert.deepEqual(JSON.parse(gunzipSync(raw.body).toString('utf8')), payload);
});

test('conserva respuesta sin compresión cuando el cliente no acepta gzip', async t => {
  const fixture = await server();
  t.after(() => fixture.instance.close());
  const raw = await rawRequest(fixture.url, 'identity');
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.match(raw.headers.vary ?? '', /Accept-Encoding/i);
  assert.deepEqual(JSON.parse(raw.body.toString('utf8')), payload);
});

test('respeta gzip con calidad cero', async t => {
  const fixture = await server();
  t.after(() => fixture.instance.close());
  const raw = await rawRequest(fixture.url, 'gzip;q=0, identity;q=1');
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(raw.body.toString('utf8')), payload);
});

test('normaliza una respuesta indefinida como JSON null', async t => {
  const fixture = await server(undefined);
  t.after(() => fixture.instance.close());
  const raw = await rawRequest(fixture.url, 'identity');
  assert.equal(raw.body.toString('utf8'), 'null');
});
