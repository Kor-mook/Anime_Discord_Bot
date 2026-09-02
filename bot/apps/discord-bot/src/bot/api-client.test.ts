import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendApiClient, BackendApiError, DirectGeminiVoiceApi } from './api-client.js';
import { makeTextTurn } from './discord-text.js';

test('development mode always returns the English default voice profile without calling an API', async () => {
  const client = new BackendApiClient({
    baseUrl: 'http://localhost:3001',
    devEchoMode: true,
    fetchImpl: async () => {
      throw new Error('fetch must not run in development echo mode');
    }
  });

  const reply = await client.createTurn({
    eventId: 'event-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    modality: 'text',
    canonicalText: 'Hi there!',
    occurredAt: '2026-08-04T00:00:00.000Z'
  });

  assert.equal(reply.text, '[development mode] Hi there!');
  assert.equal(reply.voiceProfile?.id, 'en-female-seline-leda-normal-v2');
  assert.equal(reply.voiceProfile?.provider, 'gemini');
  assert.equal(reply.voiceProfile?.settings.voice, 'Leda');
});

test('development mode selects the English female default voice for English text', async () => {
  const client = new BackendApiClient({ baseUrl: 'http://localhost:3001', devEchoMode: true });
  const reply = await client.createTurn({
    eventId: 'event-2',
    userId: 'user-1',
    conversationId: 'conversation-2',
    modality: 'text',
    canonicalText: 'Hi there!',
    occurredAt: '2026-08-04T00:00:00.000Z'
  });

  assert.equal(reply.voiceProfile?.id, 'en-female-seline-leda-normal-v2');
  assert.equal(reply.voiceProfile?.settings.voice, 'Leda');
});

test('DirectGeminiVoiceApi speaks a recovery prompt when Gemini has no text response', async () => {
  const voiceApi = new DirectGeminiVoiceApi({
    createTurn: async () => ({ text: 'unused' }),
    async *streamTurn(): AsyncGenerator<{ text: string }, { text: string }, void> {
      throw new Error('Gemini returned an empty text response.');
    }
  });

  const replies = [];
  for await (const reply of voiceApi.streamTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'hi' }))) {
    replies.push(reply.text);
  }
  assert.deepEqual(replies, ['I caught part of that, but say it once more for me?']);
});

test('DirectGeminiVoiceApi keeps the website language for TTS even when a provider returns English text', async () => {
  const voiceApi = new DirectGeminiVoiceApi({ createTurn: async () => ({ text: 'Hello from the provider.' }) });
  const reply = await voiceApi.createTurn({
    ...makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: '안녕' }),
    modality: 'voice',
    personalPreferences: { language: 'ko' }
  });

  assert.equal(reply.voiceProfile?.language, 'ko');
});

test('successful turns use the authenticated conversation endpoint without a legacy debit', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    apiKey: 'secret',
    devEchoMode: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? new Response(JSON.stringify({ text: 'Hello!' }), { status: 200 })
        : new Response(null, { status: 204 });
    }
  });

  const reply = await client.createTurn(makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: 'Hi' }));

  assert.equal(reply.text, 'Hello!');
  assert.equal(requests[0].url, 'https://anime-discord-bot-rw3b.vercel.app/api/bot/turn');
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer secret');
  assert.equal(requests.length, 1);

});

test('forwards the selected service model without moving prompt construction into the bot', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ reply: { text: 'Hello from Gemini.' } });
    }
  });

  client.setModel('gemini-3.5-flash-lite');
  await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'Hi' }));

  assert.equal(requestBody?.requestedModel, 'gemini-3.5-flash-lite');
  assert.equal(requestBody?.text, 'Hi');
});
test('accepts enveloped reply text while the website and bot are deployed independently', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async () => Response.json({
      data: { reply: { conversationId: 'website-conversation', content: 'Hello from the deployed API.' } }
    })
  });

  const reply = await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'Hi' }));

  assert.deepEqual(reply, { conversationId: 'website-conversation', text: 'Hello from the deployed API.', voiceProfile: undefined });
});

test('accepts the legacy deployed endpoint reply string with diagnostic fields', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async () => Response.json({
      ok: true,
      user: { id: 'user-1' },
      context: { source: 'website' },
      memory: [],
      modelInput: { version: 1 },
      reply: 'Legacy endpoint reply.',
      turn: { id: 'turn-1' }
    })
  });

  const reply = await client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'Hi' }));
  assert.equal(reply.text, 'Legacy endpoint reply.');
});

test('includes only response field names when a successful turn has an unsupported reply shape', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async () => Response.json({ data: { status: 'ok', model: 'hidden-model-id' } })
  });

  await assert.rejects(
    client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'Hi' })),
    /response shape: root=\[data\]; data=\[model,status\]/
  );
});

test('checks whether the Discord user has a linked website account', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    apiKey: 'secret',
    devEchoMode: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ hasAccount: false }), { status: 200 });
    }
  });

  assert.equal(await client.hasWebsiteAccount('user-1'), false);
  assert.equal(requests[0].url, 'https://anime-discord-bot-rw3b.vercel.app/api/bot/account?discordUserId=user-1');
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer secret');
});

