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
  /** Transport used at last start: "webhook" | "polling" (null: never started). */
  transport: string | null;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeInfo {
  managed: boolean;
  status: string | null;
  transport: string | null;
  pendingUpdateCount: number | null;
}

export interface LogEntry {
  id: string;
  botId: string | null;
  level: 'info' | 'warn' | 'error';
  /** Structured event code (Step 9), e.g. BOT_STARTED, AI_RESPONSE. */
  event: string | null;
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

// --- Platform layer (public site + admin additions) -------------------------

export interface SessionUserDTO {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  hasPassword: boolean;
  createdAt: string;
}

export interface SiteInfoDTO {
  siteName: string;
  tagline: string;
  supportEmail: string;
  telegramHandle: string;
  welcomeMessage: string;
}

export interface SiteInfoResponse {
  site: SiteInfoDTO;
  auth: { googleEnabled: boolean; gmailEnabled: boolean };
}

export interface SupportStatusResponse {
  configured: boolean;
  telegramUsername: string | null;
  site: SiteInfoDTO;
}

export interface ChatMessageDTO {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface CustomerDTO {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  signupMethod: 'google' | 'email';
  hasPassword: boolean;
  role: string;
  chatMessages: number;
  activeSessions: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface OfficialBotResponse {
  official: {
    botId: string | null;
    ready: boolean;
    hasTelegramToken: boolean;
    hasApiKey: boolean;
    status: string | null;
    telegramUsername: string | null;
    transport: string | null;
  };
  bot: BotDTO | null;
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
      stats: { projects: number; activeBots: number; stoppedBots: number; errors: number; totalBots: number; users: number };
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
      transport: string | null;
      pendingUpdateCount: number | null;
      telegramLastErrorMessage: string | null;
      runtimeManaged: boolean;
    }>(`/api/bots/${id}/status`),

  botLogs: (id: string, limit = 100) => api<{ logs: LogEntry[] }>(`/api/bots/${id}/logs?limit=${limit}`),

  verifyBot: (id: string) =>
    api<{
      telegram: { valid: boolean; detail: string; username?: string | null };
      provider: { valid: boolean; detail: string };
    }>(`/api/bots/${id}/verify`, { method: 'POST' }),

  health: () => api<{ status: string; version: string; name: string; vendor: string }>('/api/health'),

  // --- Platform layer -------------------------------------------------------
  // Public (no admin token): site info + customer auth + support chat.
  siteInfo: () => api<SiteInfoResponse>('/api/public/site-info'),
  register: (name: string, email: string, password: string) =>
    api<{ ok: true; devCode?: string; notice?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),
  verifyEmail: (email: string, code: string) =>
    api<{ ok: true; alreadyVerified?: boolean }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  userLogin: (email: string, password: string) =>
    api<{ ok: true; user: SessionUserDTO }>('/api/auth/user-login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  userLogout: () => api<{ ok: true }>('/api/auth/user-logout', { method: 'POST' }),
  me: () => api<{ user: SessionUserDTO | null }>('/api/auth/me'),
  supportStatus: () => api<SupportStatusResponse>('/api/support/status'),
  supportHistory: () => api<{ messages: ChatMessageDTO[] }>('/api/support/history'),
  supportChat: (message: string) =>
    api<{ reply: string }>('/api/support/chat', { method: 'POST', body: JSON.stringify({ message }) }),

  // Admin-only platform endpoints.
  officialBot: () => api<OfficialBotResponse>('/api/official-bot'),
  getSettings: () => api<{ settings: SiteInfoDTO }>('/api/settings'),
  saveSettings: (patch: Partial<SiteInfoDTO>) =>
    api<{ settings: SiteInfoDTO }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  listCustomers: () => api<{ customers: CustomerDTO[]; total: number }>('/api/admin/customers'),
  deleteCustomer: (id: string) => api<{ ok: true }>(`/api/admin/customers/${id}`, { method: 'DELETE' }),
};
