import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceChatJoinReply } from './voice-chat-join-reply.js';

test('uses an urgent Korean acknowledgement for urgent voice requests', () => {
  assert.equal(voiceChatJoinReply('셀린 지금 음성 채널로 와 줘', () => 0), '응, 알겠어. 바로 갈게.');
});

test('uses a warmer acknowledgement when the request is to hang out together', () => {
  assert.equal(voiceChatJoinReply('셀린 같이 음성 채널에서 놀자', () => 0), '응, 같이 있자. 바로 갈게.');
});

test('does not repeat the same acknowledgement when choices are available', () => {
  const first = voiceChatJoinReply('셀린 음성 채널 들어와 줘', () => 0);
  const second = voiceChatJoinReply('셀린 음성 채널 들어와 줘', () => 0);
  assert.notEqual(first, second);
});
