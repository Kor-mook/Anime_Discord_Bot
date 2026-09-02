import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTextTurn } from './discord-text.js';
import { GeminiApiError, GeminiTextClient } from './gemini-client.js';

test('GeminiTextClient returns text and the API-reported token usage', async () => {
  const client = new GeminiTextClient({
    apiKey: 'test-key',
    model: 'test-model',
    maxOutputTokens: 256,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1beta/models/test-model:generateContent');
      assert.equal(url.searchParams.get('key'), 'test-key');
      const body = JSON.parse(String(init?.body)) as {
        systemInstruction?: { parts?: Array<{ text?: string }> };
        contents?: unknown;
        generationConfig?: unknown;
      };
      assert.match(body.systemInstruction?.parts?.[0]?.text ?? '', /Korean speech level: polite/i);
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '안녕' }] }]);
      assert.deepEqual(body.generationConfig, { maxOutputTokens: 256 });
      return Response.json({
        candidates: [{ content: { parts: [{ text: '반가워!' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
      });
    }
  });

  const reply = await client.createTurn(
    makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: '안녕' })
  );

  assert.equal(reply.text, '반가워!');
  assert.deepEqual(reply.usage, { promptTokens: 12, outputTokens: 8, totalTokens: 20 });
});

test('GeminiTextClient adds concise live-call guidance only to voice turns', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new GeminiTextClient({
    apiKey: 'test-key',
    model: 'test-model',
    maxOutputTokens: 56,
    systemInstruction: 'Base persona.',
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Oh, yeah. It was good.' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 7, totalTokenCount: 11 }
      });
    }
  });

  await client.createTurn({
    eventId: 'voice-event', guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1',
    conversationId: 'voice:guild-1:channel-1:user-1', modality: 'voice', canonicalText: 'How was your day?', occurredAt: '2026-08-06T00:00:00.000Z'
  });

  const instruction = (requestBody?.systemInstruction as { parts?: Array<{ text?: string }> } | undefined)?.parts?.[0]?.text ?? '';
  assert.match(instruction, /live voice conversation/i);
  assert.match(instruction, /one concise sentence/i);
  assert.deepEqual(requestBody?.contents, [{ role: 'user', parts: [{ text: 'How was your day?' }] }]);
});
test('GeminiTextClient exposes provider status for payment and quota messaging', async () => {
  const client = new GeminiTextClient({
    apiKey: 'test-key',
    model: 'test-model',
    maxOutputTokens: 256,
    fetchImpl: async () => new Response('quota exceeded', { status: 429 })
  });

  await assert.rejects(
    client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'hello' })),
    (error: unknown) => {
      assert.ok(error instanceof GeminiApiError);
      assert.equal(error.status, 429);
      assert.equal(error.detail, 'quota exceeded');
      return true;
    }
  );
});

test('GeminiTextClient streams SSE deltas and records the final normalized reply', async () => {
  const recorded: string[] = [];
  const client = new GeminiTextClient({
    apiKey: 'test-key',
    model: 'test-model',
    maxOutputTokens: 256,
    recordTurn: (_input, reply) => { recorded.push(reply.text); },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1beta/models/test-model:streamGenerateContent');
      assert.equal(url.searchParams.get('alt'), 'sse');
      return new Response([
        'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"there."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n'
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
  });

  const stream = client.streamTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'hi' }));
  const chunks: string[] = [];
  let result = await stream.next();
  while (!result.done) {
    chunks.push(result.value.text);
    result = await stream.next();
  }

  assert.deepEqual(chunks, ['hello there.']);
  assert.equal(result.value.text, 'hello there.');
  assert.deepEqual(result.value.usage, { promptTokens: 4, outputTokens: 2, totalTokens: 6 });
  assert.deepEqual(recorded, ['hello there.']);
});
test('GeminiTextClient retries with generateContent when the stream has no text', async () => {
  const client = new GeminiTextClient({
    apiKey: 'test-key',
    model: 'test-model',
    maxOutputTokens: 256,
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(':streamGenerateContent')) {
        return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Could you say that again?' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 }
      });
    }
  });

  const stream = client.streamTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'hi' }));
  const first = await stream.next();
  const done = await stream.next();
  assert.deepEqual(first, { value: { text: 'Could you say that again?' }, done: false });
  assert.equal(done.done, true);
  if (!done.done) throw new Error('The fallback stream should be complete.');
  assert.equal(done.value.text, 'Could you say that again?');
  assert.deepEqual(done.value.usage, { promptTokens: 4, outputTokens: 5, totalTokens: 9 });
});
