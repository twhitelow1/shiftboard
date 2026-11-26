// Trades & pickups by season (managers and up): for each person, how many shifts they put up and how many
// they picked up, per season (core/seasons.js) or for a custom date range. One helper does the counting so
// the report, the comparison, the CSV, a person's own counts and the tests always agree.
//
// The counts (the report's help tooltip says the same in words, web/src/i18n/*-reports.js):
//   putUp          give-aways (drops) plus trades they offered: requests they created, counted on the day
//                  they created them (whatever happened afterwards). putUp = givenAway + tradesOffered, and
//                  putUp = taken + waiting + notTaken + cancelled.
//   pickedUp       shifts that actually moved to them, counted on the day they moved (the approval, or the
//                  accept when no approval is needed): approved open-shift pickups (openPickedUp) plus
//                  approved give-aways they took (giveawaysTaken). Trades are not pickups.
//   tradesDone     approved trades they were in (offered or accepted), counted on the day of the approval.
//   taken          of what they put up, the ones that went through (approved).
//   waiting        of what they put up, still open or waiting on a manager, and the shift hasn't come yet.
//   notTaken       of what they put up, the ones nobody ended up taking: declined by the coworker, denied by a
//                  manager, or still open when the shift's day came.
//   cancelled      of what they put up, the ones withdrawn: by them, by a manager, or automatically because a
//                  manager changed or removed the shift.
//   hoursGiven / hoursTaken / netHours   the hours of the shifts that moved away from / to them (give-aways,
//                  pickups and both sides of trades), on the day they moved; net = taken − given. A shift
//                  that was deleted since counts 0 hours.
// Days are the restaurant's local calendar days of the timestamps. Requests (core/service.js "swaps"):
// { type: swap|drop|pickup, status: open|pending_approval|approved|denied|declined|cancelled, requesterId,
//   pickupUserId, targetUserId, shiftId, targetShiftId, createdAt, acceptedAt, resolvedAt }.
import { seasonOf, seasonById, seasonsBetween, seasonsOf } from './seasons.js';
import { todayStr, addDays } from './time.js';
import { hoursOf } from './forecast.js';
import { roleOf } from './roles.js';
import { cleanArea, sameArea } from './areas.js';
import { entryRooms, roomOfShift } from './layout.js';

export const COUNTS = ['putUp', 'givenAway', 'tradesOffered', 'taken', 'waiting', 'notTaken', 'cancelled',
  'pickedUp', 'openPickedUp', 'giveawaysTaken', 'tradesDone', 'hoursGiven', 'hoursTaken', 'netHours'];
const HOURS = new Set(['hoursGiven', 'hoursTaken', 'netHours']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = ['open', 'pending_approval'];

const zero = () => Object.fromEntries(COUNTS.map((k) => [k, 0]));
const round1 = (n) => Math.round(n * 10) / 10;
/** The restaurant's local day (YYYY-MM-DD) of an ISO timestamp, '' if none. */
export const dayOf = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : todayStr(d);
};

/** When the shift moved for an approved request (the approval; older data: the accept or the request). */
const movedAt = (r) => (r.status === 'approved' ? r.resolvedAt || r.acceptedAt || r.createdAt || '' : '');

/** What happened to something someone put up: taken | waiting | notTaken | cancelled. */
export function outcomeOf(r, shift, today) {
  if (r.status === 'approved') return 'taken';
  if (r.status === 'cancelled') return 'cancelled';
  if (ACTIVE.includes(r.status)) return shift && shift.date < today ? 'notTaken' : 'waiting';
  return 'notTaken'; // declined, denied
}

/**
 * Each request as dated counts for the people in it: [{ who, day, key, n }]. `shiftOf(id)` gives a shift (or
 * null), `hours(shift)` its hours. This is the one definition of every count above.
 */
