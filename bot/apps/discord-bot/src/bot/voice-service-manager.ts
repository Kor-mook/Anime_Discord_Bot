import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

function resolveBundledFfmpeg(): string | undefined {
  try {
    const packageDirectory = dirname(require.resolve('ffmpeg-static/package.json'));
    const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const path = join(packageDirectory, executable);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

type VoiceServiceManagerOptions = {
  baseUrl: string;
  serviceDirectory?: string;
  startupTimeoutMs?: number;
  logger?: Pick<Console, 'error' | 'info' | 'warn'>;
};

export function resolveVoiceServiceDirectory(workingDirectory = process.cwd()): string {
  const candidates = [
    resolve(workingDirectory, 'apps', 'voice-service'),
    resolve(workingDirectory, '..', 'voice-service'),
    resolve(workingDirectory, '..', '..', 'voice-service')
  ];
  return candidates.find((directory) => existsSync(join(directory, 'pyproject.toml'))) ?? candidates[0];
}
export class VoiceServiceManager {
  private readonly baseUrl: string;
  private readonly serviceDirectory: string;
  private readonly startupTimeoutMs: number;
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>;
  private child?: ChildProcess;
  private startup?: Promise<void>;
  private lastError?: string;
  private serviceOutputBuffer = '';

  constructor(options: VoiceServiceManagerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.serviceDirectory = options.serviceDirectory ?? resolveVoiceServiceDirectory(process.cwd());
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.logger = options.logger ?? console;
  }

  async ensureReady(): Promise<void> {
    if (await this.isHealthy()) return;
    if (!this.isLocalService()) {
      throw new Error(`음성 서비스에 연결할 수 없습니다: ${this.baseUrl}`);
    }

    this.startup ??= this.startAndWait();
    try {
      await this.startup;
    } finally {
      this.startup = undefined;
    }
  }

  statusMessage(): string {
    return this.lastError ?? `음성 서비스(${this.baseUrl})를 시작하거나 연결하지 못했습니다.`;
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private async startAndWait(): Promise<void> {
    if (!this.child) this.startChild();
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) {
        this.logger.info(`음성 서비스 준비 완료: ${this.baseUrl}`);
        return;
      }
      if (!this.child || this.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.stop();
    throw new Error(this.statusMessage());
  }

  private startChild(): void {
    const python = this.pythonExecutable();
    if (!python) {
      this.lastError = `음성 서비스 Python 실행 파일을 찾을 수 없습니다: ${this.serviceDirectory}\\.venv`;
      throw new Error(this.lastError);
    }

    const repositoryRoot = resolve(this.serviceDirectory, '..', '..');
    const ffmpegCandidates = [
      process.env.FFMPEG_BIN,
      resolve(repositoryRoot, 'tools', 'ffmpeg', 'ffmpeg.exe'),
      resolve(repositoryRoot, 'bot', 'tools', 'ffmpeg', 'ffmpeg.exe'),
      resolveBundledFfmpeg()
    ].filter((candidate): candidate is string => typeof candidate === 'string');
    const ffmpeg = ffmpegCandidates.find((candidate) => existsSync(candidate));
    if (!ffmpeg) {
      this.lastError = 'FFmpeg executable was not found. Install project dependencies or set FFMPEG_BIN to an absolute executable path.';
      throw new Error(this.lastError);
    }

    const url = new URL(this.baseUrl);
    const sourceDirectory = join(this.serviceDirectory, 'src');
    const child = spawn(
      python,
      ['-m', 'uvicorn', 'voice_service.main:app', '--app-dir', sourceDirectory, '--host', url.hostname, '--port', url.port || '8000'],
      {
        // MeloTTS/NLTK rejects dependencies found beneath its working directory.
        // Run from the OS temp directory and explicitly provide the app source.
        cwd: tmpdir(),
        env: { ...process.env, FFMPEG_BIN: ffmpeg, PYTHONPATH: sourceDirectory, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.reportServiceOutput(chunk));
    child.on('error', (error) => {
      this.lastError = `음성 서비스 실행 실패: ${error.message}`;
      this.logger.error(this.lastError);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (code && code !== 0) {
        this.lastError ??= `음성 서비스가 종료되었습니다. 종료 코드: ${code}`;
        this.logger.error(this.lastError);
      }
    });
    this.logger.info(`음성 서비스를 시작합니다: ${python}`);
  }

  private pythonExecutable(): string | undefined {
    const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
    const repositoryRoot = resolve(this.serviceDirectory, '..', '..');
    const candidates = [
      resolve(this.serviceDirectory, '.venv', executable),
      resolve(repositoryRoot, 'bot', 'apps', 'voice-service', '.venv', executable)
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  private reportServiceOutput(chunk: string): void {
    // Python may combine several records in one stream chunk. Splitting them
    // prevents a single wrapped entry from consuming the console and avoids
    // the former duplicate "[voice-service] [voice-service]" source label.
    this.serviceOutputBuffer += chunk;
    const records = this.serviceOutputBuffer.split(/\r?\n/);
    this.serviceOutputBuffer = records.pop() ?? '';
    for (const rawLine of records) {
      const detail = rawLine.trim();
      if (!detail || /^\d+%\|/.test(detail)) continue; // tqdm progress, not a service error
      if (/\b(error|critical|traceback|exception)\b/i.test(detail)) {
        this.lastError = detail;
        this.logger.error(detail);
      } else if (/\bwarning\b/i.test(detail)) {
        this.logger.warn(detail);
      } else {
        this.logger.info(detail);
      }
    }
  }
  private isLocalService(): boolean {
    const hostname = new URL(this.baseUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
