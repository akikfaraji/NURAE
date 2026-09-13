/**
 * NURAE — dev utility: seed a markdown assistant reply into the official CS
 * bot conversation of a given user email, so the web chat markdown rendering
 * can be verified visually. Dev/test use only.
 *
 *   node scripts/seed-chat-markdown.js <email>
 */

const fs = require('node:fs');
const path = require('node:path');

// Parse DATABASE_URL from .env (dev DB).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MARKDOWN_REPLY = `### 🚀 Step-by-Step Guide

Creating your own bot on **NURAE** is simple — here is the short version:

1. **Sign up / Log in** — you are already here.
2. **Get your Telegram bot token**
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send \`/newbot\` and follow the prompts
   - ⚠️ **Keep this token private** — never share it publicly!

3. **Hand the token to the NURAE team** — we connect everything: webhooks, memory, and your AI provider.

| Plan | Models | Price |
| --- | --- | --- |
| Free | OpenRouter free tier | ~~\$0~~ **included** |
| Pro | Any provider | your key |

> Tip: free OpenRouter models are the default brain — one free key is enough to start.

Ask me anything else about \`providers\`, keys, or your account!`;

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('usage: node scripts/seed-chat-markdown.js <email>');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`user ${email} not found`);

  const bot = await prisma.bot.findFirst({ where: { name: { contains: 'CS' } } });
  if (!bot) throw new Error('official CS bot row not found');

  const chatId = `web:${user.id}`;
  let conversation = await prisma.conversation.findUnique({
    where: { botId_chatId: { botId: bot.id, chatId } },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { botId: bot.id, chatId } });
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: 'user', content: 'How to create a bot here?' },
  });
  const msg = await prisma.message.create({
    data: { conversationId: conversation.id, role: 'assistant', content: MARKDOWN_REPLY },
  });
  console.log(`seeded assistant message ${msg.id} into conversation ${conversation.id} for ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
