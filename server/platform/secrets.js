// Per-restaurant secrets (a Toast client secret, for example), encrypted at rest with AES-256-GCM.
//
// The key comes from PLATFORM_ENCRYPTION_KEY: 32 random bytes as base64 or hex
// (`openssl rand -base64 32`). Each value gets a fresh 12-byte IV, and the restaurant's id and the
// setting's name are bound in as additional data, so a ciphertext copied to another restaurant or
// another setting doesn't decrypt. Stored as "v1.<iv>.<tag>.<ciphertext>" (base64url).
//
// Secrets are never sent to the browser: the platform console shows "set / not set" and the last 4
// characters. Losing the key means re-entering the secrets (nothing else depends on it).
import crypto from 'node:crypto';

/** The 32-byte key from env, or null when it isn't set. Throws when it's set but isn't 32 bytes. */
export function encryptionKey(env = process.env) {
  const raw = String(env.PLATFORM_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('PLATFORM_ENCRYPTION_KEY must be 32 bytes, base64 or hex (openssl rand -base64 32)');
  return buf;
}

const b64 = (b) => b.toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

/** Encrypt text. `context` (e.g. "<tenantId>:TOAST_CLIENT_SECRET") must be the same to decrypt. */
export function encrypt(key, plaintext, context) {
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

/** Decrypt what encrypt() made. Throws if the key, the context or the data is wrong. */
export function decrypt(key, blob, context) {
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is not set');
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('Not an encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(iv));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(unb64(tag));
  return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString('utf8');
}

/** What the console may show about a secret. */
export const lastFour = (value) => {
  const s = String(value || '');
  return s.length > 8 ? s.slice(-4) : '';
};
