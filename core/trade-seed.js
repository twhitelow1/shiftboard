// SAMPLE trade history for the demo (Trades & pickups by season, core/trade-stats.js): give-aways, trades and
// open-shift pickups from May 2025 through August 2026, so Summer 2025, Winter 2025–26 and Summer 2026 have
// data, with every outcome (taken, declined, denied, cancelled, never taken). Each request gets its own past
// shift (published, owned by whoever ended up working it). Everything is before September 2026, so the
// demo's Swaps page (the last 30 days), Labor review (the two weeks before the posted week) and the
// posted week itself don't change. Invented, deterministic data.
import { uid } from './store.js';
import { addDays, daysBetween } from './time.js';

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [from, to, how many requests]: summers are busier than the winter.
const PERIODS = [['2025-05-03', '2025-10-30', 58], ['2025-11-02', '2026-04-29', 41], ['2026-05-02', '2026-08-25', 52]];
const STARTS = [['16:00', '22:00'], ['16:30', null], ['17:00', '23:00'], ['11:00', '16:00'], ['15:30', null]];

/** @param store the demo store after seedDemo's people and positions. Returns how many requests it added. */
export function seedTradeHistory(store, { userId, managerIds = [] } = {}) {
  const rand = prng(20260927);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const staff = store.list('users', (u) => u.role === 'employee' && u.active !== false && (u.jobCodes || []).length);
  if (staff.length < 4) return 0;
  // Some people trade a lot, most a little: weight the picks.
  const weight = new Map(staff.map((u, i) => [u.id, i % 7 === 0 ? 6 : i % 3 === 0 ? 3 : 1]));
  const weighted = staff.flatMap((u) => Array(weight.get(u.id)).fill(u));
  const approvers = managerIds.length ? managerIds : [userId?.Moe, userId?.Kelly].filter(Boolean);
  const at = (date, hour, plusDays = 0) => { const [y, m, d] = addDays(date, plusDays).split('-').map(Number); return new Date(y, m - 1, d, hour, Math.floor(rand() * 60)).toISOString(); };
  const coworkers = (u, jobCodeId) => staff.filter((x) => x.id !== u.id && (x.jobCodes || []).some((e) => e.jobCodeId === jobCodeId));
  const shift = (date, entry, owner) => {
    const [start, end] = pick(STARTS);
    return store.insert('shifts', { id: uid('shf'), date, start, end, jobCodeId: entry.jobCodeId, area: entry.areas?.[0] || '', userId: owner, tag: '', notes: '',
      breakMin: 0, eventId: null, staffingLineId: null, published: true, createdAt: at(date, 9, -14), sample: 'trades' });
  };
  let n = 0;
  for (const [from, to, count] of PERIODS) {
    const span = daysBetween(from, to);
    for (let i = 0; i < count; i++) {
      const date = addDays(from, Math.floor(rand() * span));
      const u = pick(weighted);
      const entry = pick(u.jobCodes);
      const others = coworkers(u, entry.jobCodeId);
      const created = at(date, 10 + Math.floor(rand() * 8), -(2 + Math.floor(rand() * 9)));
      const decided = (plus) => at(date, 12 + Math.floor(rand() * 4), -Math.max(1, plus));
      const roll = rand();
      const kind = roll < 0.45 || !others.length ? 'drop' : roll < 0.75 ? 'swap' : 'pickup';
      const base = { id: uid('req'), requesterId: u.id, note: '', createdAt: created, sample: 'trades' };
      if (kind === 'drop') {
        const o = rand();
        const taker = others.length ? pick(others) : null;
        if (o < 0.6 && taker) {
          const s = shift(date, entry, taker.id);
          store.insert('requests', { ...base, type: 'drop', shiftId: s.id, pickupUserId: taker.id, status: 'approved', acceptedAt: decided(2), resolvedAt: decided(1), resolvedBy: pick(approvers), resolution: '' });
        } else {
          const s = shift(date, entry, u.id);
          // Never "open": an open request shows on the Swaps page however old it is.
          const status = o >= 0.75 && taker ? 'denied' : 'cancelled';
          store.insert('requests', { ...base, type: 'drop', shiftId: s.id, status, ...(status === 'denied' ? { pickupUserId: taker.id, acceptedAt: decided(2), resolvedBy: pick(approvers) } : {}),
            resolvedAt: decided(1), resolution: '' });
        }
      } else if (kind === 'swap') {
        const t = pick(others);
        const tDate = addDays(date, 1 + Math.floor(rand() * 5));
        const tEntry = (t.jobCodes || []).find((e) => e.jobCodeId === entry.jobCodeId) || entry;
        const o = rand();
        const ok = o < 0.6;
        const mine = shift(date, entry, ok ? t.id : u.id);
        const theirs = shift(tDate, tEntry, ok ? u.id : t.id);
        const status = ok ? 'approved' : o < 0.8 ? 'declined' : o < 0.9 ? 'cancelled' : 'denied';
        store.insert('requests', { ...base, type: 'swap', shiftId: mine.id, targetShiftId: theirs.id, targetUserId: t.id, status,
          ...(['approved', 'denied'].includes(status) ? { acceptedAt: decided(2), resolvedBy: pick(approvers) } : {}), resolvedAt: decided(1), resolution: '' });
      } else {
        const o = rand();
        const status = o < 0.75 ? 'approved' : o < 0.9 ? 'denied' : 'cancelled';
        const s = shift(date, entry, status === 'approved' ? u.id : null);
        store.insert('requests', { ...base, type: 'pickup', shiftId: s.id, pickupUserId: u.id, status, resolvedAt: decided(1),
          ...(status !== 'cancelled' ? { resolvedBy: pick(approvers) } : {}), resolution: '' });
      }
      n++;
    }
  }
  return n;
}
