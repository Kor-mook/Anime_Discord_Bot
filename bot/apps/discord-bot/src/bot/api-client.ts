import type { CharacterSelection, ConversationReply, MemoryConsentUpdate, MemorySummary, TurnEnvelope, VoiceConsentCheck } from '@anime/contracts';
import type { ConversationApi } from '@anime/voice-worker';
import { createSelineVoiceProfile, selectSelineVoiceProfile } from './seline-voice.js';

type BackendApiClientOptions = { baseUrl: string; apiKey?: string; devEchoMode: boolean; fetchImpl?: typeof fetch; logger?: DetailLogger };
type DetailLogger = { detail: (...details: unknown[]) => void };
export type BotSettings = { guild?: Record<string, unknown> | null; channel?: Record<string, unknown> | null; user?: Record<string, unknown> | null };
export type BotAccount = {
  hasAccount: boolean;
  voiceConsent: boolean;
  voiceConsentUpdatedAt?: string | null;
  voiceSettings?: Record<string, unknown> | null;
};
export type PerformanceMetric = { discordUserId: string; guildId?: string; channelId?: string; eventType: 'stt' | 'llm' | 'tts' | 'barge_in'; durationMs: number; success: boolean; emptyText?: boolean; failureCode?: string; vadScore?: number; captureDurationMs?: number };
export type TokenUsageMetric = {
  discordUserId: string;
  guildId?: string;
  channelId?: string;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
};
export type TokenUsageSnapshot = { remainingPercent: number };
export type MemoryApiStatus = { enabled: boolean; plan: 'free' | 'like' | 'more' | 'love'; used: number; storageLimit: number; retrievalLimit: number };
export type MemoryListResult = { memories: MemorySummary[]; status: MemoryApiStatus };

