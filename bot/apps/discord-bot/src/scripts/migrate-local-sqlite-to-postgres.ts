/**
 * One-time, explicit importer. It never deletes or modifies the SQLite/JSON
 * sources. Run only after BOT_DATABASE_URL points at the shared Neon database.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { PostgresStateStore } from '../bot/postgres-state-store.js';

const sqlitePath = resolve(process.argv[2] ?? 'data/seline-local.sqlite');
const consolePath = resolve(process.argv[3] ?? 'data/seline-console-settings.json');
const databaseUrl = process.env.BOT_DATABASE_URL;
if (!databaseUrl) throw new Error('BOT_DATABASE_URL is required.');
if (!existsSync(sqlitePath)) throw new Error(`SQLite source was not found: ${sqlitePath}`);

const state = new PostgresStateStore(databaseUrl);
await state.initialize();
const source = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false } });

try {
  await importTurns();
  await importVoiceSettings();
  await importPreferences();
  await importConsoleSettings();
  console.info(`Imported durable bot state from ${sqlitePath}. Source files were left unchanged.`);
} finally {
  source.close();
  await pool.end();
  await state.close();
}

async function importTurns() {
  if (!hasTable('conversation_turns')) return;
  for (const row of source.prepare('SELECT scope, role, text, created_at FROM conversation_turns').all() as Array<Record<string, unknown>>) {
    const [guildId, channelId, userId] = splitScope(String(row.scope));
    await pool.query('INSERT INTO bot_conversation_turns (discord_user_id,guild_id,channel_id,role,text,created_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()))', [userId, guildId, channelId, row.role, row.text, row.created_at]);
  }
}
async function importVoiceSettings() {
  if (hasTable('voice_join_settings')) for (const row of source.prepare('SELECT guild_id, mode, prompted_at FROM voice_join_settings').all() as Array<Record<string, unknown>>) await pool.query('INSERT INTO bot_voice_join_settings (guild_id,mode,prompted_at) VALUES ($1,$2,COALESCE($3::timestamptz,NOW())) ON CONFLICT (guild_id) DO UPDATE SET mode=EXCLUDED.mode,prompted_at=EXCLUDED.prompted_at,updated_at=NOW()', [row.guild_id,row.mode,row.prompted_at]);
  if (hasTable('voice_join_bot_prompts')) for (const row of source.prepare('SELECT guild_id, prompted_at FROM voice_join_bot_prompts').all() as Array<Record<string, unknown>>) await pool.query('INSERT INTO bot_voice_join_settings (guild_id,prompted_at) VALUES ($1,COALESCE($2::timestamptz,NOW())) ON CONFLICT (guild_id) DO UPDATE SET prompted_at=COALESCE(bot_voice_join_settings.prompted_at,EXCLUDED.prompted_at),updated_at=NOW()', [row.guild_id,row.prompted_at]);
  if (hasTable('voice_language_settings')) for (const row of source.prepare('SELECT guild_id, channel_id, language, updated_at FROM voice_language_settings').all() as Array<Record<string, unknown>>) await pool.query('INSERT INTO bot_voice_language_settings (guild_id,channel_id,language,updated_at) VALUES ($1,$2,$3,COALESCE($4::timestamptz,NOW())) ON CONFLICT (guild_id,channel_id) DO UPDATE SET language=EXCLUDED.language,updated_at=EXCLUDED.updated_at', [row.guild_id,row.channel_id,row.language,row.updated_at]);
}
async function importPreferences() {
  const preferences = new Map<string, { sns?: boolean; language?: string }>();
  if (hasTable('text_style_settings')) for (const row of source.prepare('SELECT scope, sns_enabled FROM text_style_settings').all() as Array<Record<string, unknown>>) preferences.set(String(row.scope), { sns: Number(row.sns_enabled) !== 0 });
  if (hasTable('language_settings')) for (const row of source.prepare('SELECT scope, language FROM language_settings').all() as Array<Record<string, unknown>>) preferences.set(String(row.scope), { ...preferences.get(String(row.scope)), language: String(row.language) });
  for (const [scope, preference] of preferences) { const [guildId, userId] = splitPreferenceScope(scope); await pool.query('INSERT INTO bot_user_preferences (discord_user_id,guild_id,sns_enabled,language) VALUES ($1,$2,$3,$4) ON CONFLICT (discord_user_id,guild_id) DO UPDATE SET sns_enabled=EXCLUDED.sns_enabled,language=EXCLUDED.language,updated_at=NOW()', [userId,guildId,preference.sns ?? true,preference.language === 'ko' ? 'ko' : 'en-US']); }
}
async function importConsoleSettings() {
  if (!existsSync(consolePath)) return;
  const saved = JSON.parse(readFileSync(consolePath, 'utf8')) as { logMode?: unknown; defaultModel?: unknown };
  await state.saveConsoleSettings({ logMode: saved.logMode === 'detail' ? 'detail' : 'compact', defaultModel: typeof saved.defaultModel === 'string' ? saved.defaultModel.trim() || undefined : undefined });
}
function hasTable(name: string) { return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function splitScope(scope: string): [string | null, string | null, string] { const parts = scope.split(':'); return [parts[0] === 'dm' ? null : parts[0] || null, parts[1] === 'direct' ? null : parts[1] || null, parts.slice(2).join(':')]; }
function splitPreferenceScope(scope: string): [string | null, string] { const index = scope.lastIndexOf(':'); return [scope.slice(0,index) === 'dm' ? null : scope.slice(0,index) || null, scope.slice(index + 1)]; }
