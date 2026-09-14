# Telegram Bot Community — Taxonomy & Ecosystem

Companion to [PLATFORM.md](./PLATFORM.md). This is the map of what the
Telegram bot community actually builds — the demand side. NURAE's builder
agent uses this to recognize intents and build the bot the user means, not
a generic chat wrapper. Verified against live catalogs and ecosystem lists
(awesome-telegram-bots 2026, bot listicles 2025–2026, official docs) on
**2026-09-14**.

---

## 1. Market shape

- Telegram ≈ **950M users**; **500M+ use Mini Apps monthly** (official).
  The economy runs on channels (broadcast), groups (community), bots
  (automation/services) and Mini Apps (real apps).
- Monetization rails used by the community: **Telegram Stars** (digital
  goods, subscriptions, paid media), **paid channel memberships**
  (subscription invite links, InviteMember-style), **ads revenue share**
  (50%, paid in TON), **affiliate programs**, TON crypto rails, and plain
  external links (Patreon/Ko-fi shops).
- Distribution: bot directories & lists (storebot-style, awesome lists),
  Mini App Store featuring, **referral deep links** (`?start=payload`) —
  viral loops are a first-class mechanic (tap-to-earn grew to 300M users
  this way), cross-promotion in channels, Guest/Inline mode for
  "summon-anywhere" utility.

## 2. Category taxonomy (what people build)

For each category: the job-to-be-done, named examples, the Telegram
primitives it leans on, and what separates a *good* bot from a *generic*
one in that category.

### C1. Group management & moderation
- **Job:** keep groups clean and alive — welcome, anti-spam, captcha,
  filters, warns/bans, admin tooling.
- **Examples:** @Rose_Bot (filters, notes, moderation), @combot (analytics
  + CAS anti-spam federation), @GroupHelpBot (1.2M+ groups), @shieldy_bot
  (captcha for newcomers), Group Butler, OmniGest (anti-spam + AI
  moderation).
- **Primitives:** `chat_member`/`join_request` updates, restrict/ban,
  delete, admin command scoping, privacy mode, inline admin panels.
- **Good vs generic:** state per chat and per user, escalation ladders
  (warn → mute → ban), captcha on join, admin-approval UI via callbacks,
  flood heuristics, explicit "why was I muted" messages.

### C2. Group & channel analytics
- **Job:** show activity tops, growth, member stats.
- **Examples:** @combot (the de-facto standard), controller dashboards.
- **Primitives:** passive listening (privacy off or admin), periodic
  aggregation, inline-kbd reports.
- **Good vs generic:** opt-in notice (privacy!), per-chat isolation,
  date-range reports, export.

### C3. Channel tools: scheduling, cross-posting, digests
- **Job:** run a channel like a publication — schedule posts, add buttons
  to posts, clone/aggregate sources, AI digests.
- **Examples:** @ControllerBot (schedule + post analytics + post buttons),
  Junction (@junction_bot — aggregation, copying, AI digests), channel
  cloners/relayers.
- **Primitives:** post *as the channel* (admin `can_post_messages`),
  silent sends, scheduler, inline buttons on posts, RSS-like intake.
- **Good vs generic:** preview-before-publish, per-post buttons, timezone
  correctness, view/reaction analytics.

### C4. Notifications & DevOps relays
- **Job:** push events from systems into chats — CI, monitors, GitHub,
  forms, error trackers, IoT.
- **Examples:** GitHub/GitLab bots, uptime/heartbeat bots, ntfy-style
  relays; "personal alert" bots (keyword watchers, job alerts like
  @RemoteJobRadarBot aggregating Remotive/Remote OK/Arbeitnow).
