# Telegram Bot Platform — Knowledge Base

NURAE internal reference. Everything the builder agent (and we) need to know
about what the Telegram bot platform can actually do, so bots we build are
real, specific, and idiomatic — never generic.

**Source of truth:** core.telegram.org/bots/api (the manual),
/bots/features, /bots/api-changelog, /bots/webapps, /bots/payments(-stars),
/bots/faq. All facts below verified against those pages on **2026-09-14**;
platform state is **Bot API 10.3 (August 24, 2026)**.

---

## 1. Platform at a glance (2026)

- ~950M users; **more than 500M interact with Mini Apps every month**
  (official features page). Telegram is a distribution channel, app store,
  payment rail, and now an AI-agent runtime in one.
- The 2025–2026 releases made the platform **AI-native**:
  - **Streaming replies** — `sendMessageDraft` / `sendRichMessageDraft`
    (Bot API 9.3+ for all bots): stream a partial draft into the chat while
    generating; the final `sendMessage`/`sendRichMessage` lands when ready.
  - **Stop generation** — when enabled, the user gets a Stop button and the
    bot receives a `MessageGenerationStopped` update (Bot API 10.3).
  - **Rich Messages** — Bot API 10.1+: structured block documents (headings,
    tables, collages, slideshows, LaTeX, collapsible details, embedded
    documents, maps) with multiple embedded buttons. GFM-style Rich Markdown
    or granular Rich HTML.
  - **Ephemeral messages** — Bot API 10.2+: messages visible only to one
    user + the bot inside a group; also ephemeral *commands* (the user's
    invocation is invisible to everyone else). Made for AI assistants.
  - **Topics in private chats** (9.3/9.4): one bot chat, many parallel
    threads — Telegram's native answer to ChatGPT-style conversations.
- **Managed Bots** (Bot API 9.6, Apr 2026): a bot can now **create and
  operate other bots on behalf of users** — BotFather's "Bot Management
  Mode", `t.me/newbot/{manager_bot}/{new_username}?name={new_name}` links,
  `getManagedBotToken`/`replaceManagedBotToken`. This is NURAE's product
  category, natively supported by the platform (see NURAE.md §7).
- Other 2026 primitives: **Guest Mode** (10.0 — respond in chats without
  being a member), **Communities** (10.2 — linked groups/channels/bots),
  bot-to-bot communication, poll media & multi-answer quizzes, live photos,
  member tags, button styles/disabled states, `force_reply` in inline
  keyboards.

## 2. Bot identity & lifecycle

- Bots are created via **@BotFather** (`/newbot`, or its Mini App). Username
  5–32 chars, must end in `bot`, immutable. Token format
  `<bot_id>:<secret>` — the token IS full control; treat like a root
  password (NURAE encrypts at rest, AES-256-GCM).