export function factsOf(r, { shiftOf, hours, today }) {
  const out = [];
  const shift = shiftOf(r.shiftId);
  const target = r.targetShiftId ? shiftOf(r.targetShiftId) : null;
  const add = (who, day, key, n = 1) => { if (who && day) out.push({ who, day, key, n }); };
  if (r.type === 'drop' || r.type === 'swap') {
    const day = dayOf(r.createdAt);
    add(r.requesterId, day, 'putUp');
    add(r.requesterId, day, r.type === 'drop' ? 'givenAway' : 'tradesOffered');
    add(r.requesterId, day, outcomeOf(r, shift, today));
  }
  if (r.status !== 'approved') return out;
  const day = dayOf(movedAt(r));
  const h = shift ? hours(shift) : 0;
  if (r.type === 'drop') {
    add(r.requesterId, day, 'hoursGiven', h);
    add(r.pickupUserId, day, 'pickedUp');
    add(r.pickupUserId, day, 'giveawaysTaken');
    add(r.pickupUserId, day, 'hoursTaken', h);
  } else if (r.type === 'pickup') {
    const who = r.pickupUserId || r.requesterId;
    add(who, day, 'pickedUp');
    add(who, day, 'openPickedUp');
    add(who, day, 'hoursTaken', h);
  } else if (r.type === 'swap') {
    const th = target ? hours(target) : 0;
    for (const who of [r.requesterId, r.targetUserId]) add(who, day, 'tradesDone');
    add(r.requesterId, day, 'hoursGiven', h);
    add(r.requesterId, day, 'hoursTaken', th);
    add(r.targetUserId, day, 'hoursGiven', th);
    add(r.targetUserId, day, 'hoursTaken', h);
  }
  return out;
}

/** A period from what the report asked for: a custom range, a season id, else the season `today` is in. */
export function periodOf({ season, from, to } = {}, settings, today, lang = 'en') {
  if (DATE.test(from || '') && DATE.test(to || '') && from <= to) {
    return { id: 'custom', custom: true, start: from, end: to, label: `${from} – ${to}` };
  }
  return seasonById(season, settings, lang) || seasonOf(today, settings, lang);
}

/** The same season a year earlier, and the season just before this one that isn't the same kind (the "other" season). */
export function comparePeriods(season, settings, lang = 'en') {
  if (!season || season.custom) return [];
  const lastYear = seasonById(`${season.key}-${season.startYear - 1}`, settings, lang);
  let other = null;
  let cur = season;
  for (let i = 0; i < 6 && !other; i++) {
    cur = seasonOf(addDays(cur.start, -1), settings, lang);
    if (cur.key !== season.key) other = cur;
  }
  return [lastYear, other].filter(Boolean);
}

/**
 * The counts per person for one or more periods.
 * @param {object} o
 * @param o.requests  the requests (all of them; only the ones touching a period count)
 * @param o.shiftOf   (id) => shift or null
 * @param o.settings  the restaurant's settings (for hours of "until close" shifts)
 * @param o.periods   [{ start, end }] (YYYY-MM-DD, inclusive)
 * @param o.today     YYYY-MM-DD (open requests for a past shift count as not taken)
 * @param o.match     (request) => boolean: the position / room filter
 * @returns one Map(userId → counts) per period
 */
export function countByPerson({ requests, shiftOf, settings, periods, today, match = () => true }) {
  const memo = new Map();
  const shift = (id) => { if (!memo.has(id)) memo.set(id, id ? shiftOf(id) : null); return memo.get(id); };
  const hours = (s) => hoursOf(s, settings);
  const out = periods.map(() => new Map());
  const first = periods.reduce((m, p) => (p.start < m ? p.start : m), '9999');
  const last = periods.reduce((m, p) => (p.end > m ? p.end : m), '0000');
  for (const r of requests) {
    // Quick skip: a request can only count on its created or approved day.
    const c = dayOf(r.createdAt);
    const m = dayOf(movedAt(r));
    if (!((c >= first && c <= last) || (m && m >= first && m <= last))) continue;
    if (!match(r, shift)) continue;
    for (const f of factsOf(r, { shiftOf: shift, hours, today })) {
      periods.forEach((p, i) => {
        if (f.day < p.start || f.day > p.end) return;
        let row = out[i].get(f.who);
        if (!row) out[i].set(f.who, (row = zero()));
        row[f.key] += f.n;
      });
    }
  }
  for (const map of out) {
    for (const row of map.values()) {
      row.netHours = row.hoursTaken - row.hoursGiven;
      for (const k of HOURS) row[k] = round1(row[k]);
    }
  }
  return out;
}

/** Totals of rows (each a counts object). */
export function totalsOf(rows) {
  const t = zero();
  for (const r of rows) for (const k of COUNTS) t[k] += Number(r[k]) || 0;
  for (const k of HOURS) t[k] = round1(t[k]);
  return t;
}

