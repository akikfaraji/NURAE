/**
 * NURAE — single authoritative version source.
 *
 * FRAZIYM versioning format: VPP.FF.BBB-STAGE-RR
 *   PP  — Platform generation   (V00, V01, ...)
 *   FF  — Feature version       (00, 01, ...)
 *   BBB — Bug-fix version       (000, 001, ...)
 *   STAGE — -alpha | -beta | -rc (omitted for stable)
 *   RR  — Pre-release revision  (01, 02, ...)
 *
 * Every component (dashboard, API, CLI, logs, startup messages, health
 * endpoint, release metadata) MUST obtain the version from this module.
 * Do not duplicate hard-coded version strings elsewhere.
 */

export const NURAE_NAME = 'NURAE';
export const NURAE_VENDOR = 'FRAZIYM TECH & AI';
export const NURAE_TAGLINE = 'Autonomous Digital Operations System';

export const NURAE_VERSION = 'V00.01.001-beta-03';

/** Structured representation of the FRAZIYM version format. */
export interface FraziymVersion {
  platformGeneration: string; // "00"
  feature: string; // "00"
  bugfix: string; // "000"
  stage: 'alpha' | 'beta' | 'rc' | null; // null for stable
  revision: string | null; // "01"
  stable: boolean;
  raw: string;
}

/**
 * Parse a FRAZIYM version string.
 * Examples:
 *   V00.00.000-beta-01
 *   V01.02.004          (stable)
 */
export function parseFraziymVersion(version: string): FraziymVersion {
  const pre = /^V(\d{2})\.(\d{2})\.(\d{3})-(alpha|beta|rc)-(\d{2})$/.exec(version);
  if (pre) {
    return {
      platformGeneration: pre[1],
      feature: pre[2],
      bugfix: pre[3],
      stage: pre[4] as 'alpha' | 'beta' | 'rc',
      revision: pre[5],
      stable: false,
      raw: version,
    };
  }

  const stable = /^V(\d{2})\.(\d{2})\.(\d{3})$/.exec(version);
  if (stable) {
    return {
      platformGeneration: stable[1],
      feature: stable[2],
      bugfix: stable[3],
      stage: null,
      revision: null,
      stable: true,
      raw: version,
    };
  }

  throw new Error(`Invalid FRAZIYM version string: "${version}"`);
}

/** Multi-line startup banner. */
export function startupBanner(): string {
  return [`${NURAE_NAME} ${NURAE_VERSION}`, NURAE_VENDOR, NURAE_TAGLINE].join('\n');
}

/** One-line identity string, e.g. "NURAE V00.01.000-beta-02 | FRAZIYM TECH & AI". */
export function identityLine(): string {
  return `${NURAE_NAME} ${NURAE_VERSION} | ${NURAE_VENDOR}`;
}
