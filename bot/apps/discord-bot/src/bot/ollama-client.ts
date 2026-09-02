import {
  buildConversationPrompt,
  buildNaturalRewritePrompt,
  inspectNaturalness,
  shouldUseReasoning,
  type ConversationMessage,
  type ConversationPromptContext,
  type TurnEnvelope
} from '@anime/contracts';
import type { GeminiTokenUsage } from './gemini-client.js';
import { CHAT_INPUT_MAX_CHARS, limitTextForBudget } from './request-budget.js';

export type OllamaTextReply = { text: string; usage: GeminiTokenUsage };
type DetailLogger = { detail: (...details: unknown[]) => void };

export class OllamaApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Ollama API request failed (${status}). ${detail}`);
  }
}

export class OllamaReasoningLeakError extends OllamaApiError {
  constructor() {
    super(503, 'Ollama returned internal reasoning instead of a user-facing reply.');
    this.name = 'OllamaReasoningLeakError';
    // Keep the retryable status for automatic fallback, but do not misreport
    // this validation failure as a real HTTP 503 in the bot log.
    this.message = 'Ollama returned internal reasoning instead of a user-facing reply.';
  }
}

type OllamaChatResponse = {
  message?: { content?: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
};

export class OllamaTextClient {
  private model: string;

  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    maxOutputTokens: number;
    systemInstruction?: string;
    contextFor?: (input: TurnEnvelope) => string | ConversationPromptContext | undefined | Promise<string | ConversationPromptContext | undefined>;
    recordTurn?: (input: TurnEnvelope, reply: OllamaTextReply) => void | Promise<void>;
    recordUsage?: (input: TurnEnvelope, usage: GeminiTokenUsage, model: string) => void | Promise<void>;
    logger?: DetailLogger;
    fetchImpl?: typeof fetch;
  }) {
    this.model = options.model;
  }

  getModel(): string { return this.model; }

  setModel(model: string): void { this.model = model; }

  async createTurn(input: TurnEnvelope): Promise<OllamaTextReply> {
    const text = limitTextForBudget(input.canonicalText, input.modality === 'voice' ? 1_500 : CHAT_INPUT_MAX_CHARS).text;
    const boundedInput = { ...input, canonicalText: text };
    const context = await this.options.contextFor?.(boundedInput);
    const prompt = buildConversationPrompt(boundedInput, {
      systemInstruction: this.options.systemInstruction
        ? this.options.systemInstruction + ' Return only the reply for the user; never reveal analysis or reasoning.'
        : undefined,
      context
    });
    const useReasoning = isQwen3Model(this.model) && shouldUseReasoning(boundedInput);
    let reply: OllamaTextReply;
    try {
      reply = await this.requestReply(prompt.messages, useReasoning, input.modality);
    } catch (error) {
      // Some local reasoning models occasionally place their draft in
      // `message.content` even when `think: true` is requested. Do not turn
      // that recoverable response into an apparent HTTP 503 for the user.
      // Ask once more with thinking disabled before handing the error to the
      // configured fallback model (if any).
      if (!(error instanceof OllamaReasoningLeakError) || !isQwen3Model(this.model)) throw error;
      reply = await this.requestReply(prompt.messages, false, input.modality);
    }

    const issues = inspectNaturalness(reply.text, prompt);
    if (issues.length) {
      this.options.logger?.detail(`Ollama naturalness rewrite: model=${this.model}, issues=${issues.join(',')}.`);
      try {
        const rewritten = await this.requestReply(buildNaturalRewritePrompt(prompt, reply.text, issues), false, input.modality);
        reply = { text: rewritten.text, usage: addUsage(reply.usage, rewritten.usage) };
      } catch (error) {
        // A quality rewrite is best-effort. Preserve the valid original reply
        // instead of turning style polish into a provider failure.
        this.options.logger?.detail(`Ollama naturalness rewrite skipped: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    await Promise.resolve(this.options.recordTurn?.(boundedInput, reply)).catch(() => undefined);
    await Promise.resolve(this.options.recordUsage?.(boundedInput, reply.usage, this.model)).catch(() => undefined);
    return reply;
  }

  private async requestReply(
    messages: readonly ConversationMessage[],
    separatesThinking: boolean,
    modality: TurnEnvelope['modality']
  ): Promise<OllamaTextReply> {
    const response = await (this.options.fetchImpl ?? fetch)(new URL('/api/chat', this.options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: separatesThinking,
        messages,
        options: {
          num_ctx: 4_096,
          num_predict: separatesThinking ? Math.max(this.options.maxOutputTokens, 1_024) : this.options.maxOutputTokens,
          temperature: modality === 'voice' ? 0.68 : 0.78,
          top_p: 0.9,
          top_k: 40,
          repeat_penalty: 1.08
        }
      })
    });
    if (!response.ok) throw new OllamaApiError(response.status, await response.text());

    const body = await response.json() as OllamaChatResponse;
    const answer = removeThinkBlocks(body.message?.content ?? '');
    if (!answer) {
      if (body.message?.thinking?.trim()) throw new OllamaReasoningLeakError();
      throw new Error('Ollama returned an empty text response.');
    }
    if (looksLikeInternalReasoning(answer)) throw new OllamaReasoningLeakError();

    const promptTokens = body.prompt_eval_count ?? 0;
    const outputTokens = body.eval_count ?? 0;
    return { text: answer, usage: { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens } };
  }
}

function addUsage(left: GeminiTokenUsage, right: GeminiTokenUsage): GeminiTokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function isQwen3Model(model: string): boolean {
  return model.trim().toLowerCase().startsWith('qwen3');
}

export function removeThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

export function looksLikeInternalReasoning(text: string): boolean {
  return /^(?:okay|alright|let me|first,?\s+i\s+(?:need|should)|the user\s+(?:said|wrote|is)|i need to\s+(?:respond|recall|think)|since the user)/i.test(text.trim());
}
