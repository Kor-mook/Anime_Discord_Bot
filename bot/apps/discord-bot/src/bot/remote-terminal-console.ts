import { createServer, type Server, type Socket } from 'node:net';
import { ConsolePasswordGuard, type TerminalCommandHandler, type TerminalCommandResult } from './terminal-console.js';

export const REMOTE_TERMINAL_PIPE = '\\\\.\\pipe\\seline-discord-bot-console';

type RemoteConsoleMessage = {
  type?: unknown;
  password?: unknown;
  command?: unknown;
};

export type RemoteTerminalConsole = {
  close(): Promise<void>;
};

export function startRemoteTerminalConsole(commandHandler: TerminalCommandHandler, password?: string): RemoteTerminalConsole {
  if (!password) {
    console.warn('[discord-bot] Remote console is disabled: set BOT_CONSOLE_PASSWORD to enable it.');
    return { close: async () => undefined };
  }

  const passwordGuard = new ConsolePasswordGuard(password);
  const server = createServer((socket) => handleConnection(socket, passwordGuard, commandHandler));
  server.on('error', (error) => console.error('[discord-bot] Remote console pipe error:', error));
  server.listen(REMOTE_TERMINAL_PIPE, () => console.info('[discord-bot] Remote console is ready.'));

  return { close: () => closeServer(server) };
}

function handleConnection(socket: Socket, passwordGuard: ConsolePasswordGuard, commandHandler: TerminalCommandHandler): void {
  let buffer = '';
  let authenticated = false;
  let pending = Promise.resolve();
  socket.setEncoding('utf8');
  send(socket, { type: 'hello', message: 'Seline remote CLI. Enter the console password.' });

  socket.on('data', (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      pending = pending.then(() => handleLine(line, socket, passwordGuard, commandHandler, () => authenticated, () => { authenticated = true; }));
      pending = pending.catch((error: unknown) => send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) }));
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => socket.destroy());
}

async function handleLine(
  line: string,
  socket: Socket,
  passwordGuard: ConsolePasswordGuard,
  commandHandler: TerminalCommandHandler,
  isAuthenticated: () => boolean,
  markAuthenticated: () => void
): Promise<void> {
  if (line.length > 16_384) {
    send(socket, { type: 'error', message: 'Command is too long.' });
    return;
  }

  const message = parseMessage(line);
  if (!message) {
    send(socket, { type: 'error', message: 'Invalid remote CLI request.' });
    return;
  }

  if (!isAuthenticated()) {
    if (message.type !== 'authenticate' || typeof message.password !== 'string') {
      send(socket, { type: 'error', message: 'Authenticate before sending commands.' });
      return;
    }
    const attempt = passwordGuard.submit(message.password);
    if (!attempt.authenticated) {
      send(socket, { type: 'authentication_failed', locked: attempt.locked, remainingAttempts: attempt.remainingAttempts, lockRemainingMs: attempt.lockRemainingMs });
      return;
    }
    markAuthenticated();
    send(socket, { type: 'authenticated' });
    return;
  }

  if (message.type !== 'command' || typeof message.command !== 'string') {
    send(socket, { type: 'error', message: 'Expected a command.' });
    return;
  }

  const command = message.command.trim();
  if (!command) {
    send(socket, { type: 'result', lines: [] });
    return;
  }

  const result = await commandHandler(command);
  send(socket, { type: 'result', lines: normalizeResult(result) });
}

function parseMessage(line: string): RemoteConsoleMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RemoteConsoleMessage : undefined;
  } catch {
    return undefined;
  }
}

function normalizeResult(result: TerminalCommandResult): string[] {
  return Array.isArray(result) ? result : result ? [result] : [];
}

function send(socket: Socket, payload: object): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}