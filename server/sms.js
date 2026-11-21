// Text messages through Twilio's REST API (plain fetch, no SDK).
//
// Optional: without TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender (TWILIO_MESSAGING_SERVICE_SID
// or TWILIO_FROM_NUMBER) nothing is texted. Texts go out after the database commit, like email.
import crypto from 'node:crypto';

const API = 'https://api.twilio.com/2010-04-01';

/** Twilio's error code for a number that replied STOP (it won't deliver to it). */
export const UNSUBSCRIBED = 21610;

export function createTexter(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const sid = env.TWILIO_ACCOUNT_SID || '';
  const token = env.TWILIO_AUTH_TOKEN || '';
  const service = env.TWILIO_MESSAGING_SERVICE_SID || '';
  const from = env.TWILIO_FROM_NUMBER || '';
  const enabled = !!(sid && token && (service || from));

  return {
    enabled,
    /** The number texts come from, for Settings (a Messaging Service may use several). */
    from: enabled ? (service ? '' : from) : '',
    /** Send one text. Resolves Twilio's { sid, status }; rejects with Twilio's message and code. */
    async send(to, body) {
      if (!enabled) throw new Error('Text messages are not set up (TWILIO_* settings)');
      const form = new URLSearchParams({ To: to, Body: body });
      // A Messaging Service is what A2P 10DLC registration attaches to, so it wins when both are set.
      if (service) form.set('MessagingServiceSid', service);
      else form.set('From', from);
      const res = await fetchImpl(`${API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(`Twilio ${res.status}${data.code ? ` (${data.code})` : ''}: ${data.message || 'request failed'}`);
        e.status = res.status;
        e.code = data.code;
        throw e;
      }
      return { sid: data.sid, status: data.status };
    },
    /** Did this webhook request really come from Twilio? (X-Twilio-Signature, signed with the auth token) */
    validRequest(signature, urls, params) {
      return !!token && [].concat(urls).filter(Boolean).some((url) => validTwilioSignature(token, signature, url, params));
    },
  };
}

/**
 * Twilio's request signature: HMAC-SHA1 (keyed with the auth token) of the full URL followed by
 * every POST parameter's name and value, sorted by name, in base64.
 */
export function twilioSignature(authToken, url, params = {}) {
  let data = String(url);
  for (const k of Object.keys(params).sort()) {
    for (const v of [].concat(params[k]).map(String).sort()) data += k + v;
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function validTwilioSignature(authToken, signature, url, params) {
  if (!signature || !authToken) return false;
  // Twilio signs the URL as it called it; with and without the default https port both count.
  const u = String(url);
  const variants = new Set([u, u.replace(/^(https:\/\/[^/:?#]+)(?=[/?#]|$)/i, '$1:443'), u.replace(/^(https:\/\/[^/:?#]+):443(?=[/?#]|$)/i, '$1')]);
  const given = Buffer.from(String(signature));
  for (const v of variants) {
    const want = Buffer.from(twilioSignature(authToken, v, params));
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) return true;
  }
  return false;
}
