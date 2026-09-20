import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const u = await p.user.findFirst({ where: { email: { startsWith: 'browser-test-' } } });
if (u) {
  const bots = await p.bot.findMany({ where: { ownerId: u.id }, select: { id: true } });
  for (const b of bots) { await p.bot.delete({ where: { id: b.id } }).catch(() => undefined); }
  await p.chatSession.deleteMany({ where: { userId: u.id } });
  await p.userFile.deleteMany({ where: { userId: u.id } });
  await p.ledgerEntry.deleteMany({ where: { userId: u.id } }).catch(() => undefined);
  await p.topupOrder.deleteMany({ where: { userId: u.id } }).catch(() => undefined);
  await p.entitlement.deleteMany({ where: { userId: u.id } }).catch(() => undefined);
  await p.referral.deleteMany({ where: { inviterId: u.id } }).catch(() => undefined);
  await p.agentToken.deleteMany({ where: { ownerId: u.id } }).catch(() => undefined);
  await p.user.delete({ where: { id: u.id } });
  console.log('cleaned smoke user + data:', u.email);
} else console.log('no smoke user found');
const steps = await p.agentStep.deleteMany({ where: { session: null } }).catch(() => undefined);
await p.$disconnect();
