import { Readable } from 'node:stream';
import type { VoiceProfile, VoiceTranscription } from '@anime/contracts';

type VoiceServiceClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  transcriptionTimeoutMs?: number;
  logger?: DetailLogger;
};

type DetailLogger = {
  detail: (...details: unknown[]) => void;
};

export type VoiceRecognitionLanguage = 'auto' | 'en' | 'ko' | 'ja';

type TranscribeInput = {
  pcm: Buffer;
  guildId: string;
  channelId: string;
  userId: string;
  language?: VoiceRecognitionLanguage;
  signal?: AbortSignal;
};

type SynthesizeInput = {
  text: string;
  voiceProfile: VoiceProfile;
  signal?: AbortSignal;
};

export class VoiceServiceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transcriptionTimeoutMs: number;
  private readonly logger?: DetailLogger;

  constructor({ baseUrl, fetchImpl = fetch, transcriptionTimeoutMs = 10_000, logger }: VoiceServiceClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.transcriptionTimeoutMs = transcriptionTimeoutMs;
    this.logger = logger;
  }

  async transcribe(input: TranscribeInput): Promise<VoiceTranscription> {
    const deadline = createDeadlineSignal(input.signal, this.transcriptionTimeoutMs);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const startedAt = performance.now();
        this.detail('Voice STT -> POST /v1/transcriptions: attempt=' + (attempt + 1) + ', pcmBytes=' + input.pcm.length + ', guild=' + input.guildId + ', channel=' + input.channelId + ', user=' + input.userId + ', language=' + (input.language ?? 'auto') + '.');
        const response = await this.fetchImpl(`${this.baseUrl}/v1/transcriptions`, {
          method: 'POST',
          headers: {
            'content-type': 'audio/L16;rate=48000;channels=2',
            'x-guild-id': input.guildId,
            'x-channel-id': input.channelId,
            'x-user-id': input.userId,
            'x-stt-language': input.language ?? 'auto'
          },
          body: input.pcm as unknown as BodyInit,
          signal: deadline.signal
        });
        this.detail('Voice STT <- HTTP ' + response.status + ' ' + (response.statusText || '') + ' in ' + Math.round(performance.now() - startedAt) + ' ms.');
        if (response.ok) {
          const transcription = (await response.json()) as VoiceTranscription;
          this.detail('Voice STT parsed: text=' + preview(transcription.text) + ', confidence=' + String(transcription.confidence ?? 'n/a') + '.');
          return transcription;
        }
        if (attempt === 0 && response.status >= 500 && !deadline.signal.aborted) {
          this.detail('Voice STT retrying once after server error ' + response.status + '.');
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        await assertSuccessful(response, 'Voice transcription');
      }
      throw new Error('Voice transcription failed after retry.');
    } catch (error) {
      if (deadline.timedOut() && !input.signal?.aborted) {
        throw new Error(`Voice transcription timed out after ${this.transcriptionTimeoutMs} ms.`);
      }
      throw error;
    } finally {
      deadline.dispose();
    }
  }
  async synthesize(input: SynthesizeInput): Promise<Readable> {
    const response = await this.requestSpeech('/v1/speech', input);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('audio/ogg')) {
      throw new Error(`Voice service must return Ogg Opus; received ${contentType || 'no content type'}.`);
    }
    return responseBody(response);
  }

  async synthesizePcm(input: SynthesizeInput): Promise<Readable> {
    const response = await this.requestSpeech('/v1/speech/stream', input);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('audio/l16')) {
      throw new Error(`Voice service must return 48 kHz PCM; received ${contentType || 'no content type'}.`);
    }
    return responseBody(response);
  }

  private async requestSpeech(path: string, input: SynthesizeInput): Promise<Response> {
    const startedAt = performance.now();
    this.detail('Voice TTS -> POST ' + path + ': payload=' + preview(JSON.stringify({ text: input.text, voiceProfile: input.voiceProfile })) + '.');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text, voiceProfile: input.voiceProfile }),
      signal: input.signal
    });
    this.detail('Voice TTS <- HTTP ' + response.status + ' ' + (response.statusText || '') + ' in ' + Math.round(performance.now() - startedAt) + ' ms, contentType=' + (response.headers.get('content-type') ?? 'none') + '.');
    await assertSuccessful(response, 'Voice synthesis');
    return response;
  }

  private detail(message: string): void {
    this.logger?.detail(message);
  }
}

function preview(value: string, maxLength = 800): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return JSON.stringify(normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength) + '...');
}
function responseBody(response: Response): Readable {
  if (!response.body) throw new Error('Voice service returned no audio body.');
  return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
}

async function assertSuccessful(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => '');
  throw new Error(`${operation} request failed (${response.status}). ${detail}`.trim());
}
function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    }
  };
}