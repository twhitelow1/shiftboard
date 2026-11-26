// One restaurant's API on a fresh embedded database, with stand-ins for Resend and Twilio that record
// what would have been sent (no network).
import { once } from 'node:events';
import { DocDb } from '../../server/db.js';
import { openPglite } from '../../server/pglite.js';
import { createApp } from '../../server/app.js';
import { createMailer } from '../../server/email.js';
import { createTexter } from '../../server/sms.js';
import { fakeResend } from './fake-resend.js';

export const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test-auth-token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest' };

/** Twilio's Messages API: records each text. */
export function fakeTwilio() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return { ok: true, status: 201, json: async () => ({ sid: `SM${calls.length}`, status: 'queued' }) };
  };
  return { calls, fetchImpl, texts: () => calls.map((c) => c.form) };
}

/**
 * @param {object} o
 * @param {object} [o.env]     extra env (SEED_DEMO is on)
 * @param {boolean} [o.email]  Resend set up (default true)
 * @param {boolean} [o.sms]    Twilio set up (default true)
 * @param {Function} [o.now]   the app's clock (ms)
 * @param {object} [o.tenant]  a platform tenant context (plan features), as server/platform/ passes it
 * @param {Function} [o.aiClient]  ({ apiKey }) => an Anthropic client (test/helpers/fake-anthropic.js)
 * @param {object} [o.reviewClients]  fake Google / Yelp / AI clients (server/app.js reviewClients)
 */
export async function startApp({ env = {}, email = true, sms = true, now, tenant, aiClient, reviewClients } = {}) {
  const conn = await openPglite();
  const db = new DocDb(conn);
  const resend = fakeResend();
  const twilio = fakeTwilio();
  const fullEnv = { SEED_DEMO: 'true', EXPO_PUSH: 'off', ...(sms ? TWILIO_ENV : {}), ...env };
  const mailer = createMailer(email ? { RESEND_API_KEY: 're_test', EMAIL_FROM: 'ShiftBoard <schedule@rabbits.example>' } : {}, { fetchImpl: resend.fetchImpl });
  const texter = createTexter(fullEnv, { fetchImpl: twilio.fetchImpl });
  const app = createApp({ db, env: fullEnv, mailer, texter, ...(now ? { now } : {}), ...(tenant ? { tenant } : {}), ...(aiClient ? { aiClient } : {}), ...(reviewClients ? { reviewClients } : {}) });
  await app.locals.ready();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, db, conn, base, resend, twilio,
    settled: () => app.locals.settled(),
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await conn.end(); },
  };
}
