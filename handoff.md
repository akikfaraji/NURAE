# NURAE — Current Status & Handoff Guide

## Current State (as of October 2026)
- **Project**: NURAE (Next.js 16 + Prisma + SQLite/libSQL + Tailwind + Webhook/Polling Telegram Bot Platform)
- **Version**: V00.12.000-beta-01
- **OS**: Windows 11 (PowerShell)
- **Node**: v24.21.0, npm: 11.19.0
- **Running Status**: Active on port `3000` (`http://localhost:3000`), Node.js PID `24260`.
- **DB**: SQLite at `./db/custom.db` (schema in sync, all tables and migrations applied).

---

## WHAT HAS BEEN ACCOMPLISHED (Tasks 0 – 6)

1. **Vercel-Compatible Refactor & Webhook-First Transport (Beta-02)**:
   - Merged runtime into Next.js app.
   - Primary transport is webhook-first (`/api/telegram/webhook/[botId]`), with polling fallback.
   - Database-enforced state machine for bot lifecycles.

2. **External AI-Agent API (`/api/v1/*`, MCP, OpenAPI)**:
   - Mintable bearer AgentTokens (`nrae_...` prefixed, sha256 hashed at rest).
   - Endpoints: `/api/v1/me`, `/api/v1/tools`, `/api/v1/tools/call`, `/api/v1/agent/turn`.
   - MCP Server at `/api/mcp` (JSON-RPC 2.0).
   - OpenAPI 3.1 spec at `/api/openapi.json`.
   - Dashboard API-keys management card.

3. **UI/UX & Loader Polish (Beta-01 / V00.12)**:
   - Restored orbital loader with smoothed transitions (shaped pulses, eased beam/seam, crossfade to site).
   - Full-site UI/UX audit round completed (LoadState primitives, PageFade, mobile sheet drawers, URL-driven admin views).
   - Robust agent tool-usage UI: failed turns now persist with honest error handling and detailed activity feed previews.

4. **Testing & Verification**:
   - 393/393 unit/integration tests passing across 26 test files.
   - Lint clean (`0` errors).

---

## CURRENT KNOWN NOTES & ACTION ITEMS

1. **AI Provider Key (`OPENROUTER_API_KEY`)**:
   - The `.env` file currently contains an unverified/inactive OpenRouter API key. If you test live agent turns, ensure a valid OpenRouter or GLM API key is configured in `.env` or per-bot settings, or use the mock AI harness (`npm run mock-ai` / `node scripts/mock-ai.js`).
2. **Proxy vs Middleware**:
   - Next.js 16 expects `src/proxy.ts` (middleware has been removed/consolidated).

---

## USEFUL COMMANDS

```bash
# Start dev server
npm run dev

# Run test suite (Vitest)
npm test

# Database push / inspection
npm run db:push
```
