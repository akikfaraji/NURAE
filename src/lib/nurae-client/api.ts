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
  /** The official CS prompt rebuilt from current site settings. */
  officialPrompt: string;
}

// --- Chats / Agents / Files / My bots / Referral ----------------------------

export interface BotCommandSpecDTO {
  command: string;
  description: string;
  kind: 'static' | 'ai';
  response: string;
}

export interface BotReplyButtonDTO {
  text: string;
  url?: string;
  callback?: string;
}

export interface BotReplySpecDTO {
  id: string;
  name: string;
  trigger: { type: 'command' | 'keyword' | 'button' | 'fallback'; value?: string };
  messages: Array<{ text: string; ai?: string; buttons?: BotReplyButtonDTO[][] }>;
}

// Behaviors — the intent-first source of truth (compiled into commands/replies)
export type BehaviorButtonActionDTO =
  | { kind: 'message'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'webapp'; url: string }
  | { kind: 'copy'; text: string }
  | { kind: 'flow'; behaviorId: string }
  | { kind: 'ai'; instruction?: string };

export interface BehaviorButtonDTO {
  label: string;
  action: BehaviorButtonActionDTO;
}

export type BehaviorStepDTO =
  | {
      type: 'message';
      text: string;
      buttons?: BehaviorButtonDTO[];
      keyboard?: 'inline' | 'reply' | 'none';
      edit?: boolean;
      forceReply?: boolean;
      removeKeyboard?: boolean;
    }
  | { type: 'ai'; instruction?: string }
  | { type: 'media'; media: { kind: string; source: string; caption?: string; filename?: string }; buttons?: BehaviorButtonDTO[] }
  | {
      type: 'poll';
      poll: { question: string; options: string[]; quiz?: boolean; correctOption?: number; explanation?: string; anonymous?: boolean };
    }
  | { type: 'payment'; payment: { title: string; description: string; priceStars: number; successText?: string } }
  | { type: 'collect'; collect: { attribute: string; prompt?: string } }
  | { type: 'schedule'; schedule: { prompt?: string } }
  | { type: 'remember'; remember: { attribute: string; value?: string; mode?: 'set' | 'add' } }
  | { type: 'draw'; draw: { attribute: string; announce?: string; emptyText?: string } }
  | { type: 'top'; top: { attribute: string; title?: string; limit?: number } };

export type BehaviorWhenDTO =
  | { type: 'start' }
  | { type: 'command'; command: string }
  | { type: 'says'; text: string }
  | { type: 'button' }
  | { type: 'payload'; value: string }
  | { type: 'member_joined' }
  | { type: 'anything_else' };

export interface BotBehaviorDTO {
  id: string;
  title: string;
  when: BehaviorWhenDTO;
  steps: BehaviorStepDTO[];
}

export interface UserBotDTO extends BotDTO {
  ownerId: string | null;
  archived: boolean;
  commands: BotCommandSpecDTO[];
  replies: BotReplySpecDTO[];
  behaviors: BotBehaviorDTO[];
}

export interface SessionDTO {
  id: string;
  kind: 'chat' | 'agent';
  agent: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  preview: string | null;
}

export interface ActivityStepDTO {
  seq: number;
  tool: string;
  label: string;
  status: 'ok' | 'error' | 'confirm';
  detail?: string;
}

export interface EntryDTO {
  id: string;
  role: string;
  content: string;
  attachments: Array<{ fileId: string; name: string; kind: string }>;
  activity: ActivityStepDTO[];
  needsConfirm: boolean;
  draftBotId: string | null;
  handoff: { agent: string; sessionId: string; task?: string } | null;
  createdAt: string;
}

export interface FileDTO {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  status: string;
}

export interface CapturedSendDTO {
  kind?: 'text' | 'media' | 'poll' | 'payment' | 'edit';
  text: string;
  parseMode?: 'HTML';
  buttons?: Array<Array<{ text: string; url?: string; callback?: string; webapp?: string; copy?: string }>>;
  keyboard?: 'reply' | 'inline' | 'none';
  media?: { kind: string; source: string; caption?: string };
  poll?: { question: string; options: string[]; quiz?: boolean };
  payment?: { title: string; description: string; priceStars: number };
}

export interface BroadcastDTO {
  id: string;
  text: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
}

export interface BotScheduleDTO {
  id: string;
  chatId: string;
  text: string;
  runAt: string;
  recurrence: string;
  status: string;
  lastError: string | null;
}

