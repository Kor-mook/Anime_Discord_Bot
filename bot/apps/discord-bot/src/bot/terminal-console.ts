import { timingSafeEqual } from 'node:crypto';
import * as readline from 'node:readline';
import { DailyFileLogger } from './daily-file-logger.js';
import { TerminalCommandRegistry, terminalCommandRegistry } from './terminal-command-registry.js';

export type TerminalLogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';
export type TerminalLogMode = 'compact' | 'detail';
export type TerminalCommandResult = string | string[] | undefined;
export type TerminalCommandHandler = (command: string) => Promise<TerminalCommandResult> | TerminalCommandResult;
export type TerminalSelectionOption = { label: string; value: string };
export type TerminalSelectionHandler = (value: string) => Promise<TerminalCommandResult> | TerminalCommandResult;
export type ConsoleSettingsStore = { getConsoleSettings(): Promise<{ logMode: TerminalLogMode; defaultModel?: string }>; saveConsoleSettings(settings: { logMode: TerminalLogMode; defaultModel?: string }): Promise<void> };
type TerminalLogHistoryEntry = { line: string; visibleInCompact: boolean };


const PROMPT = 'Seline command > ';
// Keep the command panel separate from the scrolling log area. In particular,
// a command result must remain visible while services keep emitting logs.
const RESERVED_BOTTOM_ROWS = 4;
const MAX_LOG_HISTORY = 500;
const RESIZE_SETTLE_DELAY_MS = 300;
const fileLogger = new DailyFileLogger();
export type ConsolePasswordAttempt = {
  authenticated: boolean;
  locked: boolean;
  remainingAttempts: number;
  lockRemainingMs: number;
};

export class ConsolePasswordGuard {
  private failedAttempts = 0;
  private lockedUntil = 0;

  constructor(private readonly password: string) {}

  isLocked(now = Date.now()): boolean {
    return this.getLockRemainingMs(now) > 0;
  }

  getLockRemainingMs(now = Date.now()): number {
    return Math.max(0, this.lockedUntil - now);
  }

  submit(candidate: string, now = Date.now()): ConsolePasswordAttempt {
    const lockRemainingMs = this.getLockRemainingMs(now);
    if (lockRemainingMs > 0) return { authenticated: false, locked: true, remainingAttempts: 0, lockRemainingMs };

    const expected = Buffer.from(this.password);
    const actual = Buffer.from(candidate);
    const authenticated = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (authenticated) {
      this.failedAttempts = 0;
      return { authenticated: true, locked: false, remainingAttempts: 5, lockRemainingMs: 0 };
    }

    this.failedAttempts += 1;
    if (this.failedAttempts >= 5) {
      this.failedAttempts = 0;
      this.lockedUntil = now + 30_000;
      return { authenticated: false, locked: true, remainingAttempts: 0, lockRemainingMs: 30_000 };
    }

    return { authenticated: false, locked: false, remainingAttempts: 5 - this.failedAttempts, lockRemainingMs: 0 };
  }
}

class TerminalConsole {
  private active = false;
  private layoutActive = false;
  private inputLine = '';
  private inputCursor = 0;
  private stdinWasRaw = false;
  private authenticated = false;
  private passwordGuard?: ConsolePasswordGuard;
  private passwordLockTimer?: NodeJS.Timeout;
  private resizeTimer?: NodeJS.Timeout;
  private settingsStore?: ConsoleSettingsStore;
  private logMode: TerminalLogMode = 'compact';
  private defaultModel: string | undefined;
  private fallbackStatus: { enabled: boolean; model?: string } = { enabled: false };
  private interface?: readline.Interface;
  private commandHandler?: TerminalCommandHandler;
  // Preserve every event so changing modes updates the logs already on screen.
  private logHistory: TerminalLogHistoryEntry[] = [];
  // The command panel moves the terminal cursor on every render, so retain a
  // separate cursor for the scrolling log viewport.
  private logCursorRow = 1;
  private commandFeedback = 'Ready for a command.';
  private searchActive = false;
  private searchQuery = '';
  private searchCursor = 0;
  private searchIndex = 0;
  private selection?: { title: string; options: TerminalSelectionOption[]; selectedIndex: number; onSelect: TerminalSelectionHandler };

