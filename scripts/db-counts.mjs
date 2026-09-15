import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const [bots, users, projects, entries] = await Promise.all([
  db.bot.count(), db.botUserState.count(), db.project.count(), db.chatEntry.count(),
]);
console.log(JSON.stringify({ bots, users, projects, entries }));
await db.$disconnect();
