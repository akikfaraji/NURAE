/**
 * NURAE — AI provider registry & catalog (spec §7).
 *
 * Adding a future provider = adding one entry here (plus its implementation).
 * The Telegram system never imports provider implementations directly — it
 * asks the registry (Provider Selector step of the pipeline).
 */

import { AIProvider, AIError } from './types';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { ZaiProvider } from './providers/zai';
import type { ProviderId } from '../validation';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  requiresKey: boolean;
  requiresBaseUrl: boolean;
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  defaultModel: string;
  /** Curated starter models for the dashboard dropdown. */
  models: string[];
}

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    id: 'zai',
    label: 'GLM — Built-in (zero setup)',
    description:
      'GLM models through the FRAZIYM built-in AI. No API key required — works out of the box.',
    requiresKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: null,
    apiKeyEnvVar: null,
    defaultModel: 'glm-4.5-flash',
    models: ['glm-4.5-flash', 'glm-4.5-air', 'glm-4.5', 'glm-4-flash'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI ChatGPT API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Gateway to many models via a single OpenAI-compatible API.',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.1-70b-instruct'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek chat API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'glm',
    label: 'GLM — Zhipu Open Platform',
    description: 'GLM models via the Zhipu open platform API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvVar: 'GLM_API_KEY',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
  },
  {
    id: 'local',
    label: 'Local model (Ollama, vLLM…)',
    description:
      'Any local OpenAI-compatible endpoint (default: Ollama at 127.0.0.1:11434/v1). No API key needed.',
    requiresKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnvVar: 'LOCAL_API_KEY',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'qwen2.5', 'mistral'],
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    description: 'Any other OpenAI-compatible endpoint. Base URL is required.',
    requiresKey: true,
    requiresBaseUrl: true,
    defaultBaseUrl: null,
    apiKeyEnvVar: 'CUSTOM_API_KEY',
    defaultModel: 'default',
    models: [],
  },
];

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

type Factory = () => AIProvider;

const FACTORIES: Record<ProviderId, Factory> = {
  zai: () => new ZaiProvider(),
  openai: () =>
    new OpenAICompatibleProvider({ id: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', apiKeyEnvVar: 'OPENAI_API_KEY' }),
  openrouter: () =>
    new OpenAICompatibleProvider({
      id: 'openrouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    }),
  deepseek: () =>
    new OpenAICompatibleProvider({ id: 'deepseek', defaultBaseUrl: 'https://api.deepseek.com/v1', apiKeyEnvVar: 'DEEPSEEK_API_KEY' }),
  glm: () =>
    new OpenAICompatibleProvider({
      id: 'glm',
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyEnvVar: 'GLM_API_KEY',
    }),
  local: () =>
    new OpenAICompatibleProvider({
      id: 'local',
      defaultBaseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnvVar: 'LOCAL_API_KEY',
    }),
  custom: () =>
    new OpenAICompatibleProvider({ id: 'custom', defaultBaseUrl: 'http://localhost/v1', apiKeyEnvVar: 'CUSTOM_API_KEY' }),
};

export interface ProviderSelection {
  provider: AIProvider;
  info: ProviderInfo;
  /** API key resolved for this request (already decrypted by the caller). */
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Provider Selector — resolve a provider by id and bot configuration.
 * Throws AIError('provider_not_found') for unknown ids.
 */
export function selectProvider(
  providerId: string,
  opts?: { apiKey?: string | null; baseUrl?: string | null },
): ProviderSelection {
  const info = getProviderInfo(providerId);
  if (!info) {
    throw new AIError('provider_not_found', `Unknown AI provider: "${providerId}"`);
  }
  const provider = FACTORIES[info.id]();
  // Environment fallback for keys not stored per-bot (never logged, never returned).
  const envKey = info.apiKeyEnvVar ? process.env[info.apiKeyEnvVar] || null : null;
  const apiKey = opts?.apiKey || envKey || null;
  const baseUrl = opts?.baseUrl || info.defaultBaseUrl || null;
  return { provider, info, apiKey, baseUrl };
}

/** Is the provider's credential situation satisfiable? Used before starting bots. */
export function providerNeedsKey(providerId: string): boolean {
  const info = getProviderInfo(providerId);
  return info?.requiresKey ?? true;
}
