import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";

type MediaDelivery = {
  jobId: string;
  assetId: string;
  channelId: string;
  caption?: string;
  mimeType: string;
  fileName: string;
};

type Logger = {
  info: (...details: unknown[]) => void;
  warn: (...details: unknown[]) => void;
};

export class CharacterMediaDeliveryManager {
  private readonly baseUrl: string;
  private readonly workerId = `discord-media-${randomUUID()}`;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private client?: Client;
  private interval?: ReturnType<typeof setInterval>;
  private drainPromise?: Promise<void>;

  constructor(private readonly options: { baseUrl: string; apiKey?: string; logger: Logger; fetchImpl?: typeof fetch }) {
    this.baseUrl = new URL(options.baseUrl).origin;
  }

  start(client: Client): void {
    this.client = client;
    this.interval = setInterval(() => void this.drain(), 60_000);
    this.interval.unref();
    void this.drain();
  }

  /** Poll rapidly only after a real text turn; the minute poll is crash recovery. */
  wake(): void {
    for (const delay of [2_500, 6_000, 12_000, 22_000, 38_000, 58_000]) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.drain();
      }, delay);
      timer.unref();
      this.timers.add(timer);
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainOnce().finally(() => { this.drainPromise = undefined; });
    return this.drainPromise;
  }

  private async drainOnce(): Promise<void> {
    if (!this.client?.isReady()) return;
    let deliveries: MediaDelivery[];
    try {
      const params = new URLSearchParams({ workerId: this.workerId, limit: "5" });
      const response = await this.request(`/api/bot/media?${params.toString()}`, { method: "GET" });
      const body = await response.json() as { deliveries?: MediaDelivery[] };
      deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
    } catch (error) {
      this.options.logger.warn(`Character media claim failed: ${messageOf(error)}`);
      return;
    }
    for (const delivery of deliveries) await this.deliver(delivery);
  }

  private async deliver(delivery: MediaDelivery): Promise<void> {
    try {
      const channel = await this.client!.channels.fetch(delivery.channelId);
      const sendable = channel as { send?: (input: unknown) => Promise<unknown> } | null;
      if (!sendable?.send) throw new Error("Discord channel cannot receive media");
      const response = await this.request(`/api/bot/media/${encodeURIComponent(delivery.assetId)}`, { method: "GET" });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw new Error("Website returned an empty image");
      await sendable.send({
        ...(delivery.caption ? { content: delivery.caption } : {}),
        files: [{ attachment: bytes, name: delivery.fileName }],
      });
      await this.acknowledge(delivery.jobId, "delivered");
      this.options.logger.info(`Character media delivered: job=${delivery.jobId}, channel=${delivery.channelId}`);
    } catch (error) {
      await this.acknowledge(delivery.jobId, "failed", messageOf(error)).catch(() => undefined);
      this.options.logger.warn(`Character media delivery failed: job=${delivery.jobId}, error=${messageOf(error)}`);
    }
  }

  private async acknowledge(jobId: string, status: "delivered" | "failed", error?: string): Promise<void> {
    await this.request("/api/bot/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: this.workerId, jobId, status, ...(error ? { error: error.slice(0, 200) } : {}) }),
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);
    const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`Website media API returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    return response;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
