import { performance } from 'node:perf_hooks';

function measure(run) {
  const started = performance.now();
  const value = run();
  return { milliseconds: Number((performance.now() - started).toFixed(2)), value };
}

const count = 8_000;
const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
const links = rows.flatMap(row => [{ owner: row.id, value: row.id % 17 }, { owner: row.id, value: row.id % 23 + 30 }]);

const nestedJoin = measure(() => rows.map(row => links.filter(link => link.owner === row.id).map(link => link.value)).flat().length);
const indexedJoin = measure(() => {
  const index = new Map();
  for (const link of links) {
    const values = index.get(link.owner);
    if (values) values.push(link.value); else index.set(link.owner, [link.value]);
  }
  return rows.map(row => index.get(row.id) ?? []).flat().length;
});

const summaries = rows.map(row => ({ paymentId: row.id, advanceTotal: row.id / 10 }));
const nestedPayments = measure(() => rows.reduce((sum, row) => sum + (summaries.find(item => item.paymentId === row.id)?.advanceTotal ?? 0), 0));
const indexedPayments = measure(() => {
  const index = new Map(summaries.map(item => [item.paymentId, item.advanceTotal]));
  return rows.reduce((sum, row) => sum + (index.get(row.id) ?? 0), 0);
});

if (nestedJoin.value !== indexedJoin.value || nestedPayments.value !== indexedPayments.value) throw new Error('Los resultados del benchmark no coinciden.');

const ratio = (before, after) => Number((before / Math.max(after, 0.01)).toFixed(1));
console.log(JSON.stringify({
  dataset: { rows: count, relations: links.length },
  catalogAssociation: { beforeMs: nestedJoin.milliseconds, afterMs: indexedJoin.milliseconds, speedup: ratio(nestedJoin.milliseconds, indexedJoin.milliseconds) },
  paymentSummaryJoin: { beforeMs: nestedPayments.milliseconds, afterMs: indexedPayments.milliseconds, speedup: ratio(nestedPayments.milliseconds, indexedPayments.milliseconds) }
}, null, 2));
