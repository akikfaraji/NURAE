/**
 * NURAE — SSRF guard for user-supplied AI endpoint URLs.
 *
 * Customers may point their bots at any OpenAI-compatible gateway. Without a
 * guard, that is a textbook SSRF: a verified user could aim their bot at
 * cloud metadata (169.254.169.254), container-internal admin surfaces, or
 * scan the private network, using the platform's server as the request
 * origin (and its fetch-error text as a response oracle).
 *
 * Policy:
 *  - Only http/https are allowed (no file:, gopher:, data:, …).
 *  - Loopback (localhost / 127.0.0.0/8 / ::1) stays ALLOWED: pointing a bot
 *    at a local Ollama / LM Studio is a first-class self-hosted feature.
 *  - All OTHER private / reserved ranges are blocked by default:
 *    link-local (incl. cloud metadata), RFC1918, CGNAT, 0.0.0.0, broadcast,
 *    documentation ranges, IPv4-mapped IPv6, unique-local, link-local v6.
 *    An operator who actually runs models on their LAN can re-enable them
 *    explicitly with NURAE_ALLOW_PRIVATE_AI_URLS=1.
 *  - Hostnames are resolved (all addresses) and EVERY resolved address must
 *    pass — a name that resolves to both a public and a private IP is
 *    rejected. If resolution itself fails, the guard FAILS CLOSED: a host it
 *    could not verify must not be fetched, because the fetch would resolve
 *    DNS itself and might land on an address the guard never saw. DNS-fail
 *    verdicts use a short TTL so a recovered resolver is picked up quickly.
 *
 * Injection point: OpenAICompatibleProvider.requestOnce() — the single fetch
 * chokepoint used by generate(), stream() and validateCredentials().
 */

import { isIP } from 'node:net';
import dns from 'node:dns/promises';
import { AIError } from './types';

type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const DEFAULT_LOOKUP: LookupFn = (hostname) => dns.lookup(hostname, { all: true });

/**
 * Small TTL cache for guard verdicts. Bot conversations trigger an AI fetch
 * per message; without a cache every message pays a DNS round-trip. Verdicts
 * are per-hostname (not per-URL) and short-lived. DNS-failure verdicts are
 * cached too (an offline host would otherwise pay a resolver timeout on every
 * message) — but with a much shorter TTL, so the block never outlives the
 * outage by long.
 */
const VERDICT_TTL_MS = 60_000;
const DNS_FAIL_TTL_MS = 10_000;
const verdictCache = new Map<string, { verdict: 'pass' | 'block'; reason?: string; at: number }>();

function cachedVerdict(host: string): { verdict: 'pass' | 'block'; reason?: string } | null {
  const hit = verdictCache.get(host);
  if (!hit) return null;
  const ttl = hit.verdict === 'block' ? DNS_FAIL_TTL_MS : VERDICT_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    verdictCache.delete(host);
    return null;
  }
  return { verdict: hit.verdict, reason: hit.reason };
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (ipv4ToInt(base) & mask);
}

/** IPv4 ranges that must never be reachable through a user-supplied URL. */
function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return (
    inCidr(n, '0.0.0.0', 8) || // "this host" / default route
    inCidr(n, '10.0.0.0', 8) || // RFC1918
    inCidr(n, '100.64.0.0', 10) || // CGNAT (carrier/Tailscale-style)
    inCidr(n, '127.0.0.0', 8) || // loopback
    inCidr(n, '169.254.0.0', 16) || // link-local (cloud metadata lives here)
    inCidr(n, '172.16.0.0', 12) || // RFC1918
    inCidr(n, '192.0.0.0', 24) || // IETF protocol assignments
    inCidr(n, '192.0.2.0', 24) || // TEST-NET-1 (documentation)
    inCidr(n, '192.88.99.0', 24) || // 6to4 relay anycast (deprecated)
    inCidr(n, '192.168.0.0', 16) || // RFC1918
    inCidr(n, '198.18.0.0', 15) || // benchmarking
    inCidr(n, '198.51.100.0', 24) || // TEST-NET-2 (documentation)
    inCidr(n, '203.0.113.0', 24) || // TEST-NET-3 (documentation)
    inCidr(n, '224.0.0.0', 4) || // multicast
    inCidr(n, '240.0.0.0', 4) // reserved / broadcast
  );
}

function isLoopbackIPv4(ip: string): boolean {
  return inCidr(ipv4ToInt(ip), '127.0.0.0', 8);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/%.*$/, ''); // strip zone id
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  if (lower.startsWith('2001:db8:')) return true; // documentation
  return false;
}

function isLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/%.*$/, '');
  if (lower === '::1') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isLoopbackIPv4(mapped[1]);
  return false;
}

export interface GuardOptions {
  /** Injectable DNS lookup (tests). */
  lookup?: LookupFn;
  /** Injectable clock-free override for the private-range opt-in (tests). */
  allowPrivate?: boolean;
}

function classifyAddress(ip: string): 'loopback' | 'linklocal' | 'private' | 'public' {
  const v = isIP(ip);
  if (v === 4) {
    if (isLoopbackIPv4(ip)) return 'loopback';
    if (inCidr(ipv4ToInt(ip), '169.254.0.0', 16)) return 'linklocal'; // cloud metadata lives here
    return isPrivateIPv4(ip) ? 'private' : 'public';
  }
  if (v === 6) {
    if (isLoopbackIPv6(ip)) return 'loopback';
    const lower = ip.toLowerCase().replace(/%.*$/, '');
    if (/^fe[89ab]/.test(lower)) return 'linklocal';
    return isPrivateIPv6(ip) ? 'private' : 'public';
  }
  return 'private'; // unparseable → fail closed
}

/**
 * Validate an AI endpoint URL. Returns the normalized origin+path string on
 * success; throws AIError('policy_blocked') when the URL must not be fetched.
 */
export async function assertSafeAiUrl(rawUrl: string, opts: GuardOptions = {}): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AIError('policy_blocked', 'AI endpoint URL is not a valid absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AIError('policy_blocked', `AI endpoint scheme "${url.protocol.replace(/:$/, '')}" is not allowed (use http/https)`);
  }

  const host = url.hostname.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  const allowPrivate = opts.allowPrivate ?? process.env.NURAE_ALLOW_PRIVATE_AI_URLS === '1';

  const check = (ip: string): void => {
    const kind = classifyAddress(ip);
    if (kind === 'public') return;
    if (kind === 'loopback') return; // local-model feature: Ollama/LM Studio
    if (kind === 'linklocal') {
      // Link-local (169.254.x incl. cloud metadata endpoints) is NEVER
      // allowed — no operator use case exists, only credential theft.
      throw new AIError(
        'policy_blocked',
        `AI endpoint host "${url.hostname}" resolves to a link-local address (cloud metadata range) and is blocked by policy`,
      );
    }
    if (allowPrivate) return; // explicit opt-in for LAN model servers
    throw new AIError(
      'policy_blocked',
      `AI endpoint host "${url.hostname}" resolves to a private/reserved address and is blocked by policy (operators may set NURAE_ALLOW_PRIVATE_AI_URLS=1 for LAN model servers)`,
    );
  };

  // IP literal → judge directly, no DNS round-trip.
  if (isIP(host)) {
    check(host);
    return url.toString();
  }

  // Loopback by name — no DNS needed.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return url.toString();
  }

  // Hostname → resolve and judge EVERY address (DNS-rebind resistant), with a
  // short-lived verdict cache so per-message bot chats don't pay DNS each time.
  const cached = cachedVerdict(host);
  if (cached) {
    if (cached.verdict === 'pass') return url.toString();
    throw new AIError('policy_blocked', cached.reason ?? 'AI endpoint blocked by security policy');
  }

  const lookup = opts.lookup ?? DEFAULT_LOOKUP;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    // Fail CLOSED: if the guard cannot resolve the host, the fetch would
    // resolve DNS itself and could connect to an address the guard never
    // judged. Surface as policy (fetch would fail anyway during a real DNS
    // outage); short-cached so recovery is picked up within seconds.
    const detail = err instanceof Error ? err.message : String(err);
    const reason = `AI endpoint host "${host}" could not be resolved, so its addresses cannot be safety-verified (${detail})`;
    verdictCache.set(host, { verdict: 'block', reason, at: Date.now() });
    throw new AIError('policy_blocked', reason);
  }
  if (!addresses || addresses.length === 0) {
    const reason = `AI endpoint host "${host}" did not resolve to any address, so it cannot be safety-verified`;
    verdictCache.set(host, { verdict: 'block', reason, at: Date.now() });
    throw new AIError('policy_blocked', reason);
  }
  try {
    for (const { address } of addresses) check(address);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'AI endpoint blocked by security policy';
    verdictCache.set(host, { verdict: 'block', reason, at: Date.now() });
    throw err;
  }
  verdictCache.set(host, { verdict: 'pass', at: Date.now() });
  return url.toString();
}
