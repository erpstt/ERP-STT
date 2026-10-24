import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIndexedLookup,
  createLatestRequest,
  indexBy,
  mapWithConcurrency,
  sameRequestParameters
} from '../public/frontend-performance.js';
import { agingCurrencyBreakdown } from '../public/accounting-aging-report.js';

test('indexBy and createIndexedLookup resolve catalog joins in constant time', () => {
  const rows = Array.from({ length: 10_000 }, (_, id) => ({ id, code: `C-${id}` }));
  const byId = indexBy(rows, row => row.id);
  assert.equal(byId.size, 10_000);
  assert.equal(byId.get('9374')?.code, 'C-9374');

  const find = createIndexedLookup();
  assert.equal(find(rows, 'id', 7500)?.code, 'C-7500');
  assert.equal(find(rows, 'code', 'C-125')?.id, 125);
  assert.equal(find(undefined, 'id', 1), undefined);
});

test('mapWithConcurrency preserves order and caps simultaneous work', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(
    Array.from({ length: 18 }, (_, index) => index),
    3,
    async value => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    }
  );

  assert.equal(peak, 3);
  assert.deepEqual(result, Array.from({ length: 18 }, (_, index) => index * 2));
});

test('mapWithConcurrency stops scheduling new work after the first failure', async () => {
  const started = [];
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  await assert.rejects(
    mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async value => {
        started.push(value);
        if (value === 0) {
          await delay(2);
          throw new Error('controlled failure');
        }
        await delay(15);
        return value;
      }
    ),
    /controlled failure/
  );

  await delay(25);
  assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 2]);
});

test('sameRequestParameters compares nested filters independently of key order', () => {
  const loaded = { page: 1, subsidiaryIds: [7], nested: { to: '2026-10-31', pending: true } };
  const current = { nested: { pending: true, to: '2026-10-31' }, subsidiaryIds: [7], page: 1 };

  assert.equal(sameRequestParameters(loaded, current), true);
  assert.equal(sameRequestParameters(loaded, { ...current, subsidiaryIds: [8] }), false);
  assert.equal(sameRequestParameters(loaded, { ...current, page: 2 }), false);
});

test('createLatestRequest aborts stale work and tracks only the latest request', () => {
  const coordinator = createLatestRequest();
  const first = coordinator.begin();
  const second = coordinator.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);

  coordinator.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test('aging currency metadata keeps the existing report contract with indexed catalogs', () => {
  const breakdown = agingCurrencyBreakdown({
    currencyMode: 'ORIGINAL',
    options: {
      currencies: [{ id: 1, code: 'JMD', name: 'Dólar jamaicano', symbol: 'J$' }],
      subsidiaries: [{ id: 7, currencyId: 1 }]
    },
    data: {
      summary: {
        currencyBreakdown: [{ currency_id: 1, subledger: 120, advances: 20, netBalance: 100, controlBalance: 100, difference: 0 }]
      }
    }
  });

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].currency.code, 'JMD');
  assert.equal(breakdown[0].currency.symbol, 'J$');
  assert.equal(breakdown[0].netBalance, 100);
  assert.equal(breakdown[0].reconciliationAvailable, true);
});
