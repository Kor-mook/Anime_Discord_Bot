import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationPrompt,
  inspectNaturalness,
  SELINE_PERSONA,
  shouldUseReasoning,
  type ConversationPromptContext
} from '@anime/contracts';
import { makeTextTurn } from './discord-text.js';

test('builds one shared prompt with role-separated history and consistent Korean speech', () => {
  const input = makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '오늘 진짜 피곤함ㅋㅋ 게임은 하고 싶음' });
  const context: ConversationPromptContext = {
    instructions: 'Text style preference: relaxed.',
    recentMessages: [
      { role: 'user', content: '오늘 일 너무 많았음' },
      { role: 'assistant', content: '오늘 유난히 길었나 봐요. 일단 좀 쉬어요.' },
      { role: 'user', content: '그래도 아직 안 잘 거야' }
    ]
  };

  const prompt = buildConversationPrompt(input, { systemInstruction: 'Be Seline.', context });

  assert.equal(prompt.source, 'discord_text');
  assert.equal(prompt.speechLevel, 'casual');
  assert.equal(prompt.style.interactionType, 'emotional_support');
  assert.equal(prompt.style.userEnergy, 'low');
  assert.equal(prompt.style.usesLaughter, true);
  assert.equal(prompt.style.usesShortMessages, true);
  assert.deepEqual(prompt.messages.slice(1), [
    ...context.recentMessages!,
    { role: 'user', content: input.canonicalText }
  ]);
  assert.match(prompt.messages[0].content, /real person/i);
  assert.match(prompt.messages[0].content, /Reply in Korean only for this turn/i);
  assert.match(prompt.messages[0].content, /Current Korean speech level: casual/i);
  assert.match(prompt.messages[0].content, /Avoid reusing these recent assistant openings/i);
  assert.match(prompt.messages[0].content, /without generic therapy language/i);
});

test('leads after a bare Korean greeting without inventing personal context', () => {
  const input = makeTextTurn({ channelId: 'channel-greeting', userId: 'user-greeting', text: '안녕' });
  const prompt = buildConversationPrompt(input, { systemInstruction: 'Be Seline.' });

  assert.equal(prompt.situation.topic, 'greeting');
  assert.equal(prompt.situation.selectedMove, 'gentle_curiosity');
  assert.match(prompt.messages[0].content, /Welcome the user directly with relaxed, unmistakable warmth/i);
  assert.match(prompt.messages[0].content, /instead of evaluating the greeting/i);
  assert.match(prompt.messages[0].content, /exactly one easy, low-pressure question/i);
  assert.match(prompt.messages[0].content, /volunteered preference, routine, interest, current plan, or feeling/i);
  assert.match(prompt.messages[0].content, /never request identifying or sensitive information/i);
  assert.match(prompt.messages[0].content, /Do not invent context or assume the user worked, is tired/i);
});

test("keeps Seline's emotions visible and proportionate instead of uniformly calm", () => {
  assert.match(SELINE_PERSONA, /let it show through ordinary word choice, rhythm, or punctuation/i);
  assert.match(SELINE_PERSONA, /Many everyday turns should simply sound relaxed and present/i);
  assert.match(SELINE_PERSONA, /Do not flatten strong user emotion into generic calm friendliness/i);
  assert.match(SELINE_PERSONA, /Return to an ordinary conversational baseline when the moment passes/i);
});

test('notices a three-day return with affectionate warmth but no guilt', () => {
  const input = {
    ...makeTextTurn({ channelId: 'channel-return', userId: 'user-return', text: '안녕', occurredAt: '2026-08-10T12:00:00.000Z' }),
    personalPreferences: { language: 'ko', relationshipTone: 'romantic' }
  };
  const prompt = buildConversationPrompt(input, {
    systemInstruction: SELINE_PERSONA,
    context: { lastInteractionAt: '2026-08-07T12:00:00.000Z' }
  });
  assert.match(prompt.messages[0].content, /returning after about 3 days/i);
  assert.match(prompt.messages[0].content, /brief affectionate complaint/i);
  assert.match(prompt.messages[0].content, /welcome must clearly outweigh the complaint/i);
  assert.match(prompt.messages[0].content, /Never demand an explanation.*guilt-trip/i);
});

test('distinguishes spoken transcripts from text typed during voice', () => {
  const base = {
    eventId: 'event-1', guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1',
    conversationId: 'voice:guild-1:channel-1:user-1', modality: 'voice' as const,
    canonicalText: '이거 어떻게 해?', occurredAt: new Date(0).toISOString()
  };
  const spoken = buildConversationPrompt({ ...base, source: 'voice_transcript' }, { systemInstruction: 'Be Seline.' });
  const typed = buildConversationPrompt({ ...base, source: 'voice_channel_text' }, { systemInstruction: 'Be Seline.' });

  assert.match(spoken.messages[0].content, /live voice conversation/i);
  assert.match(typed.messages[0].content, /typed while already talking/i);
  assert.equal(typed.messages.at(-1)?.content, '이거 어떻게 해?');
});

