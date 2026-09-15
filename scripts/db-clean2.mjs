import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
// webhook.test.ts leak: "Webhook project" rows with their bots (pre-fix run).
const projects = await db.project.findMany({ where: { name: 'Webhook project' }, select: { id: true } });
const ids = projects.map((p) => p.id);
const out = { projects: ids.length };
if (ids.length) {
  const botIds = (await db.bot.findMany({ where: { projectId: { in: ids } }, select: { id: true } })).map((b) => b.id);
  if (botIds.length) {
    out.botUserState = (await db.botUserState.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.botSchedules = (await db.botSchedule.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.botBroadcasts = (await db.botBroadcast.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.botPayments = (await db.botPayment.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.conversations = (await db.conversation.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.logs = (await db.log.deleteMany({ where: { botId: { in: botIds } } })).count;
    out.bots = (await db.bot.deleteMany({ where: { id: { in: botIds } } })).count;
  }
  out.projects = (await db.project.deleteMany({ where: { id: { in: ids } } })).count;
}
console.log(JSON.stringify(out));
await db.$disconnect();
