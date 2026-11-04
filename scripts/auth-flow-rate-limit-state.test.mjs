import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { BoundedRateLimitState, BoundedRateLimitStateError } from '../dist/core/security/bounded-rate-limit-state.js';

assert.deepEqual(process.argv.slice(2), [], 'This isolated test accepts no destinations or credentials');

const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalLoadEnvFile = process.loadEnvFile;
const originalRecord = BoundedRateLimitState.prototype.recordAttempt;
const originalCreateTransport = nodemailer.createTransport;
const syntheticEnvironment = {};
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP']) {
  if (originalEnvironment[name] !== undefined) syntheticEnvironment[name] = originalEnvironment[name];
}
Object.assign(syntheticEnvironment, {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_ANON_KEY: 'p111-synthetic-public',
  SUPABASE_PUBLISHABLE_KEY: 'p111-synthetic-public',
  SUPABASE_SERVICE_ROLE_KEY: 'p111-synthetic-service',
  GENTIA_APP_URL: 'https://p111-app.example.invalid',
  DISABLE_BACKGROUND_JOBS: 'true',
  EMAIL_NOTIFICATIONS_ENABLED: 'false',
});
process.env = { ...syntheticEnvironment };
process.loadEnvFile = () => { throw Error('Environment-file access is disabled in this synthetic fixture'); };
globalThis.fetch = async () => { throw Error('Fetch is disabled during synthetic module initialization'); };
nodemailer.createTransport = () => { throw Error('SMTP is disabled during synthetic module initialization'); };
const recovery = await import('../dist/modules/auth/services/password-recovery.service.js');
const provisioning = await import('../dist/modules/auth/services/user-provisioning.service.js');
process.env = originalEnvironment;
globalThis.fetch = originalFetch;
nodemailer.createTransport = originalCreateTransport;

let now = 1_700_000_000_000;
let testNumber = 0;
let unexpectedIO = [];
test.beforeEach(() => {
  now = 1_700_000_000_000 + testNumber++ * 86_400_000;
  process.env = { ...syntheticEnvironment };
  Date.now = () => now;
  BoundedRateLimitState.prototype.recordAttempt = originalRecord;
  unexpectedIO = [];
  globalThis.fetch = async () => { unexpectedIO.push('fetch'); throw Error('Unexpected synthetic fetch'); };
  nodemailer.createTransport = () => { unexpectedIO.push('SMTP'); throw Error('SMTP is disabled in this synthetic fixture'); };
});
test.afterEach(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  BoundedRateLimitState.prototype.recordAttempt = originalRecord;
  nodemailer.createTransport = originalCreateTransport;
  assert.deepEqual(unexpectedIO, []);
});
test.after(() => { process.loadEnvFile = originalLoadEnvFile; });

const hash = value => createHash('sha256').update(value).digest('hex');
const actorId = 19;
const targetId = 17;
function notificationProvider(events, { missingAccount = false, denyPrepare = false } = {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, syntheticEnvironment.SUPABASE_URL);
    if (url.pathname === '/rest/v1/rpc/security_prepare_user_password_recovery') {
      events.push('prepare');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { p_user_id: targetId });
      return denyPrepare ? Response.json({ message: 'Synthetic permission denied' }, { status: 403 }) : Response.json({
        actor_user_id: actorId, user_id: targetId, subsidiary_id: 1,
        email: 'p111-target@example.invalid', first_name: 'Synthetic', last_name: 'Target',
      });
    }
    if (url.pathname === '/rest/v1/rpc/security_audit_user_password_notification') {
      events.push('audit');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        p_actor_user_id: actorId, p_target_user_id: targetId, p_subsidiary_id: 1, p_result: 'ERROR',
      });
      return Response.json(true);
    }
    if (missingAccount && url.pathname === '/rest/v1/users') {
      events.push('account');
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(url.searchParams.get('user_id'), 'eq.' + targetId);
      return Response.json([]);
    }
    unexpectedIO.push('unexpected-provider-path');
    throw Error('Unexpected synthetic provider path');
  };
}

function injectedFailure(failure, events = []) {
  const calls = [];
  BoundedRateLimitState.prototype.recordAttempt = function (identity, timestamp) {
    events.push('limit');
    calls.push({ identity, timestamp, ...this.getStats() });
    throw failure;
  };
  return calls;
}

