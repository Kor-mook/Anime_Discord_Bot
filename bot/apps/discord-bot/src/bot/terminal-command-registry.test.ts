import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalCommandRegistry } from './terminal-command-registry.js';

test('a registered command is executable, appears in help, and supports multi-token completion', async () => {
  const registry = new TerminalCommandRegistry().register({
    name: 'backup',
    help: 'backup <database|media> <now|verify> - Create or verify a backup.',
    completions: ['backup database now', 'backup database verify', 'backup media now'],
    handler: ({ args, raw }) => `${raw}: ${args.join(',')}`
  });

  assert.deepEqual(registry.helpLines(), ['backup <database|media> <now|verify> - Create or verify a backup.']);
  assert.deepEqual(registry.complete('backup database '), [['backup database now', 'backup database verify'], 'backup database ']);
  assert.equal(registry.completeInput('backup dat'), 'backup database ');
  assert.equal(registry.inlineSuggestion('backup database v'), 'erify');
  assert.equal(await registry.execute('backup database now'), 'backup database now: database,now');
});

test('registration validates command paths and prevents duplicate command roots', () => {
  const registry = new TerminalCommandRegistry().register({ name: 'health', help: 'health', handler: () => undefined });
  assert.throws(() => registry.register({ name: 'health', help: 'duplicate', handler: () => undefined }), /already registered/);
  assert.throws(() => registry.register({ name: 'deploy', help: 'deploy', completions: ['deployment now'], handler: () => undefined }), /must start/);
});
