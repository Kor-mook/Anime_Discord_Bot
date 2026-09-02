import { Pool, type PoolConfig } from 'pg';
import type { ConversationPromptContext, TurnEnvelope } from '@anime/contracts';
import type { TerminalLogMode } from './terminal-console.js';

const MAX_TURNS_PER_CONVERSATION = 48;

export type VoiceJoinMode = 'auto' | 'manual';
export type VoiceRecognitionLanguage = 'auto' | 'en' | 'ko' | 'ja';
export type LongTermMemory = { summary: string; evidenceCount: number; lastSeenAt: string };
export type PostgresStateStoreOptions = { onPoolError?: (error: Error) => void; createPool?: (config: PoolConfig) => Pool };

/** PostgreSQL-backed durable state. Discord IDs are the shared web-account key. */
export class PostgresStateStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string, poolConfig: Partial<PoolConfig> = {}, options: PostgresStateStoreOptions = {}) {
    const config: PoolConfig = { connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false }, ...poolConfig };
    this.pool = (options.createPool ?? ((value) => new Pool(value)))(config);
    this.pool.on('error', (error) => options.onPoolError?.(sanitizePoolError(error)));
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bot_conversation_turns (
        id BIGSERIAL PRIMARY KEY, discord_user_id TEXT NOT NULL, guild_id TEXT, channel_id TEXT, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS bot_conversation_turns_scope_idx ON bot_conversation_turns (discord_user_id, guild_id, channel_id, id DESC);
      CREATE TABLE IF NOT EXISTS bot_voice_behavior (
        discord_user_id TEXT NOT NULL, guild_id TEXT, channel_id TEXT, interruption_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (discord_user_id, guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS bot_user_preferences (
        discord_user_id TEXT NOT NULL, guild_id TEXT, sns_enabled BOOLEAN NOT NULL DEFAULT TRUE, language TEXT NOT NULL DEFAULT 'en-US' CHECK (language IN ('en-US','ko','ja')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (discord_user_id, guild_id)
      );
      CREATE TABLE IF NOT EXISTS bot_voice_join_settings (
        guild_id TEXT PRIMARY KEY, mode TEXT CHECK (mode IN ('auto','manual')), prompted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_voice_language_settings (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'auto' CHECK (language IN ('auto','en','ko','ja')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS bot_text_channel_settings (
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS bot_runtime_settings (
        setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.migrateLanguageConstraints();
  }

  async migrateLanguageConstraints(): Promise<void> {
    // CREATE TABLE IF NOT EXISTS does not widen constraints in existing installs.
    await this.pool.query(`
      ALTER TABLE bot_user_preferences DROP CONSTRAINT IF EXISTS bot_user_preferences_language_check;
      ALTER TABLE bot_user_preferences ADD CONSTRAINT bot_user_preferences_language_check CHECK (language IN ('en-US', 'ko', 'ja'));
      ALTER TABLE bot_voice_language_settings DROP CONSTRAINT IF EXISTS bot_voice_language_settings_language_check;
      ALTER TABLE bot_voice_language_settings ADD CONSTRAINT bot_voice_language_settings_language_check CHECK (language IN ('auto', 'en', 'ko', 'ja'));
    `);
  }
  async contextFor(input: TurnEnvelope, options?: { snsStyleEnabled?: boolean }): Promise<ConversationPromptContext> {
    const [turns, behavior, preference] = await Promise.all([
      this.pool.query<{ role: 'user' | 'assistant'; text: string; created_at: Date | string }>('SELECT role, text, created_at FROM bot_conversation_turns WHERE discord_user_id=$1 AND guild_id IS NOT DISTINCT FROM $2 AND channel_id IS NOT DISTINCT FROM $3 ORDER BY id DESC LIMIT $4', [input.userId, input.guildId ?? null, input.channelId ?? null, input.modality === 'voice' ? 8 : 12]),
      this.pool.query<{ interruption_count: number }>('SELECT interruption_count FROM bot_voice_behavior WHERE discord_user_id=$1 AND guild_id IS NOT DISTINCT FROM $2 AND channel_id IS NOT DISTINCT FROM $3', [input.userId, input.guildId ?? null, input.channelId ?? null]),
      this.getPreference(input)
    ]);
    const parts = ["Language rule: reply in the same language as the user's latest message."];
    if (input.modality === 'voice' && (behavior.rows[0]?.interruption_count ?? 0) >= 3) parts.push('Voice preference: this user often interrupts. Reply in one concise sentence, then leave room for them to speak.');
    if (input.modality !== 'voice') parts.push((options?.snsStyleEnabled ?? preference.snsEnabled) ? 'Text style preference: use a relaxed contemporary social-message voice.' : 'Text style preference: use clear standard conversational language.');
    return {
      instructions: parts.join('\n\n'),
      recentMessages: turns.rows.reverse().map((turn) => ({ role: turn.role, content: turn.text })),
      ...(turns.rows.at(-1)?.created_at ? { lastInteractionAt: new Date(turns.rows.at(-1)!.created_at).toISOString() } : {})
    };
  }
  async recordTurn(input: TurnEnvelope, replyText: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query('INSERT INTO bot_conversation_turns (discord_user_id,guild_id,channel_id,role,text) VALUES ($1,$2,$3,$4,$5),($1,$2,$3,$6,$7)', [input.userId,input.guildId ?? null,input.channelId ?? null,'user',limitText(input.canonicalText),'assistant',limitText(replyText)]); await client.query('DELETE FROM bot_conversation_turns WHERE discord_user_id=$1 AND guild_id IS NOT DISTINCT FROM $2 AND channel_id IS NOT DISTINCT FROM $3 AND id NOT IN (SELECT id FROM bot_conversation_turns WHERE discord_user_id=$1 AND guild_id IS NOT DISTINCT FROM $2 AND channel_id IS NOT DISTINCT FROM $3 ORDER BY id DESC LIMIT $4)', [input.userId,input.guildId ?? null,input.channelId ?? null,MAX_TURNS_PER_CONVERSATION]); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async recordBargeIn(input: Pick<TurnEnvelope,'userId'|'guildId'|'channelId'>): Promise<void> { await this.pool.query('INSERT INTO bot_voice_behavior (discord_user_id,guild_id,channel_id,interruption_count) VALUES ($1,$2,$3,1) ON CONFLICT (discord_user_id,guild_id,channel_id) DO UPDATE SET interruption_count=bot_voice_behavior.interruption_count+1,updated_at=NOW()', [input.userId,input.guildId ?? null,input.channelId ?? null]); }
  async isSnsStyleEnabled(input: Pick<TurnEnvelope,'userId'|'guildId'>): Promise<boolean> { return (await this.getPreference(input)).snsEnabled; }
  async setSnsStyleEnabled(input: Pick<TurnEnvelope,'userId'|'guildId'>, enabled: boolean): Promise<void> { await this.pool.query('INSERT INTO bot_user_preferences (discord_user_id,guild_id,sns_enabled) VALUES ($1,$2,$3) ON CONFLICT (discord_user_id,guild_id) DO UPDATE SET sns_enabled=EXCLUDED.sns_enabled,updated_at=NOW()', [input.userId,input.guildId ?? null,enabled]); }
  async getLanguage(input: Pick<TurnEnvelope,'userId'|'guildId'>): Promise<'en-US'|'ko'|'ja'> { return (await this.getPreference(input)).language; }
  async setLanguage(input: Pick<TurnEnvelope,'userId'|'guildId'>, language: 'en-US'|'ko'|'ja'): Promise<void> { await this.pool.query('INSERT INTO bot_user_preferences (discord_user_id,guild_id,language) VALUES ($1,$2,$3) ON CONFLICT (discord_user_id,guild_id) DO UPDATE SET language=EXCLUDED.language,updated_at=NOW()', [input.userId,input.guildId ?? null,language]); }
  async getVoiceJoinMode(guildId: string): Promise<VoiceJoinMode | undefined> { const r = await this.pool.query<{mode: string}>('SELECT mode FROM bot_voice_join_settings WHERE guild_id=$1',[guildId]); return r.rows[0]?.mode === 'auto' || r.rows[0]?.mode === 'manual' ? r.rows[0].mode : undefined; }
  async hasVoiceJoinPrompt(guildId: string): Promise<boolean> { return (await this.pool.query('SELECT 1 FROM bot_voice_join_settings WHERE guild_id=$1 AND prompted_at IS NOT NULL',[guildId])).rowCount === 1; }
  async markVoiceJoinPrompted(guildId: string): Promise<void> { await this.pool.query('INSERT INTO bot_voice_join_settings (guild_id,prompted_at) VALUES ($1,NOW()) ON CONFLICT (guild_id) DO UPDATE SET prompted_at=COALESCE(bot_voice_join_settings.prompted_at,NOW()),updated_at=NOW()',[guildId]); }
  async setVoiceJoinMode(guildId: string, mode: VoiceJoinMode): Promise<void> { await this.pool.query('INSERT INTO bot_voice_join_settings (guild_id,mode) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET mode=EXCLUDED.mode,updated_at=NOW()',[guildId,mode]); }
  async getVoiceRecognitionLanguage(guildId: string, channelId: string): Promise<VoiceRecognitionLanguage> { const r=await this.pool.query<{language:string}>('SELECT language FROM bot_voice_language_settings WHERE guild_id=$1 AND channel_id=$2',[guildId,channelId]); return r.rows[0]?.language === 'en' || r.rows[0]?.language === 'ko' || r.rows[0]?.language === 'ja' ? r.rows[0].language : 'auto'; }
  async setVoiceRecognitionLanguage(guildId: string, channelId: string, language: VoiceRecognitionLanguage): Promise<void> { await this.pool.query('INSERT INTO bot_voice_language_settings (guild_id,channel_id,language) VALUES ($1,$2,$3) ON CONFLICT (guild_id,channel_id) DO UPDATE SET language=EXCLUDED.language,updated_at=NOW()',[guildId,channelId,language]); }
  async getConsoleSettings(): Promise<{ logMode: TerminalLogMode; defaultModel?: string }> { const r=await this.pool.query<{setting_key:string;setting_value:string}>('SELECT setting_key,setting_value FROM bot_runtime_settings WHERE setting_key IN ($1,$2)',['console.log_mode','console.default_model']); const settings=Object.fromEntries(r.rows.map(x=>[x.setting_key,x.setting_value])); return { logMode: settings['console.log_mode'] === 'detail' ? 'detail' : 'compact', defaultModel: settings['console.default_model'] || undefined }; }
  async saveConsoleSettings(settings: { logMode: TerminalLogMode; defaultModel?: string }): Promise<void> { await this.pool.query('INSERT INTO bot_runtime_settings (setting_key,setting_value) VALUES ($1,$2),($3,$4) ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()', ['console.log_mode',settings.logMode,'console.default_model',settings.defaultModel ?? '']); }
  async close(): Promise<void> { await this.pool.end(); }
  poolStats(): { total: number; idle: number; waiting: number } { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }; }
  async isTextChatEnabled(guildId: string, channelId: string): Promise<boolean> { const r=await this.pool.query<{chat_enabled:boolean}>('SELECT chat_enabled FROM bot_text_channel_settings WHERE guild_id=$1 AND channel_id=$2',[guildId,channelId]); return r.rows[0]?.chat_enabled ?? true; }
  async setTextChatEnabled(guildId: string, channelId: string, enabled: boolean): Promise<void> { await this.pool.query('INSERT INTO bot_text_channel_settings (guild_id,channel_id,chat_enabled) VALUES ($1,$2,$3) ON CONFLICT (guild_id,channel_id) DO UPDATE SET chat_enabled=EXCLUDED.chat_enabled,updated_at=NOW()',[guildId,channelId,enabled]); }
  private async getPreference(input: Pick<TurnEnvelope,'userId'|'guildId'>): Promise<{snsEnabled:boolean;language:'en-US'|'ko'|'ja'}> { const r=await this.pool.query<{sns_enabled:boolean;language:string}>('SELECT sns_enabled,language FROM bot_user_preferences WHERE discord_user_id=$1 AND guild_id IS NOT DISTINCT FROM $2',[input.userId,input.guildId ?? null]); return { snsEnabled:r.rows[0]?.sns_enabled ?? true,language:r.rows[0]?.language === 'ko' || r.rows[0]?.language === 'ja' ? r.rows[0].language : 'en-US' }; }
}
function limitText(text: string): string { return text.trim().slice(0,1200); }
function sanitizePoolError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  return new Error(raw.replace(/postgres(?:ql)?:\/\/[^\s@/]+@/giu, 'postgres://[redacted]@').replace(/password\s*=\s*[^\s,;]+/giu, 'password=[redacted]').replace(/[\r\n]+/gu, ' ').slice(0, 500) || 'PostgreSQL pool idle client error.');
}
