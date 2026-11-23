// Encrypting small secrets at rest in a restaurant's documents (authenticator app secrets).
//
// Uses the platform's AES-256-GCM helper (server/platform/secrets.js) with PLATFORM_ENCRYPTION_KEY. A
// single-restaurant install without that key uses a key derived with HKDF from the session signing secret
// (JWT_SECRET, or the one kept in the database). Values say which key they were made with:
//   "k1.<v1 blob>"  PLATFORM_ENCRYPTION_KEY
//   "s1.<v1 blob>"  HKDF(session secret)
// so adding PLATFORM_ENCRYPTION_KEY later keeps older secrets readable. The context (restaurant schema,
// purpose and user) is bound in as additional data, so a value copied to another person or restaurant
// doesn't decrypt. Losing or changing the key means people set up their authenticator app again
// (a manager resets their two-step sign-in in Team).
import crypto from 'node:crypto';
import { encryptionKey, encrypt, decrypt } from './platform/secrets.js';

/**
 * @param {object} o
 * @param {object} o.env               PLATFORM_ENCRYPTION_KEY
 * @param {() => string} o.sessionSecret  the signing secret (once the app is ready)
 * @param {string} o.scope              the restaurant's schema, bound into every value
 */
export function createSecretBox({ env, sessionSecret, scope }) {
  let platformKey = null;
  try { platformKey = encryptionKey(env); } catch (e) { console.error(`${e.message}. Two-step secrets use the session-derived key instead.`); }
  const derived = () => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(sessionSecret())), Buffer.from('shiftboard-secret-box'), Buffer.from(`totp:${scope}`), 32));
  const ctx = (context) => `${scope}:${context}`;
  return {
    /** Which key new values use ('platform' or 'session'), for docs and tests. */
    kind: platformKey ? 'platform' : 'session',
    seal(plaintext, context) {
      return platformKey ? `k1.${encrypt(platformKey, plaintext, ctx(context))}` : `s1.${encrypt(derived(), plaintext, ctx(context))}`;
    },
    open(value, context) {
      const s = String(value || '');
      if (s.startsWith('k1.')) {
        if (!platformKey) throw new Error('PLATFORM_ENCRYPTION_KEY is not set');
        return decrypt(platformKey, s.slice(3), ctx(context));
      }
      if (s.startsWith('s1.')) return decrypt(derived(), s.slice(3), ctx(context));
      throw new Error('Not a sealed value');
    },
  };
}
