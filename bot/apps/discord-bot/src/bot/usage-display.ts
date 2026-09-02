import type { CommandLanguage } from './command-language.js';

const PROGRESS_BAR_SEGMENTS = 20;

/** Formats the web-authoritative remaining token percentage without exposing quota totals. */
export function formatRemainingUsage(remainingPercent: number, language: CommandLanguage): string {
  if (!Number.isSafeInteger(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    throw new Error('remainingPercent must be an integer from 0 to 100.');
  }
  const filledSegments = Math.round((remainingPercent / 100) * PROGRESS_BAR_SEGMENTS);
  const progressBar = `${'█'.repeat(filledSegments)}${'░'.repeat(PROGRESS_BAR_SEGMENTS - filledSegments)}`;
  const label = language === 'ko' ? '남았어요 ✨' : language === 'ja' ? '残り' : 'remaining';

  return `\`${progressBar}\`\n\n## ${remainingPercent}% ${label}`;
}