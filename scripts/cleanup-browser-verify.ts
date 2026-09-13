/**
 * Dev-only cleanup: remove everything the browser-verification run created
 * (test users, their chats/agents, the Menu Bot + its project) and restore
 * the official CS bot to seed defaults. Never touches real data rows.
 * Run: npx tsx scripts/cleanup-browser-verify.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const testUsers = await prisma.user.findMany({ where: { email: { startsWith: 'browser-test-' } } });
  for (const u of testUsers) {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => undefined);
  }

  // Bots owned by the (now deleted) test users: ownerId no longer matches a
  // real user — delete by the verification bot name + orphans defensively.
  await prisma.bot.deleteMany({ where: { name: 'Menu Bot' } });
  const usersForOrphans = await prisma.user.findMany({ select: { id: true } });
  const liveIds = new Set(usersForOrphans.map((u) => u.id));
  const allBots = await prisma.bot.findMany({ where: { ownerId: { not: null } }, select: { id: true, ownerId: true } });
  const orphans = allBots.filter((b) => !liveIds.has(b.ownerId!));
  for (const b of orphans) {
    await prisma.bot.delete({ where: { id: b.id } }).catch(() => undefined);
  }
  await prisma.project.deleteMany({ where: { description: { contains: 'Personal bot workspace' }, bots: { none: {} } } });

  // Agent/chat sessions of deleted users cascade via userId FK? ChatSession
  // has no FK to User (plain string) — sweep orphaned sessions explicitly.
  const users = await prisma.user.findMany({ select: { id: true } });
  const ids = new Set(users.map((u) => u.id));
  const sessions = await prisma.chatSession.findMany({ select: { id: true, userId: true } });
  for (const s of sessions) {
    if (!ids.has(s.userId)) await prisma.chatSession.delete({ where: { id: s.id } }).catch(() => undefined);
  }
  const files = await prisma.userFile.findMany({ select: { id: true, userId: true } });
  for (const f of files) {
    if (!ids.has(f.userId)) await prisma.userFile.delete({ where: { id: f.id } }).catch(() => undefined);
  }

  // Official bot back to seed defaults (undo the mock-AI wiring).
  const official = await prisma.bot.findFirst({ where: { name: 'NURAE CS Bot' } });
  if (official) {
    await prisma.bot.update({
      where: { id: official.id },
      data: { provider: 'openrouter', model: 'openrouter/free', baseUrl: null, apiKeyRef: null },
    });
  }

  console.log(
    JSON.stringify({ removedUsers: testUsers.length, removedOrphanBots: orphans.length, officialBotReset: Boolean(official) }),
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
