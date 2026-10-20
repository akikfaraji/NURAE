// Dependency-free screenshotter: drives Chrome over the DevTools protocol.
// Node 24 has global fetch + WebSocket, so nothing needs installing.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 9223;
const BASE = process.argv[2] || 'http://localhost:3100';
const OUT = process.argv[3] || '.zshots';
const only = process.argv[4] || '';

const SHOTS = [
  { name: 'home', path: '/', w: 1440, h: 900 },
  { name: 'pricing', path: '/pricing', w: 1440, h: 900 },
  { name: 'help', path: '/help', w: 1440, h: 900 },
  { name: 'about', path: '/about', w: 1440, h: 900 },
  { name: 'featured', path: '/featured', w: 1440, h: 900 },
  { name: 'dashboard', path: '/dashboard', w: 1440, h: 900 },
  { name: 'bots', path: '/bots', w: 1440, h: 900 },
  { name: 'chats', path: '/chats', w: 1440, h: 900 },
  { name: 'agents', path: '/chats/agents', w: 1440, h: 900 },
  { name: 'billing', path: '/billing', w: 1440, h: 900 },
  { name: 'admin-dashboard', path: '/admin/dashboard', w: 1440, h: 900 },
  { name: 'admin-customers', path: '/admin/customers', w: 1440, h: 900 },
  { name: 'admin-bots', path: '/admin/bots', w: 1440, h: 900 },
  { name: 'admin-projects', path: '/admin/projects', w: 1440, h: 900 },
  { name: 'admin-settings', path: '/admin/settings', w: 1440, h: 900 },
  { name: 'admin-agent', path: '/admin/agent', w: 1440, h: 900 },
  { name: 'm-home', path: '/', w: 390, h: 844 },
  { name: 'm-dashboard', path: '/dashboard', w: 390, h: 844 },
  { name: 'm-admin-customers', path: '/admin/customers', w: 390, h: 844 },
];

// /bots/[id] needs a real bot id; the caller resolves one from the DB and
// passes it in. No id, no shot — the route would 404 otherwise.
if (process.env.SHOOT_BOT_ID) {
  SHOTS.splice(10, 0, { name: 'bot-detail', path: `/bots/${process.env.SHOOT_BOT_ID}`, w: 1440, h: 900 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Chrome never exposed its debugging port');
}

/** Minimal CDP client over one page target. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async waitEvent(name, timeout = 20000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (events.includes(name)) {
          events.length = 0;
          return true;
        }
        await sleep(100);
      }
      return false;
    },
    close() {
      ws.close();
    },
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Optionally own the server for the whole run: started here, killed here, so
  // it can never outlive this process and lock .next/standalone again.
  let server = null;
  if (process.env.SHOOT_SERVER === '1') {
    const { spawn: spawnNode } = await import('node:child_process');
    server = spawnNode(process.execPath, ['scripts/start-prod.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: new URL(BASE).port || '3000' },
      stdio: 'ignore',
    });
    const started = Date.now();
    let up = false;
    while (Date.now() - started < 180000) {
      try {
        const r = await fetch(`${BASE}/api/ready`);
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* still booting */
      }
      await sleep(1500);
    }
    if (!up) throw new Error('server never became ready');
    console.log('server ready');
  }
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--user-data-dir=' + process.cwd() + '/.zshots/profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  try {
    await waitForChrome();
    const target = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    // The site plays a full-screen WebGL boot intro once per session. Every
    // shot here would be that loader, which is exactly how you end up
    // "verifying" 19 screenshots of a black canvas. Force the marker the boot
    // script reads, so every navigation lands on the real page.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        "try{var g=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='nuraeIntroDone')return '1';return g.call(this,k)};sessionStorage.setItem('nuraeIntroDone','1');document.documentElement.setAttribute('data-nurae-intro','done');}catch(e){}",
    });

    if (process.env.TEST_SESS) {
      const res = await cdp.send('Network.setCookie', {
        name: 'nurae_session',
        value: process.env.TEST_SESS,
        domain: new URL(BASE).hostname,
        path: '/',
      });
      console.log('setCookie result:', res);
      const cookies = await cdp.send('Network.getCookies', { urls: [BASE] });
      console.log('Network.getCookies:', JSON.stringify(cookies));
    } else {
      await cdp.send('Network.clearBrowserCookies');
    }

    const results = [];
    for (const shot of SHOTS) {
      if (only && !shot.name.includes(only)) continue;
      const url = BASE + shot.path;
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.w,
        height: shot.h,
        deviceScaleFactor: 1,
        mobile: shot.w < 500,
      });
      await cdp.send('Page.navigate', { url });
      await cdp.waitEvent('Page.loadEventFired', 25000);
      // Client-rendered pages resolve their auth check after load.
      await sleep(1800);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      const file = `${OUT}/${shot.name}.png`;
      writeFileSync(file, Buffer.from(data, 'base64'));
      // What did the page actually become? Report title + final URL.
      const { result: titleRes } = await cdp.send('Runtime.evaluate', {
        expression: 'document.title + " :: " + location.pathname + " :: " + document.body.innerText.slice(0,120)',
        returnByValue: true,
      });
      results.push({ shot: shot.name, url, title: titleRes.value });
      console.log(`shot ${shot.name} -> ${file}`);
    }
    console.log('\nSUMMARY');
    for (const r of results) console.log(`${r.shot}\t${r.title}`);
  } finally {
    chrome.kill();
    if (server) server.kill();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
