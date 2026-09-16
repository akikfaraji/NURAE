import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

// Platform bot (the AI layer config the agents use) — ownerId null = platform-owned official bot
const official = await db.bot.findFirst({ where: { ownerId: null } });
console.log('OFFICIAL BOT:', JSON.stringify({
  id: official?.id, provider: official?.provider, model: official?.model,
  maxTokens: official?.maxTokens, hasKeyRef: Boolean(official?.apiKeyRef), baseUrl: official?.baseUrl,
}));

// Agent sessions (kind=agent) + their recent entries
const sessions = await db.chatSession.findMany({
  where: { kind: 'agent' },
  orderBy: { updatedAt: 'desc' },
  take: 8,
  select: { id: true, userId: true, agent: true, title: true, updatedAt: true, state: true },
});
console.log('\nAGENT SESSIONS (latest 8):');
for (const s of sessions) {
  const counts = await db.chatEntry.groupBy({ by: ['role'], where: { sessionId: s.id }, _count: true });
  console.log(` - ${s.id} user=${s.userId} agent=${s.agent} title=${JSON.stringify(s.title)} at=${s.updatedAt.toISOString()} entries=${JSON.stringify(counts.map((c) => `${c.role}:${c._count}`))}`);
}

// The last few assistant entries on agent sessions — do they end with empty content?
const recent = await db.chatEntry.findMany({
  where: { session: { kind: 'agent' } },
  orderBy: { createdAt: 'desc' },
  take: 12,
  select: { id: true, sessionId: true, role: true, content: true, meta: true, createdAt: true },
});
console.log('\nRECENT AGENT ENTRIES (latest 12):');
for (const e of recent) {
  console.log(` - ${e.createdAt.toISOString()} ${e.role} session=${e.sessionId} len=${e.content.length} content=${JSON.stringify(e.content.slice(0, 160))}`);
}

// Agent steps: what did the tools actually do recently?
const steps = await db.agentStep.findMany({
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: { sessionId: true, seq: true, tool: true, status: true, label: true, createdAt: true },
});
console.log('\nRECENT AGENT STEPS (latest 15):');
for (const s of steps) console.log(` - ${s.createdAt.toISOString()} session=${s.sessionId} seq=${s.seq} ${s.tool} ${s.status} ${JSON.stringify(s.label.slice(0, 80))}`);

// Error logs from agent turns
const logs = await db.log.findMany({
  where: { event: { in: ['AGENT_TURN_FAILED', 'OPERATOR_TURN_FAILED'] } },
  orderBy: { timestamp: 'desc' },
  take: 10,
  select: { level: true, event: true, message: true, timestamp: true },
});
console.log('\nAGENT FAILURE LOGS (latest 10):');
for (const l of logs) console.log(` - ${l.timestamp.toISOString()} ${l.event} ${JSON.stringify(l.message.slice(0, 220))}`);
if (!logs.length) console.log(' (none)');

await db.$disconnect();
