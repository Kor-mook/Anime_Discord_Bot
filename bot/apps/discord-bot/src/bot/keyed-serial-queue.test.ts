import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyedSerialQueue } from './keyed-serial-queue.js';

test('serializes work for one key and removes completed keys', async () => {
  const queue = new KeyedSerialQueue();
  const steps: string[] = [];
  let releaseFirst!: () => void;
  const first = queue.run('one', async () => { steps.push('first-start'); await new Promise<void>((resolve) => { releaseFirst = resolve; }); steps.push('first-end'); });
  const second = queue.run('one', async () => { steps.push('second'); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(steps, ['first-start', 'first-end', 'second']);
  assert.equal(queue.size, 0);
});

test('allows distinct keys to run concurrently and continues after a failure', async () => {
  const queue = new KeyedSerialQueue();
  let firstStarted = false;
  const failed = queue.run('one', async () => { firstStarted = true; throw new Error('expected'); });
  const parallel = queue.run('two', async () => { assert.equal(firstStarted, true); });
  const next = queue.run('one', async () => 'next');
  await assert.rejects(failed, /expected/);
  await parallel;
  assert.equal(await next, 'next');
});
