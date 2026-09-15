/**
 * NURAE — agent documentation: the reference an agent reads to write REAL
 * bot configurations instead of guessing.
 *
 * Keeping this OUT of the system prompt matters: the Bot Builder prompt is
 * already large, and free-model context is precious. `docs_read` puts the
 * full behavior DSL one tool call away — the agent pulls a topic only when
 * the task needs it (a giveaway needs verify_join; an invite funnel needs
 * email_invite; a habit bot needs streak/milestone).
 *
 * Everything here mirrors the zod schemas in ../bots/behavior.ts 1:1 — when
 * the compiler changes, this file changes with it (checked by tests).
 */

export type DocsTopic = 'behaviors' | 'growth' | 'billing' | 'lifecycle';

export const DOCS_TOPICS: DocsTopic[] = ['behaviors', 'growth', 'billing', 'lifecycle'];

const BEHAVIORS = `BEHAVIOR DSL — the full reference.
A behavior: { id (slug), title (<=100 chars), when: <trigger>, steps: [<step>, ...] }.
Limits: max 40 behaviors per bot, 1-10 steps each. Flow targets must exist in the SAME bot_set_behaviors call.

TRIGGERS (when):
  {"type":"start"}                           someone presses Start (also fires for /start)
  {"type":"command","command":"/menu"}        a typed /command
  {"type":"says","text":"price"}             a message contains this word
  {"type":"button"}                          target of a flow button action
  {"type":"payload","value":"flyer"}         arrival from a deep link (...?start=flyer)
  {"type":"member_joined"}                   someone joins a group the bot is in
  {"type":"anything_else"}                   fallback for unmatched text (AI or static)

STEPS:
  {"type":"message","text":"...","buttons":[...],"keyboard":"inline"|"reply"|"none",
   "edit":true,"forceReply":true,"removeKeyboard":true}
     Text (markdown). Placeholders: {{name}}, {{chat_id}}, {{bot_username}},
     any collected attribute {{score}}, fallbacks {{score|0}}.
     Buttons: {"label":"Menu","action":{"kind":"message","text":"..."}} |
     {"kind":"link","url":"https://..."} (URLs template too) |
     {"kind":"flow","behaviorId":"menu"} (create that behavior in the SAME call) |
     {"kind":"copy","text":"..."} | {"kind":"webapp","url":"..."} |
     {"kind":"ai","instruction":"..."}.
  {"type":"ai","instruction":"tone/role hint"} — the bot's LLM answers with conversation memory.
  {"type":"media","media":{"kind":"photo"|"video"|"audio"|"voice"|"animation"|"document"|"sticker",
   "source":"https://...","caption":"..."},"buttons":[...]}
  {"type":"poll","poll":{"question":"...","options":["..."],"quiz":true,"correctOption":0,
   "anonymous":false}}
  {"type":"payment","payment":{"title":"<=32","description":"<=255","priceStars":25,
   "successText":"delivers the goods"}} — Telegram Stars; /terms /paysupport /support are added automatically.
  {"type":"collect","collect":{"attribute":"dish","prompt":"What would you like?"}} — asks and REMEMBERS.
  {"type":"remember","remember":{"attribute":"score","value":"1","mode":"set"|"add"}} — silent counter/flag.
  {"type":"schedule","schedule":{"prompt":"What and when?"}} — the bot's AI parses the answer into a reminder.

COMPILED AWAY: commands, inline keyboards, callbacks, mini-workflows — you never write them.`;

