// Two-step sign-in, the parts that are plain data (shared by the server and the in-browser demo).
// The checking itself (TOTP codes, passkey signatures, recovery code hashes) is server-only: server/auth.js.
//
// Data: every authentication factor lives in its own collection, never on the user document.
//   authFactors  { id, userId, type, createdAt, lastUsedAt?, pending? }
//     type 'totp'        secretEnc (AES-GCM, server/secret-box.js), lastStep (no code is used twice)
//     type 'recovery'    codes: [{ salt, hash, usedAt }] (10 one-time codes, sha256 with a salt each)
//     type 'passkey'     credentialId, publicKey (base64url COSE), counter, transports, name, rpId
//     type 'onboarding'  id onb_<userId>: the invite wizard's progress (pending passwordHash, th, steps done)
//   pending: '<th>'  made during an invite wizard that hasn't finished (th = the invite link's hash, cut);
//                    it counts for nothing until the wizard completes.
//   unconfirmed      an authenticator app set up but not yet confirmed with a code: counts for nothing.
//
// None of this is ever sent to anyone: views below keep names and dates only. passwordHash stays on the
// user document (as before) and is stripped from every view (core/service.js userView).

/** Fields that never leave the server, wherever they turn up. */
export const SECRET_FIELDS = ['passwordHash', 'secretEnc', 'codes', 'publicKey', 'credentialId', 'lastStep', 'counter', 'th'];

/** Does this factor count for signing in? Not the wizard's progress, not one from an unfinished invite wizard, not an unconfirmed app. */
export const isActiveFactor = (f) => f.type !== 'onboarding' && !f.pending && !f.unconfirmed;
/** A person's factors that count for signing in. */
export const activeFactors = (store, userId) => store.list('authFactors', (f) => f.userId === userId && isActiveFactor(f));

/** A sign-in factor as anyone may see it: what it is, its name and dates. */
export function factorView(f) {
  if (f.type === 'passkey') return { id: f.id, type: 'passkey', name: f.name || '', createdAt: f.createdAt, lastUsedAt: f.lastUsedAt || null };
  if (f.type === 'totp') return { id: f.id, type: 'totp', createdAt: f.createdAt, lastUsedAt: f.lastUsedAt || null };
  if (f.type === 'recovery') return { id: f.id, type: 'recovery', createdAt: f.createdAt, left: (f.codes || []).filter((c) => !c.usedAt).length };
  return null;
}

/**
 * Someone's two-step status: { on, totp, passkeys, recoveryLeft }. on: they have a second factor (an
 * authenticator app or a passkey); recovery codes alone don't count.
 */
export function twoStepOf(store, userId) {
  const list = activeFactors(store, userId);
  const totp = list.some((f) => f.type === 'totp');
  const passkeys = list.filter((f) => f.type === 'passkey').length;
  const rec = list.find((f) => f.type === 'recovery');
  return { on: totp || passkeys > 0, totp, passkeys, recoveryLeft: rec ? (rec.codes || []).filter((c) => !c.usedAt).length : 0 };
}

/** Who has two-step on, for a whole list at once (Team). */
export function twoStepMap(store) {
  const on = new Set();
  for (const f of store.list('authFactors', (x) => isActiveFactor(x) && (x.type === 'totp' || x.type === 'passkey'))) on.add(f.userId);
  return on;
}

// ---------- passwords ----------

const COMMON = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd', '1234567890', '12345678910', 'qwertyuiop', 'qwerty1234',
  'iloveyou12', 'shiftboard', 'shiftboard1', 'restaurant', 'letmein123', 'welcome123', 'abcdefghij', '0123456789', '1111111111', 'contraseña', 'contrasena']);
export const PASSWORD_MIN = 10;

/**
 * Why a new password isn't good enough (an English message, translated by core/errors.js), or null.
 * At least 10 characters; not the person's email, name or a common password.
 */
export function passwordProblem(password, { email = '', name = '' } = {}) {
  const pw = String(password ?? '');
  if (pw.length < PASSWORD_MIN) return 'Use at least 10 characters for your password';
  if (pw.length > 200) return 'That password is too long';
  const low = pw.toLowerCase();
  const plain = low.replace(/[^a-z0-9ñ]/g, '');
  if (COMMON.has(low) || COMMON.has(plain) || /^(.)\1+$/.test(pw)) return 'That password is too common. Pick another one.';
  const mail = String(email || '').toLowerCase().trim();
  const local = mail.split('@')[0] || '';
  const parts = [mail, local, ...String(name || '').toLowerCase().split(/\s+/)].map((x) => x.replace(/[^a-z0-9ñ]/g, '')).filter((x) => x.length >= 3);
  if (parts.some((x) => plain.includes(x) && x.length >= Math.min(4, plain.length))) return 'Don’t use your name or email in your password';
  return null;
}
