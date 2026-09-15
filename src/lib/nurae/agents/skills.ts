/**
 * NURAE — the agent SKILL LIBRARY.
 *
 * Tools say WHAT an agent can touch; skills say HOW a competent operator or
 * builder actually does the common jobs. Each skill is a named playbook of
 * concrete steps that reference real registry tools, injected into the system
 * prompts of both agents, shipped in the tool manifests (/api/agents/tools,
 * /api/agent/operator) and in public/llms.txt so EXTERNAL AI agents can run
 * the same playbooks against the platform.
 *
 * Rules for writing skills:
 *   - Steps name real tools and real event codes only — never invent powers.
 *   - Each skill must be completable inside one turn's tool budget.
 *   - Honest limits: if a step needs a human (tokens, money), the skill says so.
 */

export type SkillAudience = 'builder' | 'operator';

export interface AgentSkill {
  /** Stable slug — manifests and prompts reference it. */
  id: string;
  title: string;
  audience: SkillAudience | 'both';
  /** One line for manifests and prompt listings. */
  description: string;
  /** Imperative playbook steps. Referenced tools must exist in the registry. */
  steps: string[];
}

export const AGENT_SKILLS: AgentSkill[] = [
  // ------------------------------------------------------------------
  // Builder skills (customer-facing agent)
  // ------------------------------------------------------------------
  {
    id: 'build-from-brief',
    title: 'Build a bot from a plain-language brief',
    audience: 'builder',
    description:
      'Turn "I want a bot that…" into a live draft: behaviors first, profile second, knowledge third, publish last (with approval).',
    steps: [
      'Distill the brief into behaviors BEFORE calling anything: one behavior per trigger the user implied, flows for anything with a button path.',
      'bot_create_draft with name + full behaviors (create every flow target in the SAME call).',
      'bot_set_profile with one strong sentence — this is what Telegram shows before Start.',
      'If the user attached documents: files_read → bot_add_knowledge (chunked, keep each under limits).',
      'bot_get to verify the compiled result; fix gaps with bot_set_behaviors.',
      'Offer publish; call bot_publish ONLY with the user\u2019s explicit approval (confirm:true after the approval click).',
      'Report in outcomes: what a visitor sees at /start, what each button does — never callback internals.',
    ],
  },
  {
    id: 'order-form-alerts',
    title: 'Order form / intake with instant owner alerts',
    audience: 'builder',
    description:
      'Collect steps chain answers into memory; bot_set_owner_chat pushes every completed order to the owner\u2019s own Telegram in seconds.',
    steps: [
      'Build the flow: one collect step per field (what, then who, then where), then a confirmation message that renders {{placeholders}}.',
      'Call bot_set_owner_chat with the owner\u2019s own chat id so completed forms, orders and Stars payments arrive as a Telegram message the moment they happen — the owner must have sent /start to their own bot once.',
      'If the owner doesn\u2019t know their chat id: tell them to message @userinfobot (or their own bot) — the number it shows is the id.',
      'For paid goods add a payment step (Stars) after collection; successText delivers the goods.',
      'bot_list_users later shows every order\u2019s collected attributes; alerts make checking it optional, not required.',
    ],
  },
  {
    id: 'shop-with-stars',
    title: 'Digital shop with Telegram Stars',
    audience: 'builder',
    description:
      'Catalog buttons → product page → payment step → successText delivers; bot_payments_list reconciles sales.',
    steps: [
      '/menu behavior with one button per product → each opens a product behavior (media step for the cover, message for details).',
      'End each product flow with a payment step: title, description, priceStars, successText that delivers the download/key/code.',
      'Add /paysupport behavior (refund/contact path) — payment flows feel safer with it one tap away.',
      'After the first sales: bot_payments_list to reconcile, bot_list_users to see who bought what.',
      'Never promise delivery NURAE cannot do (no file hosting) — successText may carry codes/links only.',
    ],
  },
  {
    id: 'reminders-drip',
    title: 'Reminders and drip content',
    audience: 'builder',
    description:
      'schedule steps parse "tomorrow at 9am" from the user; bot_schedule_message sets owner-side drips; bot_list_schedules audits.',
    steps: [
      'In-flow: a schedule step asks the user what and when — the bot parses the time itself and confirms.',
      'Owner-side: bot_schedule_message for daily/weekly posts (welcome series, digests) to a specific chat.',
      'bot_list_schedules to verify what exists before adding duplicates.',
      'For broadcasts to everyone, that is bot_broadcast (needs the user\u2019s approval) — not schedules.',
    ],
  },
  {
    id: 'grow-audience',
    title: 'Referral and growth loop',
    audience: 'builder',
    description:
      'template_use instantiates a proven growth bot with the user\u2019s referral code; deep links + leaderboards keep it compounding.',
    steps: [
      'template_list first — if a template fits (referral, giveaway, trivia), template_use and refine with bot_set_behaviors.',
      'Personal invite links: https://t.me/{{bot_username}}?start=ref_{{chat_id}} on a "Invite friends" button — arrivals AUTO-CREDIT the inviter.',
      'remember(mode:"add") counts invites; a top step posts the leaderboard; draw picks giveaway winners.',
      'bot_list_users to verify counters actually move after a test invite.',
    ],
  },
  {
    id: 'diagnose-bot',
    title: 'Diagnose a misbehaving bot',
    audience: 'builder',
    description:
      'bot_get → verify behaviors compiled; bot_list_users → verify state; honest fixes, no invented logs.',
    steps: [
      'bot_get: are behaviors present and non-empty? Do flow buttons point at ids that exist?',
      'bot_list_users: is the reporter\u2019s chat in the audience, and is `awaiting` stuck on an attribute?',
      'Buttons dead after an edit → the owner should press Restart on the bot page (re-registers the webhook), then send /start for fresh buttons.',
      'Silent bot → usually no token or stopped: only the owner can add a token (bot page) and press Run.',
      'Fix what is actually wrong with bot_set_behaviors / bot_update; re-verify with bot_get; say what you could NOT check.',
    ],
  },
  {
    id: 'audience-outreach',
    title: 'Audience review and outreach',
    audience: 'builder',
    description:
      'bot_list_users to understand who is here, bot_broadcast (approval-gated) to reach everyone, schedules for follow-ups.',
    steps: [
      'bot_list_users first — quote real counts and what people told the bot.',
      'Draft the message WITH the user: short, one clear action, no spam tone.',
      'bot_broadcast with confirm:true only after the user approves the send (the UI shows an Approve button).',
      'Offer a follow-up: bot_schedule_message for the next touch.',
    ],
  },
  {
    id: 'polish-copy',
    title: 'Rewrite a bot\u2019s copy and personality',
    audience: 'builder',
    description:
      'bot_get → bot_set_behaviors with rewritten texts → bot_set_profile; AI settings via bot_update when tone needs the model.',
    steps: [
      'bot_get to read current behaviors and system prompt.',
      'bot_set_behaviors with the full improved list (it replaces — include everything you want to keep).',
      'bot_set_profile with the improved one-liner.',
      'If replies feel robotic, bot_update systemPrompt: "answer in the owner\u2019s language, short lines, active verbs".',
      'Remind: press Restart after edits so Telegram serves the new wiring instantly.',
    ],
  },

  // ------------------------------------------------------------------
  // Operator skills (platform agent)
  // ------------------------------------------------------------------
  {
    id: 'morning-brief',
    title: 'Platform morning brief',
    audience: 'operator',
    description:
      'Numbers-first health check: overview, analytics, error logs, fleet status — one pass, plain report.',
    steps: [
      'platform_overview for totals + 24h deltas.',
      'bot_analytics (no botId) for the busiest bots; platform_logs with level=error for fresh breakage.',
      'fleet_status; if anything drifts, fleet_ensure (safe, idempotent) and re-check.',
      'Report: growth since yesterday, the one bot that needs attention, the one error that repeats. No filler.',
    ],
  },
  {
    id: 'fleet-health',
    title: 'Official fleet health pass',
    audience: 'operator',
    description:
      'fleet_status → fleet_ensure → platform_bot_get on the drifted bot; template truth wins, customers stay untouched.',
    steps: [
      'fleet_status: which of the six fleet bots are missing, tokenless or drifted from template?',
      'fleet_ensure (idempotent self-heal) then re-run fleet_status to confirm convergence.',
      'For a bot still off: platform_bot_get to inspect behaviors; fleet_bot_update to restore template truth (refuses customer bots — let it).',
      'Tokenless fleet bot → the fix is a human with the BotFather token; say exactly that.',
    ],
  },
  {
    id: 'diagnose-down-bot',
    title: 'Diagnose any bot (including a customer\u2019s)',
    audience: 'operator',
    description:
      'bots_list_all → platform_bot_get → platform_logs filtered by bot; name the cause from evidence, never guess.',
    steps: [
      'bots_list_all to find the bot and its owner label (Official vs customer).',
      'platform_bot_get: status, has token?, transport, last error (statusDetail).',
      'platform_logs with the botId filter: TELEGRAM_SEND_FAILED / BILLING_SKIP / BUTTON_UNKNOWN name the mechanism.',
      'Report the cause + the exact human action (add token, top up wallet, Restart in dashboard). Customer bots are inspectable, not configurable.',
    ],
  },
  {
    id: 'customer-review',
    title: 'Customer base review',
    audience: 'operator',
    description:
      'customers_overview + bot_analytics: who is active, who pays, who is drifting — with numbers.',
    steps: [
      'customers_overview for the top of the base (plans, balances, bot counts).',
      'bot_analytics for usage behind those accounts (24h/7d activity, broadcasts, Stars).',
      'Call out: newest signups with zero activity, customers near zero balance, plans about to lapse. Facts only.',
    ],
  },
  {
    id: 'settings-change',
    title: 'Safe site settings change',
    audience: 'operator',
    description:
      'platform_settings_get → platform_settings_set with confirm:true — every consequential write waits for the admin\u2019s one-click approval.',
    steps: [
      'platform_settings_get to see current values; never set blind.',
      'platform_settings_set with confirm:true once the admin clearly asked for the change.',
      'The console shows an Approve control — if the admin has not approved yet, say the change is staged, not applied.',
      'After approval re-read with platform_settings_get and quote the new value.',
    ],
  },
];

/** Skills for one audience (both included). */
export function skillsFor(audience: SkillAudience): AgentSkill[] {
  return AGENT_SKILLS.filter((s) => s.audience === audience || s.audience === 'both');
}

/**
 * The prompt section: compact id + when-to-use listing. The FULL playbooks
 * stay out of the system prompt (token budget) — the agent pulls one with
 * skill_read when the task matches. Builder tools include skill_read.
 */
export function skillIndexLines(audience: SkillAudience): string {
  const lines = skillsFor(audience).map((s) => `- ${s.id}: ${s.description}`);
  return lines.join('\n');
}

/** Full playbook text for skill_read (any audience — playbooks are not sensitive). */
export function skillPlaybook(id: string): string | null {
  const skill = AGENT_SKILLS.find((s) => s.id === id);
  if (!skill) return null;
  const steps = skill.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `SKILL ${skill.id} — ${skill.title}\n${skill.description}\n\nSTEPS:\n${steps}`;
}

/** Manifest shape for /api/agents/tools and /api/agent/operator. */
export function skillManifest(audience: SkillAudience): Array<{ id: string; title: string; description: string }> {
  return skillsFor(audience).map((s) => ({ id: s.id, title: s.title, description: s.description }));
}
