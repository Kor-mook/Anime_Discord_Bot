import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_EVENT_BODY_BYTES = 16 * 1024;
const DEFAULT_PATH = '/internal/voice-consent';
type Logger = Pick<Console, 'error' | 'info' | 'warn'>;

export type VoiceConsentInvalidationEvent = { discordUserId: string; voiceConsent: boolean };
export type VoiceConsentInvalidationServer = {
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  server: Server;
};

export function createVoiceConsentInvalidationServer(input: {
  secret: string;
  onInvalidate: (event: VoiceConsentInvalidationEvent) => void;
  logger?: Logger;
  path?: string;
}): VoiceConsentInvalidationServer {
  const logger = input.logger ?? console;
  const path = input.path ?? DEFAULT_PATH;
  const server = createServer((request, response) => {
    void handleRequest(request, response, { ...input, logger, path });
  });
  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => { server.off('error', onError); resolve(); });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, input: {
  secret: string; onInvalidate: (event: VoiceConsentInvalidationEvent) => void; logger: Logger; path: string;
}): Promise<void> {
  if (request.method !== 'POST' || request.url?.split('?')[0] !== input.path) {
    response.writeHead(404).end();
    return;
  }
  if (!isAuthorized(request.headers.authorization, input.secret)) {
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  try {
    const event = parseEvent(await readBody(request));
    if (!event) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid voice consent event' }));
      return;
    }
    input.onInvalidate(event);
    input.logger.info(`Voice consent invalidated: user=${event.discordUserId}, voiceConsent=${event.voiceConsent}.`);
    response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  } catch (error) {
    input.logger.warn(`Voice consent invalidation request failed: ${error instanceof Error ? error.message : String(error)}`);
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid voice consent event' }));
  }
}

function isAuthorized(authorization: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_EVENT_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEvent(body: string): VoiceConsentInvalidationEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const discordUserId = typeof record.discordUserId === 'string' ? record.discordUserId.trim() : '';
  if (!discordUserId || discordUserId.length > 128 || typeof record.voiceConsent !== 'boolean') return undefined;
  return { discordUserId, voiceConsent: record.voiceConsent };
}