/**
 * NURAE — SecretManager.
 *
 * Central secret-handling abstraction. Secrets (Telegram bot tokens, AI API
 * keys) are encrypted at rest with AES-256-GCM and are only decrypted inside
 * the trusted runtime boundary. Secrets are NEVER returned by APIs, never
 * logged (see sanitize.ts), and never hard-coded.
 *
 * Key management:
 *  - Preferred: NURAE_SECRET_KEY environment variable (>= 32 chars recommended).
 *  - Fallback: an auto-generated random key stored in db/.nurae-secret-key
 *    (created with 0600 permissions, git-ignored). This keeps local development
 *    usable without weakening the "no hard-coded credentials" rule.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDataPath } from '@/lib/paths';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  // Resolved against the PROJECT root (never the bare cwd): the standalone
  // production server chdirs into .next/standalone — a cwd-relative key file
  // would fork the master key and make every stored secret undecryptable.
  const dbUrl = process.env.DATABASE_URL?.trim() || 'file:./db/custom.db';
  const dbFile = dbUrl.startsWith('file:') ? dbUrl.slice(5) : './db/custom.db';
  if (!dbFile || dbFile.startsWith(':')) return resolveDataPath(join('db', '.nurae-secret-key'));
  return join(dirname(resolveDataPath(dbFile)), '.nurae-secret-key');
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.NURAE_SECRET_KEY;
  if (envKey && envKey.length >= 16) {
    // 16 chars is the functional floor, but the AES master key inherits the
    // env value's entropy — below 32 chars a brute-force/dictionary attack on
    // the KDF input becomes plausible for high-value deployments. Warn loudly
    // in production; do NOT break existing deployments mid-flight.
    if (envKey.length < 32 && process.env.NODE_ENV === 'production') {
      console.error(
        '[NURAE][security] NURAE_SECRET_KEY is shorter than the recommended 32 characters. ' +
          'Stored secrets (bot tokens, AI keys) are only as strong as this value — rotate it ' +
          'to a long random string (e.g. `openssl rand -base64 32`). Note: rotating invalidates ' +
          'every stored secret and admin session; re-enter bot credentials afterwards.',
      );
    }
    cachedKey = scryptSync(envKey, 'nurae-secret-salt-v1', KEY_BYTES);
    return cachedKey;
  }

  const path = keyFilePath();
  // turbopackIgnore: the key path is intentionally runtime-dynamic (data dir
  // beside the DB); opting out stops Turbopack from tracing the whole project
  // into the standalone bundle over these two calls.
  if (existsSync(/*turbopackIgnore: true*/ path)) {
    const raw = readFileSync(/*turbopackIgnore: true*/ path, 'utf8').trim();
    if (raw.length < 32) {
      throw new Error('NURAE secret key file is corrupted (too short).');
    }
    cachedKey = scryptSync(raw, 'nurae-secret-salt-v1', KEY_BYTES);
    return cachedKey;
  }

  // Generate a fresh random key file.
  const raw = randomBytes(48).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  cachedKey = scryptSync(raw, 'nurae-secret-salt-v1', KEY_BYTES);
  return cachedKey;
}

/** Encrypt a plaintext secret. Returns "v1:<iv>:<ciphertext>:<tag>" (base64url parts). */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), enc.toString('base64url'), tag.toString('base64url')].join(':');
}

/** Decrypt a secret produced by encryptSecret. Throws if tampered or key mismatch. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid secret payload format.');
  }
  const [, ivB64, dataB64, tagB64] = parts;
  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * True when the string looks like an encrypted secret payload.
 */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith('v1:');
}

/**
 * True when the stored secret ref decrypts cleanly with the current master
 * key. Absent refs are vacuously readable. Used to decide whether a stored
 * credential can actually be used (runtime silently falls back to .env when
 * it cannot) and to warn owners that re-entry is required when it cannot.
 */
export function secretReadable(ref: string | null | undefined): boolean {
  if (!ref) return true;
  try {
    decryptSecret(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when ANY of the given stored secret refs exists but can no longer be
 * decrypted with the current master key (NURAE_SECRET_KEY rotated, or the
 * database/key-file path moved). Dashboards use this to tell an owner
 * "re-enter your credentials" instead of showing a configured-but-dead bot.
 */
export function storedSecretsUnreadable(...refs: Array<string | null | undefined>): boolean {
  return refs.some((ref) => !secretReadable(ref));
}

export const SecretManager = {
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  isEncrypted: isEncryptedSecret,
};
