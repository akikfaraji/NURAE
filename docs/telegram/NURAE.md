# NURAE ↔ Telegram: Capability Map, Blueprints & Agent Preparation

Companion to [PLATFORM.md](./PLATFORM.md) and [COMMUNITY.md](./COMMUNITY.md).
This is the "so what" document: what NURAE can build **today**, what the gap
is, and a library of concrete bot blueprints the builder agent should
recognize and assemble — so NURAE produces specific, real bots instead of
generic chat wrappers. Facts about NURAE verified against the code on
**2026-09-14** (V00.02.002-beta-03, `8255566`).

---

## 1. What NURAE supports today (verified surface)

### Runtime & transport
- Long-polling **and** webhook transports; webhook registered with secret
  token, `allowed_updates = ['message','callback_query']`
  (`telegram/adapter.ts`).
- Adapter methods: `getMe`, `deleteWebhook`, `setWebhook`,
  `getWebhookInfo`, `getUpdates`, `sendMessage` (HTML parse mode, inline
  keyboard, reply-to, link-preview off, ≤4096 chunking w/ plain-text
  fallback), `answerCallbackQuery` (toast), `setMyCommands`, `getFile`,
  `downloadFile`.
- Errors mapped: invalid token / conflict / rate-limited (+`retry_after`) /
  api / network / timeout.

### Configuration model (the "what a bot can do" surface)
- **Behaviors** (`bots/behavior.ts`) — source of truth, intent-first:
  triggers `start | command | says(keyword) | button | anything_else`,
  steps `message(+buttons) | ai(instruction)`, button actions
  `message | link | flow(behaviorId) | ai`. Compiled to commands + replies
  (`bots/capabilities.ts`); limits: 40 behaviors, 10 steps, 8 buttons/row,
  30 compiled rules, 20 menu commands, callback `r:` namespacing.
- **Commands**: `static` or `ai` (guidance-fed) kinds; registered via
  `setMyCommands`.
- **Replies**: command/keyword/button/fallback triggers; multi-message
  mini-workflows; inline keyboards (url/callback only).
- **AI**: per-bot provider/model/prompt/memory; markdown→Telegram-HTML
  converter (`telegram/markdown.ts`).
- Media **receive**: photo captions read; documents flow through the
  upload/extraction pipeline in chat (PDF/DOCX); **no vision** — pixels are
  never read (documented, honest).
- **Preview**: real-pipeline test console (text XOR callback turns).

### Builder agent (`agents/tools.ts`, 12 tools)
`bots_list, bot_get, bot_create_draft, bot_update, bot_set_behaviors,
bot_set_commands, bot_set_replies, bot_add_knowledge, bot_publish,
bot_unpublish, files_list, files_read` — audited, zod-validated,
ownership-checked at the query level, consequential actions need model
`confirm:true` AND human approval.

## 2. Gap analysis — NURAE vs the platform

> **Status update (V00.03.000-beta-03, 2026-09-14):** the P1 batch and most of P2
> shipped — items 1–9 are IMPLEMENTED (media send, edit-in-place, per-user state,
> typing action, owner broadcast, scheduler, reply keyboards, button variety,
> deep-link routing), plus 10 (group joins + mention gating + `my_chat_member`;
> admin/moderation actions still absent), 11 (polls + poll answers), 12 (Stars
> invoices → pre-checkout → ledger → auto /terms /paysupport /support; refunds still
> manual), 13 (inline mode from static menu content), 14 remains BotFather-only.
> Still open: 15–22 (P3 differentiation lane) — streaming drafts, Rich Messages,
> ephemeral/Guest, Business, Mini App hosting, Games, paid media/subscriptions,
> local Bot API server.

Priority key: **P1** unlocks whole blueprint categories soon; **P2**
material UX/ops wins; **P3** frontier/differentiation.

