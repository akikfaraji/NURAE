/**
 * NURAE — dev utility: remove a test customer account and all of its web-chat
 * data (used by E2E verification runs on the dev DB).
 *
 *   node scripts/remove-test-user.js <email>
 */

const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('usage: node scripts/remove-test-user.js <email>');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.log(`user ${email} not found — nothing to do`);
    return;
  }

  // Web conversations live under chatId `web:<userId>` — delete those
  // conversations (messages cascade) before deleting the user row.
  const chats = await prisma.conversation.findMany({ where: { chatId: `web:${user.id}` } });
  for (const c of chats) {
    await prisma.message.deleteMany({ where: { conversationId: c.id } });
    await prisma.conversation.delete({ where: { id: c.id } });
  }
  await prisma.verificationToken.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log(`removed user ${email} + ${chats.length} conversation(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
