// Signing in for tests, the way people do now: the password, then the second step (server/auth.js).
// The first sign-in sets up an authenticator app (the helper keeps its secret, like a phone would) and
// later ones type its current code. A code works once, so when this 30-second step's code was used
// already the helper takes the next step's (the server accepts ±1 step), then a recovery code.
import { hotp, stepAt } from '../../server/totp.js';

const vault = new Map(); // `${realm}|${email}` → { secret, lastStep, recovery: [codes] }
const key = (realm, email) => `${realm || ''}|${String(email).trim().toLowerCase()}`;

/** What the helper knows about someone's authenticator app (tests that type codes themselves use it). */
export const authenticatorOf = (email, realm = '') => vault.get(key(realm, email)) || null;
/** Remember an app set up outside the helper (e.g. the invitation wizard). */
export const rememberAuthenticator = (email, realm, entry) => vault.set(key(realm, email), { lastStep: -1, recovery: [], ...entry });
export const forgetAuthenticator = (email, realm = '') => vault.delete(key(realm, email));

/** A code for someone's app that hasn't been used yet (marks it used), or null when both usable steps are spent. */
export function nextCode(email, { realm = '', now = Date.now } = {}) {
  const v = vault.get(key(realm, email));
  if (!v) throw new Error(`No authenticator app for ${email}`);
  const cur = stepAt(now());
  for (const step of [cur, cur + 1]) {
    if (step > v.lastStep) { v.lastStep = step; return hotp(v.secret, step); }
  }
  return null;
}

/**
 * Finish a sign-in that answered { mfa }. post(path, body) sends JSON and returns { status, body }.
 * Returns the response that carries the session (cookie, or { token } with client: 'mobile').
 */
export async function secondStep(post, first, { email, realm = '', client, now = Date.now } = {}) {
  if (first.status !== 200 || !first.body?.mfa) return first;
  const { ticket } = first.body;
  const extra = client ? { client } : {};
  if (first.body.mfa === 'enroll') {
    const setup = await post('/api/auth/mfa/totp/setup', { ticket });
    if (setup.status !== 200) return setup;
    const step = stepAt(now());
    const r = await post('/api/auth/mfa/totp/confirm', { ticket, code: hotp(setup.body.secret, step), ...extra });
    if (r.status === 200) vault.set(key(realm, email), { secret: setup.body.secret, lastStep: step, recovery: [...(r.body.recoveryCodes || [])] });
    return r;
  }
  const code = vault.has(key(realm, email)) ? nextCode(email, { realm, now }) : null;
  if (code) return post('/api/auth/mfa/verify', { ticket, method: 'totp', code, ...extra });
  const v = vault.get(key(realm, email));
  const rc = v?.recovery.shift();
  if (!rc) throw new Error(`No way to finish signing in as ${email}`);
  return post('/api/auth/mfa/verify', { ticket, method: 'recovery', code: rc, ...extra });
}

/** A tiny browser for one server: JSON POSTs that keep cookies. */
export function jsonClient(base, fetchImpl = globalThis.fetch) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const post = async (path, body = {}, headers = {}) => {
    const res = await fetchImpl(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jar.size ? { Cookie: cookie() } : {}), ...headers }, body: JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1).trim();
      if (v) jar.set(pair.slice(0, i).trim(), v); else jar.delete(pair.slice(0, i).trim());
    }
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { post, cookie };
}

/** Sign in on a server and return the session cookie ("sb_session=…"). */
export async function cookieFor(base, email, password = 'demo1234', { fetchImpl, realm = '' } = {}) {
  const c = jsonClient(base, fetchImpl);
  const r = await signIn(c.post, email, password, { realm });
  if (r.status !== 200) throw new Error(`sign-in ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return c.cookie();
}

/** Sign in as the phone app does and return the bearer token. */
export async function tokenFor(base, email, password = 'demo1234', { fetchImpl, realm = '' } = {}) {
  const c = jsonClient(base, fetchImpl);
  const r = await signIn(c.post, email, password, { realm, client: 'mobile' });
  if (r.status !== 200 || !r.body?.token) throw new Error(`sign-in ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** Password + second step. Returns the final response ({ status, body }). */
export async function signIn(post, email, password = 'demo1234', opts = {}) {
  const first = await post('/api/auth/login', { email, password, ...(opts.client ? { client: opts.client } : {}) });
  return secondStep(post, first, { email, ...opts });
}

/**
 * Go through the invitation wizard with its link token: password, an authenticator app, recovery codes saved,
 * profile, consent. consent: { terms, sms, email, phone } (terms defaults to true). Returns the final response.
 */
export async function onboard(post, token, { email, realm = '', password = 'a-good-long-passphrase', name, phone, consent = {}, lang, now = Date.now } = {}) {
  const ok = (r, what) => { if (r.status !== 200) throw Object.assign(new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`), { response: r }); return r; };
  const start = ok(await post('/api/onboarding/start', { token }), 'start');
  const who = email || start.body.result.email;
  ok(await post('/api/onboarding/password', { password }), 'password');
  const setup = ok(await post('/api/onboarding/totp/setup', {}), 'totp setup');
  const step = stepAt(now());
  const conf = ok(await post('/api/onboarding/totp/confirm', { code: hotp(setup.body.result.secret, step) }), 'totp confirm');
  vault.set(key(realm, who), { secret: setup.body.result.secret, lastStep: step, recovery: [...conf.body.result.recoveryCodes] });
  ok(await post('/api/onboarding/recovery/ack', { saved: true }), 'recovery ack');
  ok(await post('/api/onboarding/profile', { name: name || start.body.result.name, phone: phone || '' }), 'profile');
  return post('/api/onboarding/complete', { terms: true, ...consent, ...(lang ? { lang } : {}) });
}
