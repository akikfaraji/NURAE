/**
 * Live end-to-end probes of the two APIs the user reports as broken.
 * Uses garbage credentials on purpose — we are verifying the NETWORK PATH,
 * the request shape, and the error classification the platform will show.
 * A clean 401 from each API proves: DNS ok, TLS ok, endpoint ok, and the
 * failure the user sees is credential/config state on their machine — not
 * the platform's code.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const TELEGRAM_BASE = 'https://api.telegram.org';

async function j(label, promise) {
  try {
    const res = await promise;
    let body = null;
    try { body = await res.json(); } catch { body = '<non-json>'; }
    console.log(`\n== ${label}`);
    console.log(`HTTP ${res.status}`);
    console.log(JSON.stringify(body).slice(0, 400));
    return { status: res.status, body };
  } catch (err) {
    console.log(`\n== ${label}`);
    console.log(`NETWORK FAIL: ${err.name}: ${err.message}`);
    return { status: 0, err: String(err) };
  }
}

const garbageOpenRouter = 'sk-or-v1-' + '0'.repeat(64);
const garbageTelegram = '123456:AA' + 'x'.repeat(33);

// 1. OpenRouter chat-completions with a garbage key (exactly what the platform sends)
await j('OpenRouter /chat/completions (garbage key)', fetch(`${OPENROUTER_BASE}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${garbageOpenRouter}`,
    'HTTP-Referer': 'https://nurae.local',
    'X-Title': 'NURAE probe',
  },
  body: JSON.stringify({ model: 'openrouter/free', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
}));

// 2. OpenRouter with NO key at all (what an unconfigured deployment sends)
await j('OpenRouter /chat/completions (no key)', fetch(`${OPENROUTER_BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'openrouter/free', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
}));

// 3. OpenRouter /models (fallback probe path)
await j('OpenRouter /models (garbage key)', fetch(`${OPENROUTER_BASE}/models`, {
  headers: { Authorization: `Bearer ${garbageOpenRouter}` },
}));

// 4. Telegram getMe with garbage token (exactly what the adapter sends)
await j('Telegram /getMe (garbage token)', fetch(`${TELEGRAM_BASE}/bot${garbageTelegram}/getMe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}));

// 5. Telegram getUpdates with garbage token (the polling transport call)
await j('Telegram /getUpdates (garbage token)', fetch(`${TELEGRAM_BASE}/bot${garbageTelegram}/getUpdates`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offset: 0, timeout: 0 }),
}));

console.log('\n--- probe complete ---');
