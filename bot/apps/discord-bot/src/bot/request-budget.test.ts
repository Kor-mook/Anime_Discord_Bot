import assert from 'node:assert/strict';
import test from 'node:test';
import { limitTextForBudget } from './request-budget.js';

test('request budget preserves both the opening and conclusion of long text', () => {
  const source = `opening ${'x'.repeat(120)} ending`;
  const result = limitTextForBudget(source, 90);

  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 90);
  assert.match(result.text, /^opening/);
  assert.match(result.text, /ending$/);
});

test('request budget leaves short text unchanged', () => {
  assert.deepEqual(limitTextForBudget('hello', 20), { text: 'hello', truncated: false });
});