export interface BotPaymentDTO {
  chatId: string;
  amount: number;
  currency: string;
  payload: string;
  title: string;
  createdAt: string;
}

export interface BotUserStateDTO {
  chatId: string;
  attributes: Record<string, string>;
  startPayload: string | null;
}

export interface ReferralResponse {
  referral: { code: string; invited: number; qualified: number; rewardDaysTotal: number };
  reward: { days: number; feature: string };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// --- Billing DTOs -----------------------------------------------------------

export interface PriceRowDTO {
  feature: string;
  displayName: string;
  description: string;
  unit: string;
  unitPriceMicros: number;
  freeDailyUnits: number;
  enabled: boolean;
  hardGate: boolean;
}

export interface UsageTodayDTO {
  feature: string;
  used: number;
  freeDailyUnits: number;
  unitPriceMicros: number;
  chargedTodayMicros: number;
}

export interface BillingSummary {
  balanceMicros: number;
  freeRide: { mode: 'trial' | 'premium' | null; trialEndsAt: string | null; premiumEndsAt: string | null };
  usageToday: UsageTodayDTO[];
  prices: PriceRowDTO[];
  topup: {
    starsAvailable: boolean;
    starsRateMicros: number;
    starsPresets: number[];
    cryptoAuto: boolean;
    assets: Array<{ asset: string; name: string; network: string }>;
  };
}

export interface LedgerEntryDTO {
  id: string;
  kind: string;
  feature: string | null;
  amountMicros: number;
  balanceAfter: number;
  unitCount: number;
  note: string | null;
  refId: string | null;
  createdAt: string;
}

export interface TopupOrderDTO {
  id: string;
  orderNo: string;
  provider: string;
  asset: string | null;
  address: string | null;
  expectedStars: number | null;
  expectedUsdMicros: number | null;
  status: string;
  payUrl: string | null;
  txHash: string | null;
  creditedMicros: number | null;
  note: string | null;
  createdAt: string;
  paidAt: string | null;
}

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
  register: (name: string, email: string, password: string, ref?: string) =>
    api<{ ok: true; devCode?: string; notice?: string; mailError?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, ...(ref ? { ref } : {}) }),
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
  syncOfficialPrompt: () =>
    api<{ bot: BotDTO; note: string }>('/api/official-bot', {
      method: 'POST',
      body: JSON.stringify({ action: 'sync-prompt' }),
    }),
  getSettings: () => api<{ settings: SiteInfoDTO }>('/api/settings'),
  saveSettings: (patch: Partial<SiteInfoDTO>) =>
    api<{ settings: SiteInfoDTO }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  listCustomers: () => api<{ customers: CustomerDTO[]; total: number }>('/api/admin/customers'),
  deleteCustomer: (id: string) => api<{ ok: true }>(`/api/admin/customers/${id}`, { method: 'DELETE' }),

  // --- Chats + agents -------------------------------------------------------
  listSessions: (kind?: 'chat' | 'agent') =>
    api<{ sessions: SessionDTO[] }>(`/api/chats${kind ? `?kind=${kind}` : ''}`),
  createSession: (input: { kind?: 'chat' | 'agent'; title?: string }) =>
    api<{ session: SessionDTO }>('/api/chats', { method: 'POST', body: JSON.stringify(input) }),
  getSession: (id: string) => api<{ session: SessionDTO; entries: EntryDTO[] }>(`/api/chats/${id}`),
  patchSession: (id: string, patch: { title?: string; status?: 'active' | 'archived' }) =>
    api<{ ok?: boolean }>(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => api<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  sendChatMessage: (id: string, text: string, attachmentIds?: string[]) =>
    api<{ reply: string; handoff: { agent: string; sessionId: string; task: string } | null }>(
      `/api/chats/${id}/messages`,
      { method: 'POST', body: JSON.stringify({ text, attachmentIds }) },
    ),

  listAgentSessions: () => api<{ sessions: SessionDTO[] }>('/api/agents/sessions'),
  createAgentSession: (title?: string) =>
    api<{ session: SessionDTO }>('/api/agents/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  sendAgentMessage: (id: string, text: string, approve = false, attachmentIds?: string[]) =>
    api<{ reply: string; activity: ActivityStepDTO[]; needsConfirm: boolean; draftBotId: string | null }>(
      `/api/agents/sessions/${id}/messages`,
      { method: 'POST', body: JSON.stringify({ text, approve, attachmentIds }) },
    ),

  // --- Files ----------------------------------------------------------------
  uploadFile: async (file: File, sessionId?: string): Promise<{ file: FileDTO }> => {
    const form = new FormData();
    form.append('file', file);
    if (sessionId) form.append('sessionId', sessionId);
    const res = await fetch('/api/files', { method: 'POST', body: form });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'Upload failed', res.status);
    return data as { file: FileDTO };
  },
  listFiles: () => api<{ files: FileDTO[] }>('/api/files'),

  // --- My bots --------------------------------------------------------------
  listMyBots: (includeArchived = false) =>
    api<{ bots: UserBotDTO[] }>(`/api/my/bots${includeArchived ? '?archived=1' : ''}`),
  getMyBot: (id: string) => api<{ bot: UserBotDTO }>(`/api/my/bots/${id}`),
  createMyBot: (input: Record<string, unknown>) =>
    api<{ bot: UserBotDTO }>('/api/my/bots', { method: 'POST', body: JSON.stringify(input) }),
  createBotFromTemplate: (templateId: string) =>
    api<{ bot: UserBotDTO }>('/api/my/bots/from-template', {
      method: 'POST',
      body: JSON.stringify({ templateId }),
    }),
  updateMyBot: (id: string, patch: Record<string, unknown>) =>
    api<{ bot: UserBotDTO }>(`/api/my/bots/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMyBot: (id: string) => api<{ ok: true }>(`/api/my/bots/${id}`, { method: 'DELETE' }),
  publishMyBot: (id: string) =>
    api<{ bot: UserBotDTO }>(`/api/my/bots/${id}/publish`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  unpublishMyBot: (id: string) =>
    api<{ bot: UserBotDTO }>(`/api/my/bots/${id}/publish`, { method: 'DELETE' }),
  testMyBot: (id: string, input: { text?: string; callback?: string }) =>
    api<{ sends: CapturedSendDTO[]; error: string | null }>(`/api/my/bots/${id}/test`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listMyBotUsers: (id: string) =>
    api<{ total: number; users: BotUserStateDTO[] }>(`/api/my/bots/${id}/users`),
  listMyBotBroadcasts: (id: string) =>
    api<{ broadcasts: BroadcastDTO[] }>(`/api/my/bots/${id}/broadcast`),
  broadcastMyBot: (id: string, text: string) =>
    api<{ broadcast: { id: string; status: string; total: number } }>(`/api/my/bots/${id}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  listMyBotSchedules: (id: string) =>
    api<{ schedules: BotScheduleDTO[] }>(`/api/my/bots/${id}/schedules`),
  cancelMyBotSchedule: (id: string, scheduleId: string) =>
    api<{ ok: true }>(`/api/my/bots/${id}/schedules?scheduleId=${encodeURIComponent(scheduleId)}`, { method: 'DELETE' }),
  listMyBotPayments: (id: string) =>
    api<{ totalStars: number; payments: BotPaymentDTO[] }>(`/api/my/bots/${id}/payments`),

  // --- Referral -------------------------------------------------------------
  referral: () => api<ReferralResponse>('/api/referral'),

  // --- Billing (pay-as-you-use) --------------------------------------------
  billingSummary: () => api<BillingSummary>('/api/billing'),
  billingLedger: (limit = 50) => api<{ entries: LedgerEntryDTO[] }>(`/api/billing/ledger?limit=${limit}`),
  billingTopupStars: (stars: number) =>
    api<{ order: TopupOrderDTO }>('/api/billing/topup', {
      method: 'POST',
      body: JSON.stringify({ provider: 'stars', stars }),
    }),
  billingTopupCrypto: (asset: string, usdMicros: number) =>
    api<{ order: TopupOrderDTO }>('/api/billing/topup', {
      method: 'POST',
      body: JSON.stringify({ provider: 'crypto', asset, usdMicros }),
    }),
  billingTopupSubmitTx: (orderId: string, txHash: string) =>
    api<{ order: TopupOrderDTO }>('/api/billing/topup-tx', {
      method: 'POST',
      body: JSON.stringify({ orderId, txHash }),
    }),
  billingOrders: () => api<{ orders: TopupOrderDTO[] }>('/api/billing/topup'),
};
