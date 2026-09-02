import assert from 'node:assert/strict';
import test from 'node:test';
import { chatTypingDelayMs, makeTextTurn, normalizeChatDeliveryCues, splitDiscordMessage, splitNaturalTextMessages, splitSnsStyleMessage } from './discord-text.js';

test('makeTextTurn creates a text envelope without audio data', () => {
  const turn = makeTextTurn({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    text: '  hello  '
  });

  assert.equal(turn.modality, 'text');
  assert.equal(turn.canonicalText, 'hello');
  assert.equal(turn.conversationId, 'text:guild-1:channel-1:user-1');
  assert.equal('audio' in turn, false);
});

test('splitDiscordMessage keeps every chunk within Discord message limits', () => {
  const source = `${'가'.repeat(1_900)} ${'나'.repeat(1_900)}`;
  const chunks = splitDiscordMessage(source);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2_000));
  assert.equal(chunks.join(' '), source);
});

test('splitSnsStyleMessage separates replies with three or more sentences', () => {
  assert.deepEqual(
    splitSnsStyleMessage('First thought. Second thought. Third thought.'),
    ['First thought.', 'Second thought.', 'Third thought.']
  );
  assert.deepEqual(splitSnsStyleMessage('First thought. Second thought.'), ['First thought. Second thought.']);
});
test('human-style delivery separates sentences, including Korean ones', () => {
  assert.deepEqual(
    splitNaturalTextMessages('First thought. Second thought.'),
    ['First thought.', 'Second thought.']
  );
  assert.deepEqual(
    splitNaturalTextMessages('첫 번째예요. 두 번째예요!'),
    ['첫 번째예요.', '두 번째예요!']
  );
});
test('human-style typing delays are short and bounded', () => {
  assert.equal(chatTypingDelayMs('hi'), 300);
  assert.equal(chatTypingDelayMs('a'.repeat(200)), 950);
});test('chat delivery cues use server-independent Unicode emoji', () => {
  assert.equal(normalizeChatDeliveryCues('[a small laugh] That was cute.'), '😄 That was cute.');
  assert.equal(normalizeChatDeliveryCues('[gently teasing] You know I am right.'), '😉 You know I am right.');
  assert.equal(normalizeChatDeliveryCues('No cue here.'), 'No cue here.');
  assert.equal(normalizeChatDeliveryCues("(smiles) I heard you."), String.fromCodePoint(0x1F642) + " I heard you.");
});