- Public profile: **name** (64), **description** (512, shown as "What can
  this bot do?" before start), **about/bio** (120, shown on profile), profile
  photo/video. All settable via BotFather *and* via API:
  `setMyName`, `setMyDescription`, `setMyShortDescription`,
  `setMyProfilePhoto` (9.4) — with per-language variants.
- **Global commands** every bot should support: `/start`, `/help`,
  `/settings`. Telegram builds UI shortcuts around them. `/start` can carry
  a deep-link payload.
- **Privacy mode** (groups): by default a bot in a group sees only
  - commands aimed at it (`/cmd@this_bot`), general commands if it messaged
    last, replies to its messages, messages sent via it, service messages;
  - always: private chats, channels it's in, service messages;
  - disabled privacy or **admin** ⇒ sees (almost) everything; still never
    messages from *other bots* (unless bot-to-bot mode, §8).
  - Changing privacy requires re-adding the bot to the group.
- **Admin rights** are granular (manage_chat, delete_messages, restrict,
  promote, change_info, invite_link, pin, video chats, topics, stories,
  direct messages…). Bots can hold them; `promoteChatMember` grants.
- Settings toggleable in BotFather: inline mode, join groups, privacy,
  inline feedback, domain (login widget), Main Mini App, Business
  ("Secretary Mode"), Bot Management Mode, Bot-to-Bot mode, Guest Mode,
  private-chat topics, splash screen.

## 3. Getting updates

Two transports, mutually exclusive (409 conflict if both):

- **Long polling** — `getUpdates(offset, timeout, allowed_updates)`.
  Returns up to 100 earliest unconfirmed updates; confirm with
  `offset = last_update_id + 1`. Best for dev and for NURAE's runtime
  service.
- **Webhook** — `setWebhook(url, secret_token, allowed_updates,
  max_connections, drop_pending_updates)`. Requirements: valid TLS,
  ports **443/80/88/8443**, no redirects, CN must match, wildcard certs may
  fail. Verify origin with `X-Telegram-Bot-Api-Secret-Token`
  (1–256 `[A-Za-z0-9_]`). `getWebhookInfo` exposes pending count and last
  delivery error — use it for status reconciliation (NURAE does).
- `allowed_updates` is an explicit allow-list; new update types are NOT
  delivered unless listed (re-set webhook to apply). A bot must answer
  webhooks with 200 quickly; heavy work goes to a queue.
- Updates pending delivery are kept ~24h. `drop_pending_updates` clears.

### Update types (the full trigger surface, Bot API 10.x)

| Update | Fires when | Bot role needed |
|---|---|---|
| `message` / `edited_message` | any user message (private chat always; group per privacy) | member |
| `channel_post` / `edited_channel_post` | post in a channel the bot is in | member |
| `callback_query` | inline-keyboard button press | any |
| `inline_query` / `chosen_inline_result` | `@bot query` typed in any chat / user picked a result | inline mode enabled |
| `my_chat_member` | bot's own status changed (kicked, promoted…) | any |
| `chat_member` / `chat_join_request` | other users' membership changes | **admin** (chat_member); member (join requests if link approved-by-bot) |
| `message_reaction` / `message_reaction_count` | reaction changes | any (must be allow-listed) |
| `business_connection` / `business_message` / `edited_business_message` / `deleted_business_messages` | bot connected to a user's business account | Business mode |
| `pre_checkout_query` / `shipping_query` | payment flows | any |
| `purchased_paid_media` | user unlocked paid media | any |
| `chat_boost` / `removed_chat_boost` | chat boost changes | admin |
| `guest_message` (10.0) | user summoned the bot in a chat it's not in | Guest Mode |
| `managed_bot` (9.6) | a user created a bot via your manager bot / token changed | Bot Management Mode |
| `subscription` (10.2) | user's paid subscription to the bot changed | any |
| `stopped_message_generation` (10.3) | user pressed Stop on a draft | any |

Inside `message`, the bot must also understand **service/content variants**:
text, photo, video, animation, audio, voice, video_note, document, sticker,
location, venue, contact, poll, dice, new_chat_members, left_chat_member,
new_chat_title/photo, pinned_message, successful_payment, refunded_payment,
gift/unique_gift, checklist tasks done/added, poll answers, story, chat
background set, shared users/chats (from request buttons), write_access
allowed (Mini App), forum topics, direct-messages topics, suggested posts,
community joins. Every one of these is a potential trigger or input.

## 4. Messaging surface

### Regular messages
- Types: text, photo, video, animation (GIF), audio, voice, video note,
  document, sticker, location, venue, contact, poll, dice, checklist,
  media groups (albums), invoice, game, paid media, live photo (10.0),
  rich message (10.1+).
- Formatting: **MarkdownV2** or **HTML**; HTML recommended (escaping rules
  are simpler). Entities: bold/italic/underline/strike/spoiler, inline +
  block code, links, custom emoji (if bot owner has Premium, 9.4), mentions,
  hashtags/cashtags, bot commands, blockquote + **expandable** blockquote,
  `date_time` entity (9.5).
- Links: `tg://` deep links, `t.me` links; link previews fully controllable
  (`LinkPreviewOptions`: url override, above-text position, size).
- Message effects (`message_effect_id`, 7.4) for celebratory sends.
- Sizes: text 4096; caption 1024; album = 2–10 items.

### Rich Messages (10.1+, `sendRichMessage`)
Structured documents in one message: paragraphs, section headings, lists +
task lists, tables (with spans, striping, captions), photo/video/audio/
voice/animation blocks with captions, collages & slideshows, block/pull
quotes, collapsible details, dividers, footers, anchors, LaTeX (inline +
block), maps, embedded file documents, `<tg-thinking>` placeholder blocks,
and **multiple embedded buttons**. Accepts GFM-ish Rich Markdown or Rich
HTML, or fully typed `InputRichBlock*` structures. Editable via
`editMessageText(rich_message=…)`. This is the vehicle for "AI reports" —
NURAE's markdown converter should grow into this.

### Editing & lifecycle
- `editMessageText/Caption/Media/ReplyMarkup`, `editMessageLiveLocation`,
  `stopMessageLiveLocation`, `stopPoll`, `deleteMessage`/`deleteMessages`,
  `forwardMessage(s)`, `copyMessage(s)`.
- Editing inline keyboards in place (instead of sending new messages) is
  the idiomatic UX for settings, pagination, carts, confirmations.
- `file_id`s are persistent per-bot — store and reuse them.

## 5. Interaction primitives

| Primitive | What it is | Key constraints |
|---|---|---|
| **Menu commands** | `setMyCommands` — the `/` menu | ≤100 per scope; scopes: default, all_private, all_group_admins, all_group_members, all_chat_administrators, specific chat/user; per-language variants |
| **Reply keyboard** (`ReplyKeyboardMarkup`) | replaces the user's keyboard with option buttons; buttons can request location/contact/user/chat/poll or open a Mini App | one-time mode; input placeholder; must be removed (`ReplyKeyboardRemove`) |
| **Force reply** (`ForceReply`) | forces the user to answer a specific message | also available as a field on inline/reply keyboards (10.3) |
| **Inline keyboard** | buttons under a message: callback, URL, `web_app`, `switch_inline_query`, `login_url`, `copy_text` (7.11), pay, game, `switch_inline` | ≤8 per row, ≤100 buttons; `callback_data` ≤64 bytes; answer every press with `answerCallbackQuery` (spinner; optional toast ≤200 chars or alert) |
| **Button styling** (9.4/10.3) | `style` colors, `icon_custom_emoji_id`, `disabled` buttons | |
| **Menu button** | next to input: opens commands list or launches a Mini App (`setChatMenuButton`) | per-chat override |
| **Deep links** | `t.me/bot?start=<64-char payload>` (private), `?startgroup=` (adds to group) | A-Za-z0-9_- base64url; Mini App variant `?startapp=` (≤512) |
| **Inline mode** | `@bot query` from any chat; results (articles, photos, gifs, sticker, voice, documents, videos, locations, venues, contacts, games, invoice content) | must enable in BotFather; `answerInlineQuery` within seconds; `is_personal`; button-driven `switch_inline` |
| **Attachment menu** | approved bots live in every chat's attach menu | restricted access |
| **Chat/user selection buttons** | keyboard buttons that return a picked chat/user (with name/username/photo) | `KeyboardButtonRequestChat/Users` |
| **Chat actions** | `sendChatAction`: typing, upload_*, record_*, choose_sticker, find_location | 5s status; "typing…" polish |

## 6. Groups, channels, forums, communities

- Chat kinds: private, group → **supergroup** (upgrade is automatic &
  sticky), **channel** (broadcast, comments), **forum supergroups** (topics)
  and **private-chat topics** (9.3+).
- Admin capabilities a bot can exercise: delete/restrict/ban/unban,
  promote, invite links (incl. **subscription invite links** 7.9 — time- or
  Stars-limited membership), approve/decline join requests, pin, set
  title/photo/description/permissions, sticker sets, topics management,
  **`can_manage_direct_messages`** (9.2), `can_send_welcome_messages`
  (10.3).
- Membership telemetry: `my_chat_member` (bot's own status — e.g. user
  blocked the bot), `chat_member` (join/leave/promote/restrict — needs
  admin), `chat_join_request` (+ `answerChatJoinRequestQuery` 10.1 for
  guard bots).
- **Forums/topics**: `createForumTopic` etc.; in private chats a bot can
  keep parallel conversation threads (support tickets, separate projects).
- **Channel Direct Messages** (9.2): a forum-like DM area under a channel;
  bots can reply there per-topic and handle **Suggested Posts**
  (approve/decline, paid posts, proposed price & date).
- **Super Channels** (7.9): channel posts can have user senders.
- **Communities** (10.2): several supergroups/channels/bots linked around a
  shared audience; join service messages, cross-chat onboarding.

## 7. Monetization

### Telegram Stars (digital goods — mandatory)
- Digital goods/services inside Telegram **must** be paid in Stars
  (`currency: "XTR"`, no provider token) — App Store/Play Store policy;
  violating this gets the bot hidden on mobile clients.
- Flow: `sendInvoice` (any chat type; multi- or single-use; forwardable
  inline invoices via `inputInvoiceMessageContent`) →
  `pre_checkout_query` (must `answerPreCheckoutQuery` **within 10s**) →
  `successful_payment` (store `telegram_payment_charge_id`) → deliver →
  optionally `refundStarPayment`. `getMyStarBalance` (9.1),
  `getStarTransactions` (7.5) for ledger.
- Compliance: bots selling digital goods must answer `/terms`, `/support`,
  `/paysupport`. Disputes are the developer's responsibility.
- Stars → withdraw as TON (Fragment), buy Ads, gift Premium, send gifts.
  ~21-day hold on withdrawals (third-party reports, 2026); min ~1000 Stars.

### Other monetization rails
- **Paid media** (`sendPaidMedia`, 7.6): photos/videos (incl. live photos)
  unlocked per Stars payment (≤25,000★ per item, 9.3); works in any chat
  the bot can message, incl. channels; `purchased_paid_media` update.
- **Star subscriptions** (8.0): recurring billing via
  `createInvoiceLink(subscription_period=…)`; `editUserStarSubscription`;
  `subscription` update (10.2). Period price ≤10,000★.
- **Paid broadcasts** (7.11/FAQ): free ~30 msg/s; enable paid broadcast →
  up to 1000 msg/s at 0.1★/msg over the free quota; requires 100,000★
  balance + 100K MAU.
- **Subscription invite links** (7.9): time-limited paid membership of a
  channel/group, billed in Stars, auto-expiry via `until_date`.
- **Affiliate program** (8.1): bots earn commission on referred purchases
  (`AffiliateInfo` in transactions).
- **Ads revenue sharing**: 50% of ad revenue in the bot's chat / channel,
  paid in TON.
- **Gifts**: regular & **unique (NFT)** gifts; bots can `sendGift` (paid
  in Stars), upgrade/transfer/convert gifts, read `getUserGifts`/`getChatGifts`;
  business accounts can manage gift settings. Gifts are a monetizable
  social layer (resale, blockchain-issued gifts).
- **Physical goods**: any currency/provider (Stripe etc.) via the same
  invoice API with `provider_token`; Telegram never touches payment data.

## 8. AI-agency primitives (2025–2026 additions)

- Streaming drafts (`sendMessageDraft`, `sendRichMessageDraft`; 9.3
  private-chat topics first, 9.5 for all bots) + Stop button
  (`MessageGenerationStopped`, 10.3) + Thinking placeholders.
- **Rich Messages** for final structured answers.
- **Ephemeral messages/commands** (10.2): private answers inside groups;
  `replace_callback_query_message` shows an ephemeral view in place of the
  pressed button's message.
- **Guest Mode** (10.0): be mentioned in any chat and reply once without
  membership/history — distribution without admin friction.
- **Inline mode**: summon results anywhere; inline Mini Apps.
- **Topics in private chats**: parallel AI conversations in one chat.
- **Bot-to-bot** (10.0 formalized): bots message each other by @username in
  private (both sides opt in), see each other in groups when mentioned or
  when admin/privacy-off; **loop-prevention safeguards are mandatory**
  (dedupe, rate caps, depth/time limits).
- **Managed Bots** (9.6): your bot provisions other bots for users —
  `managed_bot` update, `getManagedBotToken`, access settings. Platform-
  native "bot platform" support.

## 9. Mini Apps (Web Apps)

- A Mini App is a web app launched inside Telegram with a JS SDK
  (`telegram-web-app.js`). Launch contexts: **keyboard button**, **inline
  button** (`web_app`), **menu button**, **Main Mini App** (profile button,
  7.8 — also surfaced in the Mini App Store), **inline mode**, **direct
  link** (`t.me/bot/app?startapp=`), **chat join requests**, **attachment
  menu**. Group launches carry `chat_instance` for shared multi-user
  context.
- Security: **`initData`** is signed by the bot token (HMAC-SHA256) —
  always validate server-side; third-party validation exists (8.0).
  Since 10.2, methods are blocked from foreign origins (July 20, 2026
  default) — pin the app domain.
- JS API surface: theme params + color scheme, Back/Bottom/Settings
  buttons, main button, popups, haptics, **CloudStorage** (6.9),
  **BiometricManager** (7.2), scanning QR, file download popup (8.0),
  shareMessage/prepared inline messages (8.0), shareToStory (7.8),
  geolocation (8.0), accelerometer/gyroscope/orientation (8.0), device
  hardware info (8.0), fullscreen (8.0), home-screen shortcuts (8.0),
  emoji status (8.0), **DeviceStorage/SecureStorage** (9.0),
  `requestChat` (10.x), `hideKeyboard` (9.1), vertical-swipes control,
  secondary button (7.10), safe-area insets.
- Monetization inside Mini Apps: Stars payments, subscriptions, paid media;
  **Mini App Store** featuring (requires Main Mini App + media previews +
  Stars payments); splash screen customization.
- Design rules: native-feeling, theme-aware, no fake chrome; official
  design guidelines exist.

## 10. Games, stickers, login

- **HTML5 games**: `sendGame` → callback opens the game URL;
  `setGameScore`/`getGameHighScores` for leaderboards in chat. @GameBot,
  @gamee are the canonical examples.
- **Stickers/custom emoji**: full pack management API (create/add/reorder/
  delete, `.WEBM`/TGS formats, keywords, `needs_repainting` adaptive
  emoji, custom-emoji packs) — bots are sticker factories.
- **Login widget / `login_url` buttons**: passwordless site auth via
  Telegram identity; domain-bound, hash-verifiable. Also inline Mini App
  auth. Web3 login via TON Connect inside Mini Apps.

## 11. Operations: limits, failure modes, testing

### Hard limits (verified 2026-09)

| Thing | Limit |
|---|---|
| Text message | 4096 chars |
| Caption | 1024 chars |
| `callback_data` | 64 bytes |
| Inline keyboard | 8 buttons/row, ≤100 buttons |
| answerCallbackQuery toast | 200 chars |
| Menu commands | ≤100/scope (menu UI truncates; keep ≤20 visible) |
| Bot description / about / name | 512 / 120 / 64 chars |
| Poll question / option / explanation | 300 / 100 / 200 chars |
| Poll options | 12 (since 9.1); min 1 (10.0); auto-close ≤2,628,000s |
| Deep-link `start` payload | 64 chars base64url; `startapp` ≤512 |
| File upload (bot) | 50 MB |
| File download ( getFile ) | 20 MB |
| Webhook ports | 443, 80, 88, 8443 |
| Webhook max_connections | 1–100 (default 40) |
| Updates per getUpdates | 100 |
| Invoice title / description / payload | 32 / 255 / 128 chars |
| Paid media price | ≤25,000★ |
| Subscription period price | ≤10,000★ |
| Pre-checkout answer window | 10 seconds |

### Rate limits
- **1 msg/s per chat** (bursts tolerated then 429 with `retry_after`).
- **20 msg/min per group**.
- **~30 msg/s global broadcast** (paid: 1000/s, 0.1★/msg over free tier).
- Handle 429 by sleeping `retry_after`; never hammer. Telegram monitors
  popular bots and sends @BotFather **status alerts** for unanswered
  messages/inline/callback queries — "reply to every update" is policy.

### Local Bot API server
Self-hosted open-source server: downloads unlimited (vs 20MB), uploads
2GB (vs 50MB), HTTP webhooks on any port. Call `logOut` before switching.

### Test environment
Separate world (`…/bot<token>/test/…`), separate accounts, relaxed TLS for
webapps, same flood limits. Create a second bot for staging — do not test
against the production token.

### Failure modes every real bot handles
- 400 "chat not found" (user blocked bot → use `my_chat_member` to learn),
  403 bot blocked, 409 webhook/polling conflict, 429 flood, HTML parse
  failures (fall back to plain text — NURAE already does), file too large
  for download, **pre-checkout timeouts (10s)**, slow AI generation
  (send typing action / stream draft), broadcast storms (queue + spacing).
- Idempotency: webhooks can be re-delivered; key side effects on
  `update_id`/business keys.

## 12. Anti-patterns (what makes a bot feel fake)

1. Wall-of-text `/start` with no actions attached.
2. Buttons that answer with static text only — no flows, no state.
3. Sending new messages where editing one message is idiomatic
   (settings/pagination).
4. No typing indicator / no streaming on long AI answers.
5. Ignoring privacy mode — expecting to see all group messages.
6. Broadcasting at full speed and hitting 429s.
7. Markdown shown raw (parse failures) — always have a plain fallback.
8. Digital goods priced in anything but Stars (mobile clients hide you).
9. No `/help`, no `/terms`/`/paysupport` when selling, no error paths.
10. Dead-end buttons — every button wired, every flow reachable, exits
    provided (back/cancel).
