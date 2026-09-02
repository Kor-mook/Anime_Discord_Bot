import type { TurnEnvelope } from '@anime/contracts';

export function makeTextTurn(input: {
  guildId?: string;
  channelId: string;
  userId: string;
  text: string;
  eventId?: string;
  occurredAt?: string;
}): TurnEnvelope {
  return {
    eventId: input.eventId ?? crypto.randomUUID(),
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    conversationId: `text:${input.guildId ?? 'dm'}:${input.channelId}:${input.userId}`,
    modality: 'text',
    source: 'discord_text',
    canonicalText: input.text.trim(),
    occurredAt: input.occurredAt ?? new Date().toISOString()
  };
}

export function splitDiscordMessage(text: string, maxLength = 2_000): string[] {
  const normalized = text.trim();
  if (!normalized) return ['The reply was empty.'];
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const preferredBreak = Math.max(remaining.lastIndexOf('\n', maxLength), remaining.lastIndexOf(' ', maxLength));
    const cutAt = preferredBreak > Math.floor(maxLength * 0.6) ? preferredBreak : maxLength;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function splitSnsStyleMessage(text: string): string[] {
  const normalChunks = splitDiscordMessage(text);
  if (normalChunks.length !== 1 || text.includes('```')) return normalChunks;

  const sentences = normalChunks[0]
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length < 3) return normalChunks;

  const grouped = sentences.length <= 4
    ? sentences
    : [...sentences.slice(0, 3), sentences.slice(3).join(' ')];
  return grouped.flatMap((sentence) => splitDiscordMessage(sentence));
}

/** Split a social-message reply into human-sized sends without splitting code or long Discord chunks. */
export function splitNaturalTextMessages(text: string): string[] {
  const normalChunks = splitDiscordMessage(text);
  if (normalChunks.length !== 1 || text.includes('```')) return normalChunks;

  const sentences = normalChunks[0]
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length > 1 ? sentences.flatMap((sentence) => splitDiscordMessage(sentence)) : normalChunks;
}

/** A short bounded pause keeps multi-message replies readable without feeling sluggish. */
export function chatTypingDelayMs(text: string): number {
  return Math.max(300, Math.min(950, 220 + Array.from(text).length * 9));
}

/** Convert silent voice-performance cues into server-independent Unicode emoji for text chat. */
export function normalizeChatDeliveryCues(text: string): string {
  const emojiByCue: Record<string, string> = {
    'a small laugh': '\u{1F604}',
    smiles: '\u{1F642}',
    'gently teasing': '\u{1F609}',
    softly: '\u{1F60A}',
    warmly: '\u{1F970}',
    whisper: '\u{1F92B}'
  };
  return text.replace(/[\[(](softly|smiles|gently teasing|a small laugh|warmly|whisper)[\])]/giu, (_cue, name: string) => {
    const key = name.trim().toLocaleLowerCase();
    return emojiByCue[key] ?? '';
  });
}
