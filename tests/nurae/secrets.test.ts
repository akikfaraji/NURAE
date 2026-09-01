import { describe, expect, test } from 'vitest';
import { SecretManager } from '../../src/lib/nurae/secrets';
import { sanitizeForLog, truncateForLog } from '../../src/lib/nurae/sanitize';

describe('SecretManager (AES-256-GCM vault)', () => {
  test('encrypt → decrypt roundtrip preserves plaintext', () => {
    const secret = '1234567890:AAHkQpTzW9xExampleTokenDoNotUse12345';
    const enc = SecretManager.encrypt(secret);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain(secret);
    expect(SecretManager.decrypt(enc)).toBe(secret);
  });

  test('ciphertext is randomized (fresh IV per call)', () => {
    const a = SecretManager.encrypt('same-value');
    const b = SecretManager.encrypt('same-value');
    expect(a).not.toBe(b);
    expect(SecretManager.decrypt(a)).toBe('same-value');
    expect(SecretManager.decrypt(b)).toBe('same-value');
  });

  test('tampered ciphertext throws (auth tag mismatch)', () => {
    const enc = SecretManager.encrypt('sensitive');
    const parts = enc.split(':');
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'BB' : 'AA');
    expect(() => SecretManager.decrypt(parts.join(':'))).toThrow();
  });

  test('wrong payload format is rejected', () => {
    expect(() => SecretManager.decrypt('plaintext-junk')).toThrow();
  });
});

describe('log sanitizer', () => {
  test('redacts Telegram bot tokens', () => {
    const msg = 'Bot started with token 1234567890:AAHx9kQmZtE1vXyZ2aB3cD4eF5gH6iJ7kL8mnO before polling';
    const clean = sanitizeForLog(msg);
    expect(clean).toContain('[REDACTED]');
    expect(clean).not.toContain('AAHx9kQmZtE1vXyZ');
  });

  test('redacts OpenAI-style keys and Bearer headers', () => {
    expect(sanitizeForLog('using key sk-proj-abcdef1234567890abcdef')).toContain('[REDACTED]');
    expect(sanitizeForLog('Authorization: Bearer abc123def456ghi789')).toContain('[REDACTED]');
  });

  test('redacts key=value assignments and URL query credentials', () => {
    expect(sanitizeForLog('api_key=supersecretvalue123')).toContain('[REDACTED]');
    expect(sanitizeForLog('https://api.example.com/data?token=abc123&x=1')).toContain('[REDACTED]');
  });

  test('strips control characters and truncates long messages', () => {
    expect(sanitizeForLog('line1\nline2\u0000Injected')).toContain('Injected');
    const long = 'x'.repeat(5000);
    const out = truncateForLog(long, 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('truncated');
  });

  test('leaves ordinary messages untouched', () => {
    const msg = 'User asked about pricing; assistant replied.';
    expect(sanitizeForLog(msg)).toBe(msg);
  });
});
