// Outgoing email through Resend (https://resend.com).
//
// Optional: without RESEND_API_KEY and EMAIL_FROM the app works exactly as before and
// simply doesn't send email. Emails go out after the database commit, so a request that
// fails never emails anyone, and a retried request doesn't email twice (idempotency keys).

const API = 'https://api.resend.com';
const BATCH_MAX = 100; // Resend's batch limit

import { deliverable } from '../core/email-address.js';
import { msg } from '../core/messages.js';
export { deliverable };

export function createMailer(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const key = env.RESEND_API_KEY || '';
  const from = env.EMAIL_FROM || '';
  const replyTo = env.EMAIL_REPLY_TO || undefined;
  const enabled = !!(key && from);
  // Emails with an attachment go one at a time (Resend's batch API takes no attachments), at Resend's rate.
  const gap = 1000 / Math.max(0.5, Number(env.RESEND_RATE_LIMIT) || 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (!res.ok) throw Object.assign(new Error(`Resend ${res.status}: ${data.message || data.name || 'request failed'}`), { status: res.status });
    return data;
  }

  const envelope = (m) => ({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(replyTo ? { reply_to: replyTo } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}) }); // [{ filename, content: base64 }]

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
      const all = messages.filter((m) => deliverable(m.to));
      if (!enabled || !all.length) return { sent: 0 };
      const list = all.filter((m) => !m.attachments?.length);
      for (let i = 0; i < list.length; i += BATCH_MAX) {
        const chunk = list.slice(i, i + BATCH_MAX).map(envelope);
        await post('/emails/batch', chunk, idempotencyKey ? `${idempotencyKey}-${i / BATCH_MAX}` : undefined);
      }
      const single = all.filter((m) => m.attachments?.length);
      let failed = null;
      for (const [i, m] of single.entries()) {
        if (i) await sleep(gap);
        for (let attempt = 0; ; attempt++) { // too many requests: wait and try again (3 times); one failure never stops the rest
          try { await post('/emails', envelope(m), idempotencyKey ? `${idempotencyKey}-a${i}` : undefined); break; } catch (e) {
            if (e.status === 429 && attempt < 3) { await sleep(gap * 2 ** (attempt + 1)); continue; }
            failed ||= e;
            break;
          }
        }
      }
      if (failed) throw failed;
      return { sent: all.length };
    },
  };
}

// ---------- templates ----------
// Each template takes the recipient's language (lang: 'en' | 'es', see langOf in core/i18n.js). The words are
// in core/messages.js (MSG[lang].email); the restaurant's name and anything people typed stay as they are.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// brand: { color, logoUrl } from the restaurant's settings (Settings → Branding); both optional.
function layout({ restaurant, heading, paragraphs, button, footer, brand = {}, lang = 'en' }) {
  const head = /^#[0-9a-f]{6}$/i.test(brand.color || '') ? brand.color : '#0f172a';
  const buttonColor = /^#[0-9a-f]{6}$/i.test(brand.color || '') ? brand.color : '#4f46e5';
  const logo = /^https:\/\//.test(brand.logoUrl || '') ? `<img src="${esc(brand.logoUrl)}" alt="" height="32" style="height:32px;max-width:160px;vertical-align:middle;margin-right:10px;border-radius:4px;background:#fff">` : '';
  const html = `<!doctype html><html${lang === 'en' ? '' : ` lang="${esc(lang)}"`}><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${head};color:#ffffff;padding:16px 24px;font-weight:700;font-size:16px">${logo}${esc(restaurant)} · ShiftBoard</td></tr>
<tr><td style="padding:24px">
${heading ? `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(heading)}</h1>` : ''}
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${esc(p)}</p>`).join('\n')}
${button ? `<p style="margin:22px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:${buttonColor};color:#ffffff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:8px">${esc(button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px 20px;color:#64748b;font-size:12px;line-height:1.5;border-top:1px solid #e2e8f0">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, ...paragraphs, button ? `${button.label}: ${button.url}` : '', '', footer].filter((x) => x !== undefined).join('\n\n').trim();
  return { html, text };
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0];
/** 'Hi Ana,' · 'Hola, Ana:' ('Hi there,' · 'Hola:' without a name). */
const hello = (name, lang) => {
  const first = firstName(name);
  if (lang === 'es') return first ? msg('es').email.hi(first) : 'Hola:';
  return msg('en').email.hi(first || msg('en').email.there);
};

export function notificationEmail({ user, note, appUrl, restaurant, brand, lang = 'en' }) {
  const E = msg(lang).email;
  const subject = note.text.length > 90 ? `${note.text.slice(0, 87)}…` : note.text;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: null,
    paragraphs: [hello(user.name, lang), note.text],
    button: { label: E.open, url: `${appUrl}/${note.link || '#/my'}` },
    footer: E.notificationFooter,
  });
  return { to: user.email, subject, html, text };
}

export function inviteEmail({ user, link, restaurant, brand, invitedBy, lang = 'en' }) {
  const E = msg(lang).email;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: E.inviteHeading(restaurant),
    paragraphs: [hello(user.name, lang), E.inviteBody(restaurant, invitedBy), E.inviteSetPassword],
    button: { label: E.inviteButton, url: link },
    footer: E.inviteFooter(user.email),
  });
  return { to: user.email, subject: E.inviteSubject(restaurant), html, text };
}

export function resetEmail({ user, link, restaurant, brand, hours = 1, sentBy, lang = 'en' }) {
  const E = msg(lang).email;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: E.resetHeading,
    paragraphs: [hello(user.name, lang), E.resetBody(sentBy, hours)],
    button: { label: E.resetButton, url: link },
    footer: E.resetFooter,
  });
  return { to: user.email, subject: E.resetSubject(restaurant), html, text };
}

export function testEmail({ user, restaurant, brand, appUrl, lang = 'en' }) {
  const E = msg(lang).email;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: E.testHeading,
    paragraphs: [hello(user.name, lang), E.testBody],
    button: { label: E.open, url: appUrl },
    footer: E.testFooter,
  });
  return { to: user.email, subject: E.testSubject, html, text };
}

/** A one-time sign-in link (15 minutes), after the person typed their email and a current authenticator code. */
export function signInLinkEmail({ user, link, restaurant, brand, lang = 'en' }) {
  const E = msg(lang).email;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: E.linkHeading,
    paragraphs: [hello(user.name, lang), E.linkBody],
    button: { label: E.linkButton, url: link },
    footer: E.linkFooter,
  });
  return { to: user.email, subject: E.linkSubject(restaurant), html, text };
}

/** A security notice: a manager reset the person's second step (they set up a new one at their next sign-in). */
export function securityResetEmail({ user, restaurant, brand, by, appUrl, lang = 'en' }) {
  const E = msg(lang).email;
  const { html, text } = layout({
    restaurant, brand, lang,
    heading: E.securityHeading,
    paragraphs: [hello(user.name, lang), E.securityBody(by)],
    button: appUrl ? { label: E.open, url: appUrl } : null,
    footer: E.securityFooter,
  });
  return { to: user.email, subject: E.securitySubject(restaurant), html, text };
}