| # | Platform primitive | NURAE today | Gap & why it matters | Pri |
|---|---|---|---|---|
| 1 | Outbound media (`sendPhoto/Document/Voice/Video/Audio/Album/Sticker`) | text-only sends | C8 shops (catalogs), C13 media utils, C14 games, C7 polls-with-media, every "send the PDF/invite/QR" flow | **P1** |
| 2 | `editMessageText`/`editMessageReplyMarkup` | sends new messages only | pagination, settings menus, carts, confirm-in-place — the idiomatic UX for any list/pick flow | **P1** |
| 3 | Per-user persistent state (attributes, carts, progress) | flows are static message sequences | C11 forms, C12 habits, C9 subscriptions, carts, "my orders"; the state machine is bot-lifecycle only | **P1** |
| 4 | Typing/chat action (`sendChatAction`) | absent | AI latency feels broken without it; trivial win | **P1** |
| 5 | Owner broadcast to all bot users | absent | C4/C9 newsletters, announcements, paywall ops; needs queue + rate pacing (1/s per chat, 30/s global) | **P1** |
| 6 | Scheduler (delayed/recurring sends, reminders) | absent | C3 scheduling, C12 reminders, C15 digests, drip content | **P1** |
| 7 | Reply keyboards + `ForceReply` + keyboard remove | inline keyboards only | forms/quiz UX, "type your answer" prompts; forced input for C11 | **P2** |
| 8 | Button variety: `web_app`, `switch_inline`, `copy_text`, styles/disabled, pay | url/callback only | Mini App links, share buttons (viral loops), copy-code buttons | **P2** |
| 9 | Deep links `?start=payload` **routed** | payload logged only (BR-016 notes) | referral attribution (C4 growth), bind-a-chat flows | **P2** |
| 10 | Group support: privacy-mode guidance, `my_chat_member`/`chat_member`, admin actions, `@mention` addressing | private-chat shaped; `allowed_updates` excludes membership updates | C1/C2/C3 categories — large community demand | **P2** |
| 11 | Polls/quiz API + `poll_answer` | absent | C7 engagement | **P2** |
| 12 | Stars payments (invoice → pre-checkout → deliver → refund) + `/terms /paysupport` scaffolding | absent | C8/C9 monetization; mandatory XTR compliance | **P2** |
| 13 | Inline mode (`answerInlineQuery`) | absent | C6 search/share bots; also inline invoices for shops | **P2** |
| 14 | i18n: `setMyCommands` scopes/languages, localized name/description/about | single default scope; BotFather-only profile text | real bots localize; commands per admin-vs-member scope | **P2** |
| 15 | Streaming drafts (`sendMessageDraft`) + Stop handling | absent (sends full message after generation) | **NURAE's home turf**: AI bots that stream = category-defining UX | **P3** |
| 16 | Rich Messages (`sendRichMessage`) for AI reports | markdown→HTML only | reports/tables/LaTeX — the "AI report" blueprint | **P3** |
| 17 | Ephemeral messages/commands in groups; Guest Mode; bot-to-bot; Communities | absent | group AI assistants without privacy costs | **P3** |
| 18 | Business (Secretary Mode) & Stories APIs | absent | C16 verticals (SMB secretary bots) | **P3** |
| 19 | Mini App hosting + `web_app` buttons + initData validation | absent | C8 storefronts, C14 games — biggest build effort | **P3** |
| 20 | Games API (scores) / sticker pack creation | absent | C14 / sticker factory niche | **P3** |
| 21 | Paid media, subscription links, affiliate, gifts | absent | monetization ladder for C9/C8 | **P3** |
| 22 | Local Bot API server / big files | standard cloud API (20/50MB) | only needed for C13 heavy media | **P3** |

Also tracked: webhook inbound currently answers only `message` +
`callback_query`; every new update family above must be added to
`allowed_updates` explicitly or Telegram will not deliver it.

## 3. Blueprint library (what the agent should recognize)

Each blueprint: the intent users express, how NURAE builds it **with the
current model** (behaviors in plain language), what's missing (→ §2 items),
and the questions the agent must ask. These are the patterns behind
COMMUNITY.md §2 — the agent should match user intent to one and adapt.

