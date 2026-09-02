import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceConsentInvalidationServer } from './voice-consent-invalidation-server.js';

test('accepts only authenticated voice-consent invalidation events', async () => {
  const events: Array<{ discordUserId: string; voiceConsent: boolean }> = [];
  const listener = createVoiceConsentInvalidationServer({
    secret: 'shared-secret',
    onInvalidate: (event) => events.push(event),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  await listener.listen(0, '127.0.0.1');
  try {
    const address = listener.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/internal/voice-consent`;
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ discordUserId: 'user-1', voiceConsent: true })
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(events, []);

    const accepted = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer shared-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ discordUserId: 'user-1', voiceConsent: false })
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(events, [{ discordUserId: 'user-1', voiceConsent: false }]);
  } finally {
    await listener.close();
  }
});