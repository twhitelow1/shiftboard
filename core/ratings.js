// Ratings and skill mix (Settings → Ratings, Team → person, the schedule's Skill mix panel, the publish warning).
//
// A rating says how strong a person is in one of their positions, on the restaurant's scale (default 1–5, an admin can
// make it 1–3 or 1–10 and name the levels: 5 = "Lead", 1 = "Trainee"). Rules then say what mix a shift needs ("Servers,
// Fri–Sat dinner: at least 2 rated 5; at most 3 rated 3 or below; average 3.5 or more"), the schedule shows which fail
// and suggests who could be added or swapped in, and the AI that will draft schedules reads all of it (skillMix.week).
//
// Ratings are sensitive. Only people with the ratingsView role feature (managers and up by default, supervisors when
// an admin turns it on, employees never) see them, and only through the RPCs below: they live in their own
// collections, so no other answer (bootstrap, the schedule, Team, CSVs, PDFs, notifications, the tools) can carry them.
// Nobody sees or changes their own rating. Checked here, not per RPC (like the staffingPars role feature), so the
// Roles & features parity test holds.
//
// Collections:
//   ratings        one per person per position: { id: rtg_<userId>_<jobCodeId>, userId, jobCodeId, value (null: unrated,
//                  never 0), source: 'manual', note, setAt, setBy, suggested: null, history: [{ at, by, from, to, note,
//                  source }] (newest last, the last 50) }. `suggested` is where a rating computed from signals will go
//                  later ({ value, at, from: [signal ids] }); phase 1 never writes it.
//   ratingSignals  later: the inputs a suggested rating comes from: { id, userId, jobCodeId?, source: one of
//                  SIGNAL_SOURCES, value, date, note, createdBy }. Nothing writes it yet; training quiz scores and kudos
//                  are computed on the fly and shown "for reference" next to the rating.
//   ratingConfig   'scale': { min, max, labels: { '5': 'Lead' } } (absent: 1–5, no names)
//   skillRules     { id, jobCodeId, type: 'atLeast' | 'atMost' | 'minAvg', count, rating, avg, days: [0–6] ([] every day),
//                  daypart: '' | a daypart's name, room: '' | a room, programmingId: '' | a regular programming item (the
//                  rule then runs when the item runs, in its rooms and time), note, active, order, createdAt, createdBy,
//                  updatedAt, updatedBy }
//
// Changing the scale re-maps every rating and every rule's threshold onto the new scale (5 on 1–5 becomes 10 on 1–10;
// 3 becomes 6), so the top people stay top and the rules keep meaning the same thing. Each re-mapped rating gets a
// history entry with source 'scale'.
import { uid } from './store.js';
import { addDays, dow, range, toMin } from './time.js';
import { effectiveShift, hoursOf } from './forecast.js';
import { cleanArea, sameArea } from './areas.js';
import { roleAllows, ROLE_OFF } from './role-features.js';
import { roleOf, canManageUser } from './roles.js';
import { roomOfShift } from './layout.js';
import { dayProgramming, windowOf } from './programming.js';

export const RATING_COL = 'ratings';
export const SIGNAL_COL = 'ratingSignals';
export const CONFIG_COL = 'ratingConfig';
export const RULE_COL = 'skillRules';
export const RULE_TYPES = ['atLeast', 'atMost', 'minAvg'];
/** Where a rating or a signal comes from. Phase 1 writes 'manual' (and 'scale' when the scale changes). */
export const SIGNAL_SOURCES = ['manual', 'scale', 'review', 'writeup', 'quiz', 'attendance', 'kudos'];
export const DEFAULT_SCALE = Object.freeze({ min: 1, max: 5, labels: {} });
export const MAX_RULES = 200;
const HISTORY = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ratingId = (userId, jobCodeId) => `rtg_${userId}_${jobCodeId}`;
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- the scale ----------

export function scaleOf(store) {
  const s = store.get(CONFIG_COL, 'scale');
  return s ? { min: s.min, max: s.max, labels: s.labels || {} } : { ...DEFAULT_SCALE, labels: {} };
}

