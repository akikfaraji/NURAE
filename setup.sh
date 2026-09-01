#!/usr/bin/env bash
# ============================================================================
# NURAE — one-command setup (FRAZIYM TECH & AI)
#
#   bash setup.sh          full auto: bun + node + .env + db + build + start
#   bash setup.sh dev      same, but skips the heavy production build
#                          (recommended on low-RAM phones)
#   bash setup.sh start    start again later (builds only if no build exists)
#   bash setup.sh env      prepare everything but do not start the server
#
# Everything is automatic. The ONLY things you ever provide yourself are your
# API tokens — and those are pasted in the DASHBOARD when you create a bot
# (Telegram token from @BotFather, AI provider key), encrypted at rest.
# Run this script again any time: an existing .env is NEVER overwritten, so
# your generated secrets stay valid forever.
# ============================================================================
set -euo pipefail

MODE="${1:-full}"
case "$MODE" in
  full|dev|start|env) ;;
  *) echo "Unknown mode: $MODE (use: full | dev | start | env)"; exit 1 ;;
esac

# --- helpers -----------------------------------------------------------------
say()  { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'printf "\033[1;31m[error]\033[0m setup failed (line %s) — fix the message above and run: bash setup.sh %s\n" "$LINENO" "$MODE"' ERR

cd "$(dirname "$0")"
[[ -f package.json ]] || die "Run this script from inside the NURAE repository."

# Termux users must be inside the Debian proot (glibc binaries, WAL-capable fs)
if [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *com.termux* ]]; then
  die "This is the Termux shell, not Debian. Run:  proot-distro login debian   — then cd into the repo and run: bash setup.sh"
fi

VERSION_LINE="$(bun -e "try{console.log(require('./src/lib/nurae/version.ts').NURAE_VERSION)}catch{console.log('')}" 2>/dev/null || true)"
[[ -n "$VERSION_LINE" ]] || VERSION_LINE="NURAE"

# --- 1. Bun ------------------------------------------------------------------
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    say "Bun $(bun --version) found"
  else
    say "Installing Bun (runtime + package manager)"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- https://bun.sh/install | bash
    else
      die "curl/wget missing — run: apt update && apt install -y curl"
    fi
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || die "Bun installed but not on PATH — open a new shell and re-run."
  fi
}

# --- 1b. Node.js (build tool only — Turbopack's build spawns a real node
# --- child process for PostCSS; everything else in the app runs on Bun) ------
node_major() {
  command -v node >/dev/null 2>&1 || return 9
  local v=""
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 9
  [[ -n "$v" ]] && echo "$v"
}

node_ok() {
  local m
  m="$(node_major || true)"
  [[ -n "$m" && "$m" -ge 20 ]]
}

# Distro-independent last resort: the official tarball. Only needs curl/wget,
# tar and gzip — all present on any Debian/Fedora/Alpine box including proot.
node_tarball_install() {
  local arch="" ver="22.14.0" prefix="$HOME/.local/nurae-node"
  case "$(uname -m)" in
    x86_64)        arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l|armv8l) arch="armv7l" ;;
    *) die "Unsupported CPU ($(uname -m)) — install Node.js 20+ manually, then re-run." ;;
  esac
  say "Falling back to the official Node.js v${ver} tarball (${arch}) -> ${prefix}"
  local url="https://nodejs.org/dist/v${ver}/node-v${ver}-linux-${arch}.tar.gz"
  mkdir -p "$prefix"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" | tar -xzf - --strip-components=1 -C "$prefix"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" | tar -xzf - --strip-components=1 -C "$prefix"
  else
    die "Neither curl nor wget found — install Node.js 20+ manually, then re-run."
  fi
  export PATH="$prefix/bin:$PATH"
  # Persist for future shells so `bun run build` keeps working after this run.
  if ! grep -qs 'nurae-node' "$HOME/.bashrc"; then
    { echo ''
      echo '# added by NURAE setup.sh — Node.js used by the build toolchain'
      echo 'export PATH="$HOME/.local/nurae-node/bin:$PATH"'
    } >> "$HOME/.bashrc"
  fi
}

