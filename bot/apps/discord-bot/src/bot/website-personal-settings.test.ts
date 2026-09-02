import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPersonalVoiceSettings, limitReplyForPreference, limitVoiceReplyForPreference, personalSettingsInstruction, personalSettingsPayload, readWebsitePersonalSettings, shouldInterruptImmediately } from './website-personal-settings.js';
import { createSelineVoiceProfile } from './seline-voice.js';

test('maps website personal settings, including the Korean option labels', () => {
  const settings = readWebsitePersonalSettings({
    preferences: {
      relationship_tone: '연인',
      response_length: '길게',
      voice_style: '표현형',
      fast_response: true,
      interruption_mode: '말하면 즉시 중단'
    }
  });

  assert.deepEqual(settings, {
    relationshipTone: 'romantic',
    replyLength: 'long',
    expressiveVoice: true,
    fastVoiceResponse: true,
    interruptionMode: 'immediate'
  });
  assert.deepEqual(personalSettingsPayload(settings), settings);
  assert.equal(shouldInterruptImmediately(settings), true);
});

test('keeps stop-command-only interruption mode and caps short replies', () => {
  const settings = readWebsitePersonalSettings({
    relationshipTone: 'friend',
    replyLength: '짧게',
    interruptionMode: 'stop 명령 일때만 중단'
  });

  assert.equal(settings.relationshipTone, 'friend');
  assert.equal(settings.replyLength, 'short');
  assert.equal(shouldInterruptImmediately(settings), false);
  assert.equal(limitReplyForPreference('First sentence. Second sentence. Third sentence.', settings), 'First sentence. Second sentence.');
});

test('applies expressive delivery and faster voice playback without replacing the selected voice', () => {
  const profile = applyPersonalVoiceSettings(createSelineVoiceProfile('soft'), {
    expressiveVoice: true,
    fastVoiceResponse: true
  });

  assert.equal(profile.settings.voice, 'Leda');
  assert.equal(profile.settings.delivery, 'soft');
  assert.equal(profile.settings.speed, 1.12);
  assert.match(String(profile.settings.style), /expressive emotional variation/i);
});
test('turns every relationship and reply-length choice into model instructions', () => {
  assert.match(personalSettingsInstruction({ relationshipTone: 'friend', replyLength: 'short' }) ?? '', /Do not initiate flirting/);
  assert.match(personalSettingsInstruction({ relationshipTone: 'flirting', replyLength: 'medium' }) ?? '', /light, mutual, PG-13 flirting/);
  assert.match(personalSettingsInstruction({ relationshipTone: 'romantic', replyLength: 'long' }) ?? '', /warmly affectionate and intimate/);
  assert.match(personalSettingsInstruction({ fastVoiceResponse: true }) ?? '', /one concise sentence/);
});

test('fast voice response preserves a natural two-sentence beat and trims only overruns', () => {
  const reply = 'First sentence. Second sentence. Third sentence.';
  assert.equal(limitVoiceReplyForPreference(reply, { fastVoiceResponse: true, replyLength: 'long' }), 'First sentence. Second sentence.');
  assert.equal(limitVoiceReplyForPreference(reply, { replyLength: 'short' }), 'First sentence. Second sentence.');
});
test('maps website SNS text-style settings and includes them in the bot API payload', () => {
  const enabled = readWebsitePersonalSettings({ preferences: { text_style: 'sns' } });
  const disabled = readWebsitePersonalSettings({ sns_enabled: false });

  assert.equal(enabled.snsStyleEnabled, true);
  assert.equal(disabled.snsStyleEnabled, false);
  assert.deepEqual(personalSettingsPayload(enabled), { snsStyleEnabled: true });
  assert.match(personalSettingsInstruction(disabled) ?? '', /Do not use casual abbreviations/);
});

test('reads the command language from website personal settings and preserves it in the payload', () => {
  const korean = readWebsitePersonalSettings({ preferences: { preferred_language: 'ko' } });
  const koreanLabel = readWebsitePersonalSettings({ preferences: { preferred_language: '한글' } });
  const english = readWebsitePersonalSettings({ locale: 'en-US' });
  const japanese = readWebsitePersonalSettings({ preferences: { preferred_language: 'ja-JP' } });

  assert.deepEqual(korean, { language: 'ko' });
  assert.deepEqual(koreanLabel, { language: 'ko' });
  assert.deepEqual(english, { language: 'en-US' });
  assert.deepEqual(japanese, { language: 'ja' });
  assert.deepEqual(personalSettingsPayload(korean), { language: 'ko' });
});
