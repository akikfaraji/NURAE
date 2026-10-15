/**
 * NURAE Gateway Link — gateway key resolution.
 *
 * Security model: the gateway key authorizes a backend to REGISTER itself as
 * the API target of a frontend deployment. Because the frontend then forwards
 * every /api/* request (including auth cookies and Bearer headers) to that
 * backend, the key is as sensitive as every credential that flows through.
 *
 * Fail-closed rule (hardened): the key comes ONLY from the explicitly
 * configured NURAE_GATEWAY_KEY env var. There is deliberately NO hardcoded
 * fallback — an earlier bootstrap constant lived in this public repository,
 * which meant anyone could have linked a hostile backend and intercepted all
 * traffic. When the env var is unset, gateway mode is simply off (the proxy
 * is a pass-through and /api/gateway/register answers 501) — never "open
 * with a public key".
 */

export function effectiveGatewayKey(): string {
  return process.env.NURAE_GATEWAY_KEY?.trim() || '';
}
