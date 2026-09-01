# NURAE — Setup Manual

Self-hosting guide for NURAE, the Autonomous Digital Operations System by
**FRAZIYM TECH & AI**. This manual covers two paths:

- **Part A — Run it locally** (tested path: Debian inside Termux on Android;
  identical steps work on any Linux/macOS machine).
- **Part B — Serve it from your own Linux server** (public deployment with a
  real domain, TLS, systemd, reverse proxy).

Single process, one `.env` file, no Vercel, no GitHub Actions required.
The split-deployment "Gateway Link" mode exists but is optional — see §8.

---

## 1. Requirements

| Requirement | Minimum | Notes |
|---|---|---|
| Node.js | 20+ | The runtime — `setup.sh` installs it automatically (npm included) |
| Bun | any | Optional accelerator — used only if already present (faster installs, dev test suite); `setup.sh` never downloads it |
| Disk | ~600 MB | Dependencies + build output + database (+ ~120 MB for Node) |
| RAM | 1 GB free | `npm run build` is the peak; dev mode needs less |
| Outbound HTTPS | required | Telegram API + AI provider API |

**Termux (Android) preparation** — run NURAE inside a Debian proot, not
directly in Termux shell (glibc binaries like Bun/Prisma expect it):

```bash
pkg update && pkg install proot-distro
proot-distro install debian
proot-distro login debian      # you are now "root" in Debian
```

Inside Debian install the basics:

```bash
apt update && apt install -y curl git openssl procps
# That is all: setup.sh installs Node.js (npm included) automatically.
# Bun is optional — if you already have it, setup.sh uses it to speed
# up dependency installation; otherwise npm is used.
```

> **Termux memory tip**: if `npm run build` gets killed (OOM), add swap on the
> host Termux session or use dev mode (§4) for testing — dev mode skips the
> heavy production build entirely.

---

## 2. Quick start (one command)

```bash
git clone https://github.com/akikfaraji/NURAE.git && cd NURAE
bash setup.sh
```

That is the whole installation. `setup.sh` automatically: installs Node.js
(with npm) if it is missing, generates `.env` (random `NURAE_SECRET_KEY` +
`NURAE_ADMIN_TOKEN`, polling transport — no public URL, no tunnel), installs
dependencies (with bun when present, otherwise npm), creates the database,
builds, and starts the server. At the end it prints your dashboard URL and
admin login token.

**The only things you ever provide are your API tokens** — the Telegram bot
token and the AI provider key, pasted in the dashboard when you create a bot
(§5–6). They are encrypted at rest; nothing else is manual.

Modes:

```bash
bash setup.sh          # full auto (as above)
bash setup.sh dev      # low-RAM phones: skips the production build
bash setup.sh start    # start again later (reuses the existing build)
bash setup.sh env      # prepare everything but do not start the server
```

Re-running is safe: an existing `.env` is never overwritten, so your secrets
stay valid. The optional AI-key prompt only appears when a fresh `.env` is
created; press Enter to skip it and manage keys per-bot in the dashboard.

<details>
<summary><strong>Manual path</strong> (no script — every step by hand)</summary>

```bash
git clone https://github.com/akikfaraji/NURAE.git && cd NURAE
npm install
cp .env.example .env && nano .env          # set the 3 required values (§3)
npm run db:push                            # create the SQLite database
npm run dev                                # → http://localhost:3000
```

</details>

Open <http://localhost:3000>, log in with your `NURAE_ADMIN_TOKEN`, and you
are on the dashboard. To test a real Telegram bot with zero public URL, jump
to §5.1 (polling mode — already the default when `setup.sh` generated your
`.env`).

---

## 3. Configure `.env` (the only config file)

Everything lives in `.env` (project root). `cp .env.example .env` and set:

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | SQLite file. **Termux:** keep it under `$HOME` (e.g. `file:/data/data/com.termux/files/home/nurae/data/nurae.db`). Shared storage (`/sdcard/...`) does not support SQLite WAL. |
| `NURAE_SECRET_KEY` | yes (outside localhost) | AES-256-GCM master key encrypting every bot token / AI key stored in the DB. `openssl rand -hex 32`. **Losing it = losing all stored secrets.** |
| `NURAE_ADMIN_TOKEN` | yes (outside localhost) | Dashboard + admin API login token. `openssl rand -hex 24`. Unset = open admin on localhost dev only. |
| `PORT` / `HOSTNAME` | no | Standalone server binding (`0.0.0.0:3000` default). |
| `NURAE_BOT_TRANSPORT` | no | `webhook` (default) or `polling` — see §5. |
| `NURAE_PUBLIC_BASE_URL` | webhook only | Your public HTTPS origin (tunnel URL or your domain). |
| `OPEN*_API_KEY` etc. | no | Per-provider fallback keys. Normally configure keys per-bot in the dashboard (encrypted at rest). |

