import assert from 'node:assert/strict';
import test from 'node:test';
import { slashCommands } from './commands.js';

test('registers LoveAI controls and private memory management', () => {
  assert.equal(slashCommands.length, 2);
  const loveai = slashCommands[0];
  const memory = slashCommands[1];

  assert.equal(loveai.name, 'loveai');
  assert.deepEqual(
    loveai.options?.map((option) => option.name),
    ['help', 'chat', 'snsmode', 'usage', 'chatmode', 'tictactoe', 'model', 'voicejoin', 'voiceleave', 'voicemode', 'language']
  );
  assert.equal(memory.name, 'memory');
  assert.deepEqual(memory.options?.map((option) => option.name), ['on', 'off', 'list', 'forget', 'pin', 'unpin', 'delete']);
});
