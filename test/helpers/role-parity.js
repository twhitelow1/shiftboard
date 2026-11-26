// A fingerprint of what every role can do and see, for the "nothing changes on deploy" test of Roles &
// features (test/role-features.test.js). It runs every RPC method in core/service.js for one person of each
// role on the demo data (each call on a throwaway copy, so calls never affect each other), plus realistic
// reads (the week's schedule, events, trades, tips, training…), and keeps a short hash of each answer or the
// error it gave. test/fixtures/role-parity.json holds the fingerprint taken from the code before Roles &
// features existed; with the default role settings the code must give exactly the same one.
//
// Deterministic: the clock is fixed, Math.random is seeded before every call, and the time zone is the
// restaurant's. Keys added to app.bootstrap by Roles & features and View as (`features`, `viewAs`) are
// left out, since the code before them didn't have them.
import crypto from 'node:crypto';
import { MemoryStore, OverlayStore } from '../../core/store.js';
import { createService } from '../../core/service.js';
import { seedDemo } from '../../core/seed.js';
import { addDays } from '../../core/time.js';

const FIXED = Date.parse('2026-09-27T18:00:00Z'); // Sunday noon in Denver, the demo's clock
const NEW_BOOT_KEYS = ['features', 'viewAs'];
// Answers that hold a fresh random secret: only whether they worked counts.
const RANDOM = new Set(['tripleseat.webhookLink']);

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const short = (v) => crypto.createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

/** Run fn with a fixed clock, a seeded Math.random and the restaurant's time zone; put everything back after. */
function frozen(fn) {
  const RealDate = globalThis.Date;
  const realRandom = Math.random;
  const realTz = process.env.TZ;
  class FixedDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [FIXED])); }
    static now() { return FIXED; }
  }
  globalThis.Date = FixedDate;
  process.env.TZ = 'America/Denver';
  try {
    return fn({ reseed: (n) => { Math.random = mulberry(n); } });
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
    if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
  }
}

/**
 * The fingerprint: { [persona]: { [call]: hash | 'E<status>:<message>' } }.
 * prepare(store) runs on the seeded data before anything else (the test uses it to store role settings).
 */
export function roleFingerprint({ prepare } = {}) {
  return frozen(({ reseed }) => {
    reseed(1);
    const store = new MemoryStore();
    const now = () => new Date(FIXED);
    seedDemo(store, { now: new Date(FIXED) });
    // The demo has no Super Admin: add one (no real person).
    store.insert('users', { id: 'usr_parity_owner', name: 'Owner', role: 'super_admin', order: 0, email: 'owner@parity.test', phone: '555-0100',
      jobCodes: [], active: true, availability: {}, passwordHash: 'plain:x', createdAt: new Date(FIXED).toISOString() });
    if (prepare) prepare(store);
    const opts = { now, hashPassword: (p) => `plain:${p}` };

    // One person per role (the first in the sheet's order), a second employee, and the old 'events' role.
    const users = store.list('users').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const byRole = (r, n = 0) => users.filter((u) => u.role === r && u.active !== false)[n];
    const personas = {
      super_admin: byRole('super_admin'), admin: byRole('admin'), manager: byRole('manager'), supervisor: byRole('supervisor'),
      employee: byRole('employee'), employee2: byRole('employee', 4), events: byRole('events'),
    };

    // Realistic arguments from the data.
    const ws = '2026-09-28'; // the demo week (core/seed.js)
    const start = ws;
    const end = addDays(ws, 6);
    const shifts = store.list('shifts', (x) => x.date >= start && x.date <= end).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    const event = store.list('events').sort((a, b) => a.id.localeCompare(b.id))[0];
    const open = shifts.find((s) => !s.userId) || shifts[0];
    const curated = [
      ['app.bootstrap', {}], ['shifts.list', { start, end }], ['forecast.covers', { weekStart: ws }], ['forecast.summary', { weekStart: ws }],
      ['forecast.week', { weekStart: ws }], ['events.list', { start: '2026-09-01' }], ['events.get', { id: event.id }], ['swaps.list', {}], ['timeOff.list', {}],
      ['tips.week', { weekStart: ws }], ['myTips.week', { weekStart: ws }], ['labor.week', { weekStart: ws }], ['eightySix.board.get', {}],
      ['eightySix.summary', {}], ['menu.list', {}], ['quiz.list', {}], ['manual.list', {}], ['leaderboard.get', {}], ['venue.get', {}],
      ['sections.list', { start, end }], ['layout.get', {}], ['roster.get', {}], ['mod.get', { date: start }], ['training.summary', {}],
      ['notifications.list', {}], ['shifts.eligible', { shiftId: open.id }], ['tipPools.list', {}], ['sales.list', { start, end }],
    ];

    const methods = Object.keys(createService(store, opts).api).sort();
    const out = {};
    for (const [key, person] of Object.entries(personas)) {
      const row = {};
      const run = (label, method, args) => {
        reseed(7);
        const view = new OverlayStore(store);
        try {
          let r = createService(view, opts).call(store.get('users', person.id), method, structuredClone(args));
          if (method === 'app.bootstrap' && r) { r = { ...r }; for (const k of NEW_BOOT_KEYS) delete r[k]; }
          row[label] = RANDOM.has(method) ? 'ok' : short(r);
        } catch (e) {
          row[label] = `E${e.status || 500}:${e.message}`;
        }
      };
      for (const m of methods) run(m, m, {});
      for (const [m, args] of curated) run(`${m} ${JSON.stringify(args)}`, m, args);
      out[key] = row;
    }
    return { methods, personas: Object.fromEntries(Object.entries(personas).map(([k, u]) => [k, u.id])), calls: out };
  });
}
