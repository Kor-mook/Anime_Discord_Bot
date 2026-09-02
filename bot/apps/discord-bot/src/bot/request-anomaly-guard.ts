export type RequestAnomalyKind = 'user' | 'channel' | 'global';

export type RequestAnomalyDecision = {
  state: 'allow' | 'warn' | 'block';
  kind?: RequestAnomalyKind;
  count?: number;
  notify: boolean;
};

type Limit = {
  warningCount: number;
  blockCount: number;
  blockMs: number;
};

const WINDOW_MS = 10_000;
const WARNING_COOLDOWN_MS = 60_000;
const BLOCK_NOTICE_COOLDOWN_MS = 60_000;

const USER_LIMIT: Limit = { warningCount: 6, blockCount: 15, blockMs: 5 * 60_000 };
const CHANNEL_LIMIT: Limit = { warningCount: 20, blockCount: 40, blockMs: 60_000 };
const GLOBAL_LIMIT: Limit = { warningCount: 40, blockCount: 80, blockMs: 60_000 };

/**
 * Keeps a bot process from turning a message burst into an unbounded number
 * of provider calls. Warnings are observable but pass through; hard bursts
 * are temporarily rejected before they reach the conversation API.
 */
export class RequestAnomalyGuard {
  private readonly timestamps = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly warnedAt = new Map<string, number>();
  private readonly notifiedAt = new Map<string, number>();

  inspect(input: { userId: string; channelId: string; now?: number }): RequestAnomalyDecision {
    const now = input.now ?? Date.now();
    const scopes: Array<{ key: string; kind: RequestAnomalyKind; limit: Limit }> = [
      { key: `user:${input.userId}`, kind: 'user', limit: USER_LIMIT },
      { key: `channel:${input.channelId}`, kind: 'channel', limit: CHANNEL_LIMIT },
      { key: 'global', kind: 'global', limit: GLOBAL_LIMIT }
    ];

    const existingBlock = scopes.find(({ key }) => (this.blockedUntil.get(key) ?? 0) > now);
    if (existingBlock) return this.blockDecision(existingBlock.key, existingBlock.kind, now);

    const counts = scopes.map((scope) => ({ ...scope, count: this.record(scope.key, now) }));
    const hardLimit = counts.find(({ count, limit }) => count >= limit.blockCount);
    if (hardLimit) {
      this.blockedUntil.set(hardLimit.key, now + hardLimit.limit.blockMs);
      return this.blockDecision(hardLimit.key, hardLimit.kind, now, hardLimit.count);
    }

    const warning = counts.find(({ count, limit }) => count >= limit.warningCount);
    if (!warning) return { state: 'allow', notify: false };

    const lastWarnedAt = this.warnedAt.get(warning.key);
    const notify = lastWarnedAt === undefined || now - lastWarnedAt >= WARNING_COOLDOWN_MS;
    if (notify) this.warnedAt.set(warning.key, now);
    return { state: 'warn', kind: warning.kind, count: warning.count, notify };
  }

  private record(key: string, now: number): number {
    const recent = (this.timestamps.get(key) ?? []).filter((timestamp) => timestamp > now - WINDOW_MS);
    recent.push(now);
    this.timestamps.set(key, recent);
    return recent.length;
  }

  private blockDecision(key: string, kind: RequestAnomalyKind, now: number, count?: number): RequestAnomalyDecision {
    const lastNotifiedAt = this.notifiedAt.get(key);
    const notify = lastNotifiedAt === undefined || now - lastNotifiedAt >= BLOCK_NOTICE_COOLDOWN_MS;
    if (notify) this.notifiedAt.set(key, now);
    return { state: 'block', kind, count, notify };
  }
}