  async initializeSettings(store: ConsoleSettingsStore): Promise<void> {
    this.settingsStore = store;
    const saved = await store.getConsoleSettings();
    this.logMode = saved.logMode;
    this.defaultModel = saved.defaultModel;
  }

  start(commandHandler: TerminalCommandHandler, password?: string): void {
    if (this.active || !process.stdin.isTTY || !process.stdout.isTTY) return;
    this.active = true;
    this.commandHandler = commandHandler;
    this.passwordGuard = password ? new ConsolePasswordGuard(password) : undefined;
    this.authenticated = false;
    this.stdinWasRaw = process.stdin.isRaw === true;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', this.handleKeypress);
    process.stdout.on('resize', this.handleResize);
    process.once('exit', () => this.restoreLayout());

    this.resetLogViewport();
    this.writeLogLines(['=== Seline bot console - logs ===']);
    this.renderBottom();
  }

  write(level: TerminalLogLevel, source: string, details: unknown[]): void {
    this.recordLog(level, source, details, false);
  }

  detail(source: string, details: unknown[]): void {
    this.recordLog('INFO', source, details, true);
  }

  private recordLog(level: TerminalLogLevel, source: string, details: unknown[], isDetail: boolean): void {
    const timestamp = new Date().toLocaleTimeString('en-GB');
    const message = details.map(formatDetail).join(' | ').replace(/[\r\n]+/g, ' ') || 'No message';
    fileLogger.write(level, source, details);
    if (!this.active) {
      if (!isDetail) writePlain(level, source, message, timestamp);
      return;
    }
    const output = level === 'INFO'
      ? `[${timestamp}] INFO     [${source}] ${message}`
      : decorate(level, source, message, timestamp);
    const visibleInCompact = !isDetail && (level !== 'INFO' || isCompactMilestone(message));
    const lines = output.split(/\r?\n/);
    this.recordLogLines(lines, visibleInCompact);
    if (this.isVisibleInCurrentMode(visibleInCompact)) this.writeLogLines(lines, false);
    this.renderBottom();
  }

  setLogMode(mode: TerminalLogMode): void {
    this.logMode = mode;
    void this.settingsStore?.saveConsoleSettings({ logMode: mode, defaultModel: this.defaultModel }).catch(() => undefined);

  }

  getLogMode(): TerminalLogMode {
    return this.logMode;
  }

  getDefaultModel(): string | undefined {
    return this.defaultModel;
  }

  setFallbackStatus(enabled: boolean, model?: string): void {
    this.fallbackStatus = { enabled, model };
    this.renderBottom();
  }

  setDefaultModel(model: string): void {
    this.defaultModel = model;
    void this.settingsStore?.saveConsoleSettings({ logMode: this.logMode, defaultModel: model }).catch(() => undefined);
  }

  shutdown(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    process.stdin.off('keypress', this.handleKeypress);
    process.stdout.off('resize', this.handleResize);
    if (!this.stdinWasRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.restoreLayout();
    this.active = false;
  }

  clear(): void {
    if (!this.active) return;
    this.logHistory = [{ line: '=== Seline bot console - logs ===', visibleInCompact: true }];
    this.resetLogViewport();
    this.writeLogLines(['=== Seline bot console - logs ==='], false);
    this.renderBottom();
  }

  select(title: string, options: TerminalSelectionOption[], onSelect: TerminalSelectionHandler): void {
    if (!options.length) return;
    this.selection = { title, options, selectedIndex: 0, onSelect };
    this.writeLogLines([title, ...options.map((option, index) => `${index + 1}. ${option.label}`)]);
    this.renderBottom();
  }

  private async handleCommand(raw: string): Promise<void> {
    const command = raw.trim();
    if (!command) {
      this.renderBottom();
      return;
    }
    this.commandFeedback = terminalCommandRunningFeedback(command);
    this.renderBottom();
    try {
      const result = await this.commandHandler?.(command);
      const lines = Array.isArray(result) ? result : result ? [result] : [];
      this.commandFeedback = terminalCommandFeedback(command, lines);
      if (lines.length) this.writeCommandResult(lines, command);
      else this.renderBottom();
    } catch (error) {
      this.commandFeedback = `[FAILED] ${command}: ${formatDetail(error)}`;
      this.write('CRITICAL', 'console', [error]);
    }
  }

  private writeCommandResult(lines: string[], command?: string): void {
    if (!this.active) {
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    const output = lines.flatMap((line) => line.split(/\r?\n/));
    if (command) output.unshift(`\u001b[1;36m[COMMAND] ${command}\u001b[0m`);
    this.writeLogLines(output);
    this.renderBottom();
  }

  private readonly handleResize = (): void => {
    if (!this.active) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    // Windows emits several resize events while a window edge is dragged.
    // Redraw only after the size has settled to prevent flashing and resets.
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.refreshLayout();
    }, RESIZE_SETTLE_DELAY_MS);
  };

