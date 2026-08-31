import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

/**
 * NURAE database client.
 *
 * Single code path for every environment via the Prisma libSQL driver adapter:
 *  - Local development:  DATABASE_URL=file:./db/custom.db   (embedded libSQL)
 *  - Vercel / serverless DATABASE_URL=libsql://…-turso.io   (+DATABASE_AUTH_TOKEN)
 *
 * The adapter executes SQL through @libsql/client, so no Prisma query engine
 * binary is loaded at runtime — good for serverless cold starts.
 *
 * NURAE beta-02 is single-process (the bot runtime lives inside this app), so
 * WAL is no longer required; busy_timeout is still set as a defensive measure
 * for local file databases.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function databaseUrl(): string {
  return process.env.DATABASE_URL || 'file:./db/custom.db'
}

function createClient(): PrismaClient {
  const url = databaseUrl()
  // PrismaLibSQL is a driver-adapter FACTORY: it accepts the libSQL config
  // ({ url, authToken }) and manages the underlying @libsql/client itself.
  // It supports file: (embedded, local dev) and libsql:// (Turso, Vercel) URLs.
  const adapter = new PrismaLibSQL({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined })
  const client = new PrismaClient({
    adapter,
    log: ['error', 'warn'],
  })
  configureLocalSqlite(client, url)
  return client
}

function configureLocalSqlite(client: PrismaClient, url: string) {
  // PRAGMA statements return rows — they must use $queryRawUnsafe (not executeRaw).
  if (url.startsWith('file:')) {
    void client.$queryRawUnsafe('PRAGMA busy_timeout=5000;').catch(() => undefined)
  }
}

export const db =
  globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
