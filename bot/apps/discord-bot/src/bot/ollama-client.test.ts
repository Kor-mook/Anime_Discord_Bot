import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTextTurn } from './discord-text.js';
import { OllamaReasoningLeakError, OllamaTextClient, looksLikeInternalReasoning, removeThinkBlocks } from './ollama-client.js';

test('Qwen3 keeps thinking disabled for casual conversation and only returns the final reply', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new OllamaTextClient({
    baseUrl: 'http://ollama.test',
    model: 'qwen3:4b',
    maxOutputTokens: 260,
    systemInstruction: 'Be Seline.',
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        message: { thinking: 'Work through the greeting.', content: '안녕. 무슨 일이에요?' },
        prompt_eval_count: 11,
        eval_count: 18
      });
    }
  });

  const reply = await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '안녕' }));

  assert.equal(reply.text, '안녕. 무슨 일이에요?');
  assert.deepEqual(reply.usage, { promptTokens: 11, outputTokens: 18, totalTokens: 29 });
  assert.equal(requestBody?.think, false);
  assert.deepEqual(requestBody?.options, {
    num_ctx: 4096,
    num_predict: 260,
    temperature: 0.78,
    top_p: 0.9,
    top_k: 40,
    repeat_penalty: 1.08
  });
  const messages = requestBody?.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0].content, /never reveal analysis or reasoning/i);
});

test('retries a Qwen3 thought leak with thinking disabled before using automatic fallback', async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const client = new OllamaTextClient({
    baseUrl: 'http://ollama.test',
    model: 'qwen3:4b',
    maxOutputTokens: 260,
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requestBodies.length === 1
        ? Response.json({ message: { content: 'Okay, the user said "안녕". Let me think about how to reply.' } })
        : Response.json({ message: { content: '안녕. 오늘은 뭐 하고 있었어요?' }, prompt_eval_count: 7, eval_count: 9 });
    }
  });

  const reply = await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '안녕' }));

  assert.equal(reply.text, '안녕. 오늘은 뭐 하고 있었어요?');
  assert.deepEqual(reply.usage, { promptTokens: 7, outputTokens: 9, totalTokens: 16 });
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].think, false);
  assert.equal(requestBodies[1].think, false);
});

test('Qwen3 enables separated thinking only for a complex text request', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new OllamaTextClient({
    baseUrl: 'http://ollama.test',
    model: 'qwen3:4b',
    maxOutputTokens: 260,
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ message: { content: '공통 프롬프트 빌더로 합치면 됩니다.' }, prompt_eval_count: 20, eval_count: 10 });
    }
  });

  await client.createTurn(makeTextTurn({
    channelId: 'channel-1',
    userId: 'user-1',
    text: '현재 모델별 대화 처리 구조가 서로 다른데, 왜 문제가 되는지 분석하고 공통 프롬프트 빌더 중심으로 개선 방법을 설계해줘.'
  }));

  assert.equal(requestBody?.think, true);
});

test('uses role history and records only the final naturalness rewrite', async () => {
  const requestBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  const recorded: string[] = [];
  const client = new OllamaTextClient({
    baseUrl: 'http://ollama.test',
    model: 'qwen3:4b',
    maxOutputTokens: 260,
    systemInstruction: 'Be Seline.',
    contextFor: () => ({
      instructions: 'Keep the current topic.',
      recentMessages: [
        { role: 'user', content: '오늘 일 너무 많았어요.' },
        { role: 'assistant', content: '오늘 유난히 길었나 봐요.' }
      ]
    }),
    recordTurn: (_input, reply) => { recorded.push(reply.text); },
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> });
      return requestBodies.length === 1
        ? Response.json({ message: { content: '그렇군요. 많이 피곤하시겠어요.' }, prompt_eval_count: 10, eval_count: 6 })
        : Response.json({ message: { content: '오늘 완전히 진이 빠졌겠네요. 잠깐이라도 쉬어요.' }, prompt_eval_count: 18, eval_count: 10 });
    }
  });

  const reply = await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '오늘 진짜 피곤해요' }));

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0].messages?.slice(-3), [
    { role: 'user', content: '오늘 일 너무 많았어요.' },
    { role: 'assistant', content: '오늘 유난히 길었나 봐요.' },
    { role: 'user', content: '오늘 진짜 피곤해요' }
  ]);
  assert.match(requestBodies[1].messages?.at(-1)?.content ?? '', /Rewrite only the assistant draft/i);
  assert.equal(reply.text, '오늘 완전히 진이 빠졌겠네요. 잠깐이라도 쉬어요.');
  assert.deepEqual(reply.usage, { promptTokens: 28, outputTokens: 16, totalTokens: 44 });
  assert.deepEqual(recorded, [reply.text]);
});

test('keeps rejecting an unrecoverable Qwen3 thought leak so automatic fallback can handle it', async () => {
  const client = new OllamaTextClient({
    baseUrl: 'http://ollama.test',
    model: 'qwen3:4b',
    maxOutputTokens: 260,
    fetchImpl: async () => Response.json({
      message: { content: 'Okay, the user said "안녕". Let me think about how to reply.' }
    })
  });

  await assert.rejects(
    client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '안녕' })),
    (error: unknown) => error instanceof OllamaReasoningLeakError && error.status === 503
  );
});

test('removes explicit think tags but preserves normal replies', () => {
  assert.equal(removeThinkBlocks('<think>private work</think>안녕하세요!'), '안녕하세요!');
  assert.equal(looksLikeInternalReasoning('Okay, the user said hello.'), true);
  assert.equal(looksLikeInternalReasoning('안녕하세요. 반가워요!'), false);
});