const publicFlows = [
  {
    name: 'recovery request', windowMs: 3_600_000, limit: 3,
    identity: '203.0.113.1|' + hash('p111-user@example.invalid'),
    run: () => recovery.requestPasswordRecovery({ email: ' P111-USER@example.invalid ' }, '203.0.113.1'),
    ErrorType: recovery.PasswordRecoveryError,
    message: 'Se realizaron demasiados intentos. Intente nuevamente en 2 minuto(s).',
  },
  {
    name: 'recovery completion', windowMs: 900_000, limit: 10, identity: '203.0.113.2',
    run: () => recovery.completePasswordRecovery(undefined, {}, '203.0.113.2'),
    ErrorType: recovery.PasswordRecoveryError,
    message: 'Se realizaron demasiados intentos. Intente nuevamente en 2 minuto(s).',
  },
  {
    name: 'invitation completion', windowMs: 900_000, limit: 10, identity: '203.0.113.3',
    run: () => provisioning.completePasswordInvitation(undefined, {}, '203.0.113.3'),
    ErrorType: provisioning.UserProvisioningError,
    message: 'Demasiados intentos de activación. Intente nuevamente en 2 minuto(s).',
  },
  {
    name: 'password access continuation', windowMs: 900_000, limit: 20, identity: '203.0.113.4',
    run: () => provisioning.validatePasswordAccessContinuation({}, '203.0.113.4'),
    ErrorType: provisioning.UserProvisioningError,
    message: 'Demasiados intentos de verificación. Solicite un enlace nuevo e inténtelo más tarde.',
  },
];

for (const flow of publicFlows) test(flow.name + ' preserves its instance policy, explicit clock, original 429 and no-IO ordering', async () => {
  const calls = injectedFailure(new BoundedRateLimitStateError(61));
  await assert.rejects(flow.run, error => {
    assert.ok(error instanceof flow.ErrorType);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 61);
    assert.equal(error.message, flow.message);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identity, flow.identity);
  assert.equal(calls[0].timestamp, now);
  assert.equal(calls[0].windowMs, flow.windowMs);
  assert.equal(calls[0].attemptLimit, flow.limit);
  assert.equal(calls[0].capacity, 5_000);
});

test('notification throttling remains after actor authorization and before account, Auth or SMTP operations', async () => {
  const events = [];
  notificationProvider(events);
  const calls = injectedFailure(new BoundedRateLimitStateError(61), events);
  await assert.rejects(() => provisioning.sendExistingUserPasswordLink('Bearer p111-synthetic-actor', targetId), error => {
    assert.ok(error instanceof provisioning.UserProvisioningError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 61);
    assert.equal(error.message, 'Se enviaron demasiados enlaces. Intente nuevamente en 2 minuto(s).');
    return true;
  });
  assert.deepEqual(events, ['prepare', 'limit', 'audit']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identity, actorId + '|' + targetId);
  assert.equal(calls[0].timestamp, now);
  assert.equal(calls[0].windowMs, 900_000);
  assert.equal(calls[0].attemptLimit, 3);
  assert.equal(calls[0].capacity, 5_000);
});

test('invalid request email and invalid or unauthorized notification targets still fail before consuming any budget', async () => {
  const events = [];
  notificationProvider(events, { denyPrepare: true });
  const calls = injectedFailure(new BoundedRateLimitStateError(61), events);
  await assert.rejects(() => recovery.requestPasswordRecovery({ email: 'invalid' }, '203.0.113.5'), error => error instanceof recovery.PasswordRecoveryError && error.status === 400);
  await assert.rejects(() => provisioning.sendExistingUserPasswordLink('Bearer p111-synthetic-actor', 0), error => error instanceof provisioning.UserProvisioningError && error.status === 400);
  await assert.rejects(() => provisioning.sendExistingUserPasswordLink('Bearer p111-synthetic-actor', targetId), error => error instanceof provisioning.UserProvisioningError && error.status === 403);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, ['prepare']);
});

