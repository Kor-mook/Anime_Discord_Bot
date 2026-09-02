import assert from 'node:assert/strict';
import test from 'node:test';
import { discordLoveAiHelp } from './help-text.js';

test('Discord help is localized, structured, and shows the appropriate commands for each permission level', () => {
  const english = discordLoveAiHelp('en-US');
  const korean = discordLoveAiHelp('ko');
  const japanese = discordLoveAiHelp('ja');
  const managerEnglish = discordLoveAiHelp('en-US', true);

  assert.match(english, /\*\*LoveAI Help\*\*/);
  assert.match(english, /\*\*💬 Text chat\*\*/);
  assert.match(english, /\/loveai chatmode mode:on\|off/);
  assert.doesNotMatch(english, /\/loveai-admin/);
  assert.match(managerEnglish, /\/loveai voicejoin/);
  assert.match(korean, /\*\*🌙 LoveAI 사용 안내\*\*/);
  assert.match(korean, /\*\*💬 가볍게 대화하기\*\*/);
  assert.match(korean, /\/loveai chatmode mode:on\|off/);
  assert.match(korean, /셀린에게 하고 싶은 이야기를 보내요/);
  assert.match(japanese, /\*\*LoveAI ヘルプ\*\*/);
  assert.match(japanese, /\*\*💬 テキストチャット\*\*/);
  assert.match(japanese, /Selineにメッセージを送ります/);
  assert.doesNotMatch(english, /status <guild-id>|voice leave <guild-id>|로컬 콘솔/);
  assert.doesNotMatch(korean, /status <서버 ID>|voice leave <서버 ID>|로컬 콘솔/);
});
