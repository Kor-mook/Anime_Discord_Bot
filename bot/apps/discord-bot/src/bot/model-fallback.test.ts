import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTextTurn } from './discord-text.js';
import { AutomaticFallbackTextClient, isRetryableModelError, type ModelClient, type TextModelReply } from './model-fallback.js';

class TestClient implements ModelClient {
  readonly inputs: string[] = [];

  constructor(private model: string, private readonly respond: (input: string) => Promise<TextModelReply>) {}

  getModel(): string { return this.model; }
  setModel(model: string): void { this.model = model; }
  async createTurn(input: ReturnType<typeof makeTextTurn>): Promise<TextModelReply> {
    this.inputs.push(input.canonicalText);
    return this.respond(input.canonicalText);
  }
}

test('retries a temporary provider failure and then reuses the exact turn for the console-selected fallback model', async () => {
  const primary = new TestClient('primary', async () => { throw { status: 503, message: 'busy' }; });
  const fallback = new TestClient('fallback', async () => ({ text: 'Recovered.', usage: { promptTokens: 4, outputTokens: 2, totalTokens: 6 } }));
  const client = new AutomaticFallbackTextClient({ primary, createFallback: () => fallback, retryAttempts: 1 });
  client.setFallbackModel('fallback');
  client.setFallbackEnabled(true);

  const input = makeTextTurn({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', text: 'Keep our topic about coffee.' });
  const reply = await client.createTurn(input);

  assert.equal(reply.text, 'Recovered.');
  assert.equal(reply.fallbackModel, 'fallback');
  assert.deepEqual(primary.inputs, [input.canonicalText, input.canonicalText]);
  assert.deepEqual(fallback.inputs, [input.canonicalText]);
});

test('does not retry or fail over authentication and invalid-request failures', async () => {
  for (const status of [400, 401, 403, 404]) {
    const primary = new TestClient('primary', async () => { throw { status, message: 'not temporary' }; });
    const fallback = new TestClient('fallback', async () => ({ text: 'should not run' }));
    const client = new AutomaticFallbackTextClient({ primary, createFallback: () => fallback, retryAttempts: 2 });
    client.setFallbackModel('fallback');
    client.setFallbackEnabled(true);
    await assert.rejects(client.createTurn(makeTextTurn({ channelId: 'channel-1', userId: 'user-1', text: 'hello' })));
    assert.equal(primary.inputs.length, 1);
    assert.equal(fallback.inputs.length, 0);
  }
});

test('rejects choosing the active model as a fallback', () => {
  const client = new AutomaticFallbackTextClient({
    primary: new TestClient('primary', async () => ({ text: 'ok' })),
    createFallback: () => new TestClient('other', async () => ({ text: 'ok' }))
  });
  assert.throws(() => client.setFallbackModel('primary'), /different from the active model/);
});

test('recognizes only temporary provider failures as retryable', () => {
  assert.equal(isRetryableModelError({ status: 429 }), true);
  assert.equal(isRetryableModelError({ status: 503 }), true);
  assert.equal(isRetryableModelError({ status: 401 }), false);
  assert.equal(isRetryableModelError({ status: 400 }), false);
});