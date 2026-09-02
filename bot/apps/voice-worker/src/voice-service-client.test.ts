import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceServiceClient } from './voice-service-client.js';

test('transcribe sends in-memory PCM with Discord routing headers', async () => {
  let request: Request | undefined;
  const client = new VoiceServiceClient({
    baseUrl: 'http://voice.local',
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ text: '안녕하세요', confidence: 0.91 });
    }
  });

  const result = await client.transcribe({
    pcm: Buffer.from([1, 2, 3]),
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1'
  });

  assert.equal(result.text, '안녕하세요');
  assert.equal(result.confidence, 0.91);
  assert.equal(request?.url, 'http://voice.local/v1/transcriptions');
  assert.equal(request?.headers.get('x-guild-id'), 'guild-1');
  assert.equal(request?.headers.get('x-stt-language'), 'auto');
  assert.equal(request?.headers.get('content-type'), 'audio/L16;rate=48000;channels=2');
  assert.deepEqual([...new Uint8Array(await request!.arrayBuffer())], [1, 2, 3]);
});

test('synthesize accepts only Ogg Opus for Discord playback', async () => {
  const client = new VoiceServiceClient({
    baseUrl: 'http://voice.local',
    fetchImpl: async () =>
      new Response(new Uint8Array([79, 103, 103, 83]), {
        headers: { 'content-type': 'audio/ogg; codecs=opus' }
      })
  });

  const stream = await client.synthesize({
    text: 'hello',
    voiceProfile: {
      id: 'en-female-heart-v1',
      version: 1,
      provider: 'kokoro',
      language: 'en-US',
      settings: { voice: 'af_heart', speed: 0.95 },
      status: 'published'
    }
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));

  assert.deepEqual(Buffer.concat(chunks), Buffer.from([79, 103, 103, 83]));
});

test('synthesizePcm accepts a streaming 48 kHz PCM response', async () => {
  let request: Request | undefined;
  const client = new VoiceServiceClient({
    baseUrl: 'http://voice.local',
    fetchImpl: async (input, init) => {
      request = new Request(input, init);
      return new Response(new Uint8Array([1, 0, 1, 0]), {
        headers: { 'content-type': 'audio/L16;rate=48000;channels=2' }
      });
    }
  });
  const stream = await client.synthesizePcm({
    text: 'hello',
    voiceProfile: {
      id: 'en-female-heart-v1', version: 1, provider: 'kokoro', language: 'en-US',
      settings: { voice: 'af_heart', speed: 0.95 }, status: 'published'
    }
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.equal(request?.url, 'http://voice.local/v1/speech/stream');
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 0, 1, 0]));
});
test('transcribe aborts a stuck request at its deadline', async () => {
  let requestAborted = false;
  const client = new VoiceServiceClient({
    baseUrl: 'http://voice.local',
    transcriptionTimeoutMs: 20,
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            requestAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      })
  });

  await assert.rejects(
    client.transcribe({ pcm: Buffer.from([1, 2, 3]), guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }),
    /Voice transcription timed out after 20 ms\./
  );
  assert.equal(requestAborted, true);
});