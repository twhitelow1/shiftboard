// SAMPLE Feedback box entries for the in-browser demo only (web/src/api.js): one of each kind, anonymous and signed,
// a reader's reply, an internal note, and two on the "You said, we did" board. Everything typed in the demo stays in
// the page (there's no server). DEMO_CODE opens the anonymous suggestion with a reply waiting; the demo's Feedback
// box keeps it on "this device" so the badge shows.
import { codeHash } from './feedback.js';
import { addDays, todayStr } from './time.js';

export const DEMO_CODE = 'TRYM-E2B4-CK9P-HQ7X';

/** @param store the demo store after seedDemo. now: the demo clock (a Date). */
export function seedFeedbackDemo(store, { now }) {
  const people = store.list('users', (u) => u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const manager = people.find((u) => u.role === 'manager') || people.find((u) => u.role === 'admin');
  const staff = people.filter((u) => u.role === 'employee');
  const [writer, other] = [staff[0], staff[1] || staff[0]];
  const today = todayStr(now);
  const at = (days, h) => { const d = new Date(now.getTime() + days * 86400000); d.setHours(h, 15, 0, 0); return d.toISOString(); };
  const add = (e) => store.insert('feedback', { thread: [], notes: [], shared: null, topic: '', ...e });

  add({
    id: 'fbk_demo_patio', kind: 'suggestion', topic: 'foh', date: addDays(today, -9), signed: false, codeHash: codeHash('KX7P-M2QA-9RTD-WE4H'),
    message: 'Could we get a second bus tub station by the patio door? On busy nights we walk the long way around the bar with full tubs.',
    status: 'done',
    thread: [{ id: 'fbm_demo_1', from: 'reader', byId: manager?.id, at: at(-8, 11), text: 'Great idea. A second station goes in by the patio door on Friday.' }],
    shared: { text: 'A second bus tub station by the patio door, so nobody carries full tubs around the bar.', reply: 'Done: it went in on Friday.', date: addDays(today, -5), showName: false, byId: manager?.id },
  });
  add({
    id: 'fbk_demo_walkin', kind: 'feedback', topic: 'kitchen', date: addDays(today, -4), signed: true, userId: writer?.id, nameOk: false,
    message: 'The new walk-in labels are much easier to read. The dairy shelf still has the old ones.', status: 'in_progress',
    notes: [{ id: 'fbn_demo_1', byId: manager?.id, at: at(-3, 10), text: 'Ordered more labels; they arrive Tuesday.' }],
  });
  add({
    id: 'fbk_demo_mat', kind: 'concern', topic: 'equipment', date: addDays(today, -2), signed: false, codeHash: codeHash('R4VN-8XQC-T2MJ-KP6Z'),
    message: 'The floor mat at the dish pit curls up at the corner. Someone is going to trip carrying a rack.', status: 'new',
  });
  add({
    id: 'fbk_demo_thanks', kind: 'shoutout', topic: 'foh', date: addDays(today, -6), signed: true, userId: other?.id, nameOk: true,
    message: 'Huge thanks to the hosts on Saturday: a 40-minute wait and every guest still left smiling.', status: 'done',
    shared: { text: 'Huge thanks to the hosts on Saturday: a 40-minute wait and every guest still left smiling.', reply: '', date: addDays(today, -5), showName: true, byId: manager?.id },
  });
  add({
    id: 'fbk_demo_code', kind: 'suggestion', topic: 'schedule', date: addDays(today, -1), signed: false, codeHash: codeHash(DEMO_CODE),
    message: 'Could the schedule go up by Thursday instead of Saturday? It would help people with second jobs plan.', status: 'seen',
    thread: [{ id: 'fbm_demo_2', from: 'reader', byId: manager?.id, at: at(0, 9), text: 'Thanks for saying so. We’re trying Thursday for the next four weeks; tell us how it goes.' }],
  });
}
