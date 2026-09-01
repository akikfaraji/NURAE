import { describe, expect, test } from 'bun:test';
import {
  NURAE_NAME,
  NURAE_TAGLINE,
  NURAE_VENDOR,
  NURAE_VERSION,
  identityLine,
  parseFraziymVersion,
  startupBanner,
} from '../../src/lib/nurae/version';

describe('FRAZIYM versioning', () => {
  test('current release has the correct authoritative value', () => {
    expect(NURAE_VERSION).toBe('V00.01.004-beta-03');
    expect(NURAE_NAME).toBe('NURAE');
    expect(NURAE_VENDOR).toBe('FRAZIYM TECH & AI');
  });

  test('parses pre-release versions', () => {
    const v = parseFraziymVersion('V00.00.000-beta-01');
    expect(v.platformGeneration).toBe('00');
    expect(v.feature).toBe('00');
    expect(v.bugfix).toBe('000');
    expect(v.stage).toBe('beta');
    expect(v.revision).toBe('01');
    expect(v.stable).toBe(false);
  });

  test('parses later-stage examples from the spec', () => {
    expect(parseFraziymVersion('V00.01.003-beta-04').feature).toBe('01');
    expect(parseFraziymVersion('V01.00.000-beta-01').platformGeneration).toBe('01');
    expect(parseFraziymVersion('V00.00.001-beta-02').bugfix).toBe('001');
  });

  test('parses stable versions (stage omitted)', () => {
    const v = parseFraziymVersion('V01.02.004');
    expect(v.stable).toBe(true);
    expect(v.stage).toBeNull();
    expect(v.revision).toBeNull();
  });

  test('rejects conventional semver and malformed strings', () => {
    expect(() => parseFraziymVersion('0.1.0')).toThrow();
    expect(() => parseFraziymVersion('1.2.3')).toThrow();
    expect(() => parseFraziymVersion('V1.0.0-beta-1')).toThrow();
    expect(() => parseFraziymVersion('not-a-version')).toThrow();
  });

  test('banner and identity line contain the authoritative version', () => {
    const banner = startupBanner();
    expect(banner).toContain('NURAE V00.01.004-beta-03');
    expect(banner).toContain(NURAE_VENDOR);
    expect(banner).toContain(NURAE_TAGLINE);
    expect(identityLine()).toBe('NURAE V00.01.004-beta-03 | FRAZIYM TECH & AI');
  });
});
