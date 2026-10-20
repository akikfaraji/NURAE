/**
 * NURAE — AI provider registry & catalog (spec §7).
 *
 * Adding a future provider = adding one entry here (plus its implementation).
 * The Telegram system never imports provider implementations directly — it
 * asks the registry (Provider Selector step of the pipeline).
 */

import { AIProvider, AIError } from './types';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
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
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI ChatGPT API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — free models included',
    description:
      'One key, many models. The "openrouter/free" router auto-picks among FREE models (no charge); the starter list below is the current free catalog — it rotates, so any model id can be typed manually.',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/free',
    models: [
      'openrouter/free',
      'liquid/lfm-2.5-2.6b:free',
      'thinkingmachines/inkling:free',
      'thinkingmachines/inkling-small:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek chat API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'orca',
    label: 'OrcaRouter',
    description:
      'OrcaRouter gateway — any model from a 200+ model catalog (OpenAI-, Anthropic- and Gemini-backed). See more at https://orcarouter.ai',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://api.orcarouter.ai/v1',
    apiKeyEnvVar: 'ORCA_API_KEY',
    defaultModel: 'z-ai/glm-5.3-flash-free',
    models: [
      'z-ai/glm-5.3-flash-free',
      'orcarouter/free',
      'orcarouter/auto',
      'orcarouter/fusion',
      'orcarouter/fusion-flash',
      'orcarouter/fusion-mini',
      'tencent/hy4-preview-free',
      'deepseek/deepseek-v4-flash-free',
      'tencent/hy3-free',
      'orca/orcaverify-text1.0-free',
    ],
  },
  {
    id: 'glm',
    label: 'GLM — Zhipu Open Platform',
    description: 'GLM models via the Zhipu open platform API (OpenAI-compatible HTTP).',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvVar: 'GLM_API_KEY',
    defaultModel: 'glm-5.3-flash',
    models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'glm-5.2'],
  },
  {
    id: 'local',
    label: 'Local model (llama-cpp)',
    description:
      'Any local OpenAI-compatible endpoint (default: llama-cpp at 127.0.0.1:8080/v1). No API key needed.',
    requiresKey: false,
    requiresBaseUrl: false,
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
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
      defaultBaseUrl: 'http://127.0.0.1:8080/v1',
      apiKeyEnvVar: 'LOCAL_API_KEY',
    }),
  orca: () =>
    new OpenAICompatibleProvider({
      id: 'orca',
      defaultBaseUrl: 'https://api.orcarouter.ai/v1',
      apiKeyEnvVar: 'ORCA_API_KEY',
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
  // Legacy shim: bots created before the built-in GLM provider was removed
  // store provider='zai'. Route them to OpenRouter (free models) so they
  // keep starting; the OPENROUTER_API_KEY env fallback covers the key.
  if (providerId === 'zai') providerId = 'openrouter';
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
