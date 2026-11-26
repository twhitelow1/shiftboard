// The printable schedule and the email-template test (server side).
//
//   GET  /api/schedule/pdf?week=2026-11-23&paper=letter&orientation=portrait&fit=fit&rooms=Restaurant,Moon%20Rabbit&lang=es
//        The week as a PDF (core/schedule-pdf.js). Managers get the week as it stands (drafts included, so a week
//        with drafts says DRAFT); everyone else gets the published week, the same one they can see in the app.
//   POST /api/email/template-test { type, lang, subject, body }
//        Settings → Email notifications → Send me a test (admins): the template as typed, with sample values,
//        to the admin's own address.
import { canChangeSettings, canManageSchedule } from '../core/roles.js';
import { createService } from '../core/service.js';
import { langOf, isLang } from '../core/i18n.js';
import { cleanPdfOptions } from '../core/pdf-options.js';
import { EMAIL_TYPES, checkTemplate, renderTemplate, sampleVars, defaultTemplate } from '../core/email-templates.js';
import { weekPdf } from './notify-email.js';
import { deliverable } from './email.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {import('express').Express} app
 * @param {object} d  { db, mailer, signedIn(req), appUrl(req), brandOf(req) }
 */
export function mountSchedulePdf(app, { db, mailer, signedIn, appUrl, brandOf }) {
  app.get('/api/schedule/pdf', async (req, res) => {
    try {
      await db.sync();
      const u = signedIn(req);
      if (!u) return res.status(401).json({ error: 'Please sign in' });
      const week = String(req.query.week || '');
      if (!DATE.test(week)) return res.status(400).json({ error: 'Pick a week' });
      const o = cleanPdfOptions(req.query);
      const st = createService(db.store).settings();
      // The restaurant's language unless another was picked; on Auto, the person's own.
      const lang = o.lang || (isLang(st.language) ? st.language : langOf(u, st));
      const { bytes, filename } = await weekPdf({ store: db.store, actor: u, weekStart: week, lang, rooms: o.rooms, options: o, publishedOnly: !canManageSchedule(u) });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.set('Cache-Control', 'private, no-store');
      res.send(Buffer.from(bytes));
    } catch (e) {
      console.error('Schedule PDF failed:', e);
      res.status(500).json({ error: 'The PDF could not be made. Try again in a minute.' });
    }
  });

  app.post('/api/email/template-test', async (req, res) => {
    await db.sync();
    const u = signedIn(req);
    if (!u) return res.status(401).json({ error: 'Please sign in' });
    if (!canChangeSettings(u)) return res.status(403).json({ error: 'Admins only' });
    if (!mailer.enabled) return res.status(400).json({ error: 'Email isn’t set up yet' });
    if (!deliverable(u.email)) return res.status(400).json({ error: 'Your account needs a real email address first.' });
    const { type, lang: l, subject, body } = req.body || {};
    const lang = l === 'es' ? 'es' : 'en';
    if (!EMAIL_TYPES.some((t) => t.id === type)) return res.status(400).json({ error: 'Unknown email type' });
    const template = subject || body ? { subject: String(subject || ''), body: String(body || '') } : defaultTemplate(type, lang);
    const problems = checkTemplate(type, template);
    const unknown = problems.find((p) => p.code === 'unknown');
    if (unknown) return res.status(400).json({ error: `Unknown placeholder: {${unknown.values[0]}}` });
    if (problems.length) return res.status(400).json({ error: 'Write a subject and a message' });
    const st = createService(db.store).settings();
    const restaurant = st.restaurantName || 'ShiftBoard';
    const mail = renderTemplate({ template, vars: sampleVars(type, lang, { restaurant, name: u.name, appUrl: appUrl(req) }), restaurant, brand: brandOf(req), lang });
    try {
      await mailer.send({ to: u.email, ...mail, subject: `[${lang === 'es' ? 'Prueba' : 'Test'}] ${mail.subject}` });
      res.json({ result: { ok: true, to: u.email } });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
}
