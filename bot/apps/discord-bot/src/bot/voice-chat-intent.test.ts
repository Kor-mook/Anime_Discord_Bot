import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoiceJoinRequest } from './voice-chat-intent.js';

test('recognizes Korean and English chat requests to join voice', () => {
  assert.equal(isVoiceJoinRequest('샐린 음성채널 들어와줄래?'), true);
  assert.equal(isVoiceJoinRequest('Seline, can you join my voice chat?'), true);
  assert.equal(isVoiceJoinRequest('Could you leave the voice channel?'), false);
});