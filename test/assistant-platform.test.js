// Ask ShiftBoard on the multi-restaurant platform: usage tied to the restaurant (the platform's ledger, tagged),
// the plan decides who has it, DubLow sets a restaurant's cap in the console, and a restaurant's own Anthropic key
// (Settings → Integrations, encrypted) is used and metered, but not capped. Fake Anthropic client, PGlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { openPglite } from '../server/pglite.js';
import { createMailer } from '../server/email.js';
import { createPlatformApp } from '../server/platform/index.js';
import { fakeResend } from './helpers/fake-resend.js';
import { hostClient } from './helpers/hosts.js';
import { onboard } from './helpers/signin.js';
import { fakeAnthropic, text } from './helpers/fake-anthropic.js';
import { monthOf } from '../server/ai/usage.js';

const PLATFORM_KEY = 'sk-ant-test-platform-placeholder-1111'; // placeholders: the fake client sends nothing anywhere
const OWN_KEY = 'sk-ant-test-restaurant-own-placeholder-2222';
const ENV = {
  PLATFORM_DOMAIN: 'lvh.test', PLATFORM_ADMIN_EMAIL: 'ops@dublow.test', PLATFORM_ADMIN_PASSWORD: 'console-password-1',
  PLATFORM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), JWT_SECRET: 'shared-platform-secret', SEED_DEMO: 'true', EXPO_PUSH: 'off',
  RESEND_API_KEY: 're_test_placeholder', PLATFORM_EMAIL_FROM: 'ShiftBoard <schedule@mail.dublow.test>', ANTHROPIC_API_KEY: PLATFORM_KEY,
};

test('platform: usage is tied to the restaurant; the console sets the cap; a restaurant’s own key is metered, not capped', async () => {
  const conn = await openPglite();
  const resend = fakeResend();
  const fake = fakeAnthropic();
  const app = createPlatformApp({ conn, env: ENV, mailerFor: (e) => createMailer(e, { fetchImpl: resend.fetchImpl }), aiClient: fake.factory });
  await app.locals.warmDefault();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const admin = hostClient(port, 'admin.lvh.test');
    const login = await admin.post('/api/platform/login', { email: 'ops@dublow.test', password: 'console-password-1' });
    assert.equal(login.status, 200, login.text);
    if (login.body.result?.mustChange) await admin.post('/api/platform/password', { password: 'console-password-1' });
    const open = async (slug, plan) => {
      const r = await admin.post('/api/platform/tenants', { name: `${slug} Test`, slug, plan, ownerName: 'Pat Owner', ownerEmail: `owner@${slug}.local` });
      assert.equal(r.status, 200, r.text);
      const mail = resend.emails().filter((m) => m.to.includes(`owner@${slug}.local`)).at(-1);
      const token = /#\/welcome\?token=([\w-]+)/.exec(mail.text)[1];
      const c = hostClient(port, `${slug}.lvh.test`);
      const done = await onboard((path, body) => c.post(path, body), token, { password: 'bright-kitchen-77', realm: slug });
      assert.equal(done.status, 200, done.text);
      return { tenant: r.body.result.tenant, c };
    };
    const bistro = await open('bistro', 'pro');
    const corner = await open('corner', 'starter');
    const ask = (c, message) => c.post('/api/assistant', { message, stream: false });

    // Starter: not in the plan.
    assert.equal((await corner.c.get('/api/assistant')).body.result.reason, 'plan');
    assert.equal((await ask(corner.c, 'Hi')).status, 403);
    assert.equal((await corner.c.rpc('app.bootstrap')).body.result.features.assistant, false);

    // Pro: on DubLow's key, recorded in the platform's ledger under this restaurant.
    assert.equal((await bistro.c.rpc('app.bootstrap')).body.result.features.assistant, true);
    fake.reply(text('Hello from Bistro', { input_tokens: 5000, output_tokens: 200 }));
    const first = await ask(bistro.c, 'Hi');
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.result.message.text, 'Hello from Bistro');
    assert.deepEqual(fake.keys, ['…1111'], 'DubLow’s key');
    const rows = (await conn.query('SELECT tenant_id, purpose, billed_to, cost_usd FROM platform.ai_usage')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, bistro.tenant.id);
    assert.equal(rows[0].billed_to, 'platform');
    const list = (await admin.get('/api/platform/tenants')).body.result;
    const row = list.find((t) => t.id === bistro.tenant.id);
    assert.equal(row.ai.capUsd, 5);
    assert.ok(row.ai.usedUsd > 0);
    assert.equal(row.ai.month, monthOf(Date.now()));
    assert.equal(list.find((t) => t.id === corner.tenant.id).ai.inPlan, false);

    // DubLow sets this restaurant's cap to $0: the assistant says so, kindly, and nothing is sent.
    const capped = await admin.patch(`/api/platform/tenants/${bistro.tenant.id}`, { aiCapUsd: 0 });
    assert.equal(capped.status, 200, capped.text);
    assert.equal(capped.body.result.ai.capUsd, 0);
    assert.equal(capped.body.result.ai.override, 0);
    assert.ok(capped.body.result.audit.some((a) => a.action === 'tenant.update' && a.details.ai));
    assert.equal((await admin.patch(`/api/platform/tenants/${bistro.tenant.id}`, { aiCapUsd: -3 })).status, 400);
    const calls = fake.calls.length;
    const stopped = await ask(bistro.c, 'Who’s working tonight?');
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.result.message.notice, 'cap');
    assert.equal(fake.calls.length, calls);
    const settings = (await bistro.c.get('/api/assistant/settings')).body.result;
    assert.equal(settings.usage.capUsd, 0);
    assert.equal(settings.reason, 'cap');

    // The restaurant brings its own key (Settings → Integrations, by its own admin): used, metered as its own, not capped.
    const saved = await bistro.c.put('/api/integrations', { ANTHROPIC_OWN_API_KEY: OWN_KEY });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await bistro.c.put('/api/integrations', { ANTHROPIC_OWN_API_KEY: 'not-a-key' })).status, 400);
    const view = (await bistro.c.get('/api/integrations')).body.result;
    const anthropic = view.groups.find((g) => g.key === 'anthropic');
    assert.equal(anthropic.status, 'connected');
    assert.equal(anthropic.fields[0].last4, '2222');
    assert.ok(!JSON.stringify(view).includes(OWN_KEY), 'never shown again');
    const stored = (await conn.query(`SELECT value_enc FROM platform.tenant_secrets WHERE key = 'ANTHROPIC_OWN_API_KEY'`)).rows[0].value_enc;
    assert.ok(!stored.includes(OWN_KEY), 'encrypted at rest');
    fake.reply(text('On your own key'));
    const ownAnswer = await ask(bistro.c, 'Hi again');
    assert.equal(ownAnswer.body.result.message.text, 'On your own key');
    assert.equal(fake.keys.at(-1), '…2222');
    const detail = (await admin.get(`/api/platform/tenants/${bistro.tenant.id}`)).body.result;
    assert.ok(detail.ai.ownUsd > 0);
    assert.equal(detail.ai.usedUsd, row.ai.usedUsd, 'DubLow’s spend unchanged');
    assert.ok(detail.integrations.fields.find((f) => f.key === 'ANTHROPIC_OWN_API_KEY').set);
    // Back to the plan's cap.
    assert.equal((await admin.patch(`/api/platform/tenants/${bistro.tenant.id}`, { aiCapUsd: null })).body.result.ai.capUsd, 5);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await conn.end();
  }
});
