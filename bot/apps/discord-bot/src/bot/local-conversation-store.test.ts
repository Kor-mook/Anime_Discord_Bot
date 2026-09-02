import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTextTurn } from './discord-text.js';
import { LocalConversationStore } from './local-conversation-store.js';

test('local conversation store returns recent turns and an interruption preference', () => {
  const store = new LocalConversationStore(':memory:');
  const input = makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: 'I like coffee.' });

  store.recordTurn(input, 'Then I will remember that you like coffee.');
  const context = store.contextFor({ ...input, modality: 'voice' });
  assert.match(context ?? '', /User: I like coffee\./);
  assert.match(context ?? '', /Seline: Then I will remember that you like coffee\./);

  for (let index = 0; index < 3; index += 1) {
    store.recordBargeIn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' });
  }
  assert.match(store.contextFor({ ...input, modality: 'voice' }) ?? '', /this user often interrupts/);
});

test('repeated distinctive traits become long-term memory while one-off traits do not', () => {
  const store = new LocalConversationStore(':memory:');
  const input = makeTextTurn({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    text: 'I love making small indie games after work.'
  });

  store.recordTurn(input, 'That sounds lovely.');
  assert.equal(store.listLongMemories(input).length, 0);

  store.recordTurn({ ...input, eventId: 'event-2' }, 'You really light up when you talk about that.');
  assert.deepEqual(store.listLongMemories(input).map((memory) => memory.summary), [
    'I love making small indie games after work.'
  ]);
});
test('voice join mode is initially unset, then persists server choices', () => {
  const store = new LocalConversationStore(':memory:');
  assert.equal(store.getVoiceJoinMode('guild-1'), undefined);
  assert.equal(store.hasVoiceJoinPrompt('guild-1'), false);

  store.markVoiceJoinPrompted('guild-1');
  assert.equal(store.hasVoiceJoinPrompt('guild-1'), true);
  assert.equal(store.getVoiceJoinMode('guild-1'), undefined);

  store.setVoiceJoinMode('guild-1', 'manual');
  assert.equal(store.getVoiceJoinMode('guild-1'), 'manual');
  store.setVoiceJoinMode('guild-1', 'auto');
  assert.equal(store.getVoiceJoinMode('guild-1'), 'auto');
});
test('keeps six recent text exchanges while discarding older turns', () => {
  const store = new LocalConversationStore(':memory:');
  const base = { guildId: 'guild-2', channelId: 'channel-2', userId: 'user-2' };
  for (let index = 0; index < 7; index += 1) {
    store.recordTurn(
      makeTextTurn({ ...base, text: `conversation marker ${index}` }),
      `reply marker ${index}`
    );
  }

  const context = store.contextFor(makeTextTurn({ ...base, text: 'new message' })) ?? '';
  assert.doesNotMatch(context, /conversation marker 0/);
  assert.match(context, /conversation marker 1/);
  assert.match(context, /conversation marker 6/);
});
test('SNS text style is enabled by default and can be disabled per user', () => {
  const store = new LocalConversationStore(':memory:');
  const user = { guildId: 'guild-style', userId: 'user-style' };
  assert.equal(store.isSnsStyleEnabled(user), true);
  store.setSnsStyleEnabled(user, false);
  assert.equal(store.isSnsStyleEnabled(user), false);
});

test('English is persisted as the default language for each user setting scope', () => {
  const store = new LocalConversationStore(':memory:');
  const user = { guildId: 'guild-language', userId: 'user-language' };
  assert.equal(store.getLanguage(user), 'en-US');
  store.setLanguage(user, 'ko');
  assert.equal(store.getLanguage(user), 'ko');
  store.setLanguage(user, 'en-US');
  assert.equal(store.getLanguage(user), 'en-US');
});

test('voice recognition language defaults to auto and persists per channel', () => {
  const store = new LocalConversationStore(':memory:');
  assert.equal(store.getVoiceRecognitionLanguage('guild-1', 'voice-1'), 'auto');

  store.setVoiceRecognitionLanguage('guild-1', 'voice-1', 'ko');
  store.setVoiceRecognitionLanguage('guild-1', 'voice-2', 'en');
  store.setVoiceRecognitionLanguage('guild-1', 'voice-3', 'ja');
  assert.equal(store.getVoiceRecognitionLanguage('guild-1', 'voice-1'), 'ko');
  assert.equal(store.getVoiceRecognitionLanguage('guild-1', 'voice-2'), 'en');
  assert.equal(store.getVoiceRecognitionLanguage('guild-1', 'voice-3'), 'ja');
  assert.equal(store.getVoiceRecognitionLanguage('guild-2', 'voice-1'), 'auto');
});

test('website SNS preference overrides the local text-style setting in text context only', () => {
  const store = new LocalConversationStore(':memory:');
  const input = makeTextTurn({ guildId: 'guild-sns', channelId: 'channel-sns', userId: 'user-sns', text: 'hello' });
  store.setSnsStyleEnabled(input, false);

  assert.match(store.contextFor(input, { snsStyleEnabled: true }) ?? '', /social-message voice/);
  assert.match(store.contextFor(input, { snsStyleEnabled: false }) ?? '', /Do not use casual abbreviations/);
  assert.doesNotMatch(store.contextFor({ ...input, modality: 'voice' }, { snsStyleEnabled: true }) ?? '', /social-message voice/);
});
