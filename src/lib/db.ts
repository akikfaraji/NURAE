import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { databaseUrl } from '@/lib/paths'

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

function createClient(): PrismaClient {
  // databaseUrl() makes relative file: paths absolute against the DATA
  // ROOT (project root on Linux; %LOCALAPPDATA%\FRAZIYM\NURAE on Windows) —
  // the standalone production server chdirs into .next/standalone, and
  // without this the production server would silently open a DIFFERENT
  // (build-time snapshot) database. See src/lib/paths.ts.
  const url = databaseUrl()
  ensureSqliteDir(url)
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

/**
 * A fresh data home has no db/ folder yet — libSQL cannot create the file
 * through a missing directory and answers "Failed to connect to database"
 * on the very first touch (build page-data collection, dev boot). The
 * schema itself is pushed later by the boot-time schema sync; the empty
 * file libSQL auto-creates is a valid empty SQLite database.
 * Windows data home: %LOCALAPPDATA%\FRAZIYM\NURAE (see src/lib/paths.ts).
 */
function ensureSqliteDir(url: string) {
  if (!url.startsWith('file:')) return
  const path = url.slice('file:'.length)
  if (!path || path.startsWith(':')) return // ":memory:" and friends
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // read-only filesystem etc. — let the query surface the real error
  }
}

function configureLocalSqlite(client: PrismaClient, url: string) {
  // PRAGMA statements return rows — they must use $queryRawUnsafe (not executeRaw).
  // Best-effort: when a build phase is visible (NEXT_PHASE), skip the eager
  // PRAGMA so module imports don't open the database at all. Where the phase
  // is not propagated to build workers, the touch still succeeds silently
  // (empty db file in the data home) thanks to ensureSqliteDir above.
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (url.startsWith('file:')) {
    void client.$queryRawUnsafe('PRAGMA busy_timeout=5000;').catch(() => undefined)
  }
}

export const db =
  globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
