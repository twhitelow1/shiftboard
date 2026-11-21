import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, deliverable, notificationEmail, inviteEmail } from '../server/email.js';
import { fakeResend } from './helpers/fake-resend.js';

const ENV = { RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Chasing Rabbits <schedule@mail.example-restaurant.com>' };

test('mailer is off until both RESEND_API_KEY and EMAIL_FROM are set', async () => {
  assert.equal(createMailer({}).enabled, false);
  assert.equal(createMailer({ RESEND_API_KEY: 'x' }).enabled, false);
  assert.equal(createMailer(ENV).enabled, true);
  await assert.rejects(createMailer({}).send({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }), /not set up/);
  assert.deepEqual(await createMailer({}).sendMany([{ to: 'a@b.co' }]), { sent: 0 });
});

test('sendMany batches by 100, skips undeliverable addresses and sends the right headers', async () => {
  const r = fakeResend();
  const mailer = createMailer(ENV, { fetchImpl: r.fetchImpl });
  const msgs = Array.from({ length: 205 }, (_, i) => ({ to: `staff${i}@rabbits.co`, subject: 'Hi', html: '<p>hi</p>', text: 'hi' }));
  msgs.push({ to: 'moe@demo.shiftboard', subject: 'x', html: 'x', text: 'x' }, { to: 'admin@example.com', subject: 'x', html: 'x', text: 'x' });
  const out = await mailer.sendMany(msgs, { idempotencyKey: 'ntf-abc' });
  assert.equal(out.sent, 205);
  assert.deepEqual(r.calls.map((c) => c.body.length), [100, 100, 5]);
  assert.ok(r.calls.every((c) => c.url === 'https://api.resend.com/emails/batch'));
  assert.deepEqual(r.calls.map((c) => c.headers['Idempotency-Key']), ['ntf-abc-0', 'ntf-abc-1', 'ntf-abc-2']);
  assert.equal(r.calls[0].headers.Authorization, 'Bearer re_test_123');
  assert.equal(r.calls[0].body[0].from, ENV.EMAIL_FROM);
  assert.deepEqual(r.calls[0].body[0].to, ['staff0@rabbits.co']);
});

test('Resend errors come back with Resend’s reason', async () => {
  const mailer = createMailer(ENV, { fetchImpl: fakeResend({ fail: 'The domain is not verified' }).fetchImpl });
  await assert.rejects(mailer.send({ to: 'a@rabbits.co', subject: 's', html: 'h', text: 't' }), /403: The domain is not verified/);
});

test('deliverable() rejects demo and placeholder addresses', () => {
  for (const ok of ['kelly@chasingrabbits.com', 'a.b+c@mail.co']) assert.ok(deliverable(ok), ok);
  for (const bad of ['', null, 'nope', 'moe@demo.shiftboard', 'admin@example.com', 'x@site.test', 'x@host.invalid']) assert.ok(!deliverable(bad), String(bad));
});

test('templates escape user text and include the link', () => {
  const e = notificationEmail({ user: { name: '<b>Kelly</b> M', email: 'k@r.co' }, note: { text: 'New shift: Server Fri 4p <script>', link: '#/my' }, appUrl: 'https://app.test', restaurant: 'Chasing Rabbits' });
  assert.ok(!e.html.includes('<script>') && e.html.includes('&lt;script&gt;'));
  assert.ok(e.html.includes('Hi &lt;b&gt;Kelly&lt;/b&gt;,'));
  assert.ok(e.html.includes('https://app.test/#/my') && e.text.includes('https://app.test/#/my'));
  const inv = inviteEmail({ user: { name: 'Sam', email: 's@r.co' }, link: 'https://app.test/#/reset?token=abc', restaurant: 'Chasing Rabbits', invitedBy: 'Moe' });
  assert.match(inv.subject, /Chasing Rabbits/);
  assert.ok(inv.text.includes('https://app.test/#/reset?token=abc'));
});

test('emails carry the restaurant brand color and logo when set', () => {
  const plain = notificationEmail({ user: { name: 'Ana', email: 'ana@x.co' }, note: { text: 'Hi', link: '#/my' }, appUrl: 'https://a.app', restaurant: 'Rabbits' });
  assert.match(plain.html, /background:#0f172a/);
  assert.doesNotMatch(plain.html, /<img/);
  const branded = notificationEmail({ user: { name: 'Ana', email: 'ana@x.co' }, note: { text: 'Hi', link: '#/my' }, appUrl: 'https://a.app', restaurant: 'Rabbits',
    brand: { color: '#aa3300', logoUrl: 'https://a.app/api/branding/logo?v=1' } });
  assert.match(branded.html, /background:#aa3300/);
  assert.match(branded.html, /<img src="https:\/\/a\.app\/api\/branding\/logo\?v=1"/);
  const unsafe = notificationEmail({ user: { name: 'Ana', email: 'ana@x.co' }, note: { text: 'Hi' }, appUrl: 'https://a.app', restaurant: 'R', brand: { color: 'red;x', logoUrl: 'javascript:alert(1)' } });
  assert.doesNotMatch(unsafe.html, /javascript:|red;x/);
});