test('detects assistant clichés, repeated openings, mixed speech and voice formatting', () => {
  const issues = inspectNaturalness('그렇군요. 괜찮아, 제가 정리해 드릴게요? 또 궁금한 건 있나요?', {
    source: 'voice_transcript',
    speechLevel: 'polite',
    recentAssistantOpenings: ['그렇군요.']
  });

  assert.ok(issues.includes('assistant_cliche'));
  assert.ok(issues.includes('repeated_opening'));
  assert.ok(issues.includes('mixed_speech_level'));
  assert.ok(issues.includes('forced_questions'));
});

test('detects detached greetings and fake shared confirmation for rewrite', () => {
  const greetingPrompt = buildConversationPrompt(
    makeTextTurn({ channelId: 'c', userId: 'u', text: '안녕 셀린' }),
    { systemInstruction: SELINE_PERSONA }
  );
  const dailyPrompt = buildConversationPrompt(
    makeTextTurn({ channelId: 'c', userId: 'u', text: '오늘이 방학 마지막 날이야' }),
    { systemInstruction: SELINE_PERSONA }
  );

  assert.ok(inspectNaturalness('어, 다시 인사해 주네. 반가워라.', greetingPrompt).includes('detached_greeting'));
  assert.ok(inspectNaturalness('아, 진짜 방학 마지막 날이네.', dailyPrompt).includes('presumed_shared_context'));
  assert.match(dailyPrompt.messages[0].content, /Treat facts in the latest message as newly learned/i);
});
test('uses reasoning only for complex text requests', () => {
  assert.equal(shouldUseReasoning(makeTextTurn({ channelId: 'c', userId: 'u', text: '안녕' })), false);
  assert.equal(shouldUseReasoning(makeTextTurn({
    channelId: 'c',
    userId: 'u',
    text: '이 대화 시스템의 모델별 차이를 분석하고 공통 프롬프트 구조로 어떻게 개선할지 상세하게 설계해줘.'
  })), true);
});

test('answers about Seline concretely while preserving an underexplored user thread', () => {
  const input = makeTextTurn({
    channelId: 'channel-mutual',
    userId: 'user-mutual',
    eventId: 'event-mutual',
    text: '어떤 거 봤는데?'
  });
  const context: ConversationPromptContext = {
    recentMessages: [
      { role: 'user', content: '안녕 셀린' },
      { role: 'assistant', content: '안녕. 오늘 하루는 좀 어땠어?' },
      { role: 'user', content: '좋았어' },
      { role: 'assistant', content: '다행이네. 별일 없이 편하게 보냈나 보네.' },
      { role: 'user', content: '너는 오늘 뭐 했니?' },
      { role: 'assistant', content: '애니 극장판이랑 게임 실황을 좀 봤어.' }
    ]
  };

  const prompt = buildConversationPrompt(input, {
    systemInstruction: 'Be Seline.',
    context
  });

  assert.equal(prompt.situation.topic, 'about_seline');
  assert.equal(prompt.situation.underexploredPersonalThread, true);
  assert.ok(['reciprocal_share', 'open_thread_callback', 'playful_nudge'].includes(prompt.situation.selectedMove));
  assert.match(prompt.messages[0].content, /Answer first with one concrete, persona-consistent detail/i);
  assert.match(prompt.messages[0].content, /recent personal update from the user appears underexplored/i);
  assert.match(prompt.messages[0].content, /Keep the exchange mutual over time/i);
});

test('breaks an interview rhythm after two consecutive assistant questions', () => {
  const input = makeTextTurn({
    channelId: 'channel-rhythm',
    userId: 'user-rhythm',
    eventId: 'event-rhythm',
    text: '매운 라멘 먹었어'
  });
  const prompt = buildConversationPrompt(input, {
    systemInstruction: 'Be Seline.',
    context: {
      recentMessages: [
        { role: 'assistant', content: '오늘은 누구랑 있었어?' },
        { role: 'user', content: '친구랑 있었어' },
        { role: 'assistant', content: '둘이 뭐 먹었어?' }
      ]
    }
  });

  assert.equal(prompt.situation.questionStreak, 2);
  assert.notEqual(prompt.situation.selectedMove, 'gentle_curiosity');
  assert.notEqual(prompt.situation.selectedMove, 'open_thread_callback');
  assert.match(prompt.messages[0].content, /Do not ask another one this turn/i);
  assert.ok(inspectNaturalness('그 친구랑 자주 가는 곳이야?', prompt).includes('interview_rhythm'));
});

