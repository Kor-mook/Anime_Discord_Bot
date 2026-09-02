import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsolePasswordGuard, completeTerminalCommand, completeTerminalCommandInput, inlineTerminalSuggestion, searchLogLines, terminalCommandFeedback, terminalCommandRunningFeedback, terminalModeStatus, terminalSearchResult, terminalSearchStatus, terminalInputViewport, toggleTerminalLogMode, wrapTerminalLine } from './terminal-console.js';
import { TerminalCommandRegistry } from './terminal-command-registry.js';

const commandRegistry = new TerminalCommandRegistry()
  .register({ name: 'help', help: 'help', handler: () => undefined })
  .register({ name: 'status', help: 'status', handler: () => undefined })
  .register({ name: 'announce', help: 'announce', handler: () => undefined })
  .register({ name: 'model', help: 'model', handler: () => undefined })
  .register({ name: 'logs', help: 'logs', completions: ['logs compact', 'logs detail'], handler: () => undefined })
  .register({ name: 'fallback', help: 'fallback', completions: ['fallback on', 'fallback off'], handler: () => undefined })
  .register({ name: 'voice', help: 'voice', completions: ['voice servers', 'voice leave', 'voice pause all', 'voice resume all'], handler: () => undefined })
  .register({ name: 'clear', help: 'clear', handler: () => undefined })
  .register({ name: 'restart', help: 'restart', handler: () => undefined })
  .register({ name: 'stop', help: 'stop', handler: () => undefined });
test('Tab completion suggests supported CUI commands from a prefix', () => {
  assert.deepEqual(completeTerminalCommand('vo', commandRegistry), [['voice servers', 'voice leave', 'voice pause all', 'voice resume all'], 'vo']);
  assert.deepEqual(completeTerminalCommand('voice l', commandRegistry), [['voice leave'], 'voice l']);
  assert.deepEqual(completeTerminalCommand('logs', commandRegistry), [['logs compact', 'logs detail'], 'logs']);
  assert.deepEqual(completeTerminalCommand('', commandRegistry), [['help', 'status', 'announce', 'model', 'logs compact', 'logs detail', 'fallback on', 'fallback off', 'voice servers', 'voice leave', 'voice pause all', 'voice resume all', 'clear', 'restart', 'stop'], '']);
});

test('Tab completion extends an ambiguous command to its shared prefix', () => {
  assert.equal(completeTerminalCommandInput('voic', commandRegistry), 'voice ');
  assert.equal(completeTerminalCommandInput('fallback o', commandRegistry), 'fallback o');
  assert.equal(completeTerminalCommandInput('logs d', commandRegistry), 'logs detail');
  assert.equal(completeTerminalCommandInput('unknown', commandRegistry), 'unknown');
});
test('inline suggestions show a dimmable suffix or the available Tab choices', () => {
  assert.equal(inlineTerminalSuggestion('vo', commandRegistry), '  [Tab: voice servers | voice leave | voice pause all | voice resume all]');
  assert.equal(inlineTerminalSuggestion('logs', commandRegistry), '  [Tab: logs compact | logs detail]');
  assert.equal(inlineTerminalSuggestion('logs d', commandRegistry), 'etail');
  assert.equal(inlineTerminalSuggestion('mod', commandRegistry), 'el');
  assert.equal(inlineTerminalSuggestion('unknown', commandRegistry), '');
});

test('terminal status names F2 as the log mode toggle', () => {
  assert.equal(terminalModeStatus('detail'), '[LOGS: detail] [FALLBACK: OFF] F2 toggle | Ctrl+F search | Tab complete | help: commands');
  assert.equal(terminalModeStatus('compact', { enabled: true, model: 'gemini-3.6-flash' }), '[LOGS: compact] [FALLBACK: ON: gemini-3.6-flash] F2 toggle | Ctrl+F search | Tab complete | help: commands');
});

test('command feedback stays identifiable while logs continue to arrive', () => {
  assert.equal(terminalCommandRunningFeedback('status'), '[RUNNING] status');
  assert.equal(terminalCommandFeedback('status', ['Discord: connected']), '[DONE] status: Discord: connected');
  assert.equal(terminalCommandFeedback('help', ['first', 'second']), '[DONE] help: first (+1 more line)');
});

test('toggles detailed logging between detail and compact modes', () => {
  assert.equal(toggleTerminalLogMode('compact'), 'detail');
  assert.equal(toggleTerminalLogMode('detail'), 'compact');
});

test('input viewport keeps the cursor aligned for Korean and long commands', () => {
  assert.deepEqual(terminalInputViewport('가나다abc', 3, 4), { value: '나다', cursorOffset: 2 });
  assert.deepEqual(terminalInputViewport('logs detail', 11, 4), { value: 'tail', cursorOffset: 4 });
});
test('long logs wrap without dropping Korean or ANSI-colored text', () => {
  assert.deepEqual(wrapTerminalLine('가나다라마바사', 4), ['가나', '다라', '마바', '사']);
  assert.deepEqual(wrapTerminalLine('\u001b[1;32mabcdef\u001b[0m', 3), [
    '\u001b[1;32mabc\u001b[0m',
    '\u001b[1;32mdef\u001b[0m'
  ]);
});

test('console password locks after five failed attempts for 30 seconds', () => {
  const guard = new ConsolePasswordGuard('correct password');
  for (let attempt = 1; attempt < 5; attempt += 1) {
    const result = guard.submit('incorrect', 1_000);
    assert.equal(result.locked, false);
    assert.equal(result.remainingAttempts, 5 - attempt);
  }
  const locked = guard.submit('incorrect', 1_000);
  assert.deepEqual(locked, { authenticated: false, locked: true, remainingAttempts: 0, lockRemainingMs: 30_000 });
  assert.equal(guard.submit('correct password', 30_999).locked, true);
  assert.equal(guard.submit('correct password', 31_000).authenticated, true);
});

test('log search finds case-insensitive matches and shows navigable result status', () => {
  const matches = searchLogLines([
    '[10:00:00] INFO [bot] Ready',
    '[10:01:00] WARNING [voice] Connection lost',
    '[10:02:00] INFO [voice] Reconnected'
  ], 'VOICE');

  assert.deepEqual(matches, [
    '[10:01:00] WARNING [voice] Connection lost',
    '[10:02:00] INFO [voice] Reconnected'
  ]);
  assert.match(terminalSearchResult('voice', matches.length, 1, matches[1]), /2\/2: \[10:02:00\]/);
  assert.match(terminalSearchStatus('voice', matches.length, 1), /2\/2 matches/);
  assert.match(terminalSearchStatus('missing', 0, 0), /No matches/);
});