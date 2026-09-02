import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleLogger } from './console-logger.js';

test('prints critical logs as a compact red line', () => {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...values: unknown[]) => lines.push(values.join(' '));
  try {
    createConsoleLogger('voice-service').error('Python executable was not found');
  } finally {
    console.error = originalError;
  }

  const output = lines.join('\n');
  assert.match(output, /\u001b\[1;31m/);
  assert.match(output, /\[voice-service\]/);
  assert.match(output, /Python executable was not found/);
});