test('varies the selected conversational move across otherwise similar daily turns', () => {
  const moves = new Set(
    Array.from({ length: 12 }, (_, index) => buildConversationPrompt(
      makeTextTurn({
        channelId: 'channel-variety',
        userId: 'user-variety',
        eventId: `event-variety-${index}`,
        text: '오늘 라멘 먹었어'
      }),
      { systemInstruction: 'Be Seline.' }
    ).situation.selectedMove)
  );

  assert.ok(moves.size > 1);
  assert.ok([...moves].every((move) => [
    'specific_reaction',
    'reciprocal_share',
    'gentle_curiosity',
    'playful_nudge'
  ].includes(move)));
});

test('detects naturally opened long-term-memory opportunities without forcing a question', () => {
  const prompt = buildConversationPrompt(
    makeTextTurn({
      channelId: 'channel-memory',
      userId: 'user-memory',
      eventId: 'event-memory',
      text: '주말에는 보통 혼자 천천히 산책해'
    }),
    { systemInstruction: 'Be Seline.' }
  );

  assert.equal(prompt.situation.memoryOpportunity, 'routine');
  assert.match(prompt.messages[0].content, /go only one layer deeper/i);
  assert.match(prompt.messages[0].content, /never stack questions or mention long-term memory/i);
});

test('classifies named greetings, positive updates, and guarded replies without false memory intent', () => {
  const promptFor = (text: string, eventId: string) => buildConversationPrompt(
    makeTextTurn({
      channelId: 'channel-boundaries',
      userId: 'user-boundaries',
      eventId,
      text
    }),
    { systemInstruction: 'Be Seline.' }
  );

  const greeting = promptFor('안녕 셀린', 'event-greeting');
  const positive = promptFor('오늘 진짜 좋은 일이 있었어', 'event-positive');
  const guarded = promptFor('그건 말하고 싶지 않아', 'event-guarded');

  assert.equal(greeting.style.interactionType, 'greeting');
  assert.equal(greeting.situation.topic, 'greeting');
  assert.equal(positive.situation.topic, 'positive_update');
  assert.equal(positive.situation.emotionalSignal, 'positive');
  assert.equal(guarded.situation.openness, 'guarded');
  assert.equal(guarded.situation.memoryOpportunity, 'none');
});


test('keeps brief replies warm without treating them as a wish for distance', () => {
  const prompt = buildConversationPrompt(
    makeTextTurn({
      channelId: 'channel-brief',
      userId: 'user-brief',
      eventId: 'event-brief',
      text: 'ㅇㅇ'
    }),
    {
      systemInstruction: SELINE_PERSONA,
      context: {
        recentMessages: [
          { role: 'assistant', content: '오늘은 좀 편하게 보내고 계셨어요?' }
        ]
      }
    }
  );

  assert.equal(prompt.situation.openness, 'brief');
  assert.match(prompt.messages[0].content, /short replies.*ambiguous/i);
  assert.match(prompt.messages[0].content, /Do not infer a user's mood.*short reply alone/i);
  assert.match(prompt.messages[0].content, /warmly welcoming and respectful/i);
  assert.doesNotMatch(SELINE_PERSONA, /cool, guarded, and slightly aloof/i);
  assert.match(SELINE_PERSONA, /Seline is megadere: openly fond/i);
  assert.match(SELINE_PERSONA, /responds with clear appreciation or gentle affection/i);
  assert.doesNotMatch(SELINE_PERSONA, /tsundere/i);
});

test('responds to tiredness with empathy before one optional personal follow-up', () => {
  const prompt = buildConversationPrompt(
    makeTextTurn({
      channelId: 'channel-tired',
      userId: 'user-tired',
      eventId: 'event-tired',
      text: '너무 피곤하네'
    }),
    {
      systemInstruction: 'Be Seline.',
      context: {
        recentMessages: [
          { role: 'assistant', content: '안녕. 오늘 하루는 좀 어땠어?' }
        ]
      }
    }
  );

  assert.equal(prompt.situation.topic, 'emotional');
  assert.equal(prompt.situation.emotionalSignal, 'low');
  assert.equal(prompt.situation.questionStreak, 1);
  assert.equal(prompt.situation.selectedMove, 'empathic_curiosity');
  assert.match(prompt.messages[0].content, /First acknowledge the user's tiredness or strain/i);
  assert.match(prompt.messages[0].content, /what made them feel that way/i);
  assert.match(prompt.messages[0].content, /Do not end the exchange with only generic rest advice/i);
});