  private refreshLayout(): void {
    if (!this.active || !this.layoutActive) return;

    this.resetLogViewport();
    this.writeLogLines(this.visibleLogLines(), false);
    this.renderBottom();
  }

  private resetLogViewport(): void {
    // Font zoom and window resizing reflow old terminal rows, so clearing only
    // the previous panel coordinates leaves stale UI fragments on screen.
    process.stdout.write('\u001b[r\u001b[2J\u001b[H');
    this.configureLayout();
    this.logCursorRow = 1;
  }

  private configureLayout(): void {
    const { logBottom } = this.layout();
    process.stdout.write(`\u001b[1;${logBottom}r\u001b[?25h`);
    this.layoutActive = true;
  }

  private restoreLayout(): void {
    if (!this.layoutActive) return;
    const { rows } = this.layout();
    process.stdout.write(`\u001b[r\u001b[${rows};1H\u001b[2K\u001b[?25h\n`);
    this.layoutActive = false;
  }

  private writeLogLines(lines: string[], record = true): void {
    for (const line of lines) {
      if (record) this.recordLogLines([line], true);
      for (const visualLine of wrapTerminalLine(line, this.logColumns())) this.writeVisualLogLine(visualLine);
    }
  }

  private writeVisualLogLine(line: string): void {
    const { logBottom } = this.layout();
    const row = Math.min(this.logCursorRow, logBottom);
    process.stdout.write(`\u001b[${row};1H\u001b[2K${line}`);
    if (row < logBottom) {
      this.logCursorRow = row + 1;
      return;
    }
    // Newlines at the bottom of the configured scroll region move only logs,
    // leaving the command panel untouched.
    process.stdout.write('\n');
    this.logCursorRow = logBottom;
  }

  private logColumns(): number {
    return Math.max(1, (process.stdout.columns || 80) - 1);
  }
  private fitLine(line: string): string {
    return truncateTerminalLine(line, Math.max(40, process.stdout.columns || 120) - 1);
  }
  private recordLogLines(lines: string[], visibleInCompact: boolean): void {
    for (const line of lines) {
      this.logHistory.push({ line, visibleInCompact });
      if (this.logHistory.length > MAX_LOG_HISTORY) this.logHistory.splice(0, this.logHistory.length - MAX_LOG_HISTORY);
    }
  }

  private visibleLogLines(): string[] {
    return this.logHistory
      .filter((entry) => this.isVisibleInCurrentMode(entry.visibleInCompact))
      .map((entry) => entry.line);
  }

  private isVisibleInCurrentMode(visibleInCompact: boolean): boolean {
    return this.logMode === 'detail' || visibleInCompact;
  }