/** A scale from the editor, checked: whole numbers, 0–10 min, 2–10 max, at least two levels, short level names. */
export function cleanScale(raw, fail) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const min = Number(a.min), max = Number(a.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 10 || max - min < 1) fail(400, 'A scale is whole numbers from 0 to 10, with at least two levels');
  const labels = {};
  for (const [k, v] of Object.entries(a.labels && typeof a.labels === 'object' ? a.labels : {})) {
    const n = Number(k);
    const name = text(v, 24);
    if (Number.isInteger(n) && n >= min && n <= max && name) labels[String(n)] = name;
  }
  return { min, max, labels };
}

/** A value on one scale moved to another, keeping its place (5 of 1–5 → 10 of 1–10). round: whole numbers. */
export function remap(v, from, to, round = true) {
  if (v == null) return null;
  const span = from.max - from.min;
  const x = to.min + ((Number(v) - from.min) * (to.max - to.min)) / (span || 1);
  const y = Math.min(to.max, Math.max(to.min, x));
  return round ? Math.round(y) : round1(y);
}

/** A rating value checked against the scale: null clears it (unrated); 0 is a rating only when the scale starts at 0. */
export function cleanValue(v, scale, fail) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < scale.min || n > scale.max) fail(400, 'Pick a rating on the scale');
  return n;
}

// ---------- rules ----------

