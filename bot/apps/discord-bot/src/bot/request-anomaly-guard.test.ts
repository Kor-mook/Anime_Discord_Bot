import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestAnomalyGuard } from './request-anomaly-guard.js';

test('allows normal traffic and reports an unusual per-user burst once', () => {
  const guard = new RequestAnomalyGuard();
  const base = 1_000;

  for (let index = 0; index < 5; index += 1) {
    assert.equal(guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + index }).state, 'allow');
  }
  assert.deepEqual(guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + 5 }), {
    state: 'warn', kind: 'user', count: 6, notify: true
  });
  assert.equal(guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + 6 }).notify, false);
});

test('blocks a severe per-user burst before more provider calls are made', () => {
  const guard = new RequestAnomalyGuard();
  const base = 1_000;

  for (let index = 0; index < 14; index += 1) guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + index });
  assert.deepEqual(guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + 14 }), {
    state: 'block', kind: 'user', count: 15, notify: true
  });
  assert.deepEqual(guard.inspect({ userId: 'user-1', channelId: 'channel-1', now: base + 15 }), {
    state: 'block', kind: 'user', count: undefined, notify: false
  });
});
