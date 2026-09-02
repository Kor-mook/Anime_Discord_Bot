import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { endpointSilenceMs, isExpectedCaptureClose, isExplicitInterrupt, isLikelyPlaybackEcho, nextChunkWithSilence, nextChunkWithTimeout, PcmSpeechPipeline, smoothVadNoiseFloor, VoiceSessionManager, voiceFrameThreshold, voiceReconnectDelayMs, voiceTranscriptionIsConfident, waitForDrainWithTimeout } from './voice-session-manager.js';

test('recognizes spaced and attached shut up interruption phrases', () => {
  assert.equal(isExplicitInterrupt('Seline, shut up.'), true);
  assert.equal(isExplicitInterrupt('seline shutup'), true);
  assert.equal(isExplicitInterrupt('wait a second'), true);
  assert.equal(isExplicitInterrupt('do you like baseball?'), false);
});
test('waits through a natural pause before treating speech as a completed turn', () => {
  assert.equal(endpointSilenceMs(500), 750);
  assert.equal(endpointSilenceMs(700), 1_050);
  assert.equal(endpointSilenceMs(2_000), 1_050);
});

test('uses bounded exponential backoff for Discord voice reconnects', () => {
  assert.equal(voiceReconnectDelayMs(1), 1_000);
  assert.equal(voiceReconnectDelayMs(2), 2_000);
  assert.equal(voiceReconnectDelayMs(3), 4_000);
  assert.equal(voiceReconnectDelayMs(4), 8_000);
  assert.equal(voiceReconnectDelayMs(5), undefined);
});

test('automatically tunes VAD sensitivity from the recent channel noise floor', () => {
  assert.equal(voiceFrameThreshold(120), 270);
  assert.equal(voiceFrameThreshold(500), 1_125);
  assert.ok(voiceFrameThreshold(500) > voiceFrameThreshold(120));
  assert.equal(smoothVadNoiseFloor(120, 520), 220);
  assert.equal(smoothVadNoiseFloor(800, 20), 615);
});


test('treats Discord subscription close as a normal capture endpoint', () => {
  const error = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  assert.equal(isExpectedCaptureClose(error, { destroyed: true }), true);
  assert.equal(isExpectedCaptureClose(error, { destroyed: false }), false);
  assert.equal(isExpectedCaptureClose(new Error('decoder failed'), { destroyed: true }), false);
});
test('ignores a likely microphone echo of recent Seline speech only while it is substantial', () => {
  assert.equal(isLikelyPlaybackEcho("I'll be here.", ["[smiles] I'll be here."]), true);
  assert.equal(isLikelyPlaybackEcho('How was your day?', ["I'll be here."]), false);
  assert.equal(isLikelyPlaybackEcho('Always.', ['Always.']), false);
});
test('rejects only genuinely low-confidence voice transcriptions before they can trigger a reply', () => {
  assert.equal(voiceTranscriptionIsConfident(0.24), false);
  assert.equal(voiceTranscriptionIsConfident(0.25), true);
  assert.equal(voiceTranscriptionIsConfident(0.49), true);
  assert.equal(voiceTranscriptionIsConfident(undefined), true);
});test('forces a stalled TTS input stream to close at its deadline', async () => {
  const stream = new PassThrough();
  await assert.rejects(nextChunkWithTimeout(stream[Symbol.asyncIterator](), stream, 20), /PCM stream stalled/);
  assert.equal(stream.destroyed, true);
});

test('forces a stalled TTS output backpressure wait to close at its deadline', async () => {
  const stream = new PassThrough();
  await assert.rejects(waitForDrainWithTimeout(stream, 20), /PCM output stalled/);
  assert.equal(stream.destroyed, true);
});

test('feeds silence through a delayed TTS chunk so Discord playback stays active', async () => {
  const source = new PassThrough();
  const output = new PassThrough();
  const outputChunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk));
  const next = nextChunkWithSilence(source[Symbol.asyncIterator](), source, output, 100, 5);

  await new Promise((resolve) => setTimeout(resolve, 20));
  source.write(Buffer.from([1, 2, 3, 4]));
  const result = await next;

  assert.deepEqual(result, { value: Buffer.from([1, 2, 3, 4]), done: false });
  assert.ok(outputChunks.some((chunk) => chunk.length > 0 && chunk.every((value) => value === 0)));
  source.destroy();
  output.destroy();
});

