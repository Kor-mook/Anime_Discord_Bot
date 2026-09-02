import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DailyFileLogger, dateStamp, weekStamp } from './daily-file-logger.js';

test('uses the server local calendar date for daily log filenames', () => {
  assert.equal(dateStamp(new Date(2026, 7, 3, 23, 59, 59)), '2026-08-03');
  assert.equal(dateStamp(new Date(2026, 0, 9)), '2026-01-09');
});

test('uses ISO week stamps based on the server local calendar date', () => {
  assert.equal(weekStamp(new Date(2026, 7, 3)), '2026-W32');
  assert.equal(weekStamp(new Date(2027, 0, 1)), '2026-W53');
});

test('appends each entry to the current daily log file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-bot-log-'));
  try {
    const logger = new DailyFileLogger(directory, () => new Date(2026, 7, 3, 9, 8, 7));
    logger.write('INFO', 'discord-bot', ['Bot process started: pid=123']);
    const contents = readFileSync(join(directory, 'bot-2026-08-03.log'), 'utf8');
    assert.match(contents, /INFO\s+\[discord-bot\] Bot process started: pid=123/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('collects only critical entries in a weekly log file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-bot-log-'));
  try {
    const logger = new DailyFileLogger(directory, () => new Date(2026, 7, 3, 9, 8, 7));
    logger.write('WARNING', 'discord-bot', ['Temporary issue']);
    logger.write('CRITICAL', 'discord-bot', ['Discord client error']);

    const criticalLog = join(directory, 'critical-2026-W32.log');
    assert.ok(existsSync(criticalLog));
    assert.match(readFileSync(criticalLog, 'utf8'), /CRITICAL\s+\[discord-bot\] Discord client error/);
    assert.doesNotMatch(readFileSync(criticalLog, 'utf8'), /Temporary issue/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
