import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { REMOTE_TERMINAL_PIPE } from './remote-terminal-console.js';

type RemoteMessage = { type?: unknown; message?: unknown; lines?: unknown; locked?: unknown; remainingAttempts?: unknown; lockRemainingMs?: unknown };

class MessageQueue {
  private readonly messages: RemoteMessage[] = [];
  private readonly waiters: Array<(message: RemoteMessage) => void> = [];
  private buffer = '';

  constructor(socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.pushChunk(String(chunk)));
  }

  next(): Promise<RemoteMessage> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private pushChunk(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === 'object' && !Array.isArray(value)) this.push(value as RemoteMessage);
      } catch {
        // Ignore malformed server messages and continue reading the session.
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private push(message: RemoteMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.messages.push(message);
  }
}

const socket = createConnection(REMOTE_TERMINAL_PIPE);
const messages = new MessageQueue(socket);
const cli = createInterface({ input, output, terminal: true });

try {
  await once(socket, 'connect');
  const hello = await messages.next();
  if (hello.type !== 'hello') throw new Error(remoteMessage(hello) || 'Remote console did not respond.');

  while (true) {
    const password = await cli.question('Console password > ');
    send(socket, { type: 'authenticate', password });
    const response = await messages.next();
    if (response.type === 'authenticated') break;
    if (response.type === 'authentication_failed') {
      const locked = response.locked === true;
      const detail = locked ? `Locked for ${Math.ceil(Number(response.lockRemainingMs) / 1000)} seconds.` : `${String(response.remainingAttempts)} attempts remaining.`;
      output.write(`Incorrect password. ${detail}\n`);
      continue;
    }
    throw new Error(remoteMessage(response) || 'Authentication failed.');
  }

  output.write('Connected to the running Seline bot. Type exit to close this CLI without stopping Seline.\n');
  while (true) {
    const command = await cli.question('Seline command > ');
    if (command.trim().toLowerCase() === 'exit') break;
    send(socket, { type: 'command', command });
    const response = await messages.next();
    if (response.type === 'result') {
      for (const line of remoteLines(response)) output.write(`${line}\n`);
      continue;
    }
    output.write(`${remoteMessage(response) || 'Remote command failed.'}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`Could not connect to the running Seline bot: ${message}\n`);
  process.exitCode = 1;
} finally {
  cli.close();
  socket.end();
}

function send(target: Socket, payload: object): void {
  target.write(`${JSON.stringify(payload)}\n`);
}

function remoteLines(message: RemoteMessage): string[] {
  return Array.isArray(message.lines) ? message.lines.filter((line): line is string => typeof line === 'string') : [];
}

function remoteMessage(message: RemoteMessage): string | undefined {
  return typeof message.message === 'string' ? message.message : undefined;
}