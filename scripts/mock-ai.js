/**
 * NURAE — local mock OpenAI-compatible AI for BROWSER VERIFICATION ONLY.
 * Serves /v1/chat/completions with content-aware canned replies so the
 * chat → agent handoff and the Bot Builder tool loop can be exercised
 * end-to-end in the browser without external credentials.
 *
 * Behavior:
 *   - default: "Mock reply: <echo of the last user line>"
 *   - if the request's system prompt contains the handoff directive line
 *     (i.e. this is the CHAT system prompt) and the user text mentions
 *     "bot"/"build": reply includes the machine handoff directive.
 *   - if the system prompt looks like the BOT BUILDER (contains "Bot Builder
 *     agent"): reply with a JSON envelope: create draft → set commands →
 *     ask to publish. Second round: done.
 */
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const messages = parsed.messages ?? [];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      let content;

      if (system.includes('Bot Builder agent')) {
        const resultsRound = /TOOL RESULTS/i.test(lastUser);
        if (resultsRound) {
          content = JSON.stringify({
            message:
              'Your bot is drafted with a `/start` welcome and a `/menu` command with buttons. **Publish it now?** Press *Approve & publish* below, or tell me what to change.',
            actions: [],
            done: true,
          });
        } else {
          content = JSON.stringify({
            message: 'Building your bot now — creating the draft.',
            actions: [
              {
                tool: 'bot_create_draft',
                args: {
                  name: 'Menu Bot',
                  description: 'Restaurant menu bot built in browser verification',
                  commands: [
                    { command: '/menu', description: 'Show the menu', kind: 'static', response: 'Today: Pizza, Pasta, Salad.' },
                  ],
                  replies: [
                    {
                      id: 'r1',
                      name: 'Reserve',
                      trigger: { type: 'keyword', value: 'reserve' },
                      messages: [
                        { text: 'Reservations open at 5pm:', buttons: [[{ text: 'Call us', url: 'https://example.com' }]] },
                      ],
                    },
                  ],
                },
              },
              {
                tool: 'bot_set_commands',
                args: {
                  // Intentionally references the just-created draft via name so
                  // the loop must resolve it — simplified: list then use id.
                  botId: 'PENDING',
                  commands: [{ command: '/menu', description: 'Show the menu', kind: 'static', response: 'Today: Pizza.' }],
                },
              },
            ],
            done: false,
          });
        }
      } else if (system.includes('handoff') || system.includes('front layer')) {
        // Chat system prompt — route build-y requests to the agent.
        if (/build|make me|create.*bot/i.test(lastUser)) {
          content =
            'I can have the Bot Builder agent build this using your request.\n{"handoff":"bot-builder","task":"Build a restaurant bot with a menu command"}';
        } else {
          content = `Mock answer about **${lastUser.slice(0, 60)}** — NURAE chats render markdown, so *this*, \`code\` and lists:\n\n- one\n- two\n\n| col | val |\n| --- | --- |\n| a | b |`;
        }
      } else {
        content = `Mock reply: ${lastUser.slice(0, 80)}`;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(39901, () => console.log('mock AI on :39901'));
