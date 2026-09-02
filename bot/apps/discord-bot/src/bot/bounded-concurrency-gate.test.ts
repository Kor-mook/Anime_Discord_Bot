import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedConcurrencyGate, ServerBusyError } from './bounded-concurrency-gate.js';

test('never exceeds its configured active-work limit and returns permits after errors', async () => {
  const gate = new BoundedConcurrencyGate(2, 2, 100);
  let active = 0;
  let peak = 0;
  const work = (fails = false) => gate.run(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    if (fails) throw new Error('expected');
  });
  await Promise.allSettled([work(), work(true), work(), work()]);
  assert.equal(peak, 2);
  await gate.run(async () => undefined);
  assert.equal(gate.activeCount, 0);
});

test('rejects a full queue and a timed-out waiter with ServerBusyError', async () => {
  const gate = new BoundedConcurrencyGate(1, 1, 15);
  let release!: () => void;
  const active = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
  const waiting = gate.run(async () => undefined);
  await assert.rejects(gate.run(async () => undefined), ServerBusyError);
  await assert.rejects(waiting, ServerBusyError);
  release();
  await active;
});
