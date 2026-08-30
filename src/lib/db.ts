import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function configureSqlite(client: PrismaClient) {
  // NURAE: the API process and the bot-runtime process share this SQLite file.
  // WAL + busy_timeout make concurrent multi-process access safe.
  // NOTE: PRAGMA statements return rows, so they must use $queryRawUnsafe.
  void client
    .$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    .catch(() => undefined)
  void client
    .$queryRawUnsafe('PRAGMA busy_timeout=5000;')
    .catch(() => undefined)
}

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: ['error', 'warn'],
  })
  configureSqlite(client)
  return client
}

export const db =
  globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
