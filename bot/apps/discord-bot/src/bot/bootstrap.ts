function fatalStartup(error: unknown): never {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[fatal] Discord bot startup failed; pid=${process.pid}; uptimeMs=${Math.round(process.uptime() * 1000)}\n${detail}\n`);
  process.exit(1);
}

void import('./index.js').catch(fatalStartup);
