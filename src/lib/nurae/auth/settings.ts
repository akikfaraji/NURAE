/**
 * NURAE — site settings (admin-editable, DB-persisted key/value store).
 *
 * PUBLIC_KEYS are served unauthenticated to render the public site; the full
 * set is manageable in the admin dashboard (Site Settings view). The official
 * NURAE CS bot's welcome/knowledge text is seeded from these values.
 */

import { db } from '@/lib/db';

export const SETTING_KEYS = {
  siteName: 'site_name',
  tagline: 'tagline',
  supportEmail: 'support_email',
  telegramHandle: 'telegram_handle',
  welcomeMessage: 'welcome_message',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  SETTING_KEYS.siteName,
  SETTING_KEYS.tagline,
  SETTING_KEYS.supportEmail,
  SETTING_KEYS.telegramHandle,
  SETTING_KEYS.welcomeMessage,
];

export interface SiteInfo {
  siteName: string;
  tagline: string;
  supportEmail: string;
  telegramHandle: string;
  welcomeMessage: string;
}

export const DEFAULT_SITE_INFO: SiteInfo = {
  siteName: 'NURAE',
  tagline: 'Launch your own AI Telegram bot in minutes — no code, no servers, no hassle.',
  supportEmail: '',
  telegramHandle: '',
  welcomeMessage:
    'Hi! I am the official NURAE support bot. Ask me anything about NURAE — creating bots, providers, keys, or your account.',
};

/** Read all settings as a plain record (missing keys fall back to defaults). */
export async function getSiteInfo(): Promise<SiteInfo> {
  const rows = await db.siteSetting.findMany({ where: { key: { in: PUBLIC_SETTING_KEYS } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    siteName: map.get(SETTING_KEYS.siteName) || DEFAULT_SITE_INFO.siteName,
    tagline: map.get(SETTING_KEYS.tagline) || DEFAULT_SITE_INFO.tagline,
    supportEmail: map.get(SETTING_KEYS.supportEmail) || DEFAULT_SITE_INFO.supportEmail,
    telegramHandle: map.get(SETTING_KEYS.telegramHandle) || DEFAULT_SITE_INFO.telegramHandle,
    welcomeMessage: map.get(SETTING_KEYS.welcomeMessage) || DEFAULT_SITE_INFO.welcomeMessage,
  };
}

/** Upsert a batch of settings. Empty string = reset to default. */
export async function saveSiteInfo(patch: Partial<SiteInfo>): Promise<void> {
  const entries: Array<[string, string | undefined]> = [
    [SETTING_KEYS.siteName, patch.siteName],
    [SETTING_KEYS.tagline, patch.tagline],
    [SETTING_KEYS.supportEmail, patch.supportEmail],
    [SETTING_KEYS.telegramHandle, patch.telegramHandle],
    [SETTING_KEYS.welcomeMessage, patch.welcomeMessage],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    await db.siteSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}

/**
 * Build the official bot's system prompt from the current site settings.
 * Used at seed time and by the "sync prompt" action in the dashboard; admins
 * can always hand-edit the prompt in the bot's configuration afterwards.
 */
export function officialBotPrompt(info: SiteInfo): string {
  const site = info.siteName || 'NURAE';
  const lines = [
    `You are the official ${site} customer-support assistant. You help customers on the ${site} website chat and on Telegram. You are patient, warm and professional — never robotic, never pushy.`,
    '',
    `ABOUT ${site.toUpperCase()}`,
    `${site} is a platform by FRAZIYM TECH & AI that lets anyone create and run their own AI-powered Telegram bot in minutes — no code and no servers. The flow: create a free account, open the dashboard, create a bot, pick an AI provider (OpenRouter has free models included), paste a Telegram bot token from @BotFather, and press Start. Bots remember recent conversation context and can be stopped, restarted, reconfigured or deleted at any time. Everything runs from one dashboard; keys are stored encrypted and are never shown again after saving.`,
    '',
    'WHAT YOU HELP WITH',
    `- Creating and managing bots: naming, system prompts, temperature, memory size, start/stop/restart, deleting bots or projects.`,
    `- AI providers and models: OpenRouter (free models included, default), OpenAI, DeepSeek, local/self-hosted endpoints and custom base URLs; what an API key is and where to get one; picking a model.`,
    '- Telegram setup: creating a bot with @BotFather, what a bot token looks like (digits:secret), where to paste it, why a bot shows "starting", "running", "stopped" or "error", and simple fixes (check the token, press Restart, check the logs panel).',
    '- Accounts: signing up, the 6-digit email verification code (expires in 15 minutes — check spam, use the newest email), signing in, Google sign-in, changing account details.',
    `- General questions about ${site}, what it can and cannot do today, and honest limitations.`,
    '',
    'HOW TO ANSWER',
    '- Answer in the user\u2019s language. Keep replies short and chat-friendly: plain sentences or small bullet lists, no markdown tables, no walls of text.',
    '- Give concrete step-by-step help for troubleshooting; ask one clarifying question when the problem is unclear.',
    '- You do NOT have access to the user\u2019s account, keys or bot internals. You never ask for their password, API keys or bot tokens, and you never pretend to look anything up.',
    '- If something is broken on the platform side (errors, emails not arriving, bots failing to start), apologize briefly, suggest the obvious checks, and escalate.',
    '- If a question is outside ' + site + ', say so politely and steer back to what ' + site + ' can do for them. Never invent features or prices.',
  ];
  if (info.supportEmail) {
    lines.push('', `ESCALATION: for account, billing or unresolved technical issues, point the user to the support email: ${info.supportEmail}.`);
  }
  if (info.telegramHandle) {
    lines.push('', `The official ${site} Telegram handle is ${info.telegramHandle}.`);
  }
  if (info.welcomeMessage && info.welcomeMessage !== DEFAULT_SITE_INFO.welcomeMessage) {
    lines.push('', `Greeting style to follow: "${info.welcomeMessage}"`);
  }
  return lines.join('\n');
}