// ---------- CSV ----------
// Cells that start with = + - @ (or a tab/return) could run as a formula in a spreadsheet; a negative number stays a number.
const cell = (v) => {
  if (typeof v === 'number') return String(v);
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The report as CSV. columns: [{ key, label }] in the reader's language; rows: report rows (name + counts). */
export function statsCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ---------- seasons setting ----------
/** The seasons an admin typed, cleaned, or null when they don't cover every month exactly once. */
export function validSeasons(list) {
  if (!Array.isArray(list) || !list.length || list.length > 12) return null;
  const want = list.map((s) => ({ key: String(s?.key || '').trim().toLowerCase(), label: String(s?.label || '').trim().slice(0, 40),
    startMonth: Math.trunc(Number(s?.startMonth)), endMonth: Math.trunc(Number(s?.endMonth)) }));
  const got = seasonsOf({ seasons: want });
  const same = got.length === want.length && got.every((g, i) => g.key === want[i].key && g.startMonth === want[i].startMonth && g.endMonth === want[i].endMonth);
  return same ? got.map(({ key, label, startMonth, endMonth }) => ({ key, ...(label ? { label } : {}), startMonth, endMonth })) : null;
}

// ---------- RPC methods (merged into core/service.js) ----------

/**
 * tradeStats.summary   the report (managers and up)
 * tradeStats.list      one person's requests in a period (managers and up; anyone for themselves)
 * tradeStats.get       my own counts this season (anyone)
 * seasons.save         Settings → Seasons (admins)
 */
export function tradeStatsApi({ store, settings, fail, needAuth, needMgr, needAdmin, isMgr, today, langOf, putSettings }) {
  const userName = (id) => store.get('users', id)?.name || '';
  const allRequests = () => store.list('requests', (r) => r.type === 'drop' || r.type === 'swap' || r.type === 'pickup');

  /** The position / room filter as a request test: its shift, or for a trade either shift, is in it. */
  function matcher({ jobCodeId, area }) {
    const room = cleanArea(area);
    if (!jobCodeId && !room) return () => true;
    const jobs = new Map(store.list('jobCodes').map((j) => [j.id, j]));
    const fits = (s) => !!s && (!jobCodeId || s.jobCodeId === jobCodeId) && (!room || sameArea(roomOfShift(s, jobs.get(s.jobCodeId)), room));
    return (r, shiftOf) => fits(shiftOf(r.shiftId)) || (r.type === 'swap' && fits(shiftOf(r.targetShiftId)));
  }
  /** People listed even with no activity: active people with a position (in the position or room, when filtered). */
  function listed({ jobCodeId, area }) {
    const room = cleanArea(area);
    const jobs = new Map(store.list('jobCodes').map((j) => [j.id, j]));
    return store.list('users', (u) => u.active !== false && u.onSchedule !== false && u.role !== 'events' && (u.jobCodes || []).length > 0
      && (!jobCodeId || (u.jobCodes || []).some((e) => e.jobCodeId === jobCodeId))
      && (!room || (u.jobCodes || []).some((e) => (!jobCodeId || e.jobCodeId === jobCodeId) && entryRooms(e, jobs.get(e.jobCodeId)).some((a) => sameArea(a, room)))));
  }
  const rowFor = (u, counts) => ({ userId: u.id, name: u.name, active: u.active !== false, role: roleOf(u),
    jobCodeIds: (u.jobCodes || []).map((e) => e.jobCodeId), ...(counts || zero()) });

  /** The seasons with any activity (newest first), always with the current one. */
  function seasonsWithData(lang) {
    const st = settings();
    const now = today();
    const days = new Set();
    let earliest = now;
    for (const r of allRequests()) {
      for (const d of [dayOf(r.createdAt), dayOf(movedAt(r))]) {
        if (!d) continue;
        days.add(seasonOf(d, st).id);
        if (d < earliest) earliest = d;
      }
    }
    const cur = seasonOf(now, st, lang).id;
    return seasonsBetween(earliest, now, st, lang).filter((s) => s.id === cur || days.has(s.id)).map((s) => ({ ...s, current: s.id === cur }));
  }

  return {
    'tradeStats.summary': (actor, a = {}) => {
      needMgr(actor);
      const st = settings();
      const lang = langOf(actor);
      const now = today();
      const period = periodOf(a, st, now, lang);
      const filter = { jobCodeId: a.jobCodeId || '', area: a.area || '' };
      const periods = [period, ...(a.compare ? comparePeriods(period, st, lang) : [])];
      const maps = countByPerson({ requests: allRequests(), shiftOf: (id) => store.get('shifts', id), settings: st, periods, today: now, match: matcher(filter) });
      const people = new Map(listed(filter).map((u) => [u.id, u]));
      for (const m of maps) for (const id of m.keys()) if (!people.has(id)) { const u = store.get('users', id); if (u) people.set(id, u); }
      const rows = [...people.values()].map((u) => rowFor(u, maps[0].get(u.id))).sort((x, y) => x.name.localeCompare(y.name));
      const out = { period, seasons: seasonsWithData(lang), rows, totals: totalsOf(rows), filter };
      if (a.compare) {
        out.compare = {
          periods,
          rows: [...people.values()].map((u) => ({ userId: u.id, name: u.name, cells: maps.map((m) => m.get(u.id) || zero()) })).sort((x, y) => x.name.localeCompare(y.name)),
          totals: maps.map((m) => totalsOf([...m.values()])),
        };
      }
      return out;
    },

    'tradeStats.list': (actor, a = {}) => {
      needAuth(actor);
      const userId = a.userId || actor.id;
      if (userId !== actor.id && !isMgr(actor)) fail(403, 'Managers only');
      const st = settings();
      const now = today();
      const period = periodOf(a, st, now, langOf(actor));
      const memo = new Map();
      const shiftOf = (id) => { if (!id) return null; if (!memo.has(id)) memo.set(id, store.get('shifts', id)); return memo.get(id); };
      const match = matcher({ jobCodeId: a.jobCodeId || '', area: a.area || '' });
      const requests = [];
      for (const r of allRequests()) {
        if (![r.requesterId, r.pickupUserId, r.targetUserId].includes(userId) || !match(r, shiftOf)) continue;
        const facts = factsOf(r, { shiftOf, hours: (s) => hoursOf(s, st), today: now })
          .filter((f) => f.who === userId && f.day >= period.start && f.day <= period.end);
        if (!facts.length) continue;
        const keys = [...new Set(facts.map((f) => f.key))].filter((k) => !HOURS.has(k));
        const hrs = (k) => round1(facts.filter((f) => f.key === k).reduce((t, f) => t + f.n, 0));
        const shift = shiftOf(r.shiftId);
        const target = shiftOf(r.targetShiftId);
        const side = r.requesterId === userId && r.type !== 'pickup' ? 'requester' : r.targetUserId === userId ? 'target' : 'pickup';
        const other = side === 'requester' ? (r.type === 'swap' ? r.targetUserId : r.pickupUserId) : r.requesterId === userId ? null : r.requesterId;
        requests.push({
          id: r.id, type: r.type, status: r.status, side, createdAt: r.createdAt || null, movedAt: movedAt(r) || null,
          outcome: r.type !== 'pickup' && side === 'requester' ? outcomeOf(r, shift, now) : null, counts: keys,
          hoursGiven: hrs('hoursGiven'), hoursTaken: hrs('hoursTaken'),
          shift: shift ? { date: shift.date, start: shift.start, end: shift.end || null, jobCodeId: shift.jobCodeId, area: shift.area || '' } : null,
          targetShift: target ? { date: target.date, start: target.start, end: target.end || null, jobCodeId: target.jobCodeId, area: target.area || '' } : null,
          otherUserId: other || null, otherName: other ? userName(other) : '',
        });
      }
      requests.sort((x, y) => String(y.movedAt || y.createdAt).localeCompare(String(x.movedAt || x.createdAt)));
      return { period, person: { id: userId, name: userName(userId) }, requests };
    },

    'tradeStats.get': (actor, a = {}) => {
      needAuth(actor);
      const st = settings();
      const now = today();
      const period = periodOf({ season: a.season }, st, now, langOf(actor));
      const [map] = countByPerson({ requests: allRequests(), shiftOf: (id) => store.get('shifts', id), settings: st, periods: [period], today: now });
      return { period, counts: map.get(actor.id) || zero() };
    },

    'seasons.save': (actor, { seasons } = {}) => {
      needAdmin(actor);
      const clean = validSeasons(seasons);
      if (!clean) fail(400, 'Every month must be in exactly one season');
      putSettings({ seasons: clean });
      return { seasons: seasonsOf(settings()) };
    },
  };
}
