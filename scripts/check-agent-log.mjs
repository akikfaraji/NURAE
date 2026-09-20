import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const logs = await p.log.findMany({ where: { event: 'AGENT_TURN_FAILED' }, orderBy: { timestamp: 'desc' }, take: 5 });
for (const l of logs) console.log(l.timestamp, '|', l.message);
await p.$disconnect();
