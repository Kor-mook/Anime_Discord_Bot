import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRemainingUsage } from './usage-display.js';

test('formatRemainingUsage shows the remaining token percentage in Korean', () => {
  const filled = '█'.repeat(18);
  const empty = '░'.repeat(2);

  assert.equal(
    formatRemainingUsage(89, 'ko'),
    `\`${filled}${empty}\`\n\n## 89% 남았어요 ✨`
  );
});

test('formatRemainingUsage shows the remaining token percentage in English', () => {
  assert.equal(
    formatRemainingUsage(0, 'en-US'),
    `\`${'░'.repeat(20)}\`\n\n## 0% remaining`
  );
});

test('formatRemainingUsage rejects a percentage outside the website contract', () => {
  assert.throws(() => formatRemainingUsage(101, 'en-US'), /0 to 100/);
});