ensure_node() {
  if node_ok; then
    say "Node.js $(node_major) found (build tool)"
    return 0
  fi
  local have=""
  have="$(node_major || true)"
  [[ -n "$have" ]] && warn "Node.js ${have} is too old for the Next.js build (20+ needed) — upgrading"
  local SUDO=""
  [[ "$(id -u)" != "0" ]] && SUDO="sudo"
  say "Installing Node.js 22.x (the production build needs it — the app itself runs on Bun)"
  if command -v apt-get >/dev/null 2>&1; then
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
      (command -v curl >/dev/null 2>&1 && curl -fsSL https://deb.nodesource.com/setup_22.x \
        || wget -qO- https://deb.nodesource.com/setup_22.x) | $SUDO bash - \
        && $SUDO apt-get install -y nodejs || true
    fi
    node_ok || { $SUDO apt-get update -y || true; $SUDO apt-get install -y nodejs || true; }
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y nodejs || true
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add --no-cache nodejs npm || true
  elif command -v brew >/dev/null 2>&1; then
    brew install node@22 || true
    node_ok || export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
  fi
  node_ok || node_tarball_install || die "Node.js install failed — install Node.js 20+ manually, then re-run."
  node_ok || die "Node.js on PATH is not usable — install Node.js 20+ manually and re-run."
  say "Node.js $(node --version) ready"
}

# --- 2. .env -----------------------------------------------------------------
ADMIN_TOKEN=""
PORT_NUM="3000"

gen_hex() { bun -e "console.log(require('node:crypto').randomBytes($1).toString('hex'))"; }

write_env() {
  local secret admin
  secret="$(gen_hex 32)"
  admin="$(gen_hex 24)"
  cat > .env <<EOF
# NURAE ${VERSION_LINE} — generated by setup.sh on $(date -u +%Y-%m-%d)
# The ONLY config file. Edit freely; restart the server after changes.
# NEVER commit this file. Losing NURAE_SECRET_KEY = losing all stored secrets.
DATABASE_URL=file:$(pwd)/db/nurae.db

# Master encryption key (auto-generated — keep a private backup of this file)
NURAE_SECRET_KEY=${secret}

# Dashboard login token (auto-generated — shown at the end of setup)
NURAE_ADMIN_TOKEN=${admin}

# Server binding (0.0.0.0 = also reachable from other devices on your LAN)
HOSTNAME=0.0.0.0
PORT=3000

# polling = bots work with NO public URL, NO tunnel (best for local/Termux).
# For the production webhook transport see SETUP.md §5.2.
NURAE_BOT_TRANSPORT=polling

# AI provider fallback keys (optional — per-bot keys are entered in the
# dashboard and encrypted at rest; these are only account-wide fallbacks)
OPENAI_API_KEY=
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
GLM_API_KEY=
LOCAL_API_KEY=
CUSTOM_API_KEY=

# Gateway Link (split frontend/backend) — leave unset for single-process use.
# NURAE_LINK_FRONTEND_URL=
# NURAE_GATEWAY_KEY=
EOF
  ADMIN_TOKEN="$admin"
}

optional_ai_key() {
  # Interactive only, and only right after generating a fresh .env.
  [[ -t 0 ]] || return 0
  printf '\nOptional: paste a default AI API key now (Enter to skip — you can\nadd keys per-bot in the dashboard later): '
  read -r aikey
  [[ -n "$aikey" ]] || return 0
  echo "  1) openai   2) openrouter   3) deepseek   4) glm   5) local   6) custom"
  printf  '  Provider number [1-6, Enter = openrouter]: '
  read -r pick
  case "${pick:-2}" in
    1) VAR=OPENAI_API_KEY ;;
    3) VAR=DEEPSEEK_API_KEY ;;
    4) VAR=GLM_API_KEY ;;
    5) VAR=LOCAL_API_KEY ;;
    6) VAR=CUSTOM_API_KEY ;;
    *) VAR=OPENROUTER_API_KEY ;;
  esac
  local esc="${aikey//&/\\&}"; esc="${esc//|/\\|}"
  sed -i "s|^${VAR}=.*|${VAR}=${esc}|" .env
  say "Saved as ${VAR} (fallback for bots without their own key)"
}