const GROWTH = `GROWTH PRIMITIVES — what makes bots grow a community.

  {"type":"verify_join","verifyJoin":{"chat":"@channel","prompt":"...","buttonText":"...",
   "url":"https://t.me/..."}} — membership gate via getChatMember. Non-members get the join
  prompt + a t.me button and the flow STOPS until they re-press after joining. PUBLIC @handles
  only (private invite links cannot be verified). API errors fail OPEN — nobody gets locked out.

  {"type":"streak","streak":{"attribute":"streak"}} — silent daily return counter (UTC days):
  <attr> = current, <attr>_best = record, same-day revisits dedupe, missed day resets to 1.
  Show it with {{streak}}.

  {"type":"milestone","milestone":{"attribute":"invites","value":5,
   "message":"{{name}} hit 5 invites!","buttons":[...]}} — celebrates EXACTLY once when the
  counter first reaches the value; silent otherwise (safe inside any flow).

  {"type":"draw","draw":{"attribute":"entered","announce":" Winner: {{winner_name}} …",
   "emptyText":"No entrants yet."}} — random winner among users holding the attribute;
  placeholders {{winner_name}} {{winner_chat}} {{count}}.

  {"type":"top","top":{"attribute":"score","title":"Top players","limit":10}} — leaderboard.

  remember(mode:"add") + milestones = referral ladders (3/5/10/25 invites).
  Personal invite link pattern: https://t.me/{{bot_username}}?start=ref_{{chat_id}} — a copy
  button with that URL makes every user a promoter; arrivals with payload ref_<chatId>
  AUTO-CREDIT the inviter's "invites" counter.

  {"type":"email_invite","emailInvite":{"attribute":"email","successText":"...","failText":"...",
   "alreadyText":"...","queuedText":"..."}} — double opt-in email invitations over the site's
  SMTP: collect the address, this step records consent + queues ONE invitation (+ one weekly
  reminder). Queued honestly when SMTP is not configured.
  {"type":"email_unsubscribe","emailUnsubscribe":{"confirmText":"...","nothingText":"..."}} —
  permanent STOP, honored forever.

  Group powers: member_joined welcome flows funnel new members into the private bot (where the
  mechanics live). Moderation/admin powers are NOT available — say so honestly.`;

const BILLING = `BILLING — what running bots costs (pay-as-you-use wallet, micro-dollar ledger).

Metered features (per-server prices are admin-tunable; the wallet skips honestly when empty):
  ai_reply — one AI turn in a chat.
  ai_assistant — one AI step inside a flow.
  ai_build — one Bot Builder/agent model round.
  bot_message — one scheduled send.
  broadcast_message — one broadcast recipient.
  hosting_day — a running bot's daily server day.

Free coverage: every new account gets a 7-day free trial; after that every feature keeps a
free daily allowance; referral premium days and plans extend them.

Plans (optional, wallet-charged): Free / Plus (x3 every daily allowance, hosting for 3 running
bots) / Pro (x10, hosting for 15). Platform-owned official fleet bots are unmetered by design.

Top-ups: Telegram Stars in-chat, or crypto (manual approval; optional CryptoBot auto rail).
When a user is out of credits the bot says so honestly — never silently drops a flow.
The agent NEVER promises prices — quote what the platform's own pricing page says.`;

const LIFECYCLE = `LIFECYCLE — from draft to live.

  1. bot_create_draft (behaviors included) → the bot exists but is NOT live.
  2. The OWNER pastes the Telegram token from @BotFather (digits:secret) — agents never
     invent tokens; a draft without one cannot start.
  3. bot_publish (consequential — user approval) → enabled + webhook/polling registered.
     bot_unpublish stops it. Restart applies config changes.
  4. bot_set_profile writes what Telegram shows BEFORE Start: description ("What can this
     bot do?" <=512), shortDescription (bio <=120), name. Always set it — one strong sentence.
  5. Test console: the owner can run a real pipeline turn from the dashboard without Telegram.

Transports: webhook (preferred, needs a public HTTPS origin) or polling (fallback).
Statuses: starting → running | stopped | error (see the bot's logs panel for details).
Templates: template_list + template_use instantiate a ready-made promotion bot
(giveaway, trivia, referral, support, community, email inviter) into the user's account —
then edit behaviors on top like any other bot.`;

export const AGENT_DOCS: Record<DocsTopic, string> = {
  behaviors: BEHAVIORS,
  growth: GROWTH,
  billing: BILLING,
  lifecycle: LIFECYCLE,
};
