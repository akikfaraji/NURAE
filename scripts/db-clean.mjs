import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

// Remove test fixtures that full-suite runs leaked into the dev database
// (t24-* users, satisfaction fixture bots, their projects). Keeps maria's
// account and everything the real dev instance owns (platform bots, fleet).
const testUsers = await db.user.findMany({ where: { email: { contains: '@example.com' } }, select: { id: true } });
const ids = testUsers.map((u) => u.id);

const botIdsOfUsers = ids.length
  ? (await db.bot.findMany({ where: { ownerId: { in: ids } }, select: { id: true } })).map((b) => b.id)
  : [];

// Ownerless fixture bots (satisfaction round names) — restrict to rows created today.
const todayStart = new Date('2026-09-15T00:00:00Z');
const fixtureBotNames = ['Dash Bot', 'Customer Bot One', 'Customer Bot Two', 'No Alerts Bot', 'Silent Bot', 'Order Bot', 'Order Flow Bot'];
const junkBotIds = (
  await db.bot.findMany({
    where: { ownerId: null, name: { in: fixtureBotNames }, createdAt: { gte: todayStart } },
    select: { id: true },
  })
).map((b) => b.id);

const allBotIds = [...new Set([...botIdsOfUsers, ...junkBotIds])];
const out = { users: ids.length, bots: allBotIds.length };

if (allBotIds.length) {
  out.botUserState = (await db.botUserState.deleteMany({ where: { botId: { in: allBotIds } } })).count;
  out.botSchedules = (await db.botSchedule.deleteMany({ where: { botId: { in: allBotIds } } })).count;
  out.botBroadcasts = (await db.botBroadcast.deleteMany({ where: { botId: { in: allBotIds } } })).count;
  out.botPayments = (await db.botPayment.deleteMany({ where: { botId: { in: allBotIds } } })).count;
  out.bots = (await db.bot.deleteMany({ where: { id: { in: allBotIds } } })).count;
}

if (ids.length) {
  out.entries = (await db.chatEntry.deleteMany({ where: { session: { userId: { in: ids } } } })).count;
  out.steps = (await db.agentStep.deleteMany({ where: { session: { userId: { in: ids } } } })).count;
  out.files = (await db.userFile.deleteMany({ where: { userId: { in: ids } } })).count;
  out.ledger = (await db.ledgerEntry.deleteMany({ where: { userId: { in: ids } } })).count;
  out.topups = (await db.topupOrder.deleteMany({ where: { userId: { in: ids } } })).count;
  out.entitlements = (await db.entitlement.deleteMany({ where: { userId: { in: ids } } })).count;
  out.referralRewards = (await db.referralReward.deleteMany({ where: { inviterId: { in: ids } } })).count;
  out.referrals = (await db.referral.deleteMany({ where: { inviterId: { in: ids } } })).count;
  out.sessions = (await db.session.deleteMany({ where: { userId: { in: ids } } })).count;
  out.chatSessions = (await db.chatSession.deleteMany({ where: { userId: { in: ids } } })).count;
  out.users = (await db.user.deleteMany({ where: { id: { in: ids } } })).count;
}

// Empty projects left behind by tests (no bots left in them).
const emptyProjects = await db.project.findMany({
  where: { bots: { none: {} }, createdAt: { gte: todayStart }, name: { not: 'NURAE Official' } },
  select: { id: true },
});
if (emptyProjects.length) {
  out.projects = (await db.project.deleteMany({ where: { id: { in: emptyProjects.map((p) => p.id) } } })).count;
}

console.log(JSON.stringify(out));
await db.$disconnect();
