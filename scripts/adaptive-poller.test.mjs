import test from 'node:test';
import assert from 'node:assert/strict';
import { pollMilliseconds, startAdaptivePoller } from '../dist/core/runtime/adaptive-poller.js';

test('normaliza el intervalo configurable dentro de límites seguros', () => {
  assert.equal(pollMilliseconds(undefined), 30000);
  assert.equal(pollMilliseconds('100'), 5000);
  assert.equal(pollMilliseconds('900000'), 300000);
  assert.equal(pollMilliseconds('invalido'), 30000);
});

test('vacía trabajo activo rápido, espera al quedar vacío y nunca solapa ciclos', async () => {
  const starts = [];
  let calls = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  let stop = () => {};
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('El sondeo adaptativo no terminó a tiempo.')); }, 500);
    stop = startAdaptivePoller(async () => {
      starts.push(Date.now());
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise(done => setTimeout(done, 15));
      concurrent -= 1;
      calls += 1;
      if (calls === 3) {
        clearTimeout(timeout);
        stop();
        resolve();
      }
      return calls === 1;
    }, {activeMilliseconds: 10, idleMilliseconds: 60});
  });
  assert.equal(maximumConcurrent, 1);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] < 50, 'el segundo trabajo debe procesarse sin esperar el intervalo inactivo');
  assert.ok(starts[2] - starts[1] >= 55, 'la cola vacía debe reducir la frecuencia de consulta');
});