  private renderBottom(): void {
    if (!this.layoutActive) return;
    const { rows, columns } = this.layout();
    const separatorRow = rows - 3;
    const resultRow = rows - 2;
    const commandRow = rows - 1;
    const statusRow = rows;
    const passwordPrompt = !this.authenticated;
    const searchPrompt = this.authenticated && this.searchActive;
    const selectionPrompt = this.authenticated && Boolean(this.selection);
    const prompt = passwordPrompt ? 'Console password > ' : searchPrompt ? 'Search logs > ' : selectionPrompt ? '모델 선택 > ' : PROMPT;
    const inputLine = searchPrompt ? this.searchQuery : selectionPrompt ? this.selection!.options[this.selection!.selectedIndex].label : this.inputLine;
    const inputCursor = searchPrompt ? this.searchCursor : selectionPrompt ? 0 : this.inputCursor;
    const maxInputColumns = Math.max(1, columns - terminalCellWidth(prompt) - 1);
    const inputViewport = terminalInputViewport(inputLine, inputCursor, maxInputColumns);
    const visibleInput = inputViewport.value;
    const displayedInput = passwordPrompt ? '*'.repeat(Array.from(visibleInput).length) : visibleInput;
    const beforeCursor = passwordPrompt ? '*'.repeat(Array.from(visibleInput.slice(0, inputViewport.cursorOffset)).length) : visibleInput.slice(0, inputViewport.cursorOffset);
    const rawSuggestion = !passwordPrompt && !searchPrompt && !selectionPrompt && inputCursor === inputLine.length ? inlineTerminalSuggestion(inputLine) : '';
    const suggestionColumns = Math.max(0, columns - terminalCellWidth(prompt) - terminalCellWidth(displayedInput) - 1);
    const suggestion = suggestionColumns ? truncateTerminalLine(rawSuggestion, suggestionColumns + 1) : '';
    const matches = searchPrompt ? searchLogLines(this.visibleLogLines(), this.searchQuery) : [];
    const status = passwordPrompt ? terminalPasswordStatus(this.passwordGuard) : searchPrompt ? terminalSearchStatus(this.searchQuery, matches.length, this.searchIndex) : selectionPrompt ? this.selection!.title + ' | ↑/↓ 이동 · Enter 선택 · Esc 취소' : terminalModeStatus(this.logMode, this.fallbackStatus);
    const result = searchPrompt
      ? terminalSearchResult(this.searchQuery, matches.length, this.searchIndex, matches.length ? matches[this.searchIndex % matches.length] : undefined)
      : this.commandFeedback;
    const cursorColumn = Math.min(terminalCellWidth(prompt) + terminalCellWidth(beforeCursor), columns - 1) + 1;
    process.stdout.write('\u001b[' + separatorRow + ';1H\u001b[2K\u001b[90m' + '─'.repeat(Math.max(1, columns - 1)) + '\u001b[0m');
    process.stdout.write('\u001b[' + resultRow + ';1H\u001b[2K\u001b[36m' + this.fitLine(result) + '\u001b[0m');
    process.stdout.write('\u001b[' + commandRow + ';1H\u001b[2K' + prompt + displayedInput + '\u001b[90m' + suggestion + '\u001b[0m');
    process.stdout.write('\u001b[' + statusRow + ';1H\u001b[2K\u001b[90m' + this.fitLine(status) + '\u001b[0m');
    process.stdout.write('\u001b[' + commandRow + ';' + cursorColumn + 'H');
  }
  private submitPassword(): void {
    const guard = this.passwordGuard;
    const candidate = this.inputLine;
    this.inputLine = '';
    this.inputCursor = 0;
    if (!guard) {
      this.writeCommandResult(['Console is locked. Set BOT_CONSOLE_PASSWORD in bot/.env and restart Seline.']);
      return;
    }

    const result = guard.submit(candidate);
    if (result.authenticated) {
      this.authenticated = true;
      this.writeCommandResult(['Console unlocked.']);
      return;
    }

    if (result.locked) {
      if (this.passwordLockTimer) clearTimeout(this.passwordLockTimer);
      this.passwordLockTimer = setTimeout(() => this.renderBottom(), result.lockRemainingMs);
      this.writeCommandResult(['Incorrect password. Console locked for 30 seconds.']);
      return;
    }

    this.writeCommandResult(['Incorrect password. ' + result.remainingAttempts + ' attempts remaining.']);
  }

