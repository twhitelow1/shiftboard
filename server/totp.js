// Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP): SHA-1, 6 digits, 30-second steps, the
// step before and after accepted for clock drift. Plain node:crypto, no dependency. Authenticator apps
// (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) all use these settings.
import crypto from 'node:crypto';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (what otpauth:// secrets use). */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, RFC 4226's recommendation), base32. */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** The 30-second step a time (ms) falls in. */
export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

/** HOTP: the 6-digit code for a counter. */
export function hotp(secret, counter) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a time (ms). */
export const totpAt = (secret, ms) => hotp(secret, stepAt(ms));

/**
 * Check a code: the step it matches (now, one before or one after), or null. A step at or before
 * `afterStep` (the last one used) doesn't count, so the same code never works twice.
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1, afterStep = -1 } = {}) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret);
  const cur = stepAt(now);
  let found = null;
  for (let d = -window; d <= window; d++) {
    const step = cur + d;
    const want = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(want, Buffer.from(c)) && step > afterStep && found === null) found = step;
  }
  return found;
}

/** The otpauth:// address the QR code holds: otpauth://totp/Issuer:account?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30 */
export function otpauthUrl({ secret, account, issuer = 'ShiftBoard' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // encodeURIComponent, not URLSearchParams: apps read "+" as a plus sign, not a space.
  const q = Object.entries({ secret, issuer, algorithm: 'SHA1', digits: DIGITS, period: STEP_SECONDS })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return `otpauth://totp/${label}?${q}`;
}
