import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoundedRateLimitState,
  BoundedRateLimitStateError,
  boundedRateLimitKey,
} from '../dist/core/security/bounded-rate-limit-state.js';

assert.deepEqual(process.argv.slice(2), [], 'This pure limiter test accepts no destinations or credentials');

function fixture(options = {}) {
  let now = 0;
  const state = new BoundedRateLimitState({ windowMs: 1_000, attemptLimit: 3, clock: () => now, ...options });
  return { state, setTime: value => { now = value; } };
}

function limited(work, expectedSeconds) {
  assert.throws(work, error => {
    assert.ok(error instanceof BoundedRateLimitStateError);
    assert.equal(error.status, 429);
    assert.ok(Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1);
    if (expectedSeconds !== undefined) assert.equal(error.retryAfterSeconds, expectedSeconds);
    return true;
  });
}

test('assertions and unknown clears never allocate state or consume a budget', () => {
  const { state } = fixture({ maxEntries: 2 });
  for (let i = 0; i < 2_000; i++) {
    state.assertAllowed('synthetic-' + i + '@example.invalid');
    assert.equal(state.clear('synthetic-' + i + '@example.invalid'), false);
  }
  assert.deepEqual(state.getStats(), { entries: 0, capacity: 2, attempts: 0, attemptLimit: 3, windowMs: 1_000 });
});

test('the configured sliding limit rejects excess attempts and expires timestamps at the exact original boundary', () => {
  const { state, setTime } = fixture();
  state.recordAttempt('first');
  setTime(200); state.recordAttempt('first');
  setTime(400); state.recordAttempt('first');
  setTime(999); limited(() => state.assertAllowed('first'), 1); limited(() => state.recordAttempt('first'), 1);
  assert.equal(state.getStats().attempts, 3);
  setTime(1_000); state.assertAllowed('first');
  assert.equal(state.getStats().attempts, 2);
  state.recordAttempt('first');
  limited(() => state.recordAttempt('first'), 1);
  setTime(1_200); state.assertAllowed('first');
  assert.equal(state.getStats().attempts, 2);
});

test('blocked reads and records never renew TTL or grow the timestamp array', () => {
  const { state, setTime } = fixture({ attemptLimit: 1 });
  state.recordAttempt('first');
  for (let i = 1; i <= 100; i++) {
    setTime(i * 9); limited(() => state.assertAllowed('first')); limited(() => state.recordAttempt('first'));
  }
  assert.equal(state.getStats().attempts, 1);
  setTime(1_000); state.assertAllowed('first');
  assert.equal(state.getStats().entries, 0);
  state.recordAttempt('first');
  assert.equal(state.getStats().attempts, 1);
});

test('capacity rejects new identities without evicting active counters and still permits existing budgets', () => {
  const { state } = fixture({ maxEntries: 2 });
  state.recordAttempt('first'); state.recordAttempt('second');
  limited(() => state.assertAllowed('third'), 1); limited(() => state.recordAttempt('third'), 1);
  state.assertAllowed('first'); state.recordAttempt('first'); state.recordAttempt('first');
  limited(() => state.recordAttempt('first'), 1);
  state.assertAllowed('second');
  assert.deepEqual(state.getStats(), { entries: 2, capacity: 2, attempts: 4, attemptLimit: 3, windowMs: 1_000 });
});

test('saturation uses the earliest surviving expiry and exact expiry releases capacity', () => {
  const { state, setTime } = fixture({ windowMs: 15_000, maxEntries: 2 });
  state.recordAttempt('first');
  setTime(1_000); state.recordAttempt('second');
  limited(() => state.recordAttempt('third'), 14);
  setTime(14_999); limited(() => state.assertAllowed('third'), 1);
  setTime(15_000); state.recordAttempt('third');
  assert.equal(state.getStats().entries, 2);
  setTime(16_000); state.assertAllowed('fourth');
  assert.equal(state.getStats().entries, 1);
});

test('accepted renewal preserves expiry order and never hides an older expired identity behind an active one', () => {
  const { state, setTime } = fixture({ maxEntries: 2 });
  state.recordAttempt('first');
  setTime(100); state.recordAttempt('second');
  setTime(900); state.recordAttempt('first');
  setTime(1_100); state.recordAttempt('third');
  assert.equal(state.getStats().entries, 2);
  assert.equal(state.getStats().attempts, 3);
  setTime(1_899); limited(() => state.assertAllowed('fourth'), 1);
  setTime(1_900); state.recordAttempt('fourth');
  assert.equal(state.getStats().entries, 2);
});

test('cleanup removes only one bounded batch and later operations finish expiry without scanning the full store', () => {
  const { state, setTime } = fixture({ maxEntries: 40 });
  for (let i = 0; i < 40; i++) state.recordAttempt('synthetic-' + i);
  setTime(1_000); state.assertAllowed('unknown');
  assert.equal(state.getStats().entries, 8);
  assert.equal(state.getStats().attempts, 8);
  state.assertAllowed('another-unknown');
  assert.equal(state.getStats().entries, 0);
  assert.equal(state.getStats().attempts, 0);
});