### BP-01 FAQ / customer-support assistant
- **Intent:** "a bot that answers questions about my business."
- **Build now:** `/start` welcome with buttons (FAQ, Contact, Hours);
  `says` behaviors for top questions; AI fallback behavior ("anything else
  → AI with this knowledge"); `bot_add_knowledge` from uploaded docs.
- **Missing:** none (fully buildable today).
- **Ask:** what are the 5 most common questions? tone? hours? what must
  never be answered by AI (refunds, legal)?
- **Anti-generic:** knowledge distilled into the prompt + explicit "I don't
  know, here's contact" fallback; canned greeting; human handoff line.

### BP-02 Restaurant / café menu & ordering
- **Intent:** "menu bot with buttons; people ask for the menu and order."
- **Build now:** `/menu` (formatted menu), buttons → categories → items;
  "order" flow collecting name/items by chat; "reserve" flow.
- **Missing:** cart state (3), editable pages (2).
- **Ask:** menu items + prices, delivery vs pickup, how orders reach you
  (here? a group? phone?).

### BP-03 Appointment / booking
- **Intent:** "clients book slots in Telegram."
- **Build now:** `/book` → service buttons → day buttons → "send your
  preferred time" (AI-assisted intake), confirmation summary; list of
  bookings kept in chat thread.
- **Missing:** true slots/calendar sync, reminders (6), per-user state (3).
- **Ask:** services & durations, working hours, timezone, cancellation
  policy.

### BP-04 Feedback / complaint collector
- **Intent:** "users complain to the bot; staff sees it, users don't see
  staff."
- **Build now:** `/start` anonymous-relay notice; fallback behavior =
  forward-style AI acknowledgment + "staff will reply"; `/staff` behavior
  documenting the relay address.
- **Missing:** real relay-to-owner-group (needs owner notification — 5
  broadcast to admin).
- **Ask:** who answers, expected response time, anonymity guarantee?

### BP-05 Newsletter / broadcast bot
- **Intent:** "people subscribe; I send them updates."
- **Build now:** `/subscribe`, `/unsubscribe` static behaviors; content
  sent manually by owner today.
- **Missing:** subscriber registry + broadcast with pacing (5), scheduler
  (6).
- **Ask:** content source, frequency, opt-in copy.

### BP-06 Group welcome & rules
- **Intent:** "welcome new members, pin rules."
- **Build now (partial):** welcome behavior works in private; group joins
  need `chat_member` updates (10) — today document the limitation honestly.
- **Missing:** membership updates (10), button-on-join.
- **Ask:** group name, rules text, welcome tone.

### BP-07 Quiz / trivia game
- **Intent:** "quiz bot with scores."
- **Build now:** `/play` → question with answer buttons (flows), score
  tallying impossible → use honor-system or "next question" chains.
- **Missing:** per-user scores (3), polls (11), leaderboards.
- **Ask:** category, difficulty, round length, prizes.

### BP-08 Reminder / habits bot
- **Intent:** "remind me to X every day at Y."
- **Build now:** honest "scheduling not supported yet" + manual `/remind`
  list behavior; AI can parse the request and explain.
- **Missing:** scheduler (6) — the entire category waits on it.
- **Ask:** recurrence, timezone, quiet hours.

### BP-09 Listing / alerts bot (jobs, property, deals)
- **Intent:** "notify me when new <X> appears."
- **Build now:** keyword-triggered intake of criteria; explanation of feed
  sources.
- **Missing:** inbound polling + broadcast (5/6).
- **Ask:** sources, filters, frequency cap.

### BP-10 Digital shop (Stars)
- **Intent:** "sell my course/presets/game items."
- **Build now:** catalog via `/shop` + buttons; delivery instructions by
  flow; payments can't be charged → document.
- **Missing:** Stars invoices (12), media delivery (1), cart (3).
- **Ask:** products, prices, delivery method, refund policy.

### BP-11 Paid community gate
- **Intent:** "charge for my private channel."
- **Build now:** `/join` explains tiers; payment impossible yet.
- **Missing:** Stars subscription links / subscription invoices (12).
- **Ask:** tiers, length, what's inside.

### BP-12 Language practice partner
- **Intent:** "chat with me in Spanish and correct my mistakes."
- **Build now:** fully buildable — AI system prompt with correction
  protocol; `says` triggers for "correct", "translate", "explain";
  difficulty levels as commands.
- **Ask:** target language, level, correction strictness, voice?

### BP-13 Document Q&A / summarizer
- **Intent:** "upload a PDF, ask questions about it."
- **Build now:** user attaches file in chat → handoff to agent →
  `bot_add_knowledge` (≤3000 chars distilled) → Q&A bot; `files_read` for
  slicing.
- **Missing:** large-doc chunked retrieval (vector store), media receive
  in bot chat itself (photo-caption only).
- **Ask:** document type, expected questions, single vs multi-doc.

### BP-14 Course / drip content
- **Intent:** "send lesson 1 today, lesson 2 tomorrow…"
- **Build now:** `/lesson1`..`/lessonN` menu commands; manual pacing.
- **Missing:** scheduler (6), per-user progress (3).

### BP-15 Team / task assistant
- **Intent:** "our group tracks tasks in Telegram."
- **Build now:** `/add`, `/list`, `/done` static behaviors in private
  (shared state not yet possible); honest about group limitations.
- **Missing:** group operation (10), shared per-chat state (3), checklists
  (platform has them, NURAE doesn't).

### BP-16 Event / conference bot
- **Intent:** "schedule, speakers, FAQ, ticket info for our event."
- **Build now:** strong fit — `/schedule`, `/speakers`, `/venue`, `/faq`
  + AI fallback + buttons; deep-link from site (payload logged).
- **Missing:** personal agenda state (3), reminders (6).

### BP-17 Travel / local guide
- **Intent:** "recommend places; itinerary help."
- **Build now:** AI persona + `says` behaviors (food, nightlife, family)
  with curated links; `/itinerary` AI step with structure guidance.
- **Ask:** city, budget range, audience.

### BP-18 Raffle / giveaway runner
- **Intent:** "collect entries, pick a winner."
- **Build now:** `/join` intake + honest note that winner picking is
  manual/AI-assisted on request.
- **Missing:** participant registry + random draw (3).

### BP-19 Inline search / share utility
- **Intent:** "people type @mybot and send results anywhere."
- **Build now:** impossible (no inline mode) — refuse honestly.
- **Missing:** inline mode (13).

### BP-20 Group moderation assistant
- **Intent:** "mute spammers, filter words."
- **Build now:** impossible in groups today — say so, offer private
  assistant alternative.
- **Missing:** group updates/admin actions (10).

### BP-21 AI report generator
- **Intent:** "generate structured reports in chat."
- **Build now:** AI steps with output-structure instructions (markdown
  headings/tables render via NURAE's HTML converter).
- **Missing:** Rich Messages for full fidelity (16), streaming (15) for UX.

### BP-22 Business secretary
- **Intent:** "answer my business account's DMs."
- **Build now:** impossible — refuse honestly.
- **Missing:** Business mode (18).

## 4. Agent preparation — how not to build generic bots

### 4.1 Intent-first vocabulary (user words → NURAE primitive)
| User says | Agent builds |
|---|---|
| "when someone starts / joins" | `when: start` behavior |
| "menu / /command" | `when: command` (+ auto menu registration) |
| "if they mention price/price-related" | `when: says` keyword |
| "a button that shows/does X" | message step with button `action: message` |
| "a button that opens our site/Instagram" | button `action: link` |
| "go to the next screen / submenu" | button `action: flow` + target behavior (same call) |
| "let the AI handle the rest" | `anything_else` behavior with `ai` step |
| "it should know our policies" | `bot_add_knowledge` (distilled, ≤3000 chars) |

### 4.2 Clarify before build (playbook, keep to 2–4 questions)
1. **Audience & place:** private chat or group? (determines what's
   honestly possible — §2 items 10/17/19/20/22)
2. **The three golden flows:** what are the top 3 things a user must be
   able to do? (becomes menu commands + start buttons)
3. **Fallback:** when nothing matches, AI or static "contact us"?
4. **Assets:** do they have texts (menu, prices, FAQ)? offer to upload
   files → distill to knowledge.
5. Monetization ask only when the intent is commercial (BP-08/10/11):
   name the current limit honestly.

### 4.3 Dependency injection (the compiler's contract, restated for the model)
- Every button has an action — never a dead end; every `flow` target
  exists in the same `bot_set_behaviors` call.
- One `start`, one `anything_else` per bot.
- Menu ≤20 commands; command descriptions ≤64 chars; texts ≤4000.
- Back/cancel affordances in nested flows.
- **Voice/tone:** write bot copy like a competent human, not a brochure:
  short lines, active verbs, no emoji walls.

### 4.4 Anti-generic checklist (agent self-review before publish)
- [ ] `/start` = one-line value proposition + 2–3 buttons (no walls of text)
- [ ] `/help` exists (auto-suggest if user didn't define)
- [ ] `anything_else` behavior defined (AI or polite fallback — never
      silence, never "Unknown command")
- [ ] Every flow reachable from `/start` or a menu command
- [ ] Every question the bot asks has a stated next step
- [ ] Errors/unknowns answered honestly ("I don't have that yet — here's
      who to ask")
- [ ] Knowledge grounded (specific prices/hours/rules from the user, not
      invented)
- [ ] If a requested capability is missing (§2), the agent **said so in
      plain words** and offered the nearest buildable alternative — never
      faked it
- [ ] Preview run in the test console before publish approval

### 4.5 Honesty rules (non-negotiable, matches NURAE values)
- Missing capability ⇒ explicit limitation + nearest alternative.
- Never simulate payments, group admin powers, or state the runtime
  doesn't have.
- Media: "I can read captions, not images" is a feature, not a bug —
  say it.

## 5. Strategic notes

1. **Managed Bots (Bot API 9.6) is NURAE's category, now platform-native.**
   When the platform matures for it, NURAE can become a "manager bot":
   users create their NURAE-built bots through a native Telegram flow
   (`t.me/newbot/{manager}/{name}`), tokens via `getManagedBotToken` — no
   copy-pasting BotFather tokens. Track it; it collapses NURAE's worst
   onboarding step (token handling) once available.
2. **AI-native features are NURAE's differentiation lane:** streaming
   drafts + Stop, Rich Message reports, topics-per-thread, ephemeral group
   answers, Guest Mode summoning. A "NURAE AI bot" that streams in 2026
   looks the way a modern AI bot should look; priority when runtime work
   resumes (P3 items 15–17, ahead of P3 polish).
3. **Sequencing recommendation:** P1 batch (media send, edit-in-place,
   typing action, per-user state, broadcast, scheduler) unlocks the
   majority of the blueprint library; P2 unlocks group + money; P3 is
   differentiation.
4. **Docs as agent context:** PLATFORM.md §5 (interaction primitives),
   §7 (monetization) and COMMUNITY.md §2 (taxonomy) should feed the
   builder agent's system prompt (condensed), with NURAE.md §3–4 as its
   pattern library.

## 6. Sources

- core.telegram.org/bots/api-changelog (Bot API 10.3, Aug 24 2026 — read
  back to 7.0)
- core.telegram.org/bots/features, /bots/faq, /bots/webapps,
  /bots/payments-stars, /bots/payments
- awesome-telegram-bots (2026 active list), community bot catalogs &
  monetization guides 2025–2026 (InviteMember docs, Stars withdrawal
  guides, Mini App market reports)
- NURAE source: `src/lib/nurae/telegram/adapter.ts`,
  `bots/capabilities.ts`, `bots/behavior.ts`, `agents/tools.ts`,
  `runtime/pipeline.ts` (V00.02.002-beta-03)
