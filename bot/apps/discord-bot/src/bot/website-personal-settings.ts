import type { VoiceProfile } from '@anime/contracts';
import { commandLanguageFromValue, type CommandLanguage } from './command-language.js';

export type RelationshipTone = 'friend' | 'flirting' | 'romantic';
export type ReplyLength = 'short' | 'medium' | 'long';
export type InterruptionMode = 'immediate' | 'stop_only';

export type WebsitePersonalSettings = {
  language?: CommandLanguage;
  relationshipTone?: RelationshipTone;
  replyLength?: ReplyLength;
  snsStyleEnabled?: boolean;
  expressiveVoice?: boolean;
  fastVoiceResponse?: boolean;
  interruptionMode?: InterruptionMode;
};

type SettingsRecord = Record<string, unknown>;

export function readWebsitePersonalSettings(user: SettingsRecord | null | undefined): WebsitePersonalSettings {
  if (!user) return {};
  const sources = settingsSources(user);
  const language = commandLanguageOf(readValue(sources, ['language', 'languageCode', 'language_code', 'preferredLanguage', 'preferred_language', 'displayLanguage', 'display_language', 'uiLanguage', 'ui_language', 'locale']));
  const relationshipTone = relationshipToneOf(readValue(sources, ['relationshipTone', 'relationship_tone', 'relationship', 'relationshipMode']));
  const replyLength = replyLengthOf(readValue(sources, ['replyLength', 'reply_length', 'responseLength', 'response_length', 'answerLength', 'answer_length']));
  const snsStyleEnabled = snsStyleEnabledOf(readValue(sources, ['snsStyleEnabled', 'sns_style_enabled', 'snsEnabled', 'sns_enabled', 'snsMode', 'sns_mode', 'textStyle', 'text_style']));
  const voiceStyle = normalisedValue(readValue(sources, ['voiceStyle', 'voice_style', 'voiceMode', 'voice_mode']));
  const configuredExpressiveVoice = booleanOf(readValue(sources, ['expressiveVoice', 'expressive_voice', 'voiceExpressive', 'voice_expressive']));
  const expressiveVoice = configuredExpressiveVoice ?? (voiceStyle ? (voiceStyle === 'expressive' || voiceStyle === 'expressivevoice' || voiceStyle === '\uD45C\uD604\uD615') : undefined);
  const configuredFastVoiceResponse = booleanOf(readValue(sources, ['fastVoiceResponse', 'fast_voice_response', 'fastResponse', 'fast_response', 'quickResponse', 'quick_response']));
  const fastVoiceResponse = configuredFastVoiceResponse ?? (voiceStyle ? (voiceStyle === 'fast' || voiceStyle === 'fastresponse' || voiceStyle === '\uBE60\uB978\uC751\uB2F5') : undefined);
  const interruptionMode = interruptionModeOf(readValue(sources, ['interruptionMode', 'interruption_mode', 'interruptMode', 'interrupt_mode', 'bargeInMode', 'barge_in_mode']));

  return {
    ...(language ? { language } : {}),
    ...(relationshipTone ? { relationshipTone } : {}),
    ...(replyLength ? { replyLength } : {}),
    ...(snsStyleEnabled === undefined ? {} : { snsStyleEnabled }),
    ...(expressiveVoice === undefined ? {} : { expressiveVoice }),
    ...(fastVoiceResponse === undefined ? {} : { fastVoiceResponse }),
    ...(interruptionMode ? { interruptionMode } : {})
  };
}

export function personalSettingsPayload(settings: WebsitePersonalSettings): Record<string, string | boolean> {
  return {
    ...(settings.language ? { language: settings.language } : {}),
    ...(settings.relationshipTone ? { relationshipTone: settings.relationshipTone } : {}),
    ...(settings.replyLength ? { replyLength: settings.replyLength } : {}),
    ...(settings.snsStyleEnabled === undefined ? {} : { snsStyleEnabled: settings.snsStyleEnabled }),
    ...(settings.expressiveVoice === undefined ? {} : { expressiveVoice: settings.expressiveVoice }),
    ...(settings.fastVoiceResponse === undefined ? {} : { fastVoiceResponse: settings.fastVoiceResponse }),
    ...(settings.interruptionMode ? { interruptionMode: settings.interruptionMode } : {})
  };
}

export function personalSettingsInstruction(settings: WebsitePersonalSettings): string | undefined {
  const directions: string[] = [];
  if (settings.language) directions.push('Preferred response language: ' + (settings.language === 'ja' ? 'Japanese' : settings.language === 'ko' ? 'Korean' : 'English') + '. Use it unless the user explicitly asks for another language.');
  if (settings.relationshipTone === 'friend') directions.push('Relationship tone: be a warm, relaxed friend. Do not initiate flirting.');
  if (settings.relationshipTone === 'flirting') directions.push('Relationship tone: allow light, mutual, PG-13 flirting when it fits the conversation; never pressure the user or imply dependency.');
  if (settings.relationshipTone === 'romantic') directions.push('Relationship tone: be warmly affectionate and intimate in a fictional, PG-13 way; never claim a real-world human relationship, exclusivity, or dependency.');
  if (settings.replyLength === 'short') directions.push('Reply length: keep the answer to one or two concise sentences unless the user explicitly asks for detail.');
  if (settings.replyLength === 'medium') directions.push('Reply length: use two to four complete sentences when useful.');
  if (settings.replyLength === 'long') directions.push('Reply length: give a thorough, well-structured answer when useful, while avoiding repetition.');
  if (settings.snsStyleEnabled === true) directions.push('Text style: use a relaxed contemporary social-message voice; natural short phrasing is welcome, but do not force slang.');
  if (settings.snsStyleEnabled === false) directions.push('Text style: use clear standard conversational language. Do not use casual abbreviations or SNS-style message splitting.');
  if (settings.expressiveVoice) directions.push('Voice style: use slightly clearer, more expressive emotional color while remaining natural.');
  if (settings.fastVoiceResponse) directions.push('Voice response mode: when speaking aloud, answer promptly in one concise sentence before adding detail only if the user asks.');
  return directions.length ? `Website personal preferences (apply these over the default style): ${directions.join(' ')}` : undefined;
}