test('a requested expired identity beyond the cleanup batch is removed with bounded direct lookup', () => {
  const { state, setTime } = fixture({ maxEntries: 40, cleanupBatchSize: 2 });
  for (let i = 0; i < 40; i++) state.recordAttempt('synthetic-' + i);
  setTime(1_000); state.assertAllowed('synthetic-39');
  assert.equal(state.getStats().entries, 37);
  assert.equal(state.getStats().attempts, 37);
  state.recordAttempt('fresh');
  assert.equal(state.getStats().entries, 36);
});

test('clearing one identity preserves every other identity and never clears a shared store implicitly', () => {
  const { state } = fixture({ maxEntries: 2, attemptLimit: 1 });
  state.recordAttempt('first'); state.recordAttempt('second');
  assert.equal(state.clear('first'), true);
  assert.equal(state.clear('first'), false);
  state.assertAllowed('first'); limited(() => state.assertAllowed('second'));
  assert.equal(state.getStats().entries, 1);
  assert.equal(state.getStats().attempts, 1);
  state.recordAttempt('third');
  limited(() => state.recordAttempt('second'));
});

test('backward clock movement cannot renew a budget earlier or bypass a lock', () => {
  const { state, setTime } = fixture({ attemptLimit: 2 });
  setTime(500); state.recordAttempt('first');
  setTime(400); state.recordAttempt('first');
  setTime(0); limited(() => state.assertAllowed('first'), 1);
  setTime(1_499); limited(() => state.recordAttempt('first'), 1);
  setTime(1_500); state.assertAllowed('first');
  assert.equal(state.getStats().entries, 0);
});

test('all five existing policies can share the mechanism without changing their limit or window', () => {
  for (const [windowMs, attemptLimit] of [[3_600_000, 3], [900_000, 10], [900_000, 10], [900_000, 3], [900_000, 20]]) {
    const { state, setTime } = fixture({ windowMs, attemptLimit });
    for (let i = 0; i < attemptLimit; i++) state.recordAttempt('synthetic');
    limited(() => state.recordAttempt('synthetic'), windowMs / 1_000);
    assert.equal(state.getStats().attempts, attemptLimit);
    setTime(windowMs); state.recordAttempt('synthetic');
    assert.equal(state.getStats().attempts, 1);
  }
});

test('keys are fixed-length digests and public metrics and errors never contain the synthetic IP or email', () => {
  const identity = '203.0.113.17|SYNTHETIC_PRIVATE_EMAIL@example.invalid';
  const key = boundedRateLimitKey(identity);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(boundedRateLimitKey(identity), key);
  assert.notEqual(boundedRateLimitKey(identity + 'other'), key);
  const { state } = fixture({ maxEntries: 1, attemptLimit: 1 });
  state.recordAttempt(identity);
  for (const target of [identity, 'other']) {
    assert.throws(() => state.recordAttempt(target), error => {
      assert.ok(error instanceof BoundedRateLimitStateError);
      assert.ok(!error.message.includes(identity));
      assert.ok(!error.message.includes(key));
      return true;
    });
  }
  assert.ok(Object.values(state.getStats()).every(value => typeof value === 'number'));
  assert.ok(!JSON.stringify(state.getStats()).includes(identity));
});

test('invalid and oversized identities share one bounded conservative budget without object coercion', () => {
  const hostile = new Proxy({}, { get() { throw Error('No object property may be read'); } });
  const invalid = [undefined, null, '', 42, 1n, Symbol('synthetic'), hostile, 'x'.repeat(1_025), 'y'.repeat(16_384)];
  const { state } = fixture({ attemptLimit: 1 });
  state.recordAttempt(invalid[0]);
  for (const identity of invalid) {
    assert.equal(boundedRateLimitKey(identity), boundedRateLimitKey(undefined));
    limited(() => state.recordAttempt(identity));
  }
  assert.equal(state.getStats().entries, 1);
  assert.equal(state.getStats().attempts, 1);
  assert.notEqual(boundedRateLimitKey('x'.repeat(1_024)), boundedRateLimitKey(undefined));
});

test('invalid capacities, limits, cleanup budgets and clocks fail without allocating entries', () => {
  for (const options of [
    { windowMs: 0 }, { windowMs: NaN }, { windowMs: 86_400_001 },
    { attemptLimit: 0 }, { attemptLimit: 101 }, { attemptLimit: 1.5 },
    { maxEntries: 0 }, { maxEntries: 5_001 },
    { cleanupBatchSize: 0 }, { cleanupBatchSize: 129 }, { clock: 'synthetic' },
  ]) assert.throws(() => fixture(options), RangeError);
  const { state, setTime } = fixture();
  for (const timestamp of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    setTime(timestamp);
    assert.throws(() => state.assertAllowed('synthetic'), RangeError);
    assert.throws(() => state.recordAttempt('synthetic'), RangeError);
  }
  assert.equal(state.getStats().entries, 0);
  assert.equal(state.getStats().attempts, 0);
});
