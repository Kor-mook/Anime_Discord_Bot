export { SELINE_PERSONA } from './seline-persona.js';
export { characterCatalog, DEFAULT_CHARACTER_ID, getCharacter, getSelectableCharacter, type CharacterDefinition, type CharacterId, type CharacterStatus } from './characters.js';

export type TurnModality = 'text' | 'voice';
export type TurnInputSource = 'discord_text' | 'voice_transcript' | 'voice_channel_text';

export type VoiceProvider = 'melotts' | 'kokoro' | 'chatterbox' | 'gemini';

export type VoiceProfile = {
  id: string;
  version: number;
  provider: VoiceProvider;
  language: 'ko' | 'en-US' | 'ja';
  settings: Record<string, string | number | boolean>;
  status: 'draft' | 'published' | 'disabled';
};

/**
 * Discord ?띿뒪?몄? ?뚯꽦 ?꾩궗 寃곌낵媛 Conversation API???꾨떖?섎뒗 怨듯넻 ?뺤떇?낅땲??
 * ??媛앹껜?먮뒗 ?먮낯 ?ㅻ뵒?ㅻ굹 Discord ?좏겙???ы븿?섏? ?딆뒿?덈떎.
 */
export type TurnEnvelope = {
  eventId: string;
  guildId?: string;
  channelId?: string;
  userId: string;
  conversationId: string;
  modality: TurnModality;
  /** Distinguishes spoken transcripts from text typed while a voice session is active. */
  source?: TurnInputSource;
  canonicalText: string;
  occurredAt: string;
  sttConfidence?: number;
  personalPreferences?: Record<string, string | boolean>;
};

export {
  buildConversationPrompt,
  buildNaturalRewritePrompt,
  conversationSource,
  inspectNaturalness,
  shouldUseReasoning,
  type ConversationMessage,
  type ConversationMove,
  type ConversationSituationState,
  type ConversationPrompt,
  type ConversationPromptContext,
  type ConversationStyleState,
  type NaturalnessIssue
} from './conversation-prompt.js';

export type ConversationReply = {
  conversationId: string;
  text: string;
  voiceProfile?: VoiceProfile;
};

export type CharacterSelection = {
  guildId: string;
  channelId?: string;
  actorUserId: string;
  characterId: string;
};

export type MemoryConsentUpdate = {
  guildId?: string;
  userId: string;
  enabled: boolean;
};

export type MemorySummary = {
  id: string;
  summary: string;
  createdAt: string;
  isPinned?: boolean;
  confidence?: number;
  evidenceCount?: number;
};

export type VoiceConsentUpdate = {
  guildId: string;
  channelId: string;
  userId: string;
  enabled: boolean;
};

export type VoiceConsentCheck = Pick<VoiceConsentUpdate, 'guildId' | 'channelId' | 'userId'>;

export type VoiceTranscription = {
  text: string;
  confidence?: number;
};