test('treats barge-in aborts for active and prefetched TTS segments as normal cancellation', async () => {
  const controller = new AbortController();
  const output = new PassThrough();
  output.resume();
  const streams = [new PassThrough(), new PassThrough()];
  let synthesisCalls = 0;
  const voiceService = {
    synthesizePcm: ({ signal }: { signal: AbortSignal }) => {
      const stream = streams[synthesisCalls++];
      signal.addEventListener('abort', () => stream.emit('error', new DOMException('This operation was aborted', 'AbortError')), { once: true });
      return Promise.resolve(stream);
    }
  };
  const pipeline = new PcmSpeechPipeline(
    output,
    voiceService as any,
    {
      id: 'test',
      version: 1,
      provider: 'gemini',
      language: 'ko',
      settings: {},
      status: 'published'
    },
    controller.signal
  );

  pipeline.enqueue('첫 문장.');
  pipeline.enqueue('두 번째 문장.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synthesisCalls, 2);
  assert.doesNotThrow(() => controller.abort());
  pipeline.cancel();

  await assert.doesNotReject(pipeline.finish());
  assert.equal(output.destroyed, true);
});
test('stops every active voice session during shutdown', () => {
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => true
  } as any);
  const destroyedGuilds: string[] = [];
  for (const guildId of ['guild-1', 'guild-2']) {
    (manager as any).sessions.set(guildId, {
      channel: { id: `channel-${guildId}`, guild: { id: guildId } },
      connection: { destroy: () => destroyedGuilds.push(guildId) },
      player: { state: { status: 'idle' }, stop: () => undefined },
      startedAt: '2026-08-12T00:00:00.000Z'
    });
  }

  assert.equal(manager.stopAll(), 2);
  assert.deepEqual(destroyedGuilds, ['guild-1', 'guild-2']);
  assert.equal(manager.getStatus('guild-1'), undefined);
  assert.equal(manager.getStatus('guild-2'), undefined);
});

test('immediate interruption setting stops active voice playback without waiting for a stop command', async () => {
  let bargeInCalls = 0;
  let abortCalls = 0;
  let stopCalls = 0;
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => true,
    shouldInterruptImmediately: async () => true,
    onBargeIn: async () => { bargeInCalls += 1; }
  } as any);
  const session = {
    channel: { id: 'channel-1', guild: { id: 'guild-1' } },
    player: { state: { status: 'playing' }, stop: () => { stopCalls += 1; } },
    activeRequest: { abort: () => { abortCalls += 1; } }
  };

  await (manager as any).confirmBargeIn(session, 'user-1');

  assert.equal(bargeInCalls, 1);
  assert.equal(abortCalls, 1);
  assert.equal(stopCalls, 1);
});

test('ignores another participant while Seline is replying to the active speaker', async () => {
  let bargeInCalls = 0;
  let abortCalls = 0;
  let stopCalls = 0;
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => true,
    shouldInterruptImmediately: async () => true,
    onBargeIn: async () => { bargeInCalls += 1; }
  } as any);
  const session = {
    channel: { id: 'channel-1', guild: { id: 'guild-1' } },
    player: { state: { status: 'playing' }, stop: () => { stopCalls += 1; } },
    playbackUserId: 'active-user',
    activeRequest: { abort: () => { abortCalls += 1; } }
  };

  await (manager as any).confirmBargeIn(session, 'other-user');

  assert.equal(bargeInCalls, 0);
  assert.equal(abortCalls, 0);
  assert.equal(stopCalls, 0);
});
test('stop-command-only setting leaves active playback running during normal speech', async () => {
  let stopCalls = 0;
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => true,
    shouldInterruptImmediately: async () => false
  } as any);
  const session = {
    channel: { id: 'channel-1', guild: { id: 'guild-1' } },
    player: { state: { status: 'playing' }, stop: () => { stopCalls += 1; } }
  };
  await (manager as any).confirmBargeIn(session, 'user-1');

  assert.equal(stopCalls, 0);
});

test('clears a cached denial when a voice-consent grant event arrives', async () => {
  let allowed = false;
  let settingsChecks = 0;
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => { settingsChecks += 1; return allowed; }
  } as any);
  const scope = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };

  assert.equal(await manager.canProcessVoice(scope), false);
  assert.equal(await manager.canProcessVoice(scope), false);
  assert.equal(settingsChecks, 1);

  allowed = true;
  manager.invalidateVoiceConsent(scope.userId, true);
  assert.equal(await manager.canProcessVoice(scope), true);
  assert.equal(settingsChecks, 2);
});

test('a voice-consent withdrawal event blocks the next input without another settings read', async () => {
  let settingsChecks = 0;
  const manager = new VoiceSessionManager({
    conversationApi: { createTurn: async () => ({ conversationId: 'unused', text: 'unused' }) },
    voiceService: {},
    canProcessVoice: async () => { settingsChecks += 1; return true; }
  } as any);

  manager.invalidateVoiceConsent('user-1', false);
  assert.equal(await manager.canProcessVoice({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }), false);
  assert.equal(settingsChecks, 0);
});
