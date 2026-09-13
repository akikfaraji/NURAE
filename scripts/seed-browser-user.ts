/**
 * Dev-only: seed a verified test customer in the LOCAL dev database and
 * print the credentials. Used for browser verification — never sends mail.
 * Run: node --experimental-strip-types scripts/seed-browser-user.ts
 */
import { randomBytes } from 'node:crypto';
import { scryptSync } from 'node:crypto';

const BASE = process.cwd();

// Minimal Prisma-free path: use the app's own libs via tsx-style import.
async function main() {
  process.chdir(BASE);
  const { randomBytes: rb } = await import('node:crypto');

  const { hashPassword } = await import('../src/lib/nurae/auth/passwords.ts');
  const { PrismaClient } = await import('@prisma/client');

  const prisma = new PrismaClient();
  const email = `browser-test-${rb(3).toString('hex')}@example.com`;
  const password = 'browser-test-password';
  const user = await prisma.user.create({
    data: {
      name: 'Browser Test',
      email,
      passwordHash: await hashPassword(password),
      emailVerified: true,
    },
  });
  console.log(JSON.stringify({ email, password, userId: user.id }));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
void randomBytes;
void scryptSync;
