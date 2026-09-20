import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const bots = await p.bot.findMany({  select: { id: true, name: true, provider: true, model: true, apiKeyRef: true, baseUrl: true } });
console.log('platform bots:', JSON.stringify(bots, null, 1));
await p.$disconnect();
