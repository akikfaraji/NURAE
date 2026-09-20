/** Dev-only: restore the official bot to its pre-mock config (openrouter/env key). */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const bot = await prisma.bot.findFirst({ where: { name: 'NURAE CS Bot' } });
  if (!bot) throw new Error('official bot not found');
  await prisma.bot.update({
    where: { id: bot.id },
    data: { provider: 'openrouter', baseUrl: null, apiKeyRef: null, model: 'openrouter/free' },
  });
  console.log('official bot restored to openrouter/env-key config');
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
