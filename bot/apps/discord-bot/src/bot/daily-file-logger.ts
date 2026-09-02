import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type FileLogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';

/**
 * Keeps an append-only operational log for each server-local calendar day.
 * Logging must never take the bot down, so write errors are intentionally
 * contained and the console logger remains available as the fallback.
 */
export class DailyFileLogger {
  constructor(
    private readonly logDirectory = resolve(process.cwd(), 'logs'),
    private readonly now: () => Date = () => new Date()
  ) {}

  write(level: FileLogLevel, source: string, details: unknown[]): void {
    try {
      const timestamp = this.now();
      mkdirSync(this.logDirectory, { recursive: true });
      const entry = `${timestamp.toISOString()} ${level.padEnd(8)} [${source}] ${formatDetails(details)}\n`;
      appendFileSync(join(this.logDirectory, `bot-${dateStamp(timestamp)}.log`), entry, 'utf8');
      if (level === 'CRITICAL') appendFileSync(join(this.logDirectory, `critical-${weekStamp(timestamp)}.log`), entry, 'utf8');
    } catch {
      // A full disk or an unavailable mount must not interrupt the bot.
    }
  }
}

export function dateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** ISO week based on the server's local calendar date. */
export function weekStamp(date: Date): string {
  const localDateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = new Date(localDateUtc).getUTCDay() || 7;
  const thursdayUtc = localDateUtc + (4 - weekday) * 86_400_000;
  const year = new Date(thursdayUtc).getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstWeekday = new Date(firstThursday).getUTCDay() || 7;
  const firstWeekThursday = firstThursday + (4 - firstWeekday) * 86_400_000;
  const week = 1 + Math.round((thursdayUtc - firstWeekThursday) / 604_800_000);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function formatDetails(details: unknown[]): string {
  const message = details.map(formatDetail).join(' | ') || 'No message';
  return message.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function formatDetail(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}