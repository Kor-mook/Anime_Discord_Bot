import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { resolveVoiceServiceDirectory } from './voice-service-manager.js';

test('resolves the voice service from the Discord app working directory', () => {
  const discordBotDirectory = process.cwd();
  assert.equal(
    resolveVoiceServiceDirectory(discordBotDirectory),
    resolve(discordBotDirectory, '..', 'voice-service')
  );
});