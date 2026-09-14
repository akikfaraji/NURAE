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

      if (system.includes('Bot Builder')) {
        const resultsRound = /TOOL RESULTS/i.test(lastUser);
        if (resultsRound) {
          content = JSON.stringify({
            message:
              'Done — your restaurant bot is drafted: **when someone starts it, they get a welcome with Menu, Order and Contact buttons**, and ordering asks for the order. Open it below to preview, then publish when ready.',
            actions: [],
            done: true,
          });
        } else {
          content = JSON.stringify({
            message: 'Building your restaurant bot now.',
            actions: [
              {
                tool: 'bot_create_draft',
                args: {
                  name: 'Trattoria Bot',
                  description: 'Restaurant bot built in browser verification',
                  behaviors: [
                    {
                      id: 'welcome',
                      title: 'Welcome',
                      when: { type: 'start' },
                      steps: [
                        {
                          type: 'message',
                          text: 'Welcome! What would you like to do?',
                          buttons: [
                            { label: 'Menu', action: { kind: 'flow', behaviorId: 'menu' } },
                            { label: 'Order', action: { kind: 'message', text: 'Tell me your order and we will confirm right away.' } },
                          ],
                        },
                      ],
                    },
                    { id: 'menu', title: 'Menu', when: { type: 'button' }, steps: [{ type: 'message', text: 'Today: Pizza, Pasta, Salad.' }] },
                  ],
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
