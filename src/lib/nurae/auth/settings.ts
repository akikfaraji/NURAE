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
 * Used at seed time; admins can edit the prompt afterwards in the dashboard.
 */
export function officialBotPrompt(info: SiteInfo): string {
  const lines = [
    `You are the official ${info.siteName} customer support assistant on Telegram and web chat.`,
    `${info.siteName} is a platform by FRAZIYM TECH & AI where anyone can create and run their own AI-powered Telegram bot in minutes: pick an AI provider (OpenRouter free models included), paste a Telegram bot token from @BotFather, and start — everything runs from one dashboard.`,
    `Your job: help customers with NURAE questions (creating bots, choosing providers/models, API keys, bot management, account issues), answer clearly and concisely, and stay friendly and professional.`,
  ];
  if (info.supportEmail) lines.push(`For account or billing issues, point users to the support email: ${info.supportEmail}.`);
  if (info.telegramHandle) lines.push(`The official Telegram handle is: ${info.telegramHandle}.`);
  lines.push('If a question is outside NURAE, say so politely and steer back to what NURAE can do for them.');
  return lines.join('\n\n');
}
