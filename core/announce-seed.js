// SAMPLE announcements for the in-browser demo only (web/src/api.js): about half the staff agreed to texts
// (invented 555-01xx numbers), some to emails, most have the phone app, and two announcements: one sent last
// week (some people read it) and one scheduled for Monday morning. Nothing here is ever sent anywhere: the demo
// marks deliveries sent at once (core/announcements.js, channels.simulate).
import { uid } from './store.js';
import { releaseAnnouncement } from './announcements.js';
import { DEFAULT_SETTINGS } from './service.js';

export const DEMO_CHANNELS = { push: true, appPush: true, email: true, sms: true, simulate: true };

/** @param store the demo store after seedDemo. now: the demo clock (a Date). */
export function seedAnnouncementDemo(store, { userId, now }) {
  const staff = store.list('users', (u) => u.active !== false && u.role !== 'events').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  staff.forEach((u, i) => {
    const patch = {};
    if (i % 2 === 0) Object.assign(patch, { smsConsent: true, smsPhone: `+1303555${String(100 + (i % 100)).padStart(4, '0')}`, smsConsentAt: '2026-09-01T16:00:00.000Z', smsWelcomedAt: '2026-09-01T16:00:00.000Z' });
    if (i % 3 === 0) patch.emailConsent = true;
    if (i % 5 === 3) Object.assign(patch, { smsConsent: false, smsStoppedAt: '2026-09-10T12:00:00.000Z' }); // replied STOP
    if (Object.keys(patch).length) store.update('users', u.id, patch);
    if (i % 4 !== 1) store.insert('deviceTokens', { id: uid('dev'), userId: u.id, token: `ExponentPushToken[demo${i}]`, platform: i % 2 ? 'android' : 'ios', v: 0, createdAt: '2026-09-01T16:00:00.000Z' });
  });
  const settings = { ...DEFAULT_SETTINGS, ...(store.get('settings', 'settings') || {}) };
  const kelly = userId?.Kelly;
  const lastWeek = new Date(now.getTime() - 6 * 86400000);
  lastWeek.setHours(15, 0, 0, 0);
  const sent = store.insert('announcements', {
    id: 'ann_demo_inventory', title: 'Inventory night Monday', body: 'We close the kitchen at 9 on Monday for inventory. Bar team: please stay 30 minutes after close to count bottles. Thank you!',
    titleEs: 'Inventario el lunes en la noche', bodyEs: 'El lunes cerramos la cocina a las 9 por el inventario. Equipo de barra: por favor quédense 30 minutos después del cierre para contar botellas. ¡Gracias!',
    link: '#/schedule', audience: { kind: 'everyone' }, email: true, sms: true, urgent: false,
    status: 'queued', sendAt: null, next: lastWeek.toISOString(), createdAt: lastWeek.toISOString(), createdBy: kelly,
  });
  const done = releaseAnnouncement(store, sent, { settings, channels: DEMO_CHANNELS, now: lastWeek });
  // About two thirds opened it.
  const recipients = { ...done.recipients };
  Object.keys(recipients).forEach((id, i) => {
    if (i % 3 !== 2) recipients[id] = { ...recipients[id], readAt: new Date(lastWeek.getTime() + (i + 1) * 7 * 60000).toISOString() };
  });
  store.update('announcements', done.id, { recipients });
  for (const n of store.list('notifications', (x) => x.announcementId === done.id && recipients[x.userId]?.readAt)) store.update('notifications', n.id, { read: true });
  const monday = new Date(now.getTime() + 86400000);
  monday.setHours(9, 0, 0, 0);
  store.insert('announcements', {
    id: 'ann_demo_meeting', title: 'Server meeting Wednesday 3:30', body: 'Quick meeting in the Library before dinner service: the new fall menu and wine pairings. Wear your uniform.',
    titleEs: '', bodyEs: '', link: '#/my', audience: { kind: 'positions', jobCodeIds: ['job_srv'] }, email: false, sms: true, urgent: false,
    status: 'scheduled', sendAt: monday.toISOString(), next: monday.toISOString(), createdAt: now.toISOString(), createdBy: kelly,
  });
}
