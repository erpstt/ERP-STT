import type { ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';

const compressionThresholdBytes = 1_024;

function acceptsGzip(value: string) {
  let wildcard: boolean | undefined;
  for (const item of value.split(',')) {
    const [rawEncoding, ...rawParameters] = item.trim().split(';');
    const encoding = rawEncoding.trim().toLowerCase();
    const qualityParameter = rawParameters.find(parameter => /^\s*q\s*=/i.test(parameter));
    const quality = qualityParameter ? Number(qualityParameter.split('=')[1]?.trim()) : 1;
    const accepted = Number.isFinite(quality) && quality > 0;
    if (encoding === 'gzip') return accepted;
    if (encoding === '*') wildcard = accepted;
  }
  return wildcard ?? false;
}

function send(response: ServerResponse, status: number, payload: Buffer, headers: Record<string, string>) {
  if (response.destroyed) return;
  response.writeHead(status, { ...headers, 'Content-Length': String(payload.byteLength) });
  response.end(payload);
}

export function json(response: ServerResponse, status: number, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload) ?? 'null');
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const acceptedEncoding = String(response.req?.headers['accept-encoding'] ?? '');
  if (bytes.byteLength < compressionThresholdBytes) {
    send(response, status, bytes, headers);
    return;
  }
  if (!acceptsGzip(acceptedEncoding)) {
    send(response, status, bytes, { ...headers, Vary: 'Accept-Encoding' });
    return;
  }
  gzip(bytes, { level: 6 }, (cause, compressed) => {
    if (cause) {
      send(response, status, bytes, { ...headers, Vary: 'Accept-Encoding' });
      return;
    }
    send(response, status, compressed, {
      ...headers,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding'
    });
  });
}

export function error(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: { message, status } });
}