export function applyPersonalVoiceSettings(profile: VoiceProfile, settings: WebsitePersonalSettings): VoiceProfile {
  if (!settings.expressiveVoice && !settings.fastVoiceResponse) return profile;
  const voiceSettings = { ...profile.settings };
  if (settings.expressiveVoice) {
    const baseStyle = typeof voiceSettings.style === 'string' ? `${voiceSettings.style} ` : '';
    voiceSettings.style = `${baseStyle}Use clear, expressive emotional variation that follows the meaning, but keep it natural and never theatrical.`;
  }
  if (settings.fastVoiceResponse) {
    const currentSpeed = typeof voiceSettings.speed === 'number' ? voiceSettings.speed : 1;
    voiceSettings.speed = Math.max(currentSpeed, 1.12);
  }
  return { ...profile, settings: voiceSettings };
}

export function limitReplyForPreference(text: string, settings: WebsitePersonalSettings): string {
  if (settings.replyLength !== 'short') return text;
  const sentences = splitSentences(text);
  return sentences.length > 2 ? sentences.slice(0, 2).join(' ') : text;
}

export function limitVoiceReplyForPreference(text: string, settings: WebsitePersonalSettings): string {
  const preferred = limitReplyForPreference(text, settings);
  if (!settings.fastVoiceResponse) return preferred;
  // The prompt already asks the model for one concise spoken sentence. Keep a
  // natural two-sentence emotional beat intact and trim only genuine overruns.
  const sentences = splitSentences(preferred);
  if (sentences.length <= 2 && Array.from(preferred).length <= 260) return preferred;
  return sentences.slice(0, 2).join(' ') || preferred.slice(0, 260);
}

export function shouldInterruptImmediately(settings: WebsitePersonalSettings): boolean {
  return settings.interruptionMode === 'immediate';
}

function settingsSources(user: SettingsRecord): SettingsRecord[] {
  const nestedKeys = ['preferences', 'personalSettings', 'personal_settings', 'conversationSettings', 'conversation_settings', 'voiceSettings', 'voice_settings', 'voice'];
  return [user, ...nestedKeys.map((key) => objectOf(user[key])).filter((value): value is SettingsRecord => value !== undefined)];
}

function readValue(sources: readonly SettingsRecord[], keys: readonly string[]): unknown {
  const targetKeys = new Set(keys.map(normaliseKey));
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (targetKeys.has(normaliseKey(key))) return value;
    }
  }
  return undefined;
}

function commandLanguageOf(value: unknown): CommandLanguage | undefined {
  return commandLanguageFromValue(value);
}function relationshipToneOf(value: unknown): RelationshipTone | undefined {
  const normalised = normalisedValue(value);
  if (['friend', 'friends', 'friendship', '\uCE5C\uAD6C'].includes(normalised)) return 'friend';
  if (['flirt', 'flirting', 'some', '\uC378'].includes(normalised)) return 'flirting';
  if (['romantic', 'romance', 'lover', 'love', '\uC5F0\uC778'].includes(normalised)) return 'romantic';
  return undefined;
}

function snsStyleEnabledOf(value: unknown): boolean | undefined {
  const boolean = booleanOf(value);
  if (boolean !== undefined) return boolean;
  const normalised = normalisedValue(value);
  if (['sns', 'social', 'casual', 'shortmessages'].includes(normalised)) return true;
  if (['standard', 'formal', 'plain', 'off'].includes(normalised)) return false;
  return undefined;
}

function replyLengthOf(value: unknown): ReplyLength | undefined {
  const normalised = normalisedValue(value);
  if (['short', 'brief', '\uC9E7\uAC8C'].includes(normalised)) return 'short';
  if (['medium', 'normal', 'standard', '\uBCF4\uD1B5'].includes(normalised)) return 'medium';
  if (['long', 'detailed', '\uAE38\uAC8C'].includes(normalised)) return 'long';
  return undefined;
}

function interruptionModeOf(value: unknown): InterruptionMode | undefined {
  const normalised = normalisedValue(value);
  if (['immediate', 'always', 'speech', 'talkimmediately', '\uB9D0\uD558\uBA74\uC989\uC2DC\uC911\uB2E8'].includes(normalised)) return 'immediate';
  if (['stop', 'stoponly', 'explicit', 'command', 'stop\uBA85\uB839\uC77C\uB54C\uB9CC\uC911\uB2E8'].includes(normalised)) return 'stop_only';
  return undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const normalised = normalisedValue(value);
  if (['true', 'on', 'enabled', 'yes'].includes(normalised)) return true;
  if (['false', 'off', 'disabled', 'no'].includes(normalised)) return false;
  return undefined;
}

function splitSentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function normalisedValue(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, '') : '';
}

function normaliseKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function objectOf(value: unknown): SettingsRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SettingsRecord : undefined;
}
