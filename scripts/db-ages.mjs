import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const bots = await db.bot.findMany({ select: { createdAt: true, name: true }, orderBy: { createdAt: 'asc' }, take: 3 });
const recent = await db.bot.findMany({ select: { createdAt: true, name: true }, orderBy: { createdAt: 'desc' }, take: 3 });
const u = await db.user.findMany({ select: { createdAt: true, email: true }, orderBy: { createdAt: 'asc' }, take: 3 });
console.log('oldest bots:', bots.map(b => `${b.createdAt.toISOString()} ${b.name}`));
console.log('newest bots:', recent.map(b => `${b.createdAt.toISOString()} ${b.name}`));
console.log('oldest users:', u.map(x => `${x.createdAt.toISOString()} ${x.email}`));
await db.$disconnect();
