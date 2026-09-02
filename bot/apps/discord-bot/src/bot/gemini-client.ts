import {
  buildConversationPrompt,
  buildNaturalRewritePrompt,
  inspectNaturalness,
  type ConversationMessage,
  type ConversationPrompt,
  type ConversationPromptContext,
  type TurnEnvelope
} from '@anime/contracts';
import { CHAT_INPUT_MAX_CHARS, limitTextForBudget } from './request-budget.js';

export type GeminiTokenUsage = {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type GeminiTextReply = {
  text: string;
  usage: GeminiTokenUsage;
};

export type GeminiTextStreamChunk = {
  text: string;
};

type LocalContextHooks = {
  contextFor?: (input: TurnEnvelope) => string | ConversationPromptContext | undefined | Promise<string | ConversationPromptContext | undefined>;
  recordTurn?: (input: TurnEnvelope, reply: GeminiTextReply) => void | Promise<void>;
  recordUsage?: (input: TurnEnvelope, usage: GeminiTokenUsage, model: string) => void | Promise<void>;
};

type DetailLogger = {
  detail: (...details: unknown[]) => void;
};

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super('Gemini API request failed (' + status + '). ' + detail);
    this.name = 'GeminiApiError';
  }
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

export class GeminiTextClient {
  private readonly fetchImpl: typeof fetch;
  private model: string;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      maxOutputTokens: number;
      systemInstruction?: string;
      logger?: DetailLogger;
      fetchImpl?: typeof fetch;
    } & LocalContextHooks
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async createTurn(input: TurnEnvelope): Promise<GeminiTextReply> {
    const { boundedInput, prompt } = await this.preparePrompt(input);
    let reply = await this.requestReply(prompt.messages, input.modality);
    reply = await this.rewriteIfNeeded(prompt, reply, input.modality);
    this.options.logger?.detail(`Gemini API parsed response: text=${logPreview(reply.text)}, usage=${JSON.stringify(reply.usage)}.`);
    await this.record(boundedInput, reply);
    await this.recordUsage(boundedInput, reply.usage);
    return reply;
  }

  /**
   * Buffers the short response until it passes naturalness validation. Voice
   * playback must never start from a draft that may need to be rewritten.
   */
  async *streamTurn(input: TurnEnvelope): AsyncGenerator<GeminiTextStreamChunk, GeminiTextReply, void> {
    const { boundedInput, prompt } = await this.preparePrompt(input);
    const endpoint = this.endpoint('streamGenerateContent');
    endpoint.searchParams.set('alt', 'sse');
    const response = await this.fetchTurn(endpoint, prompt.messages, input.modality);
    if (!response.ok) await throwGeminiError(response);
    if (!response.body) throw new Error('Gemini returned an empty streaming response.');

    let accumulated = '';
    let usage: GeminiGenerateContentResponse['usageMetadata'];
    let finishReason: string | undefined;
    const decoder = new TextDecoder();
    let buffered = '';

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as GeminiGenerateContentResponse;
        const candidate = event.candidates?.[0];
        const received = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        const delta = normalizeStreamDelta(accumulated, received);
        if (delta) {
          accumulated += delta;
          this.options.logger?.detail(`Gemini SSE delta: ${logPreview(delta)}.`);
        }
        usage = event.usageMetadata ?? usage;
        finishReason = candidate?.finishReason ?? finishReason;
      }
    }

    const text = accumulated.trim();
    if (!text) {
      const fallback = await this.createTurn(input);
      yield { text: fallback.text };
      return fallback;
    }
    let reply = this.toReply(text, finishReason, usage);
    reply = await this.rewriteIfNeeded(prompt, reply, input.modality);
    this.options.logger?.detail(`Gemini stream completed: text=${logPreview(reply.text)}, usage=${JSON.stringify(reply.usage)}.`);
    yield { text: reply.text };
    await this.record(boundedInput, reply);
    await this.recordUsage(boundedInput, reply.usage);
    return reply;
  }

  private endpoint(method: 'generateContent' | 'streamGenerateContent'): URL {
    const endpoint = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:${method}`
    );
    endpoint.searchParams.set('key', this.options.apiKey);
    return endpoint;
  }

  private async preparePrompt(input: TurnEnvelope): Promise<{ boundedInput: TurnEnvelope; prompt: ConversationPrompt }> {
    const inputLimit = input.modality === 'voice' ? 1_500 : CHAT_INPUT_MAX_CHARS;
    const boundedInput = { ...input, canonicalText: limitTextForBudget(input.canonicalText, inputLimit).text };
    const localContext = await this.options.contextFor?.(boundedInput);
    return {
      boundedInput,
      prompt: buildConversationPrompt(boundedInput, {
        systemInstruction: this.options.systemInstruction,
        context: localContext
      })
    };
  }

  private async requestReply(messages: readonly ConversationMessage[], modality: TurnEnvelope['modality']): Promise<GeminiTextReply> {
    const response = await this.fetchTurn(this.endpoint('generateContent'), messages, modality);
    if (!response.ok) await throwGeminiError(response);
    const body = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty text response.');
    return this.toReply(text, candidate?.finishReason, body.usageMetadata);
  }

  private async rewriteIfNeeded(
    prompt: ConversationPrompt,
    reply: GeminiTextReply,
    modality: TurnEnvelope['modality']
  ): Promise<GeminiTextReply> {
    const issues = inspectNaturalness(reply.text, prompt);
    if (!issues.length) return reply;
    this.options.logger?.detail(`Gemini naturalness rewrite: model=${this.model}, issues=${issues.join(',')}.`);
    try {
      const rewritten = await this.requestReply(buildNaturalRewritePrompt(prompt, reply.text, issues), modality);
      return { text: rewritten.text, usage: addUsage(reply.usage, rewritten.usage) };
    } catch (error) {
      if (issues.includes('reasoning_leak')) throw new GeminiApiError(503, 'Gemini returned internal reasoning and rewrite failed.');
      this.options.logger?.detail(`Gemini naturalness rewrite skipped: ${error instanceof Error ? error.message : String(error)}.`);
      return reply;
    }
  }

  private async fetchTurn(
    endpoint: URL,
    messages: readonly ConversationMessage[],
    modality: TurnEnvelope['modality']
  ): Promise<Response> {
    const systemInstruction = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      }));
    const payload = {
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents,
      generationConfig: { maxOutputTokens: this.options.maxOutputTokens }
    };
    const startedAt = performance.now();
    // The endpoint contains the key as a query parameter; never print it.
    this.options.logger?.detail(`Gemini API -> POST ${endpoint.pathname}: model=${this.model}, modality=${modality}, messages=${messages.length}.`);
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    this.options.logger?.detail(`Gemini API <- HTTP ${response.status} ${response.statusText || ''} in ${Math.round(performance.now() - startedAt)} ms.`);
    return response;
  }

  private toReply(
    text: string,
    finishReason: string | undefined,
    usage: GeminiGenerateContentResponse['usageMetadata']
  ): GeminiTextReply {
    const totalTokens = numberOrUndefined(usage?.totalTokenCount);
    if (totalTokens === undefined) throw new Error('Gemini response did not include total token usage.');
    return {
      text: completeTruncatedSentence(text, finishReason),
      usage: {
        promptTokens: numberOrUndefined(usage?.promptTokenCount) ?? 0,
        outputTokens: numberOrUndefined(usage?.candidatesTokenCount) ?? 0,
        totalTokens
      }
    };
  }

  private async record(input: TurnEnvelope, reply: GeminiTextReply): Promise<void> {
    await Promise.resolve(this.options.recordTurn?.(input, reply)).catch(() => undefined);
  }

  private async recordUsage(input: TurnEnvelope, usage: GeminiTokenUsage): Promise<void> {
    await Promise.resolve(this.options.recordUsage?.(input, usage, this.model)).catch(() => undefined);
  }
}

async function throwGeminiError(response: Response): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new GeminiApiError(response.status, detail);
}

function addUsage(left: GeminiTokenUsage, right: GeminiTokenUsage): GeminiTokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function normalizeStreamDelta(previous: string, received: string): string {
  if (!received) return '';
  return received.startsWith(previous) ? received.slice(previous.length) : received;
}

function completeTruncatedSentence(text: string, finishReason: string | undefined): string {
  if (finishReason !== 'MAX_TOKENS') return text;
  const lastSentenceEnd = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
  return lastSentenceEnd >= 0 ? text.slice(0, lastSentenceEnd + 1).trim() : `${text.trimEnd()}...`;
}

function logPreview(value: string, maxLength = 500): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return JSON.stringify(normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength) + '...');
}
function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
