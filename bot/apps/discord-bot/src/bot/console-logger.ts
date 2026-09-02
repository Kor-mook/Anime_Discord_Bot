import { terminalConsole } from './terminal-console.js';

export type ConsoleLogger = Pick<Console, 'error' | 'info' | 'warn'> & {
  detail: (...details: unknown[]) => void;
};

export function createConsoleLogger(source: string): ConsoleLogger {
  return {
    error: (...details: unknown[]) => terminalConsole.write('CRITICAL', source, details),
    warn: (...details: unknown[]) => terminalConsole.write('WARNING', source, details),
    info: (...details: unknown[]) => terminalConsole.write('INFO', source, details),
    detail: (...details: unknown[]) => terminalConsole.detail(source, details)
  };
}