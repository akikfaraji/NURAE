import { afterEach, describe, expect, test } from 'bun:test';
import {
  handleGatewayRegister,
  handleGatewayStatus,
  handleGatewayUnregister,
  verifyBackendHealth,
} from '../../src/lib/gateway/gateway';

/**
 * Unit tests for the Gateway Link registration core. The network and the
 * store are injected/mocked here (standard unit practice); the REAL chain
 * is exercised by the split E2E driver — no mocks there.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.NURAE_GATEWAY_KEY = ORIGINAL.NURAE_GATEWAY_KEY;
});

function withKey(key: string | undefined, fn: () => Promise<unknown> | unknown): Promise<unknown> | unknown {
  if (key === undefined) delete process.env.NURAE_GATEWAY_KEY;
  else process.env.NURAE_GATEWAY_KEY = key;
  return fn();
}

/** Fetch stub returning a health response for the backend, 404 otherwise. */
function healthFetch(health: { status: number; body: unknown } | 'network-error') {
  return (async (url: string | URL | Request) => {
    if (health === 'network-error') throw new Error('ECONNREFUSED');
    const u = new URL(String(url instanceof Request ? url.url : url));
    if (u.pathname === '/api/health') {
      return new Response(JSON.stringify(health.body), { status: health.status });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('gateway registration core', () => {
  test('501 gateway-not-configured when NURAE_GATEWAY_KEY is unset on the frontend', async () => {
    await withKey(undefined, async () => {
      const r = await handleGatewayRegister({ endpoint: 'https://b.example.com', key: 'x' });
      expect(r.status).toBe(501);
      expect(r.body.error).toBe('gateway-not-configured');
    });
  });

  test('401 invalid-gateway-key on wrong or missing key', async () => {
    await withKey('correct-key-123', async () => {
      const wrong = await handleGatewayRegister({ endpoint: 'https://b.example.com', key: 'wrong' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error).toBe('invalid-gateway-key');
      const missing = await handleGatewayRegister({ endpoint: 'https://b.example.com' });
      expect(missing.status).toBe(401);
    });
  });

  test('422 invalid-endpoint for non-HTTPS, invalid URLs and paths', async () => {
    await withKey('k', async () => {
      for (const endpoint of ['http://b.example.com', 'not-a-url', 'https://b.example.com/sub/path', '', undefined]) {
        const r = await handleGatewayRegister({ endpoint, key: 'k' }, { fetchImpl: healthFetch({ status: 200, body: { status: 'ok', version: 'V00.01.001-beta-03' } }) });
        expect(r.status).toBe(422);
        expect(r.body.error).toBe('invalid-endpoint');
      }
    });
  });

  test('502 backend-unhealthy when the endpoint does not answer like NURAE', async () => {
    await withKey('k', async () => {
      const down = await handleGatewayRegister({ endpoint: 'https://b.example.com', key: 'k' }, { fetchImpl: healthFetch('network-error') });
      expect(down.status).toBe(502);
      expect(down.body.error).toBe('backend-unhealthy');

      const wrongStatus = await handleGatewayRegister(
        { endpoint: 'https://b.example.com', key: 'k' },
        { fetchImpl: healthFetch({ status: 200, body: { status: 'degraded', version: 'V00.01.001-beta-03' } }) },
      );
      expect(wrongStatus.status).toBe(502);

      const foreignApp = await handleGatewayRegister(
        { endpoint: 'https://b.example.com', key: 'k' },
        { fetchImpl: healthFetch({ status: 200, body: { status: 'ok', version: '1.2.3' } }) },
      );
      expect(foreignApp.status).toBe(502);
      expect(String(foreignApp.body.message)).toContain('not a NURAE');
    });
  });

  test('timing safety: keys of different length are compared without throw', async () => {
    await withKey('short', async () => {
      const r = await handleGatewayRegister({ endpoint: 'https://b.example.com', key: 'a-very-much-longer-key-that-differs' });
      expect(r.status).toBe(401);
    });
  });

  test('unregister requires the key too', async () => {
    await withKey('k', async () => {
      const r = await handleGatewayUnregister({ key: 'nope' });
      expect(r.status).toBe(401);
    });
  });

  test('status reports gateway mode and never leaks the full endpoint', async () => {
    process.env.NURAE_GATEWAY_KEY = 'k';
    const r = await handleGatewayStatus();
    expect(r.status).toBe(200);
    const body = r.body as { gatewayMode: boolean; linked: boolean; endpoint: string | null };
    expect(body.gatewayMode).toBe(true);
    // store not configured in the unit environment → nothing linked
    expect(body.linked).toBe(false);
    expect(body.endpoint).toBeNull();
  });

  test('success path stores the link; unregister removes it', async () => {
    await withKey('correct-key', async () => {
      const saved: unknown[] = {};
      const memoryStore = {
        read: async () => (saved.link as { endpoint: string } | undefined) ?? null,
        write: async (link: unknown) => {
          saved.link = link;
        },
        remove: async () => {
          delete saved.link;
        },
      };
      const r = await handleGatewayRegister(
        { endpoint: 'https://b.example.com', key: 'correct-key' },
        {
          fetchImpl: healthFetch({ status: 200, body: { status: 'ok', version: 'V00.01.001-beta-03' } }),
          store: memoryStore,
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.linked).toBe(true);
      expect(saved.link).toBeDefined();

      const status = await handleGatewayStatus({ store: memoryStore });
      expect((status.body as { linked: boolean }).linked).toBe(true);
      expect((status.body as { endpoint: string | null }).endpoint).toBe('b.example.com');

      const un = await handleGatewayUnregister({ key: 'correct-key' }, { store: memoryStore });
      expect(un.status).toBe(200);
      const after = await handleGatewayStatus({ store: memoryStore });
      expect((after.body as { linked: boolean }).linked).toBe(false);
    });
  });

  test('health verifier accepts only NURAE V00-series health payloads', async () => {
    const ok = await verifyBackendHealth('https://b.example.com', healthFetch({ status: 200, body: { status: 'ok', version: 'V00.01.001-beta-03' } }));
    expect(ok).toBeNull();
    const bad = await verifyBackendHealth('https://b.example.com', healthFetch({ status: 200, body: { status: 'ok', version: 'V01.00.000' } }));
    expect(bad).toContain('not a NURAE V00-series');
  });
});
