import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

loadProjectEnvironment();

const configSchema = z
  .object({
    DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN이 필요합니다.'),
    BOT_DATABASE_URL: z.string().url('BOT_DATABASE_URL이 필요합니다.'),
    BOT_DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    BOT_DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    BOT_DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID가 필요합니다.'),
    DISCORD_GUILD_ID: z.string().trim().transform((value) => value || undefined).optional(),
    BOT_CONSOLE_PASSWORD: z.string().trim().transform((value) => value || undefined).optional(),
    BOT_API_BASE_URL: z.string().url().default('https://anime-discord-bot-rw3b.vercel.app'),
    BOT_SECRET_KEY: z.string().min(1).optional(),
    CHARACTER_MEDIA_MODE: z.enum(['enabled', 'placeholder', 'disabled']).default('placeholder'),
    VOICE_SERVICE_BASE_URL: z.string().url().default('http://localhost:8000'),
    BOT_DEV_ECHO_MODE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Service mode is the only operating default. Local direct mode deliberately
    // requires a separate opt-in so legacy BOT_TEST_DIRECT_* values cannot make
    // a production bot bypass the website conversation owner.
    BOT_RUNTIME_MODE: z.enum(['service', 'local-direct']).default('service'),
    BOT_AUTO_REPLY_CHANNEL_ID: z.string().trim().transform((value) => value || undefined).optional(),
    BOT_TEST_DIRECT_GEMINI: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    // BOT_TEST_DIRECT_GEMINI is retained for existing deployments. New local
    // deployments should use BOT_TEST_DIRECT_LLM with LLM_PROVIDER instead.
    BOT_TEST_DIRECT_LLM: z.enum(['true', 'false']).optional().transform((value) => value === undefined ? undefined : value === 'true'),
    LLM_PROVIDER: z.enum(['gemini', 'grok', 'ollama']).default('gemini'),
    OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
    LLM_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    LLM_AVAILABLE_MODELS: z
      .string()
      .default('gemini-3.5-flash-lite,gemini-3.6-flash')
      .transform((value) => [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))]),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(2_048).default(1024),
    GEMINI_API_KEY: z.string().optional(),
    LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    LLM_MAX_QUEUE: z.coerce.number().int().min(0).max(1_000).default(50),
    LLM_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(20_000),
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    GEMINI_AVAILABLE_MODELS: z
      .string()
      .default('gemini-3.5-flash-lite,gemini-3.6-flash')
      .transform((value) => [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))]),
    GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(2_048).default(1024),
    GROK_API_KEY: z.string().optional(),
    // HTTP listener for authenticated website->bot consent invalidation events.
    BOT_VOICE_CONSENT_INVALIDATION_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    BOT_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000)
  })
  .superRefine((value, context) => {
    if (!value.BOT_DEV_ECHO_MODE && !value.BOT_SECRET_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_SECRET_KEY'],
        message: 'BOT_DEV_ECHO_MODE=false이면 BOT_SECRET_KEY가 필요합니다.'
      });
    }
    const directLlmEnabled = value.BOT_RUNTIME_MODE === 'local-direct';
    if (directLlmEnabled && value.NODE_ENV === 'production') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_RUNTIME_MODE'],
        message: 'BOT_RUNTIME_MODE=local-direct is forbidden when NODE_ENV=production.'
      });
    }
    if (directLlmEnabled && !(value.BOT_TEST_DIRECT_LLM ?? value.BOT_TEST_DIRECT_GEMINI)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_TEST_DIRECT_LLM'],
        message: 'local-direct mode also requires BOT_TEST_DIRECT_LLM=true.'
      });
    }
    if (directLlmEnabled && value.LLM_PROVIDER === 'gemini' && !value.GEMINI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GEMINI_API_KEY'],
        message: 'BOT_TEST_DIRECT_GEMINI=true이면 GEMINI_API_KEY가 필요합니다.'
      });
    }
    if (directLlmEnabled && value.LLM_PROVIDER === 'grok' && !value.GROK_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GROK_API_KEY'],
        message: 'BOT_TEST_DIRECT_LLM=true and LLM_PROVIDER=grok require GROK_API_KEY.'
      });
    }

    if (!value.LLM_AVAILABLE_MODELS.includes(value.LLM_MODEL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LLM_AVAILABLE_MODELS'],
        message: 'LLM_AVAILABLE_MODELS must include LLM_MODEL.'
      });
    }
  });

export type BotConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  return configSchema.parse({
    ...environment,
    BOT_TEST_DIRECT_LLM: environment.BOT_TEST_DIRECT_LLM ?? environment.BOT_TEST_DIRECT_GEMINI,
    LLM_MODEL: environment.LLM_MODEL ?? environment.GEMINI_MODEL,
    LLM_AVAILABLE_MODELS: environment.LLM_AVAILABLE_MODELS ?? environment.GEMINI_AVAILABLE_MODELS,
    LLM_MAX_OUTPUT_TOKENS: environment.LLM_MAX_OUTPUT_TOKENS ?? environment.GEMINI_MAX_OUTPUT_TOKENS
  });
}

function loadProjectEnvironment(): void {
  let directory = process.cwd();
  while (true) {
    const candidates = [join(directory, '.env'), join(directory, 'bot', '.env')];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      process.loadEnvFile(candidate);
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}