test('accepts the legacy account payload returned by an older website deployment', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    apiKey: 'secret',
    devEchoMode: false,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, account: { discord_user_id: 'user-1' }, user: null }), { status: 200 })
  });

  assert.equal(await client.hasWebsiteAccount('user-1'), true);
});

test('reports a non-JSON account response as a backend API error', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    apiKey: 'secret',
    devEchoMode: false,
    fetchImpl: async () => new Response('<!DOCTYPE html><title>404</title>', { status: 200 })
  });

  await assert.rejects(
    client.hasWebsiteAccount('user-1'),
    (error: unknown) => error instanceof BackendApiError && error.detail === 'Expected a JSON response from the website bot API.'
  );
});

test('voice processing reads the account API and requires an explicit linked-account consent', async () => {
  const requests: string[] = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({
        hasAccount: true,
        voiceConsent: true,
        voiceConsentUpdatedAt: '2026-09-02T00:00:00.000Z',
        voiceSettings: { language: 'ko' }
      }), { status: 200 });
    }
  });

  assert.equal(await client.canProcessVoice({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }), true);
  assert.match(requests[0], /\/api\/bot\/account\?discordUserId=user-1$/);
});


test('accepts the nested account response currently returned by the deployed website API', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async () => Response.json({
      ok: true,
      account: {
        discordUserId: 'user-1',
        linked: true,
        voiceConsent: true,
        voiceConsentUpdatedAt: '2026-09-02T02:13:47.408Z'
      },
      user: { id: 'account-1', voiceConsent: true, voice_consent: true }
    })
  });

  assert.deepEqual(await client.getAccount('user-1'), {
    hasAccount: true,
    voiceConsent: true,
    voiceConsentUpdatedAt: '2026-09-02T02:13:47.408Z'
  });
  assert.equal(await client.canProcessVoice({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }), true);
});
test('voice processing is blocked for an unlinked account or withdrawn consent', async () => {
  const denied = async (payload: unknown) => {
    const client = new BackendApiClient({
      baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
      devEchoMode: false,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 })
    });
    return client.canProcessVoice({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' });
  };

  assert.equal(await denied({ hasAccount: false, voiceConsent: true }), false);
  assert.equal(await denied({ hasAccount: true, voiceConsent: false }), false);
});

test('voice processing propagates an account API failure for the voice-session fail-closed handler', async () => {
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 })
  });

  await assert.rejects(client.canProcessVoice({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }), BackendApiError);
});
test('forwards normalized website personal preferences with a conversation turn', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? new Response(JSON.stringify({ text: 'Hello!' }), { status: 200 })
        : new Response(null, { status: 204 });
    }
  });

  await client.createTurn({
    ...makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: 'Hi' }),
    personalPreferences: { relationshipTone: 'flirting', replyLength: 'short', interruptionMode: 'immediate' }
  });

  assert.deepEqual(JSON.parse(String(requests[0].init?.body)).personalPreferences, {
    relationshipTone: 'flirting',
    replyLength: 'short',
    interruptionMode: 'immediate'
  });
});

test('forwards the website SNS text-style preference with a conversation turn', async () => {
  const requests: Array<{ init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app',
    devEchoMode: false,
    fetchImpl: async (_url, init) => {
      requests.push({ init });
      return requests.length === 1
        ? new Response(JSON.stringify({ text: 'Hello!' }), { status: 200 })
        : new Response(null, { status: 204 });
    }
  });

  await client.createTurn({
    ...makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: 'Hi' }),
    personalPreferences: { snsStyleEnabled: false }
  });

  assert.deepEqual(JSON.parse(String(requests[0].init?.body)).personalPreferences, { snsStyleEnabled: false });
});

test('reads the web-owned remaining token percentage with bearer authentication', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app', apiKey: 'secret', devEchoMode: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ tokenUsage: { remainingPercent: 80 } });
    }
  });

  assert.deepEqual(await client.getTokenUsage('user-1'), { remainingPercent: 80 });
  assert.equal(requests[0].url, 'https://anime-discord-bot-rw3b.vercel.app/api/bot/billing?discordUserId=user-1');
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer secret');
});

test('reads server-owned memory quota and updates an individual pin through A', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new BackendApiClient({
    baseUrl: 'https://anime-discord-bot-rw3b.vercel.app', apiKey: 'secret', devEchoMode: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? new Response(JSON.stringify({ status: { enabled: true, plan: 'more', used: 1, storageLimit: 500, retrievalLimit: 8 }, memories: [{ id: 'memory-1', summary: 'Likes ramen', isPinned: false, evidenceCount: 2, createdAt: '2026-08-01T00:00:00.000Z' }] }), { status: 200 })
        : new Response(null, { status: 204 });
    }
  });
  const result = await client.listMemories({ userId: 'user-1', characterId: 'seline', query: 'anime' });
  assert.deepEqual(result.status, { enabled: true, plan: 'more', used: 1, storageLimit: 500, retrievalLimit: 8 });
  assert.equal(result.memories[0]?.evidenceCount, 2);
  await client.updateMemory({ userId: 'user-1', id: 'memory-1', isPinned: true });
  assert.equal(requests[0].url, 'https://anime-discord-bot-rw3b.vercel.app/api/bot/memory?discordUserId=user-1&characterId=seline&query=anime');
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { userId: 'user-1', id: 'memory-1', isPinned: true, discordUserId: 'user-1', characterId: 'seline' });
});
