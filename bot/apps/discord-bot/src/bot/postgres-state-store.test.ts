import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Pool, PoolConfig } from 'pg';
import { PostgresStateStore } from './postgres-state-store.js';

class FakePool extends EventEmitter {
  totalCount = 2;
  idleCount = 1;
  waitingCount = 0;
  ended = false;
  async end(): Promise<void> { this.ended = true; }
}

test('handles idle pool errors locally and closes the pool', async () => {
  const pool = new FakePool();
  const errors: Error[] = [];
  const store = new PostgresStateStore('postgres://user:secret@db.example/test', {}, {
    createPool: (_config: PoolConfig) => pool as unknown as Pool,
    onPoolError: (error) => errors.push(error)
  });
  pool.emit('error', new Error('connect postgres://user:secret@db.example/test failed'));
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!.message, /secret/);
  assert.deepEqual(store.poolStats(), { total: 2, idle: 1, waiting: 0 });
  await store.close();
  assert.equal(pool.ended, true);
});