  private readonly handleKeypress = (input: string, key: readline.Key): void => {
    if (key?.ctrl && key.name === 'c') {
      this.inputLine = '';
      this.inputCursor = 0;
      this.writeCommandResult(['Ctrl+C is ignored. Type stop to shut down Seline.']);
      return;
    }
    if (!this.authenticated && this.passwordGuard?.isLocked()) {
      this.inputLine = '';
      this.inputCursor = 0;
      this.renderBottom();
      return;
    }
    if (key?.ctrl && key.name === 'f') {
      if (!this.authenticated) {
        this.renderBottom();
        return;
      }
      this.searchActive = !this.searchActive;
      if (this.searchActive) {
        this.searchQuery = '';
        this.searchCursor = 0;
        this.searchIndex = 0;
      }
      this.renderBottom();
      return;
    }
    if (this.searchActive) {
      this.handleSearchKeypress(input, key);
      return;
    }
    if (this.selection) {
      this.handleSelectionKeypress(input, key);
      return;
    }
    if (key?.name === 'f2') {
      if (!this.authenticated) {
        this.renderBottom();
        return;
      }
      this.setLogMode(toggleTerminalLogMode(this.logMode));
      this.renderBottom();
      return;
    }
    if (key?.name === 'return' || key?.name === 'enter') {
      if (!this.authenticated) {
        this.submitPassword();
        return;
      }
      const command = this.inputLine;
      this.inputLine = '';
      this.inputCursor = 0;
      this.renderBottom();
      void this.handleCommand(command);
      return;
    }
    if (key?.name === 'tab' && this.authenticated) {
      this.inputLine = completeTerminalCommandInput(this.inputLine);
      this.inputCursor = this.inputLine.length;
    } else if (key?.name === 'backspace' || input === '\u007f' || input === '\b') {
      if (this.inputCursor > 0) {
        const previousIndex = previousTerminalInputIndex(this.inputLine, this.inputCursor);
        this.inputLine = this.inputLine.slice(0, previousIndex) + this.inputLine.slice(this.inputCursor);
        this.inputCursor = previousIndex;
      }
    } else if (key?.name === 'delete') {
      const nextIndex = nextTerminalInputIndex(this.inputLine, this.inputCursor);
      this.inputLine = this.inputLine.slice(0, this.inputCursor) + this.inputLine.slice(nextIndex);
    } else if (key?.name === 'left') {
      this.inputCursor = previousTerminalInputIndex(this.inputLine, this.inputCursor);
    } else if (key?.name === 'right') {
      this.inputCursor = nextTerminalInputIndex(this.inputLine, this.inputCursor);
    } else if (key?.name === 'home') {
      this.inputCursor = 0;
    } else if (key?.name === 'end') {
      this.inputCursor = this.inputLine.length;
    } else if (input && !key?.ctrl && !key?.meta) {
      this.inputLine = this.inputLine.slice(0, this.inputCursor) + input + this.inputLine.slice(this.inputCursor);
      this.inputCursor += input.length;
    }
    this.renderBottom();
  };
  private handleSelectionKeypress(input: string, key: readline.Key): void {
    const selection = this.selection;
    if (!selection) return;
    if (key?.name === 'escape') {
      this.selection = undefined;
      this.writeCommandResult(['모델 선택을 취소했습니다.']);
      return;
    }
    if (key?.name === 'up') selection.selectedIndex = (selection.selectedIndex - 1 + selection.options.length) % selection.options.length;
    else if (key?.name === 'down') selection.selectedIndex = (selection.selectedIndex + 1) % selection.options.length;
    else if (/^[1-9]$/.test(input) && Number(input) <= selection.options.length) {
      selection.selectedIndex = Number(input) - 1;
      void this.confirmSelection();
      return;
    } else if (key?.name === 'return' || key?.name === 'enter') {
      void this.confirmSelection();
      return;
    }
    this.renderBottom();
  }

