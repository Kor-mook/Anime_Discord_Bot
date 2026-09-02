import {
  buildConversationPrompt,
  buildNaturalRewritePrompt,
  inspectNaturalness,
  type ConversationMessage,
  type ConversationPromptContext,
  type TurnEnvelope
} from '@anime/contracts';
import type { GeminiTokenUsage } from './gemini-client.js';
import { CHAT_INPUT_MAX_CHARS, limitTextForBudget } from './request-budget.js';

type LocalContextHooks = {
  contextFor?: (input: TurnEnvelope) => string | ConversationPromptContext | undefined | Promise<string | ConversationPromptContext | undefined>;
  recordTurn?: (input: TurnEnvelope, reply: GrokTextReply) => void | Promise<void>;
  recordUsage?: (input: TurnEnvelope, usage: GeminiTokenUsage, model: string) => void | Promise<void>;
};

type DetailLogger = { detail: (...details: unknown[]) => void };

export type GrokTextReply = { text: string; usage: GeminiTokenUsage };

export class GrokApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super('Grok API request failed (' + status + '). ' + detail);
    this.name = 'GrokApiError';
  }
}

type GrokChatCompletion = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export class GrokTextClient {
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

  getModel(): string { return this.model; }

  setModel(model: string): void { this.model = model; }

  async createTurn(input: TurnEnvelope): Promise<GrokTextReply> {
    const inputLimit = input.modality === 'voice' ? 1_500 : CHAT_INPUT_MAX_CHARS;
    const boundedInput = { ...input, canonicalText: limitTextForBudget(input.canonicalText, inputLimit).text };
    const localContext = await this.options.contextFor?.(boundedInput);
    const prompt = buildConversationPrompt(boundedInput, {
      systemInstruction: this.options.systemInstruction,
      context: localContext
    });
    let reply = await this.requestReply(prompt.messages);
    const issues = inspectNaturalness(reply.text, prompt);
    if (issues.length) {
      this.options.logger?.detail('Grok naturalness rewrite: model=' + this.model + ', issues=' + issues.join(',') + '.');
      try {
        const rewritten = await this.requestReply(buildNaturalRewritePrompt(prompt, reply.text, issues));
        reply = { text: rewritten.text, usage: addUsage(reply.usage, rewritten.usage) };
      } catch (error) {
        if (issues.includes('reasoning_leak')) throw new GrokApiError(503, 'Grok returned internal reasoning and rewrite failed.');
        this.options.logger?.detail('Grok naturalness rewrite skipped: ' + (error instanceof Error ? error.message : String(error)) + '.');
      }
    }
    await Promise.resolve(this.options.recordTurn?.(boundedInput, reply)).catch(() => undefined);
    await Promise.resolve(this.options.recordUsage?.(boundedInput, reply.usage, this.model)).catch(() => undefined);
    return reply;
  }

  private async requestReply(messages: readonly ConversationMessage[]): Promise<GrokTextReply> {
    const payload = {
      model: this.model,
      messages,
      max_tokens: this.options.maxOutputTokens
    };
    const endpoint = new URL('https://api.x.ai/v1/chat/completions');
    const startedAt = performance.now();
    this.options.logger?.detail('Grok API -> POST ' + endpoint.pathname + ': model=' + this.model + '.');
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.options.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    this.options.logger?.detail('Grok API <- HTTP ' + response.status + ' ' + (response.statusText || '') + ' in ' + Math.round(performance.now() - startedAt) + ' ms.');
    if (!response.ok) throw new GrokApiError(response.status, await response.text().catch(() => ''));
    const body = await response.json() as GrokChatCompletion;
    const text = contentText(body.choices?.[0]?.message?.content).trim();
    if (!text) throw new Error('Grok returned an empty text response.');
    const totalTokens = numberOrUndefined(body.usage?.total_tokens);
    if (totalTokens === undefined) throw new Error('Grok response did not include total token usage.');
    const reply = {
      text,
      usage: {
        promptTokens: numberOrUndefined(body.usage?.prompt_tokens) ?? 0,
        outputTokens: numberOrUndefined(body.usage?.completion_tokens) ?? 0,
        totalTokens
      }
    };
    return reply;
  }
}

function addUsage(left: GeminiTokenUsage, right: GeminiTokenUsage): GeminiTokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function contentText(content: string | Array<{ text?: string }> | undefined): string {
  return typeof content === 'string' ? content : content?.map((part) => part.text ?? '').join('') ?? '';
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
