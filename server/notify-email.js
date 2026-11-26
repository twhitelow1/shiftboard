// Notification emails: a copy of each new in-app notification, in the words the restaurant chose for that type
// of email (Settings → Email notifications, core/email-templates.js), after the database commit.
//
// Who gets one: active people with a real address who agreed to notification emails (users.emailConsent,
// core/consent.js), when the restaurant has emails on and that type isn't turned off. Each in their language.
// The publish email can carry the week's schedule as a PDF (core/publish-notify.js marks those notifications):
// it goes only to people already getting the publish email, made once per language.
import { createService } from '../core/service.js';
import { emailConsentOf } from '../core/consent.js';
import { langOf } from '../core/i18n.js';
import { canManageSchedule } from '../core/roles.js';
import { notificationTemplateEmail, typeOfNote, typeOn } from '../core/email-templates.js';
import { loadSheetModel, schedulePdf, pdfFileName } from '../core/schedule-pdf.js';
import { deliverable } from './email.js';

const MAX_ATTACHMENT = 2 * 1024 * 1024; // a schedule is ~20–60 KB; anything near this is a mistake, not a schedule

/**
 * The week's schedule PDF, read as `actor` would see it (staff: published shifts and approved time off only).
 * @returns {Promise<{ bytes: Uint8Array, filename: string, model: object }>}
 */
export async function weekPdf({ store, actor, weekStart, lang = 'en', rooms = [], options = {}, publishedOnly = false }) {
  const svc = createService(store);
  const call = (method, args) => svc.call(actor, method, args);
  const model = await loadSheetModel(call, { weekStart, lang, rooms, publishedOnly, isMgr: canManageSchedule(actor) });
  const { bytes } = await schedulePdf(model, options);
  return { bytes, filename: pdfFileName(model), model };
}

/**
 * The emails for new notifications: [{ ...message, attach? }] for sendNotificationEmails. Pure (no sending).
 * @param {object} o  { notes, store, settings, appUrl, brand }
 */
export function notificationMessages({ notes, store, settings: st, appUrl, brand }) {
  const out = [];
  for (const n of notes) {
    const u = store.get('users', n.userId);
    // Notification emails need the person's email consent; account emails (invites, resets, links) don't.
    if (!u || u.active === false || !emailConsentOf(u) || !deliverable(u.email)) continue;
    if (!typeOn(st, typeOfNote(n))) continue; // that kind of email is off for the restaurant
    const lang = langOf(u, st);
    const by = n.by ? store.get('users', n.by)?.name || '' : '';
    const { type, ...message } = notificationTemplateEmail({ note: n, user: u, settings: st, appUrl, brand, lang, by });
    out.push({ message, lang, attach: n.attach?.kind === 'schedulePdf' ? { ...n.attach, by: n.by } : null });
  }
  return out;
}

/** Send them: plain ones in Resend batches, ones with the PDF one by one. Never throws (errors are logged). */
export async function sendNotificationEmails({ notes, store, settings, appUrl, brand, mailer, idempotencyKey }) {
  const list = notificationMessages({ notes, store, settings, appUrl, brand });
  if (!list.length) return { sent: 0 };
  const pdfs = new Map(); // one PDF per language
  for (const item of list) {
    if (!item.attach) continue;
    const key = item.lang;
    if (!pdfs.has(key)) {
      const a = item.attach;
      const actor = (a.by && store.get('users', a.by)) || store.list('users').find((u) => u.active !== false && canManageSchedule(u));
      pdfs.set(key, actor ? weekPdf({ store, actor, weekStart: a.weekStart, lang: item.lang, options: a, publishedOnly: true })
        .catch((e) => { console.error('Schedule PDF for the email failed:', e.message); return null; }) : Promise.resolve(null));
    }
    const pdf = await pdfs.get(key);
    if (pdf && pdf.bytes.length <= MAX_ATTACHMENT) item.message.attachments = [{ filename: pdf.filename, content: Buffer.from(pdf.bytes).toString('base64') }];
  }
  return mailer.sendMany(list.map((x) => x.message), { idempotencyKey });
}