prepare_env() {
  if [[ -f .env ]]; then
    say "Keeping existing .env (secrets preserved)"
    # Patch in anything an older .env lacks so the app always boots.
    grep -q '^NURAE_ADMIN_TOKEN=' .env || { echo "NURAE_ADMIN_TOKEN=$(gen_hex 24)" >> .env; warn "NURAE_ADMIN_TOKEN was missing — generated a new one"; }
    grep -q '^NURAE_SECRET_KEY='  .env || { echo "NURAE_SECRET_KEY=$(gen_hex 32)"  >> .env; warn "NURAE_SECRET_KEY was missing — generated a new one (old encrypted secrets may be unreadable)"; }
    grep -q '^DATABASE_URL='      .env || echo "DATABASE_URL=file:$(pwd)/db/nurae.db" >> .env
    grep -q '^NURAE_BOT_TRANSPORT=' .env || echo 'NURAE_BOT_TRANSPORT=polling' >> .env
  else
    say "Creating .env (random secrets, polling transport)"
    write_env
    optional_ai_key
  fi
  ADMIN_TOKEN="$(grep '^NURAE_ADMIN_TOKEN=' .env | head -1 | cut -d= -f2-)"
  PORT_NUM="$(grep '^PORT=' .env | head -1 | cut -d= -f2- || true)"
  [[ -n "$PORT_NUM" ]] || PORT_NUM=3000
}

# --- 3. dependencies + database ----------------------------------------------
prepare_db() {
  say "Installing dependencies (bun install)"
  bun install
  say "Creating the database schema (prisma db push)"
  # package.json invokes prisma/next as `node <direct entry path>` — immune to
  # `bun run` not putting node_modules/.bin on PATH and to shebang resolution
  # (the old bare `prisma` failed with exit 127 on a node-less box).
  # ensure_node() above has guaranteed a Node.js 20+ runtime by this point.
  bun run db:push
}

# --- 4. build -----------------------------------------------------------------
maybe_build() {
  if [[ "$MODE" == "dev" ]]; then
    warn "dev mode: skipping the production build (hot reload, lighter on RAM)"
    return 0
  fi
  if [[ "$MODE" == "start" && -f .next/standalone/server.js ]]; then
    say "Reusing existing production build"
    return 0
  fi
  say "Building the production bundle (the heavy step — patience)"
  bun run build
}

# --- 5. pre-flight + start ----------------------------------------------------
already_running() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -sf --max-time 2 "http://127.0.0.1:${PORT_NUM}/api/health" >/dev/null 2>&1
}

print_box() {
  local ip="" ip_note=""
  if command -v hostname >/dev/null 2>&1; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  [[ -n "$ip" ]] && ip_note="  (LAN: http://${ip}:${PORT_NUM})"
  cat <<EOF

============================================================
 NURAE ${VERSION_LINE} — ready
 Dashboard  : http://localhost:${PORT_NUM}${ip_note}
 Login with this admin token (also saved in .env):

   ${ADMIN_TOKEN}

 Transport  : $(grep '^NURAE_BOT_TRANSPORT=' .env | cut -d= -f2- || echo webhook)
------------------------------------------------------------
 The only manual parts are your API tokens, entered in the
 dashboard (encrypted at rest):
   1. Open the URL above, paste the admin token
   2. New project -> New bot -> paste the Telegram bot
      token from @BotFather
   3. Bot page -> AI provider -> pick one, paste its API
      key -> Save -> Start
============================================================
EOF
}

ensure_bun
ensure_node
prepare_env
prepare_db

if [[ "$MODE" == "env" ]]; then
  say "Preparation complete — not starting the server (env mode)."
  print_box
  exit 0
fi

maybe_build

if already_running; then
  warn "NURAE already answers on port ${PORT_NUM} — nothing to start."
  print_box
  exit 0
fi

print_box
say "Starting NURAE (Ctrl+C stops it)"

if [[ "$MODE" == "dev" ]]; then
  exec bun run dev
else
  exec bun run start
fi
