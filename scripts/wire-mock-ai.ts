/**
 * Dev-only: wire the official NURAE bot to the local mock AI (browser
 * verification helper). Run: npx tsx scripts/wire-mock-ai.ts
 */
import { PrismaClient } from '@prisma/client';
import { SecretManager } from '../src/lib/nurae/secrets';

const prisma = new PrismaClient();

async function main() {
  const bot = await prisma.bot.findFirst({ where: { name: 'NURAE CS Bot' } });
  if (!bot) throw new Error('official bot not seeded yet (boot the app once)');
  await prisma.bot.update({
    where: { id: bot.id },
    data: {
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:39901/v1',
      apiKeyRef: SecretManager.encrypt('mock-key'),
    },
  });
  console.log('official bot wired to mock AI at http://127.0.0.1:39901/v1');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
