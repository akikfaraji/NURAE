/**
 * NURAE — input validation schemas (zod).
 *
 * All API inputs are validated here — frontend validation alone is never
 * trusted (spec §18). Validation is also reused by the runtime when it loads
 * bot configuration, so a corrupted row cannot poison a bot process.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const BOT_STATUSES = ['stopped', 'starting', 'running', 'stopping', 'error'] as const;

export const LIMITS = {
  nameMax: 100,
  descriptionMax: 2000,
  systemPromptMax: 8000,
  modelMax: 200,
  baseUrlMax: 500,
  temperatureMin: 0,
  temperatureMax: 2,
  maxTokensMin: 1,
  maxTokensMax: 100000,
  memorySizeMin: 1,
  memorySizeMax: 50,
};

// ---------------------------------------------------------------------------
// AI providers (kept in sync with src/lib/nurae/ai/providers.ts)
// ---------------------------------------------------------------------------

export const PROVIDER_IDS = ['zai', 'openai', 'openrouter', 'deepseek', 'glm', 'local', 'custom'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(LIMITS.nameMax, `Name must be at most ${LIMITS.nameMax} characters`);

const descriptionSchema = z
  .string()
  .trim()
  .max(LIMITS.descriptionMax, `Description must be at most ${LIMITS.descriptionMax} characters`)
  .optional()
  .default('');

export const createProjectSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
});

export const updateProjectSchema = z.object({
  name: nameSchema.optional(),
  description: z
    .string()
    .trim()
    .max(LIMITS.descriptionMax)
    .optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

export const createBotSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  telegramToken: z
    .string()
    .trim()
    .min(1, 'Telegram bot token is required')
    .max(128, 'Telegram bot token looks invalid')
    .regex(/^\d{6,12}:[A-Za-z0-9_-]{25,}$/, 'Telegram bot token format is invalid (expected <bot_id>:<secret>)'),
  provider: z.enum(PROVIDER_IDS).default('zai'),
  model: z.string().trim().min(1, 'Model is required').max(LIMITS.modelMax).default('glm-4.5-flash'),
  systemPrompt: z
    .string()
    .trim()
    .min(1, 'System prompt is required')
    .max(LIMITS.systemPromptMax, `System prompt must be at most ${LIMITS.systemPromptMax} characters`)
    .default('You are a helpful customer-support assistant.\nAnswer clearly and concisely.\nIf you do not know something, say so.'),
  temperature: z.number().min(LIMITS.temperatureMin).max(LIMITS.temperatureMax).default(0.7),
  maxTokens: z.number().int().min(LIMITS.maxTokensMin).max(LIMITS.maxTokensMax).default(1024),
  memorySize: z.number().int().min(LIMITS.memorySizeMin).max(LIMITS.memorySizeMax).default(10),
  apiKey: z.string().trim().max(500).optional().or(z.literal('')),
  baseUrl: z.string().trim().url('Base URL must be a valid URL').max(LIMITS.baseUrlMax).optional().or(z.literal('')),
});

export const updateBotConfigSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().max(LIMITS.descriptionMax).optional(),
  systemPrompt: z.string().trim().min(1).max(LIMITS.systemPromptMax).optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().trim().min(1).max(LIMITS.modelMax).optional(),
  temperature: z.number().min(LIMITS.temperatureMin).max(LIMITS.temperatureMax).optional(),
  maxTokens: z.number().int().min(LIMITS.maxTokensMin).max(LIMITS.maxTokensMax).optional(),
  memorySize: z.number().int().min(LIMITS.memorySizeMin).max(LIMITS.memorySizeMax).optional(),
  enabled: z.boolean().optional(),
  telegramToken: z
    .string()
    .trim()
    .regex(/^\d{6,12}:[A-Za-z0-9_-]{25,}$/, 'Telegram bot token format is invalid')
    .optional(),
  apiKey: z.string().trim().max(500).optional().or(z.literal('')),
  baseUrl: z.string().trim().url('Base URL must be a valid URL').max(LIMITS.baseUrlMax).optional().or(z.literal('')),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotConfigInput = z.infer<typeof updateBotConfigSchema>;

/** Telegram bot token shape (used by the runtime before getMe verification). */
export const TELEGRAM_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{25,}$/;

/** Format a zod error into a flat, API-friendly record. */
export function formatZodError(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
