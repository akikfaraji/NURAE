/**
 * LIVE OpenRouter test with the REAL key from .env (not garbage).
 * Replicates exactly what NURAE's OpenAICompatibleProvider sends:
 *   POST https://openrouter.ai/api/v1/chat/completions
 *   model: openrouter/free (platform default)
 * Also checks key metadata via GET /auth/key so we can report
 * quota/limit/tier state — the thing the garbage-key probe could not see.
 */
import { readFileSync } from 'node:fs';

const BASE = 'https://openrouter.ai/api/v1';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/OPENROUTER_API_KEY=(.+)/)?.[1] || '').trim();
if (!KEY) { console.error('NO KEY IN .env'); process.exit(1); }
console.log(`key: ${KEY.slice(0, 12)}…${KEY.slice(-4)} (len ${KEY.length})`);

async function call(label, path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try { body = await res.json(); } catch { body = '<non-json>'; }
  console.log(`\n== ${label} → HTTP ${res.status}`);
  return { status: res.status, body };
}

// 1. Key metadata — proves the key is VALID and shows quota state
const meta = await call('GET /auth/key (key metadata)', '/auth/key', {
  headers: { Authorization: `Bearer ${KEY}` },
});
if (meta.status === 200) {
  const d = meta.body?.data ?? {};
  console.log(`   label=${d.label}  usage=$${d.usage}  limit=${d.limit ?? 'unlimited'}  free_tier=${d.is_free_tier}  rate_blocked=${d.rate_limit ? 'maybe' : 'no'}`);
} else {
  console.log(`   body: ${JSON.stringify(meta.body).slice(0, 300)}`);
}

// 2. Real chat completion — EXACTLY the platform's call (openrouter/free)
const chat = await call('POST /chat/completions (REAL key, model=openrouter/free)', '/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KEY}`,
    'HTTP-Referer': 'https://nurae.local',
    'X-Title': 'NURAE live test',
  },
  body: JSON.stringify({
    model: 'openrouter/free',
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    max_tokens: 512,
  }),
});

if (chat.status === 200) {
  const choice = chat.body?.choices?.[0]?.message?.content;
  console.log(`   model used: ${chat.body?.model}`);
  console.log(`   reply: ${JSON.stringify(choice)}`);
  console.log(`   usage: ${JSON.stringify(chat.body?.usage)}`);
} else {
  const err = chat.body?.error ?? chat.body;
  console.log(`   ERROR ${err?.code ?? ''}: ${JSON.stringify(err).slice(0, 400)}`);
}

// 3. Fallback probe path the platform's health check uses: /models with real key
const models = await call('GET /models (REAL key)', '/models', {
  headers: { Authorization: `Bearer ${KEY}` },
});
if (models.status === 200) {
  const free = (models.body?.data ?? []).filter((m) => String(m.id).endsWith(':free'));
  console.log(`   total models=${models.body?.data?.length}, free models=${free.length}`);
  console.log(`   sample free: ${free.slice(0, 5).map((m) => m.id).join(', ')}`);
}

console.log('\n--- live probe complete ---');
