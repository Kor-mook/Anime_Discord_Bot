export type TerminalCommandResult = string | string[] | undefined;
export type TerminalCommandHandler = (input: TerminalCommandInput) => Promise<TerminalCommandResult> | TerminalCommandResult;

export type TerminalCommandInput = {
  /** The registered root command, normalized to lower case. */
  command: string;
  /** Everything after the root command, split on whitespace. */
  args: readonly string[];
  /** The command exactly as the user entered it, except leading/trailing whitespace. */
  raw: string;
};

export type TerminalCommandDefinition = {
  /** One root token, for example `fallback` or `voice`. */
  name: string;
  /** The line automatically included in `help`. */
  help: string;
  /**
   * Full command paths which can be completed. This supports multi-token
   * commands directly, e.g. `voice pause all`.
   */
  completions?: readonly string[];
  handler: TerminalCommandHandler;
};

type RegisteredTerminalCommand = Omit<TerminalCommandDefinition, 'name' | 'completions'> & {
  name: string;
  completions: readonly string[];
};

/**
 * Single source of truth for local-console commands. Registering a command
 * makes it executable, visible in help, and available to Tab completion.
 */
export class TerminalCommandRegistry {
  private readonly commands = new Map<string, RegisteredTerminalCommand>();

  register(definition: TerminalCommandDefinition): this {
    const name = normalizeCommandName(definition.name);
    if (this.commands.has(name)) throw new Error(`Terminal command "${name}" is already registered.`);

    const completions = uniqueCommandPaths(definition.completions?.length ? definition.completions : [name], name);
    this.commands.set(name, { ...definition, name, completions });
    return this;
  }

  helpLines(): string[] {
    return [...this.commands.values()].map((command) => command.help);
  }

  completionCandidates(): string[] {
    return [...this.commands.values()].flatMap((command) => command.completions);
  }

  complete(line: string): [string[], string] {
    const query = completionQuery(line);
    const candidates = this.completionCandidates();
    const matches = candidates.filter((candidate) => candidate.toLowerCase().startsWith(query));
    return [matches.length ? matches : candidates, line];
  }

  completeInput(line: string): string {
    const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
    const query = completionQuery(line);
    const matches = this.completionCandidates().filter((candidate) => candidate.toLowerCase().startsWith(query));
    if (!matches.length) return line;

    const completion = commonPrefix(matches.map((candidate) => candidate.toLowerCase()));
    return completion.length > query.length ? leadingWhitespace + completion : line;
  }

  inlineSuggestion(line: string): string {
    const query = completionQuery(line);
    if (!query) return '';
    const matches = this.completionCandidates().filter((candidate) => candidate.toLowerCase().startsWith(query));
    if (!matches.length) return '';
    if (matches.length === 1) return matches[0].slice(query.length);
    return `  [Tab: ${matches.join(' | ')}]`;
  }

  async execute(raw: string): Promise<TerminalCommandResult> {
    const input = raw.trim();
    const [enteredName = '', ...args] = input.split(/\s+/);
    const command = this.commands.get(enteredName.toLowerCase());
    if (!command) return `Unknown command: ${enteredName}. Type help for local console commands.`;
    return command.handler({ command: command.name, args, raw: input });
  }
}

export const terminalCommandRegistry = new TerminalCommandRegistry();

function normalizeCommandName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!name || /\s/u.test(name)) throw new Error('A terminal command name must be one non-empty token.');
  return name;
}

function uniqueCommandPaths(paths: readonly string[], name: string): string[] {
  const values = new Map<string, string>();
  for (const path of paths) {
    const normalized = path.trim().replace(/\s+/gu, ' ');
    const normalizedName = normalized.toLowerCase();
    if (!normalized || (normalizedName !== name && !normalizedName.startsWith(`${name} `))) {
      throw new Error(`Completion path "${path}" must start with terminal command "${name}".`);
    }
    values.set(normalizedName, normalized);
  }
  return [...values.values()];
}

function completionQuery(line: string): string {
  return line.trimStart().toLowerCase();
}

function commonPrefix(values: readonly string[]): string {
  return values.reduce((prefix, value) => {
    let length = 0;
    while (length < prefix.length && length < value.length && prefix[length] === value[length]) length += 1;
    return prefix.slice(0, length);
  });
}
