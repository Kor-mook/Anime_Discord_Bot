export type TextBudgetResult = {
  text: string;
  truncated: boolean;
};

export const CHAT_INPUT_MAX_CHARS = 1_200;
export const VOICE_INPUT_MAX_CHARS = 500;

/**
 * Keeps both the request opening and conclusion. This is a character-level
 * guardrail; provider token usage remains authoritative.
 */
export function limitTextForBudget(text: string, maxChars: number): TextBudgetResult {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };

  const marker = '\n[... middle omitted to stay within the request budget ...]\n';
  const available = Math.max(0, maxChars - marker.length);
  const prefixLength = Math.floor(available * 0.4);
  const suffixLength = available - prefixLength;
  return {
    text: `${normalized.slice(0, prefixLength)}${marker}${normalized.slice(-suffixLength)}`,
    truncated: true
  };
}