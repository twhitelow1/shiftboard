// Signing in, the second step, passkeys, email links, the invitation wizard and sign-in settings
// (server/auth.js, server/onboarding.js; the contract is in docs/auth.md). Hosted app only: the demo
// signs in without any of this, and its onboarding preview never calls the server.
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { ApiError, IS_DEMO } from './api.js';
import { getLang, translateError } from './i18n/index.js';

async function send(path, body, { method = 'POST' } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || translateError(`Request failed (${res.status})`));
  return data.result ?? data;
}

// ---------- passkeys in this browser ----------
export const passkeysSupported = () => !IS_DEMO && typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();
/** Does this device have a built-in passkey maker (Face ID, fingerprint, Windows Hello)? */
export const devicePasskeyAvailable = async () => { try { return passkeysSupported() && await platformAuthenticatorIsAvailable(); } catch { return false; } };
/** The browser said no (cancelled, timed out, not allowed): not an error worth a red message. */
export const passkeyCancelled = (e) => ['NotAllowedError', 'AbortError'].includes(e?.name) || e?.code === 'ERROR_CEREMONY_ABORTED';

// ---------- signing in ----------
/** Password: { mfa: 'verify', ticket, methods } or { mfa: 'enroll', ticket }. */
export const passwordStep = (email, password) => send('/api/auth/login', { email, password });
export const verifyCode = (ticket, method, code) => send('/api/auth/mfa/verify', { ticket, method, code });
export const totpSetup = (ticket) => send('/api/auth/mfa/totp/setup', ticket ? { ticket } : {});
export const totpConfirm = (ticket, code) => send('/api/auth/mfa/totp/confirm', { ...(ticket ? { ticket } : {}), code });
/** Make a passkey (enroll ticket, or signed in) and save it. */
export async function addPasskey(ticket, name) {
  const { options } = await send('/api/auth/passkey/register/options', ticket ? { ticket } : {});
  const response = await startRegistration({ optionsJSON: options });
  return send('/api/auth/passkey/register/verify', { ...(ticket ? { ticket } : {}), response, ...(name ? { name } : {}) });
}
/** Sign in with a passkey (no password: it counts as both steps). */
export async function passkeySignIn() {
  const { options } = await send('/api/auth/passkey/login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  return send('/api/auth/passkey/login/verify', { response });
}
export const requestLink = (email, code) => send('/api/auth/link', { email, code });
export const consumeLink = (token) => send('/api/auth/link/consume', { token });
export const resetWithToken = (token, password) => send('/api/auth/reset', { token, password });

// ---------- my sign-in settings ----------
export const securityInfo = () => send('/api/auth/security', null, { method: 'GET' });
export const renamePasskey = (id, name) => send('/api/auth/passkey/rename', { id, name });
export const removePasskey = (id) => send('/api/auth/passkey/remove', { id });
export const removeTotp = () => send('/api/auth/mfa/totp/remove', {});
export const newRecoveryCodes = () => send('/api/auth/mfa/recovery/regenerate', {});
/** The second step again, for one action (making yourself Super Admin): a passkey answer to send with it. */
export async function stepUpPasskey() {
  const { options } = await send('/api/auth/step-up/passkey/options', {});
  return startAuthentication({ optionsJSON: options });
}
/** A manager or admin resets someone's second step (they set up a new one at their next sign-in). */
export const resetTwoStep = (userId) => send(`/api/users/${encodeURIComponent(userId)}/reset-2fa`, {});

// ---------- the invitation wizard ----------
export const onboarding = {
  start: (token) => send('/api/onboarding/start', { token }),
  state: () => send('/api/onboarding/state', {}),
  password: (password) => send('/api/onboarding/password', { password }),
  totpSetup: () => send('/api/onboarding/totp/setup', {}),
  totpConfirm: (code) => send('/api/onboarding/totp/confirm', { code }),
  async passkey(name) {
    const { options } = await send('/api/onboarding/passkey/options', {});
    const response = await startRegistration({ optionsJSON: options });
    return send('/api/onboarding/passkey/verify', { response, ...(name ? { name } : {}) });
  },
  regenerate: () => send('/api/onboarding/recovery/regenerate', {}),
  saved: () => send('/api/onboarding/recovery/ack', { saved: true }),
  profile: (name, phone, legal = {}) => send('/api/onboarding/profile', { name, phone, ...legal }), // legal: { legalFirstName, legalLastName }
  photo: (dataUrl) => send('/api/onboarding/photo', dataUrl ? { dataUrl } : { remove: true }),
  complete: (payload) => send('/api/onboarding/complete', payload),
};
