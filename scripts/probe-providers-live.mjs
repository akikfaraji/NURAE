import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const pick = (name) => (env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1] || '').trim();

const OPENROUTER_KEY = pick('OPENROUTER_API_KEY');
const ORCA_KEY = pick('ORCA_API_KEY');
const ORCA_MODEL = 'z-ai/glm-5.3-flash-free';

async function call(label, url, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    console.log(`\n== ${label} -> HTTP ${res.status} (${Date.now() - started}ms)`);
    return { status: res.status, body };
  } catch (err) {
    console.log(`\n== ${label} -> TRANSPORT FAILURE (${Date.now() - started}ms): ${err.message}`);
    return { status: 0, body: null };
  }
}

function chatBody(model) {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    max_tokens: 512,
  });
}

function reportChat(res) {
  if (res.status === 200) {
    console.log(`   model used: ${res.body?.model}`);
    console.log(`   reply: ${JSON.stringify(res.body?.choices?.[0]?.message?.content)}`);
    console.log(`   usage: ${JSON.stringify(res.body?.usage)}`);
    return true;
  }
  const err = res.body?.error ?? res.body;
  console.log(`   error: ${JSON.stringify(err).slice(0, 300)}`);
  return false;
}

if (OPENROUTER_KEY) {
  const BASE = 'https://openrouter.ai/api/v1';
  const meta = await call('OpenRouter GET /auth/key', `${BASE}/auth/key`, {
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
  });
  if (meta.status === 200) {
    const d = meta.body?.data ?? {};
    console.log(`   label=${d.label} usage=$${d.usage} limit=${d.limit ?? 'unlimited'} free_tier=${d.is_free_tier}`);
  }

  const chat = await call('OpenRouter POST /chat/completions (openrouter/free)', `${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENROUTER_KEY}` },
    body: chatBody('openrouter/free'),
  });
  reportChat(chat);
} else {
  console.log('OPENROUTER_API_KEY missing in .env');
}

if (ORCA_KEY) {
  const BASE = 'https://api.orcarouter.ai/v1';
  const models = await call('OrcaRouter GET /models', `${BASE}/models`, {
    headers: { Authorization: `Bearer ${ORCA_KEY}` },
  });
  let ids = [];
  if (models.status === 200) {
    ids = (models.body?.data ?? []).map((m) => m.id).filter(Boolean);
    console.log(`   total models=${ids.length}`);
    console.log(`   default model "${ORCA_MODEL}": ${ids.includes(ORCA_MODEL) ? 'FOUND' : 'NOT in /models'}`);
    const free = ids.filter((id) => /free/i.test(id));
    console.log(`   free sample: ${free.slice(0, 8).join(', ') || '(none matched /free/)'}`);
  } else {
    console.log(`   error: ${JSON.stringify(models.body?.error ?? models.body).slice(0, 300)}`);
  }

  const chat = await call(`OrcaRouter POST /chat/completions (${ORCA_MODEL})`, `${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ORCA_KEY}` },
    body: chatBody(ORCA_MODEL),
  });
  if (!reportChat(chat) && ids.length) {
    const alt = ids.find((id) => /glm.*free/i.test(id)) || ids.find((id) => /free/i.test(id)) || ids[0];
    if (alt && alt !== ORCA_MODEL) {
      const retry = await call(`OrcaRouter POST /chat/completions (fallback: ${alt})`, `${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ORCA_KEY}` },
        body: chatBody(alt),
      });
      reportChat(retry);
    }
  }
} else {
  console.log('ORCA_API_KEY missing in .env');
}

console.log('\n--- provider probe complete ---');
