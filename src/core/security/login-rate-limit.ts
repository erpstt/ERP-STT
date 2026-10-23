type Attempt = { failures: number[]; lockedUntil: number };
const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export class LoginRateLimitError extends Error {
  readonly status = 429;
  constructor(readonly retryAfterSeconds: number) {
    super(`Demasiados intentos de acceso. Intente nuevamente en ${Math.ceil(retryAfterSeconds / 60)} minuto(s).`);
    this.name = 'LoginRateLimitError';
  }
}

function key(ip: string | null | undefined, email: unknown) {
  const address = ip || 'unknown';
  const account = typeof email === 'string' ? email.trim().toLowerCase() : 'unknown';
  return `${address}|${account}`;
}

function current(entry: Attempt | undefined, now: number): Attempt {
  return entry
    ? { ...entry, failures: entry.failures.filter(timestamp => now - timestamp < WINDOW_MS) }
    : { failures: [], lockedUntil: 0 };
}

export function assertLoginAllowed(ip: string | null | undefined, email: unknown, now = Date.now()) {
  const entry = current(attempts.get(key(ip, email)), now);
  if (entry.lockedUntil > now) throw new LoginRateLimitError(Math.ceil((entry.lockedUntil - now) / 1000));
  attempts.set(key(ip, email), entry);
}

export function recordLoginFailure(ip: string | null | undefined, email: unknown, now = Date.now()) {
  const id = key(ip, email);
  const entry = current(attempts.get(id), now);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) entry.lockedUntil = now + LOCK_MS;
  attempts.set(id, entry);
}

export function clearLoginFailures(ip: string | null | undefined, email: unknown) {
  attempts.delete(key(ip, email));
}
