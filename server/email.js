// Outgoing email through Resend (https://resend.com).
//
// Optional: without RESEND_API_KEY and EMAIL_FROM the app works exactly as before and
// simply doesn't send email. Emails go out after the database commit, so a request that
// fails never emails anyone, and a retried request doesn't email twice (idempotency keys).

const API = 'https://api.resend.com';
const BATCH_MAX = 100; // Resend's batch limit

import { deliverable } from '../core/email-address.js';
export { deliverable };

export function createMailer(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const key = env.RESEND_API_KEY || '';
  const from = env.EMAIL_FROM || '';
  const replyTo = env.EMAIL_REPLY_TO || undefined;
  const enabled = !!(key && from);

  async function post(path, body, idempotencyKey) {
    const res = await fetchImpl(API + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message || data.name || 'request failed'}`);
    return data;
  }

  const envelope = (m) => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(replyTo ? { reply_to: replyTo } : {}) });

  return {
    enabled,
    from,
    /** Send one email. Returns Resend's response ({ id }). */
    async send(message, { idempotencyKey } = {}) {
      if (!enabled) throw new Error('Email is not set up (RESEND_API_KEY and EMAIL_FROM)');
      return post('/emails', envelope(message), idempotencyKey);
    },
    /** Send many emails in as few requests as possible. Undeliverable addresses are skipped. */
    async sendMany(messages, { idempotencyKey } = {}) {
      const list = messages.filter((m) => deliverable(m.to));
      if (!enabled || !list.length) return { sent: 0 };
      for (let i = 0; i < list.length; i += BATCH_MAX) {
        const chunk = list.slice(i, i + BATCH_MAX).map(envelope);
        await post('/emails/batch', chunk, idempotencyKey ? `${idempotencyKey}-${i / BATCH_MAX}` : undefined);
      }
      return { sent: list.length };
    },
  };
}

// ---------- templates ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ restaurant, heading, paragraphs, button, footer }) {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0f172a;color:#ffffff;padding:16px 24px;font-weight:700;font-size:16px">${esc(restaurant)} · ShiftBoard</td></tr>
<tr><td style="padding:24px">
${heading ? `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(heading)}</h1>` : ''}
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${esc(p)}</p>`).join('\n')}
${button ? `<p style="margin:22px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px">${esc(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px 20px;color:#64748b;font-size:12px;line-height:1.5;border-top:1px solid #e2e8f0">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, ...paragraphs, button ? `${button.label}: ${button.url}` : '', '', footer].filter((x) => x !== undefined).join('\n\n').trim();
  return { html, text };
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

export function notificationEmail({ user, note, appUrl, restaurant }) {
  const subject = note.text.length > 90 ? `${note.text.slice(0, 87)}…` : note.text;
  const { html, text } = layout({
    restaurant,
    heading: null,
    paragraphs: [`Hi ${firstName(user.name)},`, note.text],
    button: { label: 'Open ShiftBoard', url: `${appUrl}/${note.link || '#/my'}` },
    footer: 'You get these emails for updates in ShiftBoard. To stop them, open My Shifts and turn off email notifications.',
  });
  return { to: user.email, subject, html, text };
}

export function inviteEmail({ user, link, restaurant, invitedBy }) {
  const { html, text } = layout({
    restaurant,
    heading: `You're on the ${restaurant} schedule`,
    paragraphs: [
      `Hi ${firstName(user.name)},`,
      `${invitedBy ? `${invitedBy} added` : 'You were added'} you to ShiftBoard, where ${restaurant} posts the schedule, shift trades, time off and event details.`,
      'Set your password to sign in. This link works for 7 days.',
    ],
    button: { label: 'Set my password', url: link },
    footer: `Your sign-in email is ${user.email}. If you weren't expecting this, you can ignore it.`,
  });
  return { to: user.email, subject: `Set up your ${restaurant} schedule account`, html, text };
}

export function resetEmail({ user, link, restaurant, hours = 1, sentBy }) {
  const { html, text } = layout({
    restaurant,
    heading: 'Reset your password',
    paragraphs: [`Hi ${firstName(user.name)},`,
      `${sentBy ? `${sentBy} sent you a link to reset your ShiftBoard password.` : 'Someone asked to reset the password for your ShiftBoard account.'} This link works for ${hours === 1 ? '1 hour' : `${hours} hours`} and can be used once.`],
    button: { label: 'Choose a new password', url: link },
    footer: "If you didn't ask for this, ignore this email. Your password stays the same.",
  });
  return { to: user.email, subject: `Reset your ${restaurant} ShiftBoard password`, html, text };
}

export function testEmail({ user, restaurant, appUrl }) {
  const { html, text } = layout({
    restaurant,
    heading: 'Email is working',
    paragraphs: [`Hi ${firstName(user.name)},`, 'This is a test from ShiftBoard. Staff will now get emails for schedule updates, trades, time off and event changes, and new people get a link to set their password.'],
    button: { label: 'Open ShiftBoard', url: appUrl },
    footer: 'Sent from the Settings page.',
  });
  return { to: user.email, subject: 'ShiftBoard test email', html, text };
}