- **Primitives:** inbound HTTP (the *bot's own* webhook server) →
  `sendMessage` to a chat; deep links to bind a chat (`?start=<token>`),
  per-user routing, quiet hours.
- **Good vs generic:** identity binding (which system → which chat),
  filtering/dedup, action buttons (mute this alert, open run), rate
  control during incidents.

### C5. AI assistants & chatbots
- **Job:** talk, answer from documents, generate content, translate,
  summarize, voice.
- **Examples:** the huge ChatGPT-wrapper space; @ozvuchka_free_bot (TTS to
  voice messages), AskePub (study notes from ePub); NURAE's own segment.
- **Primitives (2026-native):** streaming drafts + Stop button, Rich
  Messages for reports, topics-in-private-chats for parallel threads,
  ephemeral answers in groups, Guest Mode summoning, voice notes in/out,
  file intake (PDF/DOCX), Stars quotas/subscriptions.
- **Good vs generic:** memory that persists per user/thread, citation of
  sources, format choice (report vs chat), token-cost awareness, honest
  failure messages, streaming so latency feels alive.

### C6. Search & inline utilities
- **Job:** find and send things without leaving the chat.
- **Examples:** @gif, @pic, @vid, @wiki, @sticker, @vote; inline calculators,
  translators; @durgerkingbot (inline Mini App ordering).
- **Primitives:** inline mode + `answerInlineQuery` ≤seconds,
  `chosen_inline_result` feedback loop, `switch_inline` buttons, caching.
- **Good vs generic:** sub-second answers, personalization via feedback,
  graceful empty states.

### C7. Polls, quizzes, engagement
- **Job:** run votes, quizzes, trivia, raffles inside groups.
- **Examples:** @vote, trivia bots; quiz engines with scores.
- **Primitives:** `sendPoll` (quiz mode, multiple answers, revoting,
  shuffle — 9.6), `poll_answer` updates, leaderboards (games API or DB).
- **Good vs generic:** explanations after answers, timed rounds, media in
  questions (poll media, 10.0), anti-cheat (revoting rules).

### C8. Commerce: shops, digital products, storefronts
- **Job:** sell inside Telegram — catalogs, carts, invoices, delivery.
- **Examples:** @Demo Shop (official channel-storefront example), @ShopBot,
  Gategram (open-source Mini App storefront with Stars instant delivery),
  merchant bots of every niche (courses, art commissions, game items).
- **Primitives:** Stars invoices (`XTR`) + pre-checkout in 10s + refunds,
  inline invoices (forwardable), paid media, Mini App catalog +
  `web_app` buttons, `/terms` `/paysupport` compliance.
- **Good vs generic:** catalog with pagination *by editing the message*,
  order state machine, receipts, real stock/refund handling, receipt
  messages kept in-chat.

### C9. Paid memberships & paywalled channels
- **Job:** sell access to private channels/groups, subscriptions with
  auto-renewal and dunning.
- **Examples:** **InviteMember** (the dominant SaaS; six payment
  providers), Stars-native subscription bots, VIP-signal channels.
- **Primitives:** `createChatSubscriptionInviteLink` (Stars, auto-expiry),
  one-time invite links, `my_chat_member` to detect when the user leaves,
  Stars subscriptions (8.0), reminders before renewal.
- **Good vs generic:** welcome flows, expiry warnings, self-service
  "extend my plan", audit trail.

### C10. Customer support & feedback
- **Job:** relay user messages to a staff group, answer with templates +
  AI, ticket threads.
- **Examples:** Livegram-style feedback bots (every "contact us" bot), NURAE
  official CS bot pattern, helpdesk mini apps.
- **Primitives:** copy/forward to admin topic, topics-in-private-chat =
  tickets, anonymous relay (user never sees staff), canned replies +
  AI fallback, ratings.
- **Good vs generic:** SLA indicators, thread-per-ticket, human handoff
  switch, no message lost on error.

### C11. Forms, surveys, registrations
- **Job:** collect structured input from users (applications, RSVP,
  onboarding).
- **Examples:** @moreformbot; every event bot that walks users through
  fields.
- **Primitives:** multi-step flows with state per user, force_reply,
  validation, export (CSV via document), Mini App forms for complex ones.
- **Good vs generic:** resumable sessions, edit answers, privacy statement,
  confirmation summary before submit.

### C12. Reminders, habits & personal productivity
- **Job:** natural-language reminders, todo, habit streaks, notes.
- **Examples:** Skeddy (NL reminders), todo bots, Weight Goal Bot
  (photo-backed progress charts).
- **Primitives:** per-user scheduler, timezone handling, recurring jobs,
  document/photo intake, checklists (9.1, business), progress rendering.
- **Good vs generic:** "remind me tomorrow 9am" parsing, list editing,
  quiet hours, honest failure when the scheduler dies.

### C13. Media utilities: downloaders, converters, stickers
- **Job:** fetch/convert/transform media (yt-dlp-based downloaders,
  Stickerify, TTS, image tools).
- **Primitives:** file upload 50MB/download 20MB (local Bot API server:
  2GB), `getFile`, albums, sticker pack API, rate limits as the cost
  driver.
- **Good vs generic:** progress messages, format options via callbacks,
  size-limit messaging, queueing, copyright honesty.
- **Note:** this space is legally gray (downstream copyright) — NURAE
  policy should treat it as "user's responsibility" and add disclaimers.

### C14. Games & tap-to-earn
- **Job:** entertainment + viral monetization.
- **Examples:** @GameBot/@gamee (HTML5 games, leaderboards), Mini App
  giants: Hamster Kombat (300M), Notcoin, Catizen — TON + referral loops +
  Stars monetization.
- **Primitives:** games API (`setGameScore`), Mini Apps fullscreen,
  `shareMessage` referral cards, deep-link referrals, Stars/TON payments,
  emoji status rewards.
- **Good vs generic:** social mechanics (share to unlock), score
  leaderboards in chat, instant-load Mini App.

### C15. Crypto & TON ecosystem
- **Job:** wallets, swaps, airdrops, payments, gated content.
- **Examples:** @wallet (built-in), TON Connect integrations, Fragment
  username/gift marketplace flows, airdrop bots.
- **Primitives:** TON Connect inside Mini Apps, Stars↔TON conversion,
  blockchain-issued unique gifts, deep-link onboarding.
- **Good vs generic:** security messaging, tx confirmations, no seed
  phrases in chat (Mini App + server-side signing).

### C16. Niche verticals (long tail — where most builders live)
- Booking/appointments for salons & clinics, restaurant menus + table
  ordering, class attendance, CRM-ish mini apps, church/community bots,
  school bots (homework, grades), real-estate/vehicle listings, delivery
  status bots, employee check-in, HR bots, document management (Paperless
  bot), access sync (Jellyfin ↔ channel membership), language-learning
  drills, flashcards, journaling bots, estate/neighborhood watch, blood
  donor networks, municipal complaint bots.
- The pattern: a small business process mapped onto chat + buttons + a
  spreadsheet-grade DB. These are exactly the bots generic "AI SaaS"
  builders produce badly, and domain-aware builders win.

## 3. What the community builds WITH

- **Frameworks:** grammY (TS, modern), Telegraf, node-telegram-bot-api;
  aiogram (Python), python-telegram-bot, pyTelegramBotAPI; telebot (Go),
  teloxide (Rust), Telegram.Bot (.NET), Nutgram (PHP) — NURAE replaces
  this layer with its own dependency-free adapter.
- **Hosting:** Railway/Fly/Render, Oracle free tier, self-host + systemd/
  PM2, serverless (webhook mode).
- **Ops:** dedicated test environment, second staging bot, local Bot API
  server for big files, webhook inspectors.
- **Community hubs:** @BotNews (official changelog announcements),
  @BotTalk (dev community), @BotSupport, r/TelegramBots, framework chats.

## 4. Distribution & growth playbook (what successful bots do)

1. **Onboarding in one screen:** `/start` lands a 2–3 button menu, never a
   wall of text; description + about text sell the bot before start.
2. **Deep-link funnels:** every share/link carries `?start=<payload>` —
   referral attribution, content deep links, payment resumption.
3. **Summon-anywhere:** inline mode / Guest Mode / `@mention` so the bot
   meets users where they already are.
4. **Virality hooks:** share buttons (`switch_inline`, shareMessage),
   referral rewards, score bragging.
5. **Stars-first monetization** for digital goods; channel paywalls via
   subscription links; ads revenue for channel-scale properties.
6. **Notifications as retention:** opt-in alerts with per-user frequency
   control (never spam — BotFather alerts + blocks punish you).

## 5. Failure patterns observed in the wild (avoid these)

- Bots that only reply to exact commands and dead-end on anything else —
  no fallback, no AI.
- Group bots added without privacy-mode planning (either deaf or privacy-
  invasive with no disclosure).
- Shops that break pre-checkout (10s window) and lose sales silently.
- Broadcasters that hit 429s and get muted/blocked.
- Paywall bots that never notice when a member leaves (no
  `my_chat_member` handling).
- Downloaders that promise 2GB files and die at 20MB (cloud API limit).
- AI bots that "think" for 30s with no typing/streaming indicator — users
  assume the bot is broken.