Rules of thumb:

- Restart the process after every `.env` change — values are read at boot.
- Never commit `.env`. It is already in `.gitignore`; keep it that way.
- Rotating `NURAE_SECRET_KEY` after bots exist breaks decryption of stored
  secrets — plan rotations before adding bots, not after.

---

## 4. Run it

### Dev mode (fast loop, no build step)

```bash
npm run dev        # http://localhost:3000, hot reload
```

### Production standalone (what you will serve on a real server)

```bash
npm run build      # compiles .next/standalone (the heavy step)
npm run start      # serves it; honors PORT / HOSTNAME from .env
```

Health check: `curl http://localhost:3000/api/health` →
`{"status":"ok","version":"V00.01.006-beta-03",...}`

> **Note:** bots run in an in-memory manager. After a process restart, start
> your bots again from the dashboard (one click each). Configuration and
> secrets persist in the database; only the running state is ephemeral.

---

## 5. Connect a real Telegram bot

Prerequisite: create a bot with [@BotFather](https://t.me/BotFather) in
Telegram, take the **bot token** (`123456:ABC-...`). Then on the dashboard:
**New project → New bot → paste token → (choose transport) → Start**.

### 5.1 Polling mode — zero public URL (best for local/Termux testing)

Set in `.env`:

```env
NURAE_BOT_TRANSPORT=polling
```

Restart NURAE, then start the bot from the dashboard. NURAE long-polls
Telegram directly from your machine — no tunnel, no domain, no TLS. When the
bot replies to your messages, the whole chain works.

### 5.2 Webhook mode — the production transport

Telegram POSTs updates to a public HTTPS URL. Locally, bridge it with a
free Cloudflare quick tunnel:

```bash
# cloudflared for arm64 (Termux Debian) — amd64 for a PC/server:
curl -sSLo cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3000
# → prints:  https://<random-words>.trycloudflare.com
```

Then in `.env`:

```env
NURAE_PUBLIC_BASE_URL=https://<random-words>.trycloudflare.com
```

Restart NURAE, start the bot from the dashboard (webhook is registered
against that URL). **The quick-tunnel URL changes every restart** — update
`.env`, restart NURAE, restart the bot. On a real server (Part B) the URL is
your stable domain and none of this churn exists.

---

## 6. Configure AI (the bot's brain)

Dashboard → your bot → **AI provider**: pick a provider from the catalog
(openai / openrouter / deepseek / glm / local / custom), paste its API key
and model name. Keys are encrypted with `NURAE_SECRET_KEY` before hitting the
database. Send your bot a message in Telegram — it should answer using the
configured model.

---

## Part B — Serve it from your own Linux server

## 7. Production deployment on a VPS

Tested layout: Ubuntu/Debian x86-64 VPS, NURAE at `/opt/nurae`, unprivileged
user `nurae`, Caddy for TLS, systemd for service management.

### 7.1 Install

The same one-command path works on a VPS — `bash setup.sh` does Node.js,
`.env`, database and build automatically; then register the systemd service
below so it survives reboots. Manual equivalent:

```bash
adduser --disabled-password nurae && usermod -aG sudo nurae
sudo -iu nurae
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs                   # Node.js 20+ (npm included)
git clone https://github.com/akikfaraji/NURAE.git /opt/nurae && cd /opt/nurae
npm install
cp .env.example .env && nano .env
#   DATABASE_URL=file:/opt/nurae/db/nurae.db
#   NURAE_SECRET_KEY=<openssl rand -hex 32>
#   NURAE_ADMIN_TOKEN=<openssl rand -hex 24>
#   NURAE_PUBLIC_BASE_URL=https://bots.your-domain.com
npm run db:push
npm run build
```

DNS: point `bots.your-domain.com` (A/AAAA record) at the server IP **before**
starting, so Telegram webhooks and TLS both work.

### 7.2 systemd service

`/etc/systemd/system/nurae.service`:

```ini
[Unit]
Description=NURAE — Autonomous Digital Operations System
After=network-online.target
Wants=network-online.target

[Service]
User=nurae
WorkingDirectory=/opt/nurae
EnvironmentFile=/opt/nurae/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nurae
sudo journalctl -u nurae -f        # live logs
```

(`PORT`/`HOSTNAME` come from `.env`; the app listens on `localhost:3000` by
way of the reverse proxy below — set `HOSTNAME=127.0.0.1` to keep it
off the public interface.)

### 7.3 TLS reverse proxy — Caddy (simplest)

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
bots.your-domain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the TLS certificate automatically. nginx works too
(`proxy_pass http://127.0.0.1:3000;` + certbot), Caddy is just fewer steps.

### 7.4 Firewall and hardening

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw enable
```

- Only 80/443 are public; NURAE itself stays behind the proxy.
- Keep `NURAE_ADMIN_TOKEN` long and private — it is the only gate to the
  dashboard.
- Back up the database file (`db/nurae.db`) — it contains every encrypted
  secret. Without `NURAE_SECRET_KEY` a stolen backup is unreadable, and with
  it, it is everything.

### 7.5 Updating to a new release

```bash
cd /opt/nurae && git pull
npm install && npm run db:push && npm run build
sudo systemctl restart nurae      # then re-start bots from the dashboard
```

---

## 8. Optional: Gateway Link (split frontend ⇄ backend)

NURAE can also run as **two processes**: a static dashboard frontend
(e.g. on Vercel/free hosting) and this backend, connected at runtime — the
backend registers itself with the frontend (`POST /api/gateway/register`,
shared `NURAE_GATEWAY_KEY`) and the frontend proxies `/api/*` to it. The
backend re-registers every 60 s, so tunnel restarts self-heal.

For single-process self-hosting (this manual) **leave all gateway variables
unset** — the middleware passes everything through locally. Details and the
temporary bootstrap key note: `.env.example` §5 and
`src/lib/gateway/bootstrap-key.ts`.

---

## 9. Configuration reference (all variables)

Complete, commented list: **`.env.example`** in the repo root. Summary:

| Variable | Scope | Effect |
|---|---|---|
| `DATABASE_URL` | core | SQLite/libSQL location |
| `DATABASE_AUTH_TOKEN` | core | Auth token — only when `DATABASE_URL` is `libsql://` (Turso) |
| `NURAE_SECRET_KEY` | core | Master encryption key (AI keys, bot tokens at rest) |
| `NURAE_ADMIN_TOKEN` | core | Dashboard/admin API authentication |
| `PORT`, `HOSTNAME` | server | Standalone listener binding |
| `NURAE_BOT_TRANSPORT` | bots | `webhook` (default) / `polling` |
| `NURAE_PUBLIC_BASE_URL` | bots | Public HTTPS origin used for webhooks |
| `OPENAI_API_KEY` … `CUSTOM_API_KEY` | AI | Account-wide fallback provider keys |
| `NURAE_GATEWAY_KEY` | split | Shared secret for Gateway Link registration |
| `NURAE_LINK_FRONTEND_URL` | split | Frontend the backend registers with |
| `NURAE_BACKEND_URL` | split (legacy) | Build-time fixed proxy target |
| `NURAE_TELEGRAM_API_BASE` | tests | Override Telegram API base (integration tests) |

---

## 10. Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| `node: command not found` in a fresh shell | setup.sh's tarball fallback installs to `~/.local/nurae-node` and adds it to `~/.bashrc` → `source ~/.bashrc`, or re-run `bash setup.sh` |
| Build killed / frozen on the phone | OOM → add swap, or test with `npm run dev` instead of building |
| Prisma error `Failed to connect to database: ./db/custom.db` | Run `npm run db:push` first; on Termux check the path is under `$HOME`, not `/sdcard` |
| `SQLite database error: unable to open database file` | Path not writable / WAL on shared storage → move `DATABASE_URL` into `$HOME` |
| Bot starts but never receives messages (webhook) | `NURAE_PUBLIC_BASE_URL` not reachable by Telegram → re-open the tunnel, update `.env`, restart NURAE, restart the bot. Verify: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` |
| `Polling transport cannot run on serverless platforms` | Polling needs a persistent process — run locally/on a VPS, not on Vercel |
| Dashboard asks for a token / 401 on API | Expected: set `NURAE_ADMIN_TOKEN` and log in with it |
| Forgot `NURAE_ADMIN_TOKEN` | Read it from `.env`; it is not hashed (it is a bearer credential) |
| Port already in use | `PORT=3000` taken → change `PORT` in `.env` and restart |
| Login works but bots vanish after restart | In-memory runtime — start bots again from the dashboard; config persists in the DB |
