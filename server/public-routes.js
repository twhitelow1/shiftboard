// Small routes around consent and profiles:
//   GET /api/photos/:id      a profile photo (signed-in people only; bytes read on demand, db.js LAZY_DATA)
//   GET /api/consents.csv    every consent record, for carrier and Twilio audits (admins only; IPs masked)
//   GET /sms-opt-in          the public page that shows how people opt in to texts (Twilio A2P 10DLC review)
import { canChangeSettings } from '../core/roles.js';
import { consentCsv, CONSENT_TEXT, WELCOME_TEXT, termsParts } from '../core/consent.js';
import { STOP_WORDS, START_WORDS } from '../core/notify-prefs.js';

const SERVABLE = /^image\/(jpeg|png|webp)$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param app express app
 * @param {object} d  db, env, legal ({ privacy, terms }), signedIn(req) → user|null, restaurantName()
 */
export function publicRoutes(app, { db, legal, signedIn }) {
  app.get('/api/photos/:id', async (req, res) => {
    await db.sync();
    if (!signedIn(req)) return res.status(401).json({ error: 'Please sign in' });
    const p = db.store.get('profilePhotos', req.params.id);
    if (!p || !SERVABLE.test(p.mime)) return res.status(404).json({ error: 'Photo not found' });
    const data = p.data ?? await db.lazyData('profilePhotos', p.id);
    if (!data) return res.status(404).json({ error: 'Photo not found' });
    res.set('Content-Type', p.mime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable'); // a photo's bytes never change for its id
    res.set('Content-Security-Policy', "default-src 'none'");
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(Buffer.from(data, 'base64'));
  });

  app.get('/api/consents.csv', async (req, res) => {
    await db.sync();
    const u = signedIn(req);
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="consent-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(`﻿${consentCsv(db.store)}`); // the BOM makes Excel read it as UTF-8 (Spanish accents)
  });

  app.get('/sms-opt-in', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.type('html').send(optInPage(legal));
  });
}

const termsHtml = (lang, legal) => termsParts(lang, legal).map((p) => (p.href ? `<a href="${esc(p.href)}">${esc(p.text)}</a>` : esc(p.text))).join('');

/** The public opt-in page. Plain HTML (no script), the exact wording from core/consent.js, sample data only. */
export function optInPage(legal) {
  const box = (html) => `<div class="box"><span class="tick" aria-hidden="true"></span><span>${html}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Text message opt-in · ShiftBoard by DubLow Digital</title>
<meta name="description" content="How ShiftBoard employees opt in to shift schedule text messages from DubLow Digital.">
<style>
:root{color-scheme:light}
body{margin:0;background:#f8fafc;color:#0f172a;font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}h2{font-size:19px;margin:28px 0 8px}
p,li{margin:6px 0}.muted{color:#475569}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:12px 0}
.box{display:flex;gap:10px;align-items:flex-start;padding:10px 0}.tick{flex:none;width:20px;height:20px;margin-top:2px;border:2px solid #64748b;border-radius:4px;background:#fff}
.sms{background:#e2e8f0;border-radius:16px;padding:10px 14px;display:inline-block;max-width:520px}
code{background:#f1f5f9;border-radius:4px;padding:1px 5px}figure{margin:12px 0}img{max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:12px}
figcaption{font-size:14px;color:#475569;margin-top:6px}a{color:#4338ca}.tag{font-size:12px;font-weight:700;text-transform:uppercase;color:#64748b;letter-spacing:.04em}
</style></head>
<body><main>
<p class="tag">ShiftBoard · DubLow Digital</p>
<h1>Shift schedule text messages: how employees opt in</h1>
<p class="muted">ShiftBoard is a staff scheduling app that DubLow Digital runs for restaurants. Employees can choose to get text messages about their shift schedule (new or changed shifts, trades, time off). Texts are only for employees who opt in themselves, and they are never required.</p>

<h2>1. The invitation</h2>
<p>A manager adds an employee with their name, email address and role. ShiftBoard emails the employee an invitation link. <strong>No text message is sent before the employee opts in.</strong> Invitations are never sent by text.</p>

<h2>2. The consent screen</h2>
<p>While setting up their account, after choosing a password, securing their sign-in and filling in their profile, the employee sees a consent screen with three separate checkboxes. <strong>None of the boxes is checked when the screen opens</strong>, and the employee must check each one themselves:</p>
<div class="card">
${box(`${termsHtml('en', legal)} <em class="muted">(required to use ShiftBoard)</em>`)}
${box(`${esc(CONSENT_TEXT.en.sms)} <em class="muted">(optional)</em>`)}
${box(`${esc(CONSENT_TEXT.en.email)} <em class="muted">(optional)</em>`)}
</div>
<p>The text message box is <strong>optional</strong>: employees who leave it unchecked use ShiftBoard exactly the same way and get no texts. Checking it needs a mobile number, which the employee types in themselves. Employees can also turn texts on or off later in the app (My Shifts → Text messages), with the same wording and an unchecked box.</p>
<figure><img src="/sms-opt-in-consent.png" alt="The ShiftBoard consent screen on a phone, with three unchecked checkboxes: the Privacy Policy and Terms, shift schedule text messages, and email notifications" width="390">
<figcaption>The consent screen as an employee sees it on a phone (sample data).</figcaption></figure>
<p>Spanish-speaking employees see the same screen in Spanish:</p>
<div class="card" lang="es">
${box(termsHtml('es', legal))}
${box(esc(CONSENT_TEXT.es.sms))}
${box(esc(CONSENT_TEXT.es.email))}
</div>

<h2>3. Records</h2>
<p>For every choice ShiftBoard stores a consent record: the person, the channel, yes or no, the exact words shown and their version, the language, the mobile number, the time, the IP address and the browser. Records are never changed or deleted.</p>

<h2>4. The confirmation text</h2>
<p>Right after an employee opts in for the first time, ShiftBoard sends exactly this message:</p>
<p class="sms">${esc(WELCOME_TEXT.en)}</p>
<p>Sample schedule text (sample data): <span class="sms">Our Restaurant: New shift: Server Fri, Oct 2 4p-10p https://schedule.example.com/#/my</span></p>
<p>Message frequency varies with the employee's schedule. Message and data rates may apply.</p>

<h2>5. STOP and HELP</h2>
<ul>
<li>Reply <code>STOP</code> (or ${STOP_WORDS.filter((w) => w !== 'STOP').map((w) => `<code>${w}</code>`).join(', ')}) to cancel. ShiftBoard turns that number's texts off right away and sends nothing more.</li>
<li>Reply <code>START</code> (or ${START_WORDS.filter((w) => w !== 'START').map((w) => `<code>${w}</code>`).join(', ')}) to opt back in.</li>
<li>Reply <code>HELP</code> for help. You can also reach your manager, or DubLow Digital at <a href="/support">/support</a>.</li>
</ul>
<p>Consent is not a condition of employment. Mobile information is not shared with third parties or affiliates for marketing or promotional purposes.</p>

<h2>Policies</h2>
<p><a href="${esc(legal.privacy)}">Privacy Policy</a> · <a href="${esc(legal.terms)}">Terms</a></p>
</main></body></html>`;
}
