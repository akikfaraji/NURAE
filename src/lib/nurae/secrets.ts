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

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  const dbUrl = process.env.DATABASE_URL || 'file:./db/custom.db';
  const dbFile = dbUrl.startsWith('file:') ? dbUrl.slice(5) : './db/custom.db';
  const dir = dirname(dbFile.startsWith('/') ? dbFile : join(process.cwd(), dbFile));
  return join(dir, '.nurae-secret-key');
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.NURAE_SECRET_KEY;
  if (envKey && envKey.length >= 16) {
    cachedKey = scryptSync(envKey, 'nurae-secret-salt-v1', KEY_BYTES);
    return cachedKey;
  }

  const path = keyFilePath();
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
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

/** True when the string looks like an encrypted secret payload. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith('v1:');
}

export const SecretManager = {
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  isEncrypted: isEncryptedSecret,
};
