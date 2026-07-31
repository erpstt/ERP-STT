import type { ServerResponse } from 'node:http';

export function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export function error(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: { message, status } });
}