/** A rule from the editor, checked. ctx: { jobExists(id), rooms, dayparts (names), programming (ids), scale, fail }. */
export function cleanRule(raw, { jobExists, rooms = [], dayparts = [], programming = [], scale, fail }) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const jobCodeId = String(a.jobCodeId || '');
  if (!jobExists(jobCodeId)) fail(400, 'That position doesn’t exist');
  if (!RULE_TYPES.includes(a.type)) fail(400, 'Pick a kind of rule');
  const out = { jobCodeId, type: a.type, count: null, rating: null, avg: null };
  if (a.type === 'minAvg') {
    const avg = Number(a.avg);
    if (!Number.isFinite(avg) || avg < scale.min || avg > scale.max) fail(400, 'Pick a rating on the scale');
    out.avg = round1(avg);
  } else {
    const count = Number(a.count);
    if (!Number.isInteger(count) || count < 0 || count > 50) fail(400, 'A count is a whole number from 0 to 50');
    out.count = count;
    out.rating = cleanValue(a.rating, scale, fail);
    if (out.rating == null) fail(400, 'Pick a rating on the scale');
  }
  out.days = Array.isArray(a.days) ? [...new Set(a.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  out.daypart = '';
  if (a.daypart) {
    const hit = dayparts.find((d) => d.toLowerCase() === String(a.daypart).toLowerCase());
    if (!hit) fail(400, 'Pick one of the dayparts');
    out.daypart = hit;
  }
  out.room = '';
  if (a.room) {
    const hit = rooms.find((r) => sameArea(r, a.room));
    if (!hit) fail(400, 'Pick one of the venue’s rooms');
    out.room = hit;
  }
  out.programmingId = '';
  if (a.programmingId) {
    if (!programming.includes(String(a.programmingId))) fail(404, 'Programming not found');
    out.programmingId = String(a.programmingId);
  }
  out.note = text(a.note, 120);
  out.active = a.active !== false;
  return out;
}

// ---------- evaluating ----------

const spanOf = (s, settings) => {
  const e = effectiveShift(s, settings);
  let a = toMin(e.start), b = toMin(e.end || e.start);
  if (b <= a) b += 1440;
  return [a, b];
};
const daypartWindow = (settings, name) => {
  const dp = (settings.dayparts || []).find((d) => d.name === name);
  if (!dp?.start || !dp?.end) return null;
  let a = toMin(dp.start), b = toMin(dp.end);
  if (b <= a) b += 1440;
  return [a, b];
};

/**
 * Which shifts a rule looks at on a date. Returns null when it doesn't apply that day (weekday, a closed day, its
 * programming item not running), else { shifts, window, rooms, item }. ctx: { settings, jobs, day (dayProgramming's
 * answer, for rules on a programming item) }.
 */
export function ruleGroup(rule, date, dayShifts, { settings = {}, jobs = {}, day = null }) {
  if (rule.active === false) return null;
  if ((settings.closedDays || []).includes(dow(date))) return null;
  let window = null;
  let rooms = rule.room ? [rule.room] : [];
  let item = null;
  if (rule.programmingId) {
    item = (day?.items || []).find((x) => x.id === rule.programmingId && (x.status === 'on' || x.status === 'partial'));
    if (!item) return null;
    window = item.window;
    if (!rooms.length) rooms = item.roomsLeft || item.rooms || [];
  }
  if (rule.days?.length && !rule.days.includes(dow(date))) return null;
  if (rule.daypart) {
    const w = daypartWindow(settings, rule.daypart);
    if (w) window = window ? [Math.max(window[0], w[0]), Math.min(window[1], w[1])] : w;
  }
  const shifts = dayShifts.filter((s) => s.userId && s.jobCodeId === rule.jobCodeId
    && (!rule.programmingId || !s.eventId)
    && (!rooms.length || rooms.some((r) => sameArea(r, roomOfShift(s, jobs[s.jobCodeId]))))
    && (!window || (() => { const [a, b] = spanOf(s, settings); return a < window[1] && window[0] < b; })()));
  return { shifts, window, rooms, item };
}

/**
 * One rule on one date: { ruleId, date, status: 'ok' | 'fail' | 'na', have, need, avg, people: [{ userId, shiftId,
 * rating }], unrated }. ratingOf(userId, jobCodeId) → number | null. 'na': a minimum average with nobody rated.
 * Unrated people never count toward "at least" or "at most" and are left out of the average (listed as unrated).
 */
export function evaluateRule(rule, group, ratingOf) {
  const seen = new Map();
  for (const s of group.shifts) if (!seen.has(s.userId)) seen.set(s.userId, { userId: s.userId, shiftId: s.id, rating: ratingOf(s.userId, rule.jobCodeId) });
  const people = [...seen.values()].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  const rated = people.filter((p) => p.rating != null);
  const unrated = people.length - rated.length;
  const avg = rated.length ? round1(rated.reduce((t, p) => t + p.rating, 0) / rated.length) : null;
  let status, have, need;
  if (rule.type === 'atLeast') { have = rated.filter((p) => p.rating >= rule.rating).length; need = rule.count; status = have >= need ? 'ok' : 'fail'; }
  else if (rule.type === 'atMost') { have = rated.filter((p) => p.rating <= rule.rating).length; need = rule.count; status = have <= need ? 'ok' : 'fail'; }
  else { have = avg; need = rule.avg; status = avg == null ? 'na' : avg >= rule.avg ? 'ok' : 'fail'; }
  return { ruleId: rule.id, date: group.date, status, have, need, avg, people, unrated, scheduled: people.length };
}

/** Does a rating meet what a failing rule needs from someone new? */
export function helps(rule, rating, result) {
  if (rating == null) return false;
  if (rule.type === 'atLeast') return rating >= rule.rating;
  if (rule.type === 'atMost') return rating > rule.rating;
  return rating >= rule.avg && rating > (result?.avg ?? -Infinity); // above today's average and the target: it raises it
}
/** Is a scheduled person the one to swap out for a failing rule? */
function weak(rule, rating, result) {
  if (rule.type === 'atLeast') return rating == null || rating < rule.rating;
  if (rule.type === 'atMost') return rating != null && rating <= rule.rating;
  return rating != null && rating < (result?.avg ?? rule.avg);
}

// Conflicts that keep someone off a suggestion (core/service.js conflictList's codes). The rest are warnings.
const BLOCKING = new Set(['inactive', 'untrained', 'overlap', 'timeOffApproved', 'dayOff', 'unavailable', 'availableFrom', 'availableUntil', 'unknown']);

// ---------- the API ----------

/**
 * ratings.*, skillRules.*, skillMix.* RPCs. deps: { store, settings, fail, needAuth, needAdmin, now, today, layouts,
 *   conflictList(userId, shift, ignoreIds) → [{ code, args }], qualified(user, jobCodeId) }.
 *   ratings.get                 { jobCodeId?, room? } the bulk grid: people × positions, the scale
 *   ratings.person.get          { userId } one person's ratings per position, history, and signals for reference
 *   ratings.set                 { userId, jobCodeId, value (null: unrated), note? }            (ratingsEdit)
 *   ratings.setMany             { changes: [{ userId, jobCodeId, value }], note? }           (ratingsEdit)
 *   ratings.scale.save          { min, max, labels } (admins): re-maps ratings and rules       (ratingsEdit)
 *   skillRules.list             the rules and what they can be scoped to
 *   skillRules.save / .delete   a rule                                                          (ratingsEdit)
 *   skillMix.week               { weekStart, suggest?, includeRatings? } each day's rule results (the schedule, the
 *                               publish warning, the AI); includeRatings adds ratings by position
 *   skillMix.suggestions.list   { date, ruleId } who could be added or swapped in
 */
export function ratingsApi({ store, settings, fail, needAuth, needAdmin, now, layouts, conflictList, qualified }) {
  const rank = (u) => ({ super_admin: 5, admin: 4, manager: 3, supervisor: 2, employee: 1 })[roleOf(u)] || 1;
  const canView = (a) => !!a && rank(a) >= 2 && roleAllows(a, settings()).ratingsView === true;
  const canEdit = (a) => canView(a) && roleAllows(a, settings()).ratingsEdit === true;
  const needView = (a) => { needAuth(a); if (!canView(a)) fail(403, ROLE_OFF); };
  const needEdit = (a) => { needAuth(a); if (!canEdit(a)) fail(403, ROLE_OFF); };
  /** Whose ratings this viewer sees: never their own; people they manage (a supervisor: employees). */
  const seesPerson = (a, u) => !!u && u.id !== a.id && (canManageUser(a, u) || (rank(a) === 2 && roleOf(u) === 'employee'));
  const st = () => settings();
  const scale = () => scaleOf(store);
  const jobs = () => Object.fromEntries(store.list('jobCodes').map((j) => [j.id, j]));
  const activeJobs = () => store.list('jobCodes', (j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const people = () => store.list('users', (u) => u.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const ratingDoc = (userId, jobCodeId) => store.get(RATING_COL, ratingId(userId, jobCodeId));
  const valueOf = (userId, jobCodeId) => { const r = ratingDoc(userId, jobCodeId); return r && r.value != null ? r.value : null; };
  const rules = () => store.list(RULE_COL).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || '').localeCompare(b.createdAt || ''));
  const roomNames = () => {
    const out = (layouts.current().rooms || []).map((r) => r.room).filter(Boolean);
    for (const r of st().rooms || []) if (!/buy-?out/i.test(r) && !out.some((x) => sameArea(x, r))) out.push(cleanArea(r));
    return out;
  };
  const stamp = () => now().toISOString();

  /** Set one rating (checked), with its history entry. Returns the doc, or null when nothing changed. */
  function setOne(actor, { userId, jobCodeId, value, note, source = 'manual' }) {
    const u = store.get('users', String(userId || ''));
    if (!u || u.active === false) fail(404, 'Person not found');
    if (u.id === actor.id) fail(403, 'Nobody rates themselves');
    if (!seesPerson(actor, u)) fail(403, 'You can’t rate this person');
    if (!jobs()[jobCodeId] || !qualified(u, jobCodeId)) fail(400, 'They don’t work that position');
    const v = cleanValue(value, scale(), fail);
    const cur = ratingDoc(u.id, jobCodeId);
    const from = cur?.value ?? null;
    const n = text(note, 200);
    if (from === v && !n) return null;
    const at = stamp();
    const entry = { at, by: actor.id, from, to: v, source, ...(n ? { note: n } : {}) };
    const fields = { value: v, source, note: n || (from === v ? cur?.note || '' : ''), setAt: at, setBy: actor.id };
    if (cur) return store.update(RATING_COL, cur.id, { ...fields, history: [...(cur.history || []), entry].slice(-HISTORY) });
    return store.insert(RATING_COL, { id: ratingId(u.id, jobCodeId), userId: u.id, jobCodeId, ...fields, suggested: null, history: [entry] });
  }

  const nameOf = (id) => store.get('users', id)?.name || '';
  const ruleView = (r) => ({ ...r });
  const dayparts = () => (st().dayparts || []).map((d) => d.name).filter(Boolean);
  const programmingItems = () => store.list('programming').map((x) => ({ id: x.id, name: x.name, days: x.days || [], rooms: x.rooms || [] }));

  /** For reference next to a rating: training quiz scores and kudos (last 180 days), computed, never stored. */
  function signalsFor(u, jobCodeId) {
    const since = addDays(now().toISOString().slice(0, 10), -180);
    const quizzes = Object.fromEntries(store.list('quizzes').map((q) => [q.id, q]));
    const tries = store.list('quizAttempts', (t) => t.userId === u.id && t.submittedAt && t.submittedAt.slice(0, 10) >= since
      && (!jobCodeId || !(quizzes[t.quizId]?.jobCodeIds || []).length || quizzes[t.quizId].jobCodeIds.includes(jobCodeId)));
    const kudos = store.list('kudos', (k) => k.userId === u.id && (k.date || '') >= since);
    return {
      quiz: tries.length ? { source: 'quiz', attempts: tries.length, avgPct: Math.round(tries.reduce((t, x) => t + (x.pct || 0), 0) / tries.length) } : null,
      kudos: kudos.length ? { source: 'kudos', count: kudos.length } : null,
    };
  }

  /** The week's results. Rules on days they apply, with people and ratings (only those the viewer may see). */
  function week(actor, ws, { includeRatings = false } = {}) {
    if (!DATE.test(String(ws || ''))) fail(400, 'Pick a week');
    const settingsNow = st();
    const js = jobs();
    const list = rules().filter((r) => r.active !== false);
    const end = addDays(ws, 6);
    const shifts = store.list('shifts', (s) => s.date >= ws && s.date <= end);
    const items = store.list('programming');
    const evs = store.list('events', (e) => e.date >= ws && e.date <= end);
    const rooms = roomNames();
    const cache = new Map();
    const ratingOf = (userId, jobCodeId) => { const k = `${userId}|${jobCodeId}`; if (!cache.has(k)) cache.set(k, valueOf(userId, jobCodeId)); return cache.get(k); };
    const visible = (userId) => seesPerson(actor, store.get('users', userId));
    const days = range(ws, 7).map((date) => {
      const dayShifts = shifts.filter((s) => s.date === date);
      const day = list.some((r) => r.programmingId) ? dayProgramming({ date, items, events: evs, settings: settingsNow, roomNames: rooms, today: date }) : null;
      const results = [];
      for (const r of list) {
        const g = ruleGroup(r, date, dayShifts, { settings: settingsNow, jobs: js, day });
        if (!g) continue;
        const res = evaluateRule(r, { ...g, date }, ratingOf);
        res.people = res.people.map((p) => ({ userId: p.userId, name: nameOf(p.userId), shiftId: p.shiftId, ...(visible(p.userId) ? { rating: p.rating } : { hidden: true }) }));
        results.push(res);
      }
      return { date, results, failing: results.filter((x) => x.status === 'fail').length };
    });
    const out = { weekStart: ws, scale: scale(), canEdit: canEdit(actor), rules: list.map(ruleView), days, failing: days.reduce((t, d) => t + d.failing, 0) };
    if (includeRatings) {
      out.ratingsByPosition = Object.fromEntries(activeJobs().map((j) => [j.id, people().filter((u) => qualified(u, j.id) && seesPerson(actor, u))
        .map((u) => ({ userId: u.id, name: u.name, rating: ratingOf(u.id, j.id) }))]).filter(([, l]) => l.length));
    }
    return out;
  }

  /** Who could be added or swapped in for a failing rule on a date. */
  function suggestions(actor, date, ruleId) {
    if (!DATE.test(String(date || ''))) fail(400, 'Pick a date');
    const rule = store.get(RULE_COL, String(ruleId || ''));
    if (!rule) fail(404, 'Rule not found');
    const settingsNow = st();
    const js = jobs();
    const dayShifts = store.list('shifts', (s) => s.date === date);
    const day = rule.programmingId ? dayProgramming({ date, items: store.list('programming'), events: store.list('events', (e) => e.date === date), settings: settingsNow, roomNames: roomNames(), today: date }) : null;
    const g = ruleGroup(rule, date, dayShifts, { settings: settingsNow, jobs: js, day });
    if (!g) return { date, ruleId: rule.id, applies: false, status: 'na', candidates: [] };
    const res = evaluateRule(rule, { ...g, date }, valueOf);
    // The shift a new person would work: like one already in the group, else the daypart, the programming, the day's hours.
    const like = g.shifts[0];
    const fromMin = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
    const hours = settingsNow.hours?.[dow(date)] || {};
    const template = like ? { date, start: like.start, end: like.end || null, jobCodeId: rule.jobCodeId, area: like.area || '', breakMin: like.breakMin || 0 }
      : { date, start: g.window ? fromMin(g.window[0]) : hours.open || '17:00', end: g.window ? fromMin(g.window[1]) : hours.close || null, jobCodeId: rule.jobCodeId,
        area: g.rooms.length === 1 ? g.rooms[0] : '', breakMin: 0 };
    if (template.end === template.start) template.end = null;
    if (res.status !== 'fail') return { date, ruleId: rule.id, applies: true, status: res.status, template, candidates: [] };
    const ws = (() => { let d = date; while (dow(d) !== Number(settingsNow.weekStartDow || 0)) d = addDays(d, -1); return d; })();
    const weekShifts = store.list('shifts', (s) => s.date >= ws && s.date <= addDays(ws, 6) && s.userId);
    const inGroup = new Set(g.shifts.map((s) => s.userId));
    // Swap targets: drafts in the group whose person is what the rule has too much of (or too little of), weakest first.
    const targets = g.shifts.filter((s) => !s.published && weak(rule, valueOf(s.userId, rule.jobCodeId), res) && seesPerson(actor, store.get('users', s.userId)))
      .sort((a, b) => (valueOf(a.userId, rule.jobCodeId) ?? -1) - (valueOf(b.userId, rule.jobCodeId) ?? -1));
    const out = [];
    for (const u of people()) {
      if (inGroup.has(u.id) || !qualified(u, rule.jobCodeId) || !seesPerson(actor, u)) continue;
      const rating = valueOf(u.id, rule.jobCodeId);
      if (!helps(rule, rating, res)) continue;
      const codes = conflictList(u.id, { id: null, ...template }, []).map((c) => c.code);
      if (codes.some((c) => BLOCKING.has(c))) continue;
      const mine = weekShifts.filter((s) => s.userId === u.id);
      const weekHours = round1(mine.reduce((t, s) => t + hoursOf(s, settingsNow), 0));
      const add = rule.type === 'atMost' ? null : { ...template };
      const extra = hoursOf({ ...template }, settingsNow);
      if (u.maxHours && weekHours + extra > u.maxHours) continue;
      if (u.maxDays && !mine.some((s) => s.date === date) && new Set(mine.map((s) => s.date)).size + 1 > u.maxDays) continue;
      let swap = null;
      for (const s of targets) {
        const c = conflictList(u.id, s, [s.id]).map((x) => x.code);
        if (c.some((x) => BLOCKING.has(x))) continue;
        swap = { shiftId: s.id, userId: s.userId, name: nameOf(s.userId), rating: valueOf(s.userId, rule.jobCodeId),
          shift: { id: s.id, date: s.date, start: s.start, end: s.end || null, jobCodeId: s.jobCodeId, area: s.area || '', tag: s.tag || '', notes: s.notes || '', breakMin: s.breakMin || 0,
            eventId: s.eventId || null, staffingLineId: s.staffingLineId || null } };
        break;
      }
      if (!add && !swap) continue;
      out.push({ userId: u.id, name: u.name, rating, weekHours, warnings: codes.filter((c) => !BLOCKING.has(c)), add, swap });
    }
    out.sort((a, b) => b.rating - a.rating || a.weekHours - b.weekHours || a.name.localeCompare(b.name));
    return { date, ruleId: rule.id, applies: true, status: res.status, template, candidates: out.slice(0, 8) };
  }

  return {
    'ratings.get': (actor, { jobCodeId = '', room = '' } = {}) => {
      needView(actor);
      const js = activeJobs().filter((j) => !jobCodeId || j.id === jobCodeId);
      const rows = people().filter((u) => seesPerson(actor, u) && js.some((j) => qualified(u, j.id))
        && (!room || (u.jobCodes || []).some((e) => js.some((j) => j.id === e.jobCodeId) && [...(e.areas || []), store.get('jobCodes', e.jobCodeId)?.department || ''].some((a) => sameArea(a, room)))))
        .map((u) => ({ userId: u.id, name: u.name, jobCodeIds: js.filter((j) => qualified(u, j.id)).map((j) => j.id),
          ratings: Object.fromEntries(js.filter((j) => qualified(u, j.id)).map((j) => [j.id, valueOf(u.id, j.id)])) }));
      return { scale: scale(), canEdit: canEdit(actor), canScale: canEdit(actor) && rank(actor) >= 4, positions: js.filter((j) => rows.some((r) => r.jobCodeIds.includes(j.id))).map((j) => j.id),
        rooms: roomNames(), rows, signalSources: SIGNAL_SOURCES };
    },
    'ratings.person.get': (actor, { userId } = {}) => {
      needView(actor);
      const u = store.get('users', String(userId || ''));
      if (!u) fail(404, 'Person not found');
      if (!seesPerson(actor, u)) fail(403, 'You can’t see this person’s ratings');
      const positions = (u.jobCodes || []).filter((e) => jobs()[e.jobCodeId] && !jobs()[e.jobCodeId].archived).map((e) => {
        const r = ratingDoc(u.id, e.jobCodeId);
        return { jobCodeId: e.jobCodeId, value: r?.value ?? null, note: r?.note || '', setAt: r?.setAt || null, setBy: r?.setBy ? nameOf(r.setBy) : '', suggested: r?.suggested || null,
          history: (r?.history || []).slice().reverse().map((h) => ({ ...h, byName: nameOf(h.by) })), signals: signalsFor(u, e.jobCodeId) };
      });
      return { userId: u.id, name: u.name, scale: scale(), canEdit: canEdit(actor), positions };
    },
    'ratings.set': (actor, { userId, jobCodeId, value, note } = {}) => {
      needEdit(actor);
      const doc = setOne(actor, { userId, jobCodeId: String(jobCodeId || ''), value, note });
      return { changed: !!doc, value: doc ? doc.value : valueOf(userId, jobCodeId) };
    },
    'ratings.setMany': (actor, { changes, note } = {}) => {
      needEdit(actor);
      if (!Array.isArray(changes) || changes.length > 500) fail(400, 'Send up to 500 ratings at a time');
      // Check everything before saving anything.
      for (const c of changes) {
        const u = store.get('users', String(c?.userId || ''));
        if (!u || u.active === false) fail(404, 'Person not found');
        if (u.id === actor.id) fail(403, 'Nobody rates themselves');
        if (!seesPerson(actor, u)) fail(403, 'You can’t rate this person');
        if (!qualified(u, String(c.jobCodeId || ''))) fail(400, 'They don’t work that position');
        cleanValue(c.value, scale(), fail);
      }
      let changed = 0;
      for (const c of changes) if (setOne(actor, { userId: c.userId, jobCodeId: String(c.jobCodeId), value: c.value, note })) changed++;
      return { changed };
    },
    'ratings.scale.save': (actor, a = {}) => {
      needEdit(actor);
      needAdmin(actor);
      const next = cleanScale(a, fail);
      const cur = scale();
      let remapped = 0;
      if (next.min !== cur.min || next.max !== cur.max) {
        const at = stamp();
        for (const r of store.list(RATING_COL)) {
          if (r.value == null) continue;
          const to = remap(r.value, cur, next);
          store.update(RATING_COL, r.id, { value: to, history: [...(r.history || []), { at, by: actor.id, from: r.value, to, source: 'scale', note: `${cur.min}–${cur.max} → ${next.min}–${next.max}` }].slice(-HISTORY) });
          remapped++;
        }
        for (const r of store.list(RULE_COL)) {
          store.update(RULE_COL, r.id, r.type === 'minAvg' ? { avg: remap(r.avg, cur, next, false) } : { rating: remap(r.rating, cur, next) });
        }
      }
      if (store.get(CONFIG_COL, 'scale')) store.update(CONFIG_COL, 'scale', { ...next, updatedAt: stamp(), updatedBy: actor.id });
      else store.insert(CONFIG_COL, { id: 'scale', ...next, updatedAt: stamp(), updatedBy: actor.id });
      return { scale: scale(), remapped };
    },
    'skillRules.list': (actor) => {
      needView(actor);
      return { scale: scale(), canEdit: canEdit(actor), rules: rules().map(ruleView), dayparts: dayparts(), rooms: roomNames(), programming: programmingItems(), types: RULE_TYPES };
    },
    'skillRules.save': (actor, a = {}) => {
      needEdit(actor);
      const js = jobs();
      const doc = cleanRule(a, { jobExists: (id) => !!js[id] && !js[id].archived, rooms: roomNames(), dayparts: dayparts(), programming: programmingItems().map((x) => x.id), scale: scale(), fail });
      const at = stamp();
      if (a.id) {
        const cur = store.get(RULE_COL, String(a.id));
        if (!cur) fail(404, 'Rule not found');
        return { rule: store.update(RULE_COL, cur.id, { ...doc, updatedAt: at, updatedBy: actor.id }) };
      }
      if (store.list(RULE_COL).length >= MAX_RULES) fail(400, 'Up to 200 rules');
      return { rule: store.insert(RULE_COL, { id: uid('skr'), ...doc, order: store.list(RULE_COL).length, createdAt: at, createdBy: actor.id, updatedAt: at, updatedBy: actor.id }) };
    },
    'skillRules.delete': (actor, { id } = {}) => {
      needEdit(actor);
      const cur = store.get(RULE_COL, String(id || ''));
      if (!cur) fail(404, 'Rule not found');
      store.remove(RULE_COL, cur.id);
      return { ok: true };
    },
    'skillMix.week': (actor, { weekStart, includeRatings = false } = {}) => {
      needView(actor);
      return week(actor, weekStart, { includeRatings: !!includeRatings });
    },
    'skillMix.suggestions.list': (actor, { date, ruleId } = {}) => {
      needView(actor);
      return suggestions(actor, date, ruleId);
    },
  };
}

// ---------- demo ----------

/**
 * SAMPLE ratings and one rule for the demo (server/app.js with SEED_DEMO, and the tests): servers and bartenders
 * rated, and "Servers, Friday & Saturday dinner: at least 2 rated 5" so the schedule shows a skill-mix alert.
 * Invented people only (the demo's own). Deterministic ids, no randomness.
 */
export function seedRatingsDemo(store, { at = '2026-09-20T18:00:00.000Z' } = {}) {
  if (store.list(RULE_COL).length || store.list(RATING_COL).length) return;
  const by = store.list('users', (u) => u.role === 'admin' || u.role === 'manager')[0]?.id || null;
  const pattern = [5, 3, 4, 2, 5, 3, 5, 4, 2, 3];
  for (const jobCodeId of ['job_srv', 'job_bar']) {
    if (!store.get('jobCodes', jobCodeId)) continue;
    const staff = store.list('users', (u) => u.active !== false && u.role === 'employee' && (u.jobCodes || []).some((j) => j.jobCodeId === jobCodeId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    staff.forEach((u, i) => {
      if (i % 7 === 3) return; // a few stay unrated
      const value = pattern[i % pattern.length];
      store.insert(RATING_COL, { id: ratingId(u.id, jobCodeId), userId: u.id, jobCodeId, value, source: 'manual', note: '', setAt: at, setBy: by, suggested: null,
        history: [{ at, by, from: null, to: value, source: 'manual' }] });
    });
  }
  if (store.get('jobCodes', 'job_srv')) {
    store.insert(RULE_COL, { id: 'skr_demo_fri_sat', jobCodeId: 'job_srv', type: 'atLeast', count: 2, rating: 5, avg: null, days: [5, 6], daypart: 'Dinner', room: '', programmingId: '',
      note: '', active: true, order: 0, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by });
  }
}