  private async confirmSelection(): Promise<void> {
    const selection = this.selection;
    if (!selection) return;
    const option = selection.options[selection.selectedIndex];
    this.selection = undefined;
    try {
      const result = await selection.onSelect(option.value);
      const lines = Array.isArray(result) ? result : result ? [result] : [];
      if (lines.length) this.writeCommandResult(lines);
      else this.renderBottom();
    } catch (error) {
      this.write('CRITICAL', 'console', [error]);
    }
  }
  private handleSearchKeypress(input: string, key: readline.Key): void {
    if (key?.name === 'escape') {
      this.searchActive = false;
      this.renderBottom();
      return;
    }
    const matches = searchLogLines(this.visibleLogLines(), this.searchQuery);
    if ((key?.name === 'return' || key?.name === 'enter' || key?.name === 'down') && matches.length) {
      this.searchIndex = (this.searchIndex + 1) % matches.length;
    } else if (key?.name === 'up' && matches.length) {
      this.searchIndex = (this.searchIndex - 1 + matches.length) % matches.length;
    } else if (key?.name === 'backspace' || input === '\u007f' || input === '\b') {
      if (this.searchCursor > 0) {
        const previousIndex = previousTerminalInputIndex(this.searchQuery, this.searchCursor);
        this.searchQuery = this.searchQuery.slice(0, previousIndex) + this.searchQuery.slice(this.searchCursor);
        this.searchCursor = previousIndex;
        this.searchIndex = 0;
      }
    } else if (key?.name === 'delete') {
      const nextIndex = nextTerminalInputIndex(this.searchQuery, this.searchCursor);
      this.searchQuery = this.searchQuery.slice(0, this.searchCursor) + this.searchQuery.slice(nextIndex);
      this.searchIndex = 0;
    } else if (key?.name === 'left') {
      this.searchCursor = previousTerminalInputIndex(this.searchQuery, this.searchCursor);
    } else if (key?.name === 'right') {
      this.searchCursor = nextTerminalInputIndex(this.searchQuery, this.searchCursor);
    } else if (key?.name === 'home') {
      this.searchCursor = 0;
    } else if (key?.name === 'end') {
      this.searchCursor = this.searchQuery.length;
    } else if (input && !key?.ctrl && !key?.meta) {
      this.searchQuery = this.searchQuery.slice(0, this.searchCursor) + input + this.searchQuery.slice(this.searchCursor);
      this.searchCursor += input.length;
      this.searchIndex = 0;
    }
    this.renderBottom();
  }

  private layout(): { rows: number; columns: number; logBottom: number } {
    const rows = Math.max(process.stdout.rows || 24, RESERVED_BOTTOM_ROWS + 2);
    const columns = Math.max(process.stdout.columns || 80, 40);
    return { rows, columns, logBottom: rows - RESERVED_BOTTOM_ROWS };
  }
}

export const terminalConsole = new TerminalConsole();

export function searchLogLines(lines: readonly string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return lines.filter((line) => line.toLowerCase().includes(normalized));
}

export function terminalSearchResult(query: string, matchCount: number, matchIndex: number, activeMatch?: string): string {
  if (!query.trim()) return 'Search results will appear here.';
  if (!matchCount) return `No matches for "${query}"`;
  return `${matchIndex % matchCount + 1}/${matchCount}: ${activeMatch ?? ''}`;
}

export function terminalSearchStatus(query: string, matchCount: number, matchIndex: number): string {
  if (!query.trim()) return 'Type to search logs | Enter/Down next | Up previous | Esc or Ctrl+F close';
  if (!matchCount) return `No matches for "${query}" | Esc or Ctrl+F close`;
  return `${matchIndex % matchCount + 1}/${matchCount} matches | Enter/Down next | Up previous | Esc close`;
}

export function completeTerminalCommand(line: string, registry: TerminalCommandRegistry = terminalCommandRegistry): [string[], string] {
  return registry.complete(line);
}

export function completeTerminalCommandInput(line: string, registry: TerminalCommandRegistry = terminalCommandRegistry): string {
  return registry.completeInput(line);
}
export function inlineTerminalSuggestion(line: string, registry: TerminalCommandRegistry = terminalCommandRegistry): string {
  return registry.inlineSuggestion(line);
}

export function toggleTerminalLogMode(mode: TerminalLogMode): TerminalLogMode {
  return mode === 'detail' ? 'compact' : 'detail';
}


export type TerminalInputViewport = { value: string; cursorOffset: number };

export function terminalInputViewport(value: string, cursorOffset: number, maxColumns: number): TerminalInputViewport {
  const characters = Array.from(value);
  const cursorCharacter = Array.from(value.slice(0, Math.max(0, Math.min(cursorOffset, value.length)))).length;
  let start = cursorCharacter;
  let usedColumns = 0;
  while (start > 0) {
    const width = terminalCellWidth(characters[start - 1]);
    if (usedColumns + width > maxColumns) break;
    start -= 1;
    usedColumns += width;
  }
  let end = cursorCharacter;
  while (end < characters.length) {
    const width = terminalCellWidth(characters[end]);
    if (usedColumns + width > maxColumns) break;
    usedColumns += width;
    end += 1;
  }
  const prefix = characters.slice(start, cursorCharacter).join('');
  return { value: characters.slice(start, end).join(''), cursorOffset: prefix.length };
}

function terminalCellWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300) ? 2 : 1;
  }
  return width;
}