test('unexpected helper failures propagate unchanged, including the existing notification audit path', async () => {
  const unexpected = new Error('P111_SYNTHETIC_UNEXPECTED_HELPER_FAILURE');
  const events = [];
  notificationProvider(events);
  const calls = injectedFailure(unexpected, events);
  for (const flow of publicFlows) await assert.rejects(flow.run, error => error === unexpected);
  await assert.rejects(() => provisioning.sendExistingUserPasswordLink('Bearer p111-synthetic-actor', targetId), error => error === unexpected);
  assert.equal(calls.length, 5);
  assert.deepEqual(events, ['limit', 'limit', 'limit', 'limit', 'prepare', 'limit', 'audit']);
});

test('missing IP addresses retain the original shared unknown identity for all public flows', async () => {
  const calls = injectedFailure(new BoundedRateLimitStateError(1));
  const work = [
    () => recovery.requestPasswordRecovery({ email: 'unknown@example.invalid' }),
    () => recovery.completePasswordRecovery(undefined, {}),
    () => provisioning.completePasswordInvitation(undefined, {}),
    () => provisioning.validatePasswordAccessContinuation({}),
  ];
  for (const run of work) await assert.rejects(run, error => error.status === 429 && error.retryAfterSeconds === 1);
  assert.deepEqual(calls.map(call => call.identity), ['unknown|' + hash('unknown@example.invalid'), 'unknown', 'unknown', 'unknown']);
});

test('real recovery request state consumes three attempts before configuration and releases at the one-hour boundary', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const run = () => recovery.requestPasswordRecovery({ email: 'budget-request@example.invalid' }, '203.0.113.20');
  const start = now;
  for (let i = 0; i < 3; i++) await assert.rejects(run, error => error instanceof recovery.PasswordRecoveryError && error.status === 503);
  await assert.rejects(run, error => error instanceof recovery.PasswordRecoveryError && error.status === 429 && error.retryAfterSeconds === 3_600);
  now = start + 3_600_000 - 1;
  await assert.rejects(run, error => error.status === 429 && error.retryAfterSeconds === 1);
  now = start + 3_600_000;
  await assert.rejects(run, error => error instanceof recovery.PasswordRecoveryError && error.status === 503);
});

for (const flow of [
  { name: 'recovery completion', limit: 10, status: 401, run: () => recovery.completePasswordRecovery(undefined, {}, '203.0.113.21') },
  { name: 'invitation completion', limit: 10, status: 401, run: () => provisioning.completePasswordInvitation(undefined, {}, '203.0.113.22') },
  { name: 'password access continuation', limit: 20, status: 400, run: () => provisioning.validatePasswordAccessContinuation({}, '203.0.113.23') },
]) test('real ' + flow.name + ' state retains its budget, denial and exact fifteen-minute boundary before IO', async () => {
  const start = now;
  for (let i = 0; i < flow.limit; i++) await assert.rejects(flow.run, error => error.status === flow.status);
  await assert.rejects(flow.run, error => error.status === 429 && error.retryAfterSeconds === 900);
  now = start + 900_000 - 1;
  await assert.rejects(flow.run, error => error.status === 429 && error.retryAfterSeconds === 1);
  now = start + 900_000;
  await assert.rejects(flow.run, error => error.status === flow.status);
});

test('real notification state allows three authorized attempts and throttles later attempts before account lookup', async () => {
  const events = [];
  notificationProvider(events, { missingAccount: true });
  const run = () => provisioning.sendExistingUserPasswordLink('Bearer p111-synthetic-actor', targetId);
  const start = now;
  for (let i = 0; i < 3; i++) await assert.rejects(run, error => error instanceof provisioning.UserProvisioningError && error.status === 409);
  await assert.rejects(run, error => error instanceof provisioning.UserProvisioningError && error.status === 429 && error.retryAfterSeconds === 900);
  assert.deepEqual(events, ['prepare', 'account', 'audit', 'prepare', 'account', 'audit', 'prepare', 'account', 'audit', 'prepare', 'audit']);
  now = start + 900_000 - 1;
  await assert.rejects(run, error => error.status === 429 && error.retryAfterSeconds === 1);
  assert.deepEqual(events.slice(-2), ['prepare', 'audit']);
  now = start + 900_000;
  await assert.rejects(run, error => error.status === 409);
  assert.deepEqual(events.slice(-3), ['prepare', 'account', 'audit']);
});
