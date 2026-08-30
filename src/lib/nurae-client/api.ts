/**
 * NURAE dashboard — typed client for the NURAE API.
 * All requests use relative paths (same origin). Secrets never come back.
 */

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : `Request failed (${res.status})`;
    const fields = data.fields as Record<string, string> | undefined;
    throw new ApiError(message, res.status, fields);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Types (mirror the server DTOs — secrets are never part of these)
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  botCount: number;
  activeBots: number;
}

export interface BotDTO {
  id: string;
  projectId: string;
  name: string;
  description: string;
  telegramUsername: string | null;
  hasTelegramToken: boolean;
  hasApiKey: boolean;
  baseUrl: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeInfo {
  managed: boolean;
  status: string | null;
  startedAt: number | null;
}

export interface LogEntry {
  id: string;
  botId: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  requiresKey: boolean;
  requiresBaseUrl: boolean;
  defaultBaseUrl: string | null;
  defaultModel: string;
  models: string[];
}

export interface Catalog {
  identity: { name: string; version: string; vendor: string; tagline: string };
  providers: ProviderInfo[];
  limits: {
    temperatureMin: number;
    temperatureMax: number;
    maxTokensMin: number;
    maxTokensMax: number;
    memorySizeMin: number;
    memorySizeMax: number;
    nameMax: number;
    systemPromptMax: number;
  };
}

export interface BotInput {
  name: string;
  description?: string;
  telegramToken?: string;
  provider: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const nuraeApi = {
  authStatus: () => api<{ authRequired: boolean; authenticated: boolean }>('/api/auth/status'),
  login: (token: string) =>
    api<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }) }),
  logout: () => api<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  catalog: () => api<Catalog>('/api/catalog'),

  stats: () =>
    api<{
      stats: { projects: number; activeBots: number; stoppedBots: number; errors: number; totalBots: number };
    }>('/api/stats'),

  listProjects: () => api<{ projects: ProjectSummary[] }>('/api/projects'),
  createProject: (name: string, description: string) =>
    api<{ project: ProjectSummary }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  getProject: (id: string) => api<{ project: ProjectSummary; bots: BotDTO[] }>(`/api/projects/${id}`),
  deleteProject: (id: string) => api<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  createBot: (projectId: string, input: BotInput) =>
    api<{ bot: BotDTO }>(`/api/projects/${projectId}/bots`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getBot: (id: string) => api<{ bot: BotDTO; runtime: RuntimeInfo }>(`/api/bots/${id}`),
  deleteBot: (id: string) => api<{ ok: true }>(`/api/bots/${id}`, { method: 'DELETE' }),
  updateConfig: (id: string, input: Partial<BotInput>) =>
    api<{ bot: BotDTO; note: string; restartNeeded: boolean }>(`/api/bots/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  startBot: (id: string) =>
    api<{ bot: BotDTO; runtime: { status: string } }>(`/api/bots/${id}/start`, { method: 'POST' }),
  stopBot: (id: string) =>
    api<{ bot: BotDTO; runtime: { status: string } }>(`/api/bots/${id}/stop`, { method: 'POST' }),
  restartBot: (id: string) =>
    api<{ bot: BotDTO; runtime: { status: string } }>(`/api/bots/${id}/restart`, { method: 'POST' }),

  botStatus: (id: string) =>
    api<{
      botId: string;
      status: string;
      persistedStatus: string;
      statusDetail: string | null;
      telegramUsername: string | null;
      runtimeManaged: boolean;
    }>(`/api/bots/${id}/status`),

  botLogs: (id: string, limit = 100) => api<{ logs: LogEntry[] }>(`/api/bots/${id}/logs?limit=${limit}`),

  verifyBot: (id: string) =>
    api<{
      telegram: { valid: boolean; detail: string; username?: string | null };
      provider: { valid: boolean; detail: string };
    }>(`/api/bots/${id}/verify`, { method: 'POST' }),

  health: () => api<{ status: string; version: string; name: string; vendor: string }>('/api/health'),
};
