/**
 * NURAE — the official bot fleet.
 *
 * NURAE CS Bot is the support desk. The FLEET is the rest of the official
 * lineup: the five built-in promotion bots (referral, giveaway, trivia,
 * support, community) instantiated as PLATFORM-owned bot rows (ownerId
 * null) inside the "NURAE Official" project, right next to NURAE CS.
 *
 * Why rows and not just templates: the admin wants to RUN these bots on
 * Telegram — paste a token from @BotFather into each, start it, done.
 * Platform-owned rows are unmetered by design (the platform does not pay
 * itself) and never appear in any customer's bot list.
 *
 * Seeding is idempotent and self-healing, with the same semantics as the
 * CS bot: a pointer per template lives in site_settings
 * (`official_fleet_<templateId>`), live rows are NEVER overwritten (admin
 * edits survive), vanished rows are re-created. Because template growth
 * hooks need an absolute site URL and boot time may not have one (no env,
 * no request), seeding is also called lazily from GET /api/official-bot
 * where the request origin always resolves.
 */

import { db } from '@/lib/db';
import { selectProvider } from '../ai/registry';
import { compileBehaviors, serializeBehaviors } from '../bots/behavior';
import { serializeCapabilities } from '../bots/capabilities';
import { buildTemplateBot, TEMPLATE_CATALOG, type GrowthLinks } from '../bots/templates';
import { growthLinksFromEnv } from '../bots/growth-links';
import { OFFICIAL_PROJECT_NAME } from './official-bot';

export interface FleetBotSpec {
  templateId: string;
  botName: string;
}

/** The official lineup, in display order. Names are unique inside the project. */
export const OFFICIAL_FLEET: FleetBotSpec[] = [
  { templateId: 'referral-ambassador', botName: 'NURAE Referral Bot' },
  { templateId: 'giveaway', botName: 'NURAE Giveaway Bot' },
  { templateId: 'daily-trivia', botName: 'NURAE Trivia Bot' },
  { templateId: 'support-faq', botName: 'NURAE Support Bot' },
  { templateId: 'community-hub', botName: 'NURAE Community Bot' },
];

const pointerKey = (templateId: string) => `official_fleet_${templateId}`;

/**
 * The platform's own referral code baked into the fleet's growth hooks.
 * Default "nurae" is an honest vanity code (the credit loop ignores codes
 * without a matching invite) — set NURAE_REFERRAL_CODE to the owner's real
 * invite code to let the fleet itself earn premium days.
 */
export function platformReferralCode(): string {
  return process.env.NURAE_REFERRAL_CODE?.trim() || 'nurae';
}

/**
 * Ensure every fleet bot exists. Returns the number of rows created.
 * `links` overrides env resolution (request-time callers pass the resolved
 * origin); when no site URL can be resolved nothing is seeded — the next
 * dashboard load retries lazily. Never throws far.
 */
export async function ensureOfficialFleet(links?: GrowthLinks): Promise<number> {
  try {
    const resolved = links ?? growthLinksFromEnv();
    if (!resolved) return 0;
    const project = await db.project.findFirst({
      where: { name: OFFICIAL_PROJECT_NAME },
      select: { id: true },
    });
    // The CS bot seeding owns project creation — fleet always runs after it.
    if (!project) return 0;
    const refCode = platformReferralCode();
    let seeded = 0;
    for (const spec of OFFICIAL_FLEET) {
      const key = pointerKey(spec.templateId);
      const pointer = await db.siteSetting.findUnique({ where: { key } });
      if (pointer) {
        const existing = await db.bot.findUnique({ where: { id: pointer.value }, select: { id: true } });
        if (existing) continue; // live row — admin edits are never touched
      }
      const built = buildTemplateBot(spec.templateId, resolved, refCode);
      if (!built) continue; // unknown template — catalog drift guard, skip loudly in tests
      // The same validated compile path user templates go through
      // (createUserBot): behaviors are the source of truth, compiled into
      // the executed configuration at creation time.
      const compiled = compileBehaviors(built.behaviors);
      const caps = serializeCapabilities({ commands: compiled.commands, replies: compiled.replies });
      const bot = await db.bot.create({
        data: {
          projectId: project.id,
          name: spec.botName,
          description: `Official NURAE fleet bot — ${built.description}`,
          systemPrompt: built.systemPrompt,
          provider: 'openrouter',
          model: 'openrouter/free',
          temperature: 0.5,
          memorySize: 10,
          commandsJson: caps.commandsJson,
          repliesJson: caps.repliesJson,
          behaviorsJson: serializeBehaviors(built.behaviors),
        },
      });
      await db.siteSetting.upsert({
        where: { key },
        update: { value: bot.id },
        create: { key, value: bot.id },
      });
      await db.log.create({
        data: {
          botId: bot.id,
          level: 'info',
          event: 'OFFICIAL_FLEET_SEEDED',
          message: `Official fleet bot "${bot.name}" seeded from the "${spec.templateId}" template. Add a Telegram token and start it.`,
        },
      });
      seeded += 1;
    }
    return seeded;
  } catch (err) {
    console.error(
      `[NURAE] official fleet seeding failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

export interface FleetBotStatus {
  templateId: string;
  name: string;
  tagline: string;
  category: string;
  botId: string | null;
  hasTelegramToken: boolean;
  hasApiKey: boolean;
  /** AI answerable: bot key stored OR the provider's env fallback exists. */
  ready: boolean;
  status: string | null;
  transport: string | null;
  telegramUsername: string | null;
}

/** Admin-facing fleet summary (no secrets) — CS bot NOT included (it has its own card). */
export async function officialFleetStatus(): Promise<FleetBotStatus[]> {
  const meta = new Map(TEMPLATE_CATALOG.map((t) => [t.id, t]));
  const out: FleetBotStatus[] = [];
  for (const spec of OFFICIAL_FLEET) {
    const info = meta.get(spec.templateId);
    const base = {
      templateId: spec.templateId,
      name: spec.botName,
      tagline: info?.tagline ?? '',
      category: info?.category ?? '',
    };
    const pointer = await db.siteSetting.findUnique({ where: { key: pointerKey(spec.templateId) } });
    const bot = pointer
      ? await db.bot.findUnique({ where: { id: pointer.value } })
      : null;
    if (!bot) {
      out.push({
        ...base,
        botId: null,
        hasTelegramToken: false,
        hasApiKey: false,
        ready: false,
        status: null,
        transport: null,
        telegramUsername: null,
      });
      continue;
    }
    const selection = selectProvider(bot.provider, { apiKey: null, baseUrl: bot.baseUrl });
    const envKey = selection.info.apiKeyEnvVar ? process.env[selection.info.apiKeyEnvVar] || '' : '';
    const ready = selection.info.requiresKey ? Boolean(bot.apiKeyRef) || Boolean(envKey) : true;
    out.push({
      ...base,
      botId: bot.id,
      hasTelegramToken: Boolean(bot.telegramTokenRef),
      hasApiKey: Boolean(bot.apiKeyRef),
      ready,
      status: bot.status,
      transport: bot.transport,
      telegramUsername: bot.telegramUsername,
    });
  }
  return out;
}
