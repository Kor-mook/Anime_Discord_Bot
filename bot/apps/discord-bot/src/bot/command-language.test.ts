import assert from 'node:assert/strict';
import test from 'node:test';
import { commandLanguageFromValue, voiceProfileLanguageFor, voiceRecognitionLanguageFor } from './command-language.js';

test('normalizes website language codes and human-facing labels', () => {
  for (const value of ['ko', 'ko-KR', 'kr', 'korean', '한국어', '한글', '한국말']) {
    assert.equal(commandLanguageFromValue(value), 'ko');
  }
  for (const value of ['ja', 'ja-JP', 'japanese', '일본어', '日本語']) {
    assert.equal(commandLanguageFromValue(value), 'ja');
  }
  for (const value of ['en', 'en-US', 'english', '영어']) {
    assert.equal(commandLanguageFromValue(value), 'en-US');
  }
});

test('derives STT and TTS language from the same website language', () => {
  assert.equal(voiceRecognitionLanguageFor('ko'), 'ko');
  assert.equal(voiceProfileLanguageFor('ko'), 'ko');
  assert.equal(voiceRecognitionLanguageFor('en-US'), 'en');
  assert.equal(voiceProfileLanguageFor('en-US'), 'en-US');
});
