import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Identity is resolved by PostgreSQL from authenticated credentials, never HTTP input.
const execution = new AsyncLocalStorage<string>();
export function withAuditExecution<T>(work: () => T): T {
  return execution.run(randomUUID(), work);
}

export function auditRequestHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  for (const key of [...headers.keys()]) {
    if (key.startsWith('x-audit-')) headers.delete(key);
  }
  headers.set('x-audit-execution-context-id', execution.getStore() ?? randomUUID());
  return headers;
}
