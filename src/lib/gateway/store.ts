/**
 * NURAE Gateway Link — link store (frontend side).
 *
 * Holds the single record "which backend is this frontend linked to".
 * The store is intentionally behind a tiny interface so the backing
 * implementation can be swapped (Vercel Blob today; a database table
 * tomorrow) without touching the gateway routes or the middleware.
 *
 * Backing store: Vercel Blob (`BLOB_READ_WRITE_TOKEN` is injected by the
 * platform when a Blob store is connected to the project). The stored JSON
 * contains NO secrets — only the backend endpoint origin, the link time and
 * the NURAE version that established the link.
 *
 * Reads are cached in-process for 10 s: the middleware consults the link on
 * every /api request and Blob latency would otherwise dominate the proxy hop.
 */

export interface GatewayLink {
  endpoint: string; // backend origin, e.g. "https://xyz.trycloudflare.com"
  linkedAt: string; // ISO timestamp of the accepted registration
  version: string; // NURAE version that established the link
}

const LINK_PATH = 'gateway/backend-link.json';
const CACHE_MS = 10_000;

const globalForGateway = globalThis as unknown as {
  nuraeGatewayCache?: { link: GatewayLink | null; at: number };
};

export function gatewayStoreConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Swappable store contract (tests inject an in-memory implementation). */
export interface GatewayStore {
  read(): Promise<GatewayLink | null>;
  write(link: GatewayLink): Promise<void>;
  remove(): Promise<void>;
}

export const blobStore: GatewayStore = {
  read: readGatewayLink,
  write: writeGatewayLink,
  remove: deleteGatewayLink,
};

function setCache(link: GatewayLink | null): void {
  globalForGateway.nuraeGatewayCache = { link, at: Date.now() };
}

/** Current link, or null when unlinked / store not configured. Never throws. */
export async function readGatewayLink(): Promise<GatewayLink | null> {
  const cached = globalForGateway.nuraeGatewayCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.link;
  if (!gatewayStoreConfigured()) return null;
  try {
    const { get } = await import('@vercel/blob');
    const res = await get(LINK_PATH, { cacheControl: 'no-store' });
    const raw: unknown = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const link = raw as GatewayLink;
    if (!link || typeof link.endpoint !== 'string' || !/^https:\/\//.test(link.endpoint)) {
      setCache(null);
      return null;
    }
    setCache(link);
    return link;
  } catch {
    // Not linked yet (404) or a transient store error — both read as "no link".
    setCache(null);
    return null;
  }
}

/** Persist a fresh link (overwrites the previous one). Throws on store failure. */
export async function writeGatewayLink(link: GatewayLink): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(LINK_PATH, JSON.stringify(link), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
  setCache(link);
}

/** Remove the link (unregister). Throws on store failure. */
export async function deleteGatewayLink(): Promise<void> {
  const { del } = await import('@vercel/blob');
  try {
    await del(LINK_PATH);
  } catch (err) {
    if (!(err instanceof Error && /not found/i.test(err.message))) throw err;
  }
  setCache(null);
}
