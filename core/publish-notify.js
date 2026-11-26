// Telling staff when the schedule goes out: the Publish dialog's "Notify staff" (the same choice and helper as
// Unpublish, core/notify-choice.js) and the schedule PDF attached to the publish email.
//
//   const { notify: tell, attach } = publishOptions(args, settings())  // the Publish dialog's choices
//   scheduleNotice(ctx, { shifts, start, end, notify: tell, attach })  // the notifications, or none at all
//
// With notify off nothing goes out on any channel (in-app, email, phone, text): every channel follows the
// notifications this writes. The PDF option only marks the notifications; the server attaches the PDF to the
// publish email for the people who get notification emails (server/notify-email.js), never anyone else.
import { cleanPdfOptions } from './pdf-options.js';
import { wantsNotify, staffNotifier } from './notify-choice.js';

/** The publish email's PDF, remembered per restaurant (settings.publishPdf). Off until someone turns it on. */
export const PUBLISH_PDF_DEFAULT = { attach: false, paper: 'letter', orientation: 'portrait', fit: 'fit' };

/**
 * What a publish (or unpublish) asked for: notify (on unless false), and the PDF to attach (null for none).
 * Attaching only happens when people are notified. `remember` is what to save as the restaurant's choice.
 */
export function publishOptions(args = {}, settings = {}) {
  const notify = wantsNotify(args);
  const saved = { ...PUBLISH_PDF_DEFAULT, ...(settings.publishPdf || {}) };
  const asked = 'attachPdf' in args ? !!args.attachPdf : !!saved.attach;
  const pdf = cleanPdfOptions({ ...saved, ...(args.pdf || {}) });
  const remember = 'attachPdf' in args ? { attach: asked, paper: pdf.paper, orientation: pdf.orientation, fit: pdf.fit } : null;
  return { notify, attach: notify && asked ? { paper: pdf.paper, orientation: pdf.orientation, fit: pdf.fit } : null, remember };
}

/**
 * The notifications for shifts that were just posted (or taken down).
 * @param {object} ctx   { notify(userIds, text, link, extra), users(), say, day, store }
 * @param {object} o
 * @param {object[]} o.shifts      the shifts that changed
 * @param {string} [o.start]       the week (or range) they're in
 * @param {string} [o.end]
 * @param {string} [o.eventId]     an event's shifts only
 * @param {boolean} [o.notify]     false: tell nobody
 * @param {object|null} [o.attach] attach the week's PDF to the email ({ paper, orientation, fit })
 * @param {Function} [o.text]      the message, (lang) => text (default: "The schedule for … is posted")
 * @param {boolean} [o.openShifts] tell qualified people about open shifts (default true)
 * @param {Set<string>} [o.skip]   people already told another way (e.g. "what changed for you" after an unpublish)
 * @returns {{ notified: number, openNotified: number }}
 */
export function scheduleNotice(ctx, { shifts, start, end, eventId, notify = true, attach = null, text, openShifts = true, skip = null }) {
  const { say, day } = ctx;
  const extra = attach && !eventId && start ? { attach: { kind: 'schedulePdf', weekStart: start, ...attach } } : null;
  const tell = staffNotifier((ids, msgText, link) => ctx.notify(ids, msgText, link, extra), { notify });
  const tellOpen = staffNotifier(ctx.notify, { notify });
  const byUser = new Set(shifts.map((s) => s.userId).filter(Boolean));
  const message = text || (eventId ? say('eventShiftsPosted', ctx.store.get('events', eventId)?.name) : say('schedulePosted', day(start, { dow: false }), day(end, { dow: false })));
  const notified = tell([...byUser].filter((id) => !skip?.has(id)), message, '#/my');
  let openNotified = 0;
  const open = openShifts ? shifts.filter((s) => !s.userId) : [];
  if (open.length) {
    const jobs = new Set(open.map((s) => s.jobCodeId));
    const eligible = ctx.users().filter((u) => u.active !== false && u.jobCodes?.some((j) => jobs.has(j.jobCodeId)) && !byUser.has(u.id)).map((u) => u.id);
    openNotified = tellOpen(eligible, say('openShiftsPosted', open.length), '#/my');
  }
  return { notified: notify === false ? 0 : notified + (skip?.size || 0), openNotified };
}
