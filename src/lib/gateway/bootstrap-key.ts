/**
 * NURAE Gateway Link — TEMPORARY bootstrap key.
 *
 * ⚠️ HARDCODED AT THE USER'S EXPLICIT REQUEST, FOR THE FIRST GATEWAY E2E
 * CHECK ONLY (beta-03). This repository is PUBLIC, so treat this key as
 * PUBLIC KNOWLEDGE: anyone who sees it can link a hostile backend to a
 * gateway-mode frontend and intercept the traffic that flows through it.
 *
 * REMOVE / ROTATE as soon as the check is done:
 *   1. Set the real NURAE_GATEWAY_KEY env var on the Vercel project
 *      (it ALWAYS wins over this fallback) and as the GATEWAY_KEY secret.
 *   2. Delete the fallback constant (search: NURAE_GATEWAY_KEY_FALLBACK).
 *
 * The fallback only activates on Vercel's runtime (process.env.VERCEL),
 * never in local dev or on the Actions backend, so single-process mode
 * and the workflow path keep their existing behavior.
 */

export const NURAE_GATEWAY_KEY_FALLBACK = 'nurae-f&bc_0U24KN802q0CATd8f9YwX1Pde8aj';

/**
 * The key this deployment actually uses: an explicitly configured env var
 * always wins; the hardcoded bootstrap fallback applies only on Vercel.
 */
export function effectiveGatewayKey(): string {
  return (
    process.env.NURAE_GATEWAY_KEY?.trim() ||
    (process.env.VERCEL ? NURAE_GATEWAY_KEY_FALLBACK : '')
  );
}