export class BackendApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Website bot API request failed (${status}). ${detail}`);
    this.name = 'BackendApiError';
  }
}

export class BackendApiClient implements ConversationApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private selectedModel: string | undefined;

  constructor(private readonly options: BackendApiClientOptions) {
    this.baseUrl = new URL(options.baseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getModel(): string | undefined {
    return this.selectedModel;
  }

  setModel(model: string): void {
    this.selectedModel = model;
  }

  async createTurn(input: TurnEnvelope): Promise<ConversationReply> {
    if (this.options.devEchoMode) return createDevelopmentReply(input);
    const response = await this.request<unknown>('/api/bot/turn', 'POST', toWebsiteTurn(input, this.selectedModel));
    const reply = parseConversationReply(response, input.conversationId);

    return reply;
  }

  async hasWebsiteAccount(discordUserId: string): Promise<boolean> {
    if (this.options.devEchoMode) return true;
    return (await this.getAccount(discordUserId)).hasAccount;
  }

  /**
   * The account endpoint is the source of truth for voice-processing consent.
   * A missing account or any response without an explicit `true` consent is
   * intentionally treated as not allowed by callers.
   */
  async getAccount(discordUserId: string): Promise<BotAccount> {
    const params = new URLSearchParams({ discordUserId });
    return parseBotAccount(await this.request<unknown>(`/api/bot/account?${params.toString()}`, 'GET'));
  }

  /** The website owns token limits and exposes only the remaining percentage. */
  async getTokenUsage(discordUserId: string): Promise<TokenUsageSnapshot> {
    if (this.options.devEchoMode) return { remainingPercent: 100 };
    const params = new URLSearchParams({ discordUserId });
    return parseTokenUsage(await this.request<unknown>(`/api/bot/billing?${params.toString()}`, 'GET'));
  }

  async selectCharacter(input: CharacterSelection): Promise<void> {
    await this.request<void>('/api/bot/settings', 'PATCH', { ...input, discordUserId: input.actorUserId });
  }

  async updateMemoryConsent(input: MemoryConsentUpdate): Promise<void> {
    await this.request<void>('/api/bot/consent', 'POST', { ...input, discordUserId: input.userId });
  }

  /** `userId` is always the current Discord message author or voice speaker. */
  async listMemories(input: { userId: string; characterId?: string; query?: string }): Promise<MemoryListResult> {
    const params = new URLSearchParams({ discordUserId: input.userId, characterId: input.characterId ?? "seline" });
    if (input.query) params.set("query", input.query);
    return parseMemoryList(await this.request<unknown>(`/api/bot/memory?${params.toString()}`, "GET"));
  }

  async forgetMemories(input: { guildId?: string; userId: string }): Promise<void> {
    await this.request<void>('/api/bot/memory', 'DELETE', { ...input, discordUserId: input.userId });
  }

  async updateMemory(input: { id: string; userId: string; characterId?: string; guildId?: string; summary?: string; isPinned?: boolean; deletedAt?: string | null }): Promise<void> {
    await this.request<void>("/api/bot/memory", "PATCH", { ...input, discordUserId: input.userId, characterId: input.characterId ?? "seline" });
  }

  async canProcessVoice(input: VoiceConsentCheck): Promise<boolean> {
    if (this.options.devEchoMode) return true;
    const account = await this.getAccount(input.userId);
    return account.hasAccount && account.voiceConsent;
  }

  async getSettings(input: { discordUserId: string; guildId?: string; channelId?: string }): Promise<BotSettings> {
    const params = new URLSearchParams({ discordUserId: input.discordUserId });
    if (input.guildId) params.set('guildId', input.guildId);
    if (input.channelId) params.set('channelId', input.channelId);
    return parseSettings(await this.request<unknown>(`/api/bot/settings?${params.toString()}`, 'GET'));
  }

  async recordMetric(input: PerformanceMetric): Promise<void> { await this.request<void>('/api/bot/metrics', 'POST', input); }
  async recordTokenUsage(input: TokenUsageMetric): Promise<void> { await this.request<void>('/api/bot/metrics', 'POST', input); }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const startedAt = performance.now();
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    this.options.logger?.detail(`Bot API -> ${method} ${path}: body=${bodyText === undefined ? 'none' : `${bodyText.length} bytes redacted`}.`);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: bodyText });
    const text = response.status === 204 ? '' : await response.text().catch(() => '');
    this.options.logger?.detail(`Bot API <- HTTP ${response.status} ${response.statusText || ''} in ${Math.round(performance.now() - startedAt)} ms: body=${text.length} bytes redacted.`);
    if (!response.ok) throw new BackendApiError(response.status, text);
    if (response.status === 204 || !text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new BackendApiError(response.status, 'Expected a JSON response from the website bot API.'); }
  }
}

export class DirectGeminiVoiceApi implements ConversationApi {
  constructor(private readonly textApi: { createTurn(input: TurnEnvelope): Promise<{ text: string }>; streamTurn?(input: TurnEnvelope): AsyncGenerator<{ text: string }, { text: string }, void> }) {}

  async createTurn(input: TurnEnvelope): Promise<ConversationReply> {
    return this.toVoiceReply(input, (await this.textApi.createTurn(input)).text);
  }

  async *streamTurn(input: TurnEnvelope): AsyncGenerator<ConversationReply, void, void> {
    if (!this.textApi.streamTurn) { yield await this.createTurn(input); return; }
    let text = '';
    try {
      for await (const chunk of this.textApi.streamTurn(input)) {
        text += chunk.text;
        if (chunk.text) yield this.toVoiceReply(input, chunk.text);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Gemini returned an empty text response.') throw error;
      yield this.toVoiceReply(input, 'I caught part of that, but say it once more for me?');
      return;
    }
    if (text) yield this.toVoiceReply(input, '');
  }

  private toVoiceReply(input: TurnEnvelope, text: string): ConversationReply {
    return {
      conversationId: input.conversationId,
      text,
      voiceProfile: selectSelineVoiceProfile({
        userText: input.canonicalText,
        assistantText: text,
        preferredLanguage: voiceLanguageFromPreferences(input.personalPreferences)
      })
    };
  }
}

function toWebsiteTurn(input: TurnEnvelope, selectedModel?: string): Record<string, unknown> {
  const preferredLanguage = input.personalPreferences?.language;
  const locale = preferredLanguage === 'ja'
    ? 'ja-JP'
    : preferredLanguage === 'ko'
      ? 'ko-KR'
      : /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(input.canonicalText)
        ? 'ja-JP'
        : /[\uac00-\ud7a3]/u.test(input.canonicalText) ? 'ko-KR' : 'en-US';
  return { ...input, discordUserId: input.userId, messageId: input.eventId, inputType: input.modality, text: input.canonicalText, locale, ...(selectedModel ? { requestedModel: selectedModel } : {}) };
}
function voiceLanguageFromPreferences(preferences: TurnEnvelope['personalPreferences']): 'en-US' | 'ko' | 'ja' | undefined {
  const language = preferences?.language;
  return language === 'en-US' || language === 'ko' || language === 'ja' ? language : undefined;
}
function parseConversationReply(value: unknown, conversationId: string): ConversationReply {
  const root = objectOf(value);
  // The legacy deployed endpoint returns its completed answer directly in
  // `reply`, alongside diagnostic fields such as `context` and `modelInput`.
  // Treat that scalar as the answer before looking for newer envelopes.
  if (typeof root.reply === 'string' && root.reply.trim()) {
    return {
      conversationId: conversationIdFrom(root) ?? conversationId,
      text: root.reply,
      voiceProfile: root.voiceProfile as ConversationReply['voiceProfile']
    };
  }
  // The website has returned both a direct reply and an envelope during
  // rollouts. Read only text-like fields from those envelopes so a website
  // deployment cannot turn a successful model turn into a Discord failure.
  const candidates = replyCandidates(root);
  for (const candidate of candidates) {
    const text = replyText(candidate);
    if (text !== undefined) {
      return {
        conversationId: conversationIdFrom(candidate) ?? conversationIdFrom(root) ?? conversationId,
        text,
        voiceProfile: candidate.voiceProfile as ConversationReply['voiceProfile']
      };
    }
  }
  throw new Error(`Website bot API returned no reply text (response shape: ${responseShape(root)}).`);
}
function replyCandidates(root: Record<string, unknown>): Record<string, unknown>[] {
  const data = objectOf(root.data);
  const response = objectOf(root.response);
  const result = objectOf(root.result);
  return [root, objectOf(root.reply), data, objectOf(data.reply), response, objectOf(response.reply), result, objectOf(result.reply)]
    .filter((candidate, index, all) => Object.keys(candidate).length > 0 && all.indexOf(candidate) === index);
}
function replyText(candidate: Record<string, unknown>): string | undefined {
  for (const field of ['text', 'replyText', 'reply_text', 'content']) {
    const value = candidate[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const message = objectOf(candidate.message);
  const assistant = objectOf(candidate.assistant);
  for (const value of [candidate.message, message.text, message.content, assistant.text, assistant.content]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
function conversationIdFrom(candidate: Record<string, unknown>): string | undefined {
  return typeof candidate.conversationId === 'string' && candidate.conversationId ? candidate.conversationId : undefined;
}
function responseShape(root: Record<string, unknown>): string {
  const keys = (value: Record<string, unknown>) => Object.keys(value).sort().slice(0, 12).join(',') || 'none';
  const scalarKind = (value: unknown): string | undefined => {
    if (typeof value === 'string') return `string(${value.length})`;
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    return value === undefined || (value && typeof value === 'object') ? undefined : typeof value;
  };
  const nested = ['reply', 'data', 'response', 'result', 'message', 'assistant']
    .map((field) => {
      const value = objectOf(root[field]);
      return Object.keys(value).length
        ? `${field}=[${keys(value)}]`
        : scalarKind(root[field]) ? `${field}=${scalarKind(root[field])}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  return `root=[${keys(root)}]${nested.length ? `; ${nested.join('; ')}` : ''}`;
}
function parseSettings(value: unknown): BotSettings { const root = objectOf(value); return { guild: objectOf(root.guild), channel: objectOf(root.channel), user: objectOf(root.user) }; }
function parseBotAccount(value: unknown): BotAccount {
  const root = objectOf(value);
  const account = objectOf(root.account);
  const user = objectOf(root.user);
  // The flat response is the current contract, while deployed revisions wrap
  // the same fields in `account` and `user`. An explicit current value always
  // wins, particularly `false`, so a stale nested field cannot grant access.
  const hasAccount = typeof root.hasAccount === 'boolean'
    ? root.hasAccount
    : typeof account.linked === 'boolean'
      ? account.linked
      : Object.keys(account).length > 0 || Object.keys(user).length > 0;
  const voiceConsent = typeof root.voiceConsent === 'boolean'
    ? root.voiceConsent
    : typeof account.voiceConsent === 'boolean'
      ? account.voiceConsent
      : typeof user.voiceConsent === 'boolean'
        ? user.voiceConsent
        : user.voice_consent === true;
  const voiceConsentUpdatedAt = typeof root.voiceConsentUpdatedAt === 'string' || root.voiceConsentUpdatedAt === null
    ? root.voiceConsentUpdatedAt
    : typeof account.voiceConsentUpdatedAt === 'string' || account.voiceConsentUpdatedAt === null
      ? account.voiceConsentUpdatedAt
      : undefined;
  const voiceSettings = objectOf(root.voiceSettings);
  const legacyVoiceSettings = Object.keys(voiceSettings).length > 0 ? voiceSettings : objectOf(account.voiceSettings);
  return {
    hasAccount,
    voiceConsent,
    ...(voiceConsentUpdatedAt !== undefined ? { voiceConsentUpdatedAt } : {}),
    ...(Object.keys(legacyVoiceSettings).length > 0 ? { voiceSettings: legacyVoiceSettings } : {})
  };
}
function parseTokenUsage(value: unknown): TokenUsageSnapshot {
  const root = objectOf(value);
  const tokenUsage = objectOf(root.tokenUsage);
  const remainingPercent = tokenUsage.remainingPercent;
  if (typeof remainingPercent !== 'number' || !Number.isSafeInteger(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    throw new Error('Website bot API returned an invalid tokenUsage.remainingPercent.');
  }
  return { remainingPercent };
}
function parseMemoryList(value: unknown): MemoryListResult {
  const root = objectOf(value); const rows = Array.isArray(value) ? value : Array.isArray(root.memories) ? root.memories : [];
  const status = objectOf(root.status);
  const plan = status.plan;
  if ((plan !== 'free' && plan !== 'like' && plan !== 'more' && plan !== 'love') || typeof status.enabled !== 'boolean' || typeof status.used !== 'number' || typeof status.storageLimit !== 'number' || typeof status.retrievalLimit !== 'number') throw new Error('Website bot API returned invalid memory status.');
  const memories = rows.flatMap((item) => { const row = objectOf(item); const summary = typeof row.summary === 'string' ? row.summary : typeof row.content === 'string' ? row.content : undefined; const id = typeof row.id === 'string' ? row.id : undefined; return id && summary ? [{ id, summary, createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(), isPinned: row.isPinned === true, ...(typeof row.confidence === 'number' ? { confidence: row.confidence } : {}), ...(typeof row.evidenceCount === 'number' ? { evidenceCount: row.evidenceCount } : {}) }] : []; });
  return { memories, status: { enabled: status.enabled, plan, used: status.used, storageLimit: status.storageLimit, retrievalLimit: status.retrievalLimit } };
}
function objectOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function createDevelopmentReply(input: TurnEnvelope): ConversationReply { return { conversationId: input.conversationId, text: `[development mode] ${input.canonicalText}`, voiceProfile: createSelineVoiceProfile() }; }
