import type { TurnEnvelope } from '@anime/contracts';
import type { GeminiTokenUsage } from './gemini-client.js';

export type TextModelReply = {
  text: string;
  usage?: GeminiTokenUsage;
  /** Set only when this response came from the active fallback model. */
  fallbackModel?: string;
};

export type ModelClient = {
  createTurn(input: TurnEnvelope): Promise<TextModelReply>;
  getModel(): string;
  setModel(model: string): void;
};

type DetailLogger = { detail: (...details: unknown[]) => void };

/**
 * The fallback model is selected only by the process-local console. The
 * original TurnEnvelope is reused, so both models get identical conversation
 * and long-term-memory context.
 */
export class AutomaticFallbackTextClient implements ModelClient {
  private fallback: ModelClient | undefined;
  private fallbackModel: string | undefined;
  private fallbackEnabled = false;

  constructor(private readonly options: {
    primary: ModelClient;
    createFallback: (model: string) => ModelClient;
    retryAttempts?: number;
    logger?: DetailLogger;
  }) {}

  getModel(): string { return this.options.primary.getModel(); }
  setModel(model: string): void {
    // A model selection can also mean a provider selection (for example,
    // Gemini -> Ollama). Recreate the client so the new model never remains
    // attached to the previous provider''s API endpoint.
    if (model === this.options.primary.getModel()) return;
    this.options.primary = this.options.createFallback(model);
  }
  getFallbackModel(): string | undefined { return this.fallbackModel; }
  isFallbackEnabled(): boolean { return this.fallbackEnabled; }

  setFallbackModel(model: string): void {
    if (model === this.getModel()) throw new Error('Fallback model must be different from the active model.');
    this.fallback = this.options.createFallback(model);
    this.fallbackModel = model;
  }

  setFallbackEnabled(enabled: boolean): void {
    if (enabled && !this.fallback) throw new Error('Select a fallback model before enabling automatic fallback.');
    this.fallbackEnabled = enabled;
  }

  async createTurn(input: TurnEnvelope): Promise<TextModelReply> {
    try {
      return await this.options.primary.createTurn(input);
    } catch (firstError) {
      if (!this.canFailOver(firstError)) throw firstError;

      let lastError = firstError;
      const retries = this.options.retryAttempts ?? 1;
      for (let attempt = 0; attempt < retries; attempt += 1) {
        this.options.logger?.detail(`LLM primary retry ${attempt + 1}/${retries}: model=${this.getModel()}, reason=${errorLabel(lastError)}.`);
        try {
          return await this.options.primary.createTurn(input);
        } catch (error) {
          lastError = error;
          if (!isRetryableModelError(error)) throw error;
        }
      }

      const fallback = this.fallback!;
      const fallbackModel = this.fallbackModel ?? fallback.getModel();
      this.options.logger?.detail(`LLM failover: primary=${this.getModel()}, fallback=${fallbackModel}, reason=${errorLabel(lastError)}.`);
      const reply = await fallback.createTurn(input);
      return { ...reply, fallbackModel };
    }
  }

  private canFailOver(error: unknown): boolean {
    return this.fallbackEnabled && Boolean(this.fallback)
      && this.fallback!.getModel() !== this.getModel() && isRetryableModelError(error);
  }
}

/** Temporary provider failures only; bad requests and authentication never switch models. */
export function isRetryableModelError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError'
    || /(?:timed?\s*out|timeout|network|fetch failed|econnreset|eai_again)/i.test(error.message);
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 240) : String(error);
}