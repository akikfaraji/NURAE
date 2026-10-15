/**
 * NURAE — agent-API test fixture (dev-only).
 * Seeds one verified user + three AgentTokens (raw Prisma path — no tsconfig
 * alias imports) and prints the raw keys ONCE:
 *   1. full    — user scope, allowConsequential=true  (main test driver)
 *   2. limited — user scope, allowConsequential=false (consequential-gate test)
 *   3. platform— platform scope                        (operator tier + turn-403 test)
 * Run: node scripts/seed-agent-fixture.mjs
 */
import { createHash, randomBytes, scryptSync } from 'node:crypto';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomBase62(length) {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (out.length >= length) break;
      if (b >= 248) continue;
      out += BASE62[b % 62];
    }
  }
  return out;
}
function mint(name, scope, ownerId, allowConsequential) {
  const token = `nrae_${randomBase62(43)}`;
  return { token, row: { name, scope, ownerId, allowConsequential, prefix: token.slice(0, 12), keyHash: createHash('sha256').update(token).digest('hex') } };
}

// scrypt password hash — exact app scheme: scrypt$N$r$p$<salt b64url>$<hash b64url>
function hashPassword(password) {
  const N = 16384, R = 8, P = 1, KEYLEN = 64;
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const prisma = new (await import('@prisma/client')).PrismaClient();
try {
  const email = 'agent-adv-test@example.com';
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        name: 'Agent Advanced Test',
        email,
        passwordHash: hashPassword('agent-adv-test-password'),
        emailVerified: true,
      },
    });
  }

  const full = mint('adv-test-full', 'user', user.id, true);
  const limited = mint('adv-test-limited', 'user', user.id, false);
  const platform = mint('adv-test-platform', 'platform', null, true);
  for (const t of [full, limited, platform]) {
    await prisma.agentToken.create({ data: { name: t.row.name, prefix: t.row.prefix, keyHash: t.row.keyHash, scope: t.row.scope, ownerId: t.row.ownerId, allowConsequential: t.row.allowConsequential } });
  }

  console.log(JSON.stringify({ userId: user.id, email, password: 'agent-adv-test-password', full: full.token, limited: limited.token, platform: platform.token }, null, 2));
} finally {
  await prisma.$disconnect();
}
