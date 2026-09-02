import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelineVoiceProfile, selectSelineVoiceDelivery, selectSelineVoiceProfile } from './seline-voice.js';

test('Seline uses Leda with a bright but natural playful delivery', () => {
  const profile = createSelineVoiceProfile('playful');

  assert.equal(profile.settings.voice, 'Leda');
  assert.equal(profile.settings.delivery, 'playful');
  assert.equal(profile.settings.gainDb, 0.5);
  assert.match(String(profile.settings.style), /never use baby talk/i);
});

test('whisper delivery requires an explicit user request', () => {
  assert.equal(selectSelineVoiceDelivery({ userText: 'Could you whisper that to me?' }), 'whisper');
  assert.equal(selectSelineVoiceDelivery({ userText: '그거 속삭여서 말해줘.' }), 'whisper');
  assert.equal(selectSelineVoiceDelivery({ userText: 'Tell me a secret.' }), 'normal');
});

test('existing assistant delivery cues choose soft or playful speech without whispering', () => {
  assert.equal(selectSelineVoiceDelivery({ userText: 'I had a rough day.', assistantText: '[softly] I am here.' }), 'soft');
  assert.equal(selectSelineVoiceDelivery({ userText: 'Guess what?', assistantText: '[smiles] No way.' }), 'playful');
});

test('Korean assistant replies select a Korean Gemini voice profile', () => {
  const profile = selectSelineVoiceProfile({ userText: 'hello', assistantText: '응, 나 여기 있어.' });
  assert.equal(profile.language, 'ko');
  assert.match(profile.id, /^ko-female-seline-leda-/);
  assert.equal(profile.settings.speed, 0.88);
});

test('website language overrides the language inferred from an English transcript', () => {
  const profile = selectSelineVoiceProfile({
    userText: 'Hello',
    assistantText: 'Hey there.',
    preferredLanguage: 'ko'
  });

  assert.equal(profile.language, 'ko');
  assert.match(profile.id, /^ko-female-seline-leda-/);
});

test('Japanese assistant replies select a Japanese Gemini voice profile', () => {
  const profile = selectSelineVoiceProfile({ userText: 'こんにちは', assistantText: 'うん、ここにいるよ。' });
  assert.equal(profile.language, 'ja');
  assert.match(profile.id, /^ja-female-seline/);
});