function truncateTerminalLine(line: string, maxColumns: number): string {
  let output = '';
  let usedColumns = 0;
  let index = 0;
  while (index < line.length) {
    const ansi = line.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) {
      output += ansi[0];
      index += ansi[0].length;
      continue;
    }
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const width = terminalCellWidth(character);
    if (usedColumns + width > maxColumns - 1) return `${output}…\u001b[0m`;
    output += character;
    usedColumns += width;
    index += character.length;
  }
  return output;
}

export function wrapTerminalLine(line: string, maxColumns: number): string[] {
  const columns = Math.max(1, maxColumns);
  const lines: string[] = [];
  let output = '';
  let usedColumns = 0;
  let index = 0;
  let activeSgr = '';

  const pushLine = (): void => {
    lines.push(output + (activeSgr ? '\u001b[0m' : ''));
    output = activeSgr;
    usedColumns = 0;
  };

  while (index < line.length) {
    const ansi = line.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) {
      output += ansi[0];
      if (ansi[0].endsWith('m')) {
        const parameters = ansi[0].slice(2, -1).split(';');
        activeSgr = parameters.includes('0') || parameters.includes('') ? '' : ansi[0];
      }
      index += ansi[0].length;
      continue;
    }
    const codePoint = line.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const width = terminalCellWidth(character);
    if (usedColumns && usedColumns + width > columns) pushLine();
    output += character;
    usedColumns += width;
    index += character.length;
  }
  if (output || !lines.length) lines.push(output + (activeSgr ? '\u001b[0m' : ''));
  return lines;
}

function previousTerminalInputIndex(value: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = value.charCodeAt(offset - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && offset > 1 ? offset - 2 : offset - 1;
}

function nextTerminalInputIndex(value: string, offset: number): number {
  if (offset >= value.length) return value.length;
  const current = value.charCodeAt(offset);
  return current >= 0xd800 && current <= 0xdbff && offset + 1 < value.length ? offset + 2 : offset + 1;
}
export function terminalPasswordStatus(guard?: ConsolePasswordGuard): string {
  if (!guard) return 'Console locked: set BOT_CONSOLE_PASSWORD in bot/.env, then restart.';
  const remainingMs = guard.getLockRemainingMs();
  if (remainingMs > 0) return 'Console locked: try again in ' + Math.ceil(remainingMs / 1000) + ' seconds.';
  return 'Console locked: enter password.';
}
export function terminalModeStatus(mode: TerminalLogMode, fallback: { enabled: boolean; model?: string } = { enabled: false }): string {
  const fallbackLabel = fallback.enabled ? 'ON' + (fallback.model ? ': ' + fallback.model : '') : 'OFF';
  return '[LOGS: ' + mode + '] [FALLBACK: ' + fallbackLabel + '] F2 toggle | Ctrl+F search | Tab complete | help: commands';
}
export function terminalCommandRunningFeedback(command: string): string { return `[RUNNING] ${command}`; }
export function terminalCommandFeedback(command: string, lines: readonly string[]): string {
  const firstLine = lines[0]?.replace(/[\r\n]+/g, ' ') || 'Command completed.';
  const extraLines = lines.length - 1;
  return `[DONE] ${command}: ${firstLine}${extraLines > 0 ? ` (+${extraLines} more line${extraLines === 1 ? '' : 's'})` : ''}`;
}

function writePlain(level: TerminalLogLevel, source: string, message: string, timestamp: string): void {
  if (level === 'INFO') return void console.info(`[${source}] ${message}`);
  const output = decorate(level, source, message, timestamp);
  if (level === 'SUCCESS') console.info(output);
  else console.error(output);
}

function isCompactMilestone(message: string): boolean {
  return /\b(?:ready|completed?|finished|connected|sent|delivered|saved)\b|완료|준비|연결/u.test(message);
}

function decorate(level: Exclude<TerminalLogLevel, 'INFO'>, source: string, message: string, timestamp: string): string {
  const color = level === 'SUCCESS' ? '\u001b[1;32m' : level === 'WARNING' ? '\u001b[38;5;208m' : '\u001b[1;31m';
  return `${color}[${timestamp}] ${level.padEnd(8)} [${source}] ${message}\u001b[0m`;
}
function formatDetail(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
