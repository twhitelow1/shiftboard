// Saved lists ("par lists"): a reusable named list of products, each with a par (how many to keep on hand), like
// "Rabbit Hole bar, nightly", "Patio well" or "My station". Someone opens it, taps "Run it", counts what's on hand
// line by line (or skips a line), and the app works out what's needed: need = max(0, par − on hand), rounded up to
// the product's unit. Then: send the needs to support (a quick list to the barbacks on duty, a person, a position or a
// room: the usual quick-list send and its notifications), work it myself (a list assigned to me, then the usual Got it
// / Short / Out), and/or mark lines with none on hand and none in the storeroom out on the 86 List (and its buyer).
// Every run is kept on the list (who, when, the counts), so each line shows its last run and what it "usually needs".
// Operational restocking only: no costs, no inventory valuation.
//
// Who may do what (the role features are core/role-features.js: stock, stockManage):
//   - anyone with Stock lists makes personal lists (just me); room- and position-wide lists need stockManage
//   - the owner, or a manager (stockManage), shares a list with people, role levels, positions or rooms, to use it
//     (run it, ask for a par change) or to edit it (lines and pars). Use is the default. They can unshare it again.
//   - a room-wide list is for everyone who works that room; a positions list for everyone in those positions (in that
//     room, when it has one); a personal list only for its owner and whoever it's shared with
//   - managers see and manage every room and position list; a personal list only when it's shared with them
//   - someone who may only use a list asks the owner to change a par (logged; the owner or a manager answers)
// Every change is in the list's own log and in the audit log (auditLog, action stock.saved.*).
//
// They supersede the old manager-only templates: once per restaurant (SAVED_MIGRATION, the first time Stock lists are
// used) every template becomes a saved list for its room (the room the lists made from it went to, else its 86 list's
// area, else every room) with its quantities as pars; the template document stays, hidden (kind 'migrated',
// migratedTo). stock.fromTemplate, stock.saveAsTemplate, stock.save { kind: 'template' } and the 'templates' scope
// keep working on saved lists (core/stock.js).
//
// Collection
//   stockParLists { id, name, notes, lines: [line], scope, owner (user id), shares: [share], runs: [run] (last 30),
//                   requests: [request], eightySixListId, templateId (the template it came from), createdBy, createdAt,
//                   updatedBy, updatedAt, log: [{ at, by, what, ... }] }
//   scope       { type: 'personal' } | { type: 'room', room ('' = every room) } | { type: 'positions', jobCodeIds, room? }
//   line        { id, productId, par, unit ('' = the product's), note }
//   share       { id, to: { type: 'person', userId } | { type: 'role', role } | { type: 'position', jobCodeId } | { type: 'room', room },
//                 can: 'use' | 'edit', by, at }
//   run         { id, at, by, counts: [{ lineId (null: added during the run), productId, par, onHand (null: skipped), need }],
//                 send: 'support' | 'self' | 'none', listId (the stock list it made), to (who it went to), out: [productId] }
//   request     { id, lineId, productId, from, to, note, by, at, status: 'open' | 'accepted' | 'declined', answeredBy, answeredAt }
import { uid } from './store.js';
import { roleOf, ROLE_IDS, roleLabelPlural } from './roles.js';
import { sameArea } from './areas.js';
import { unitName } from './products.js';
import { todayStr } from './time.js';

export const SAVED_MIGRATION = 'saved-lists-from-templates';
export const MAX_SAVED_LINES = 150;
export const MAX_SHARES = 60;
export const MAX_RUNS = 30;
const USUAL_RUNS = 5; // "usually needs": the median of the last five runs that counted the line
// Units counted in halves (half a pound, half a gallon); everything else (bottles, cases, each, typed-in units) whole.
const HALVES = new Set(['lb', 'gallon']);

/** Notifications, in each language. List and product names are the restaurant's and stay as typed. */
export const SAVED_TEXT = {
  en: {
    shared: (who, name) => `${who} shared the list “${name}” with you`,
    parAsk: (who, product, list, from, to) => `${who} asks to change the par for ${product} on “${list}” from ${from} to ${to}`,
    parYes: (product, list, to) => `The par for ${product} on “${list}” is now ${to}`,
    parNo: (product, list) => `Your par change for ${product} on “${list}” wasn’t accepted`,
  },
  es: {
    shared: (who, name) => `${who} compartió contigo la lista “${name}”`,
    parAsk: (who, product, list, from, to) => `${who} pide cambiar el par de ${product} en “${list}” de ${from} a ${to}`,
    parYes: (product, list, to) => `El par de ${product} en “${list}” ahora es ${to}`,
    parNo: (product, list) => `No se aceptó tu cambio de par de ${product} en “${list}”`,
  },
};

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What a line needs: max(0, par − on hand), rounded up to the unit (whole bottles, cases…; halves of a pound or a
 * gallon). null when the line was skipped (nothing counted).
 */
export function needFor(par, onHand, unit = '') {
  if (onHand === null || onHand === undefined || onHand === '') return null;
  const raw = Number(par) - Number(onHand);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const step = HALVES.has(unit) ? 0.5 : 1;
  return round2(Math.ceil(round2(raw / step)) * step);
}

/** The median of the last few needs a line had (the runs that counted it), or null when it was never counted. */
export function usuallyNeeds(runs, lineId) {
  const got = [];
  for (let i = (runs || []).length - 1; i >= 0 && got.length < USUAL_RUNS; i--) {
    const c = runs[i].counts.find((x) => x.lineId === lineId);
    if (c && c.need !== null && c.need !== undefined) got.push(c.need);
  }
  if (!got.length) return null;
  const s = [...got].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round2((s[mid - 1] + s[mid]) / 2);
}

/** The saved lists in the store (for merge and usage counts in core/stock.js). */
export const savedListsOf = (store) => store.list('stockParLists');

/**
 * Once per restaurant: every template becomes a saved list for its room (see the top of this file). areas: the
 * restaurant's rooms. Returns the marker, or null when it ran before.
 */
export function ensureSavedLists(store, { at = new Date().toISOString(), areas = [] } = {}) {
  if (store.get('migrations', SAVED_MIGRATION)) return null;
  const known = (r) => (r ? areas.find((a) => sameArea(a, r)) || '' : '');
  const map = {};
  for (const t of store.list('stockLists', (l) => l.kind === 'template')) {
    // The room: where the lists made from it went most often, else its 86 list's area, else every room.
    const rooms = new Map();
    for (const l of store.list('stockLists', (x) => x.templateId === t.id && x.assign?.room)) {
      const r = known(l.assign.room);
      if (r) rooms.set(r, (rooms.get(r) || 0) + 1);
    }
    const room = [...rooms.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || known(store.get('eightySixLists', t.eightySixListId)?.area) || '';
    const doc = store.insert('stockParLists', {
      id: uid('spl'), name: t.name, notes: t.notes || '', scope: { type: 'room', room }, owner: t.createdBy || null,
      lines: (t.lines || []).map((x) => ({ id: uid('spn'), productId: x.productId, par: x.qty, unit: '', note: x.note || '' })),
      shares: [], runs: [], requests: [], eightySixListId: t.eightySixListId || null, templateId: t.id,
      createdBy: t.createdBy || null, createdAt: t.createdAt || at, updatedBy: null, updatedAt: at, log: [{ at, by: null, what: 'migrated', from: t.id }],
    });
    store.update('stockLists', t.id, { kind: 'migrated', migratedTo: doc.id, updatedAt: at });
    map[t.id] = doc.id;
  }
  return store.insert('migrations', { id: SAVED_MIGRATION, at, lists: map });
}

/**
 * The saved-list RPCs. s: what core/stock.js shares with them: its RPCs (stock.save for the list a run makes),
 * fullView (a stock list as its screen shows it), report86 (out → the 86 List and its buyer), setRunAssign (let a
 * run's list go to one person), areas, onNow, nameOf, fresh, ready, canManageLists, canQuick.
 */
export function savedListsApi({ store, now, settings, notify, fail, langOf, s }) {
  const nowIso = () => now().toISOString();
  const today = () => todayStr(now());
  const needAuth = (a) => { if (!a) fail(401, 'Please sign in'); };
  const mgrOf = (u) => s.canManageLists(u, settings());
  const all = () => store.list('stockParLists');
  const product = (id) => (id ? store.get('products', id) : null);
  const jobName = (id) => store.get('jobCodes', id)?.name || '';
  const knownRoom = (r) => s.areas().find((a) => sameArea(a, r)) || '';

  // ---------- who works where ----------
  const shiftsToday = (u) => store.list('shifts', (x) => x.published && x.userId === u.id && x.date === today());
  /** The rooms someone works (their positions' rooms) and is scheduled in today. */
  const roomsOf = (u) => [...(u.jobCodes || []).flatMap((j) => j.areas || []), ...shiftsToday(u).map((x) => x.area).filter(Boolean)];
  const worksRoom = (u, room) => !room || roomsOf(u).some((r) => sameArea(r, room));
  const worksJob = (u, ids) => (u.jobCodes || []).some((j) => ids.includes(j.jobCodeId)) || shiftsToday(u).some((x) => ids.includes(x.jobCodeId));
  /** Today's rooms and positions (the sort: lists for where I'm working today first). */
  function todayOf(u) {
    const sh = shiftsToday(u).sort((a, b) => Number(s.onNow(b)) - Number(s.onNow(a)));
    return { rooms: sh.map((x) => x.area).filter(Boolean), jobs: sh.map((x) => x.jobCodeId).filter(Boolean) };
  }
  const scopeHits = (sc, u) => (sc.type === 'room' ? worksRoom(u, sc.room) : sc.type === 'positions' ? worksJob(u, sc.jobCodeIds || []) && worksRoom(u, sc.room) : false);
  function shareHits(to, u) {
    if (to.type === 'person') return to.userId === u.id;
    if (to.type === 'role') return roleOf(u) === to.role;
    if (to.type === 'position') return worksJob(u, [to.jobCodeId]);
    if (to.type === 'room') return worksRoom(u, to.room);
    return false;
  }
  /** owner · manage (managers; edit and share) · edit (shared to edit) · use (my room or position, or shared) · null */
  function access(l, u) {
    if (l.owner === u.id) return 'owner';
    const mine = (l.shares || []).filter((x) => shareHits(x.to, u));
    if (mgrOf(u) && (l.scope.type !== 'personal' || mine.length)) return 'manage';
    if (mine.some((x) => x.can === 'edit')) return 'edit';
    if (mine.length || scopeHits(l.scope, u)) return 'use';
    return null;
  }
  const canEdit = (a) => a === 'owner' || a === 'manage' || a === 'edit';
  const canShare = (a) => a === 'owner' || a === 'manage';
  function visible(u, id) {
    const l = id ? store.get('stockParLists', String(id)) : null;
    const a = l ? access(l, u) : null;
    if (!a) fail(404, 'List not found');
    return { l, a };
  }

  // ---------- words ----------
  function scopeLabel(sc, lang) {
    if (sc.type === 'personal') return lang === 'es' ? 'Solo para mí' : 'Just me';
    if (sc.type === 'room') return sc.room || (lang === 'es' ? 'Todos los salones' : 'Every room');
    return `${(sc.jobCodeIds || []).map(jobName).filter(Boolean).join(' + ')}${sc.room ? ` · ${sc.room}` : ''}`;
  }
  function shareLabel(to, lang) {
    if (to.type === 'person') return s.nameOf(to.userId);
    if (to.type === 'role') return roleLabelPlural(to.role, lang);
    if (to.type === 'position') return jobName(to.jobCodeId);
    return to.room;
  }

  // ---------- views ----------
  function lineView(x, l, lang) {
    const p = product(x.productId);
    const unit = x.unit || p?.unit || '';
    const lastRun = [...(l.runs || [])].reverse().find((r) => r.counts.some((c) => c.lineId === x.id && c.onHand !== null));
    const last = lastRun?.counts.find((c) => c.lineId === x.id);
    return {
      id: x.id, productId: x.productId, name: p?.name || '', category: p?.category || 'other', unit, unitName: unitName(unit, lang), size: p?.size || '',
      location: p?.location || '', photos: (p?.photos || []).map((ph) => ({ id: ph.id, w: ph.w || 0, h: ph.h || 0 })), review: p?.review || 'ok',
      archived: !p || p.status === 'archived', par: x.par, note: x.note || '', usually: usuallyNeeds(l.runs, x.id),
      last: last ? { onHand: last.onHand, need: last.need, at: lastRun.at } : null,
    };
  }
  function runView(r, l, lang) {
    return {
      id: r.id, at: r.at, by: { id: r.by, name: s.nameOf(r.by) }, send: r.send, listId: r.listId || null, to: r.to || '',
      needs: r.counts.filter((c) => c.need > 0).length, skipped: r.counts.filter((c) => c.onHand === null).length,
      counts: r.counts.map((c) => ({ ...c, name: product(c.productId)?.name || '', unitName: unitName(l.lines.find((x) => x.id === c.lineId)?.unit || product(c.productId)?.unit, lang) })),
      out: (r.out || []).map((id) => product(id)?.name || '').filter(Boolean),
    };
  }
  function summary(l, u, lang = langOf(u), t = todayOf(u)) {
    const a = access(l, u);
    const last = (l.runs || [])[l.runs.length - 1];
    const sc = l.scope;
    // Today: a list for a room or position I'm working today (or shared with one of them) comes first.
    const todayHit = (sc.type === 'room' && t.rooms.some((r) => !sc.room || sameArea(r, sc.room)))
      || (sc.type === 'positions' && t.jobs.some((j) => (sc.jobCodeIds || []).includes(j)) && (!sc.room || t.rooms.some((r) => sameArea(r, sc.room))))
      || (l.shares || []).some((x) => (x.to.type === 'room' && t.rooms.some((r) => sameArea(r, x.to.room))) || (x.to.type === 'position' && t.jobs.includes(x.to.jobCodeId)));
    return {
      id: l.id, kind: 'saved', name: l.name, notes: l.notes || '', scope: sc, scopeLabel: scopeLabel(sc, lang), owner: l.owner ? { id: l.owner, name: s.nameOf(l.owner) } : null,
      lines: l.lines.length, access: a, canEdit: canEdit(a), canShare: canShare(a), mine: l.owner === u.id, today: !!todayHit,
      shared: (l.shares || []).length, sharedWithMe: a === 'use' || a === 'edit' ? (l.shares || []).some((x) => shareHits(x.to, u)) : false,
      lastRun: last ? { at: last.at, by: { id: last.by, name: s.nameOf(last.by) }, needs: last.counts.filter((c) => c.need > 0).length } : null,
      openRequests: canEdit(a) ? (l.requests || []).filter((r) => r.status === 'open').length : 0, updatedAt: l.updatedAt,
    };
  }
  function fullView(l, u) {
    const lang = langOf(u);
    const sm = summary(l, u, lang);
    const reqs = (l.requests || []).filter((r) => r.status === 'open' && (sm.canEdit || r.by === u.id));
    return {
      ...sm, eightySixListId: l.eightySixListId || null, templateId: l.templateId || null, createdAt: l.createdAt,
      lines: l.lines.map((x) => lineView(x, l, lang)),
      shares: sm.canShare || sm.canEdit ? (l.shares || []).map((x) => ({ id: x.id, to: x.to, label: shareLabel(x.to, lang), can: x.can, by: { id: x.by, name: s.nameOf(x.by) }, at: x.at })) : [],
      requests: reqs.map((r) => ({ ...r, product: product(r.productId)?.name || '', byName: s.nameOf(r.by) })),
      runs: [...(l.runs || [])].reverse().slice(0, 10).map((r) => runView(r, l, lang)),
      log: sm.canEdit ? (l.log || []).slice(-100).map((e) => ({ ...e, byName: s.nameOf(e.by) })) : [],
      canManage: mgrOf(u), canScope: sm.canShare && mgrOf(u),
    };
  }

  // ---------- changes ----------
  const logEntry = (l, e) => [...(l.log || []), { at: nowIso(), ...e }].slice(-300);
  function audit(u, l, action, details = {}) {
    store.insert('auditLog', { id: uid('aud'), at: nowIso(), actorId: u.id, targetId: l.id, action: `stock.saved.${action}`, details: { list: l.name, ...details } });
  }
  function cleanPar(v) {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 9999) fail(400, 'A par level is a number from 0 to 9999');
    return round2(n);
  }
  function cleanCount(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 99999) fail(400, 'On hand is a number from 0 to 99999');
    return round2(n);
  }
  function cleanLines(raw, cur = []) {
    if (!Array.isArray(raw)) return cur;
    if (raw.length > MAX_SAVED_LINES) fail(400, 'A list can have up to 150 products');
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      const p = product(r?.productId ? String(r.productId) : null);
      if (!p || p.status === 'archived') fail(400, 'Pick products from the catalog');
      if (seen.has(p.id)) continue; // one line per product
      seen.add(p.id);
      const old = (r.id ? cur.find((x) => x.id === r.id && x.productId === p.id) : null) || cur.find((x) => x.productId === p.id) || null;
      out.push({ id: old?.id || uid('spn'), productId: p.id, par: cleanPar(r.par ?? old?.par ?? 1), unit: text(r.unit ?? old?.unit, 20), note: text(r.note ?? old?.note, 140) });
    }
    return out;
  }
  function cleanScope(sc, u) {
    const type = sc?.type || 'personal';
    if (type === 'personal') return { type };
    if (!mgrOf(u)) fail(403, 'Only managers make lists for a room or a position');
    if (type === 'room') {
      if (sc.room && !knownRoom(sc.room)) fail(400, 'Pick a room');
      return { type, room: knownRoom(sc.room) };
    }
    if (type === 'positions') {
      const ids = [...new Set((Array.isArray(sc.jobCodeIds) ? sc.jobCodeIds : [sc.jobCodeId]).filter(Boolean).map(String))]
        .filter((id) => { const j = store.get('jobCodes', id); return j && !j.archived; });
      if (!ids.length) fail(400, 'Pick a position');
      if (sc.room && !knownRoom(sc.room)) fail(400, 'Pick a room');
      return { type, jobCodeIds: ids, ...(sc.room ? { room: knownRoom(sc.room) } : {}) };
    }
    fail(400, 'Pick who the list is for');
    return null;
  }
  function cleanShareTo(to) {
    if (!to || typeof to !== 'object') fail(400, 'Pick who to share it with');
    if (to.type === 'person') {
      const p = to.userId ? store.get('users', String(to.userId)) : null;
      if (!p || p.active === false) fail(400, 'Pick someone on the team');
      return { type: 'person', userId: p.id };
    }
    if (to.type === 'role') {
      if (!ROLE_IDS.includes(to.role)) fail(400, 'Pick a role');
      return { type: 'role', role: to.role };
    }
    if (to.type === 'position') {
      const j = to.jobCodeId ? store.get('jobCodes', String(to.jobCodeId)) : null;
      if (!j || j.archived) fail(400, 'Pick a position');
      return { type: 'position', jobCodeId: j.id };
    }
    if (to.type === 'room') {
      const room = knownRoom(to.room);
      if (!room) fail(400, 'Pick a room');
      return { type: 'room', room };
    }
    fail(400, 'Pick who to share it with');
    return null;
  }
  const sameTo = (a, b) => a.type === b.type && a.userId === b.userId && a.role === b.role && a.jobCodeId === b.jobCodeId && (a.type !== 'room' || sameArea(a.room, b.room));

  /** A run's counts → every line with its need (skipped lines: onHand null), and lines added during the run. */
  function compute(l, counts, lang) {
    const raw = Array.isArray(counts) ? counts.slice(0, MAX_SAVED_LINES * 2) : [];
    const byLine = new Map(raw.filter((c) => c?.lineId).map((c) => [String(c.lineId), c]));
    for (const id of byLine.keys()) if (!l.lines.some((x) => x.id === id)) fail(400, 'That product isn’t on the list');
    const out = [];
    for (const x of l.lines) {
      const p = product(x.productId);
      if (!p || p.status === 'archived') continue;
      const c = byLine.get(x.id);
      const onHand = c && !c.skip ? cleanCount(c.onHand) : null;
      const unit = x.unit || p.unit || '';
      out.push({ lineId: x.id, productId: p.id, name: p.name, unit, unitName: unitName(unit, lang), location: p.location || '', par: x.par, onHand, need: needFor(x.par, onHand, unit), note: x.note || '' });
    }
    // Added on the fly during the run (not on the saved list): a product and a par for this run.
    for (const c of raw.filter((x) => x && !x.lineId && x.productId)) {
      const p = product(String(c.productId));
      if (!p || p.status === 'archived') fail(400, 'Pick products from the catalog');
      if (out.some((x) => x.productId === p.id)) continue;
      const par = cleanPar(c.par ?? 1);
      const onHand = c.skip ? null : cleanCount(c.onHand);
      out.push({ lineId: null, productId: p.id, name: p.name, unit: p.unit || '', unitName: unitName(p.unit, lang), location: p.location || '', par, onHand, need: needFor(par, onHand, p.unit), note: '' });
    }
    return out;
  }
  const needsOf = (lines) => lines.filter((x) => x.need > 0);
  const keyOf = (x) => x.lineId || `p:${x.productId}`;

  function savePatch(l, u, patch, entry, action, details) {
    const out = store.update('stockParLists', l.id, { ...patch, updatedBy: u.id, updatedAt: nowIso(), log: logEntry(l, { by: u.id, ...entry }) });
    audit(u, l, action, details);
    return out;
  }

  const api = {
    // Lists for me: mine, then the ones for my rooms and positions or shared with me (today's first); managers: every
    // room and position list too (all: true).
    'stock.saved.list': (actor, { all: everything = false } = {}) => {
      needAuth(actor);
      s.ready();
      const u = s.fresh(actor);
      const lang = langOf(u);
      const t = todayOf(u);
      const mgr = mgrOf(u);
      const out = [];
      for (const l of all()) {
        const a = access(l, u);
        if (!a) continue;
        const sm = summary(l, u, lang, t);
        const section = sm.mine ? 'mine' : sm.sharedWithMe || scopeHits(l.scope, u) ? 'forMe' : 'all';
        if (section === 'all' && !everything) continue;
        out.push({ ...sm, section });
      }
      const rank = { mine: 0, forMe: 1, all: 2 };
      out.sort((a, b) => Number(b.today) - Number(a.today) || rank[a.section] - rank[b.section] || a.name.localeCompare(b.name));
      return { lists: out, canManage: mgr, canCreate: s.canQuick(u, settings()), today: today() };
    },
    'stock.saved.get': (actor, { id } = {}) => {
      needAuth(actor);
      s.ready();
      const u = s.fresh(actor);
      return fullView(visible(u, id).l, u);
    },
    // Who and where a list can be for or shared with, and where a run's needs can go.
    'stock.saved.options.get': (actor) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const lang = langOf(u);
      const jobs = store.list('jobCodes', (j) => !j.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const mine = shiftsToday(u).sort((a, b) => Number(s.onNow(b)) - Number(s.onNow(a)));
      const bbk = jobs.find((j) => /bar\s*back|barback|ayudante de barra/i.test(j.name));
      return {
        people: store.list('users', (x) => x.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.id, name: x.name })),
        roles: ROLE_IDS.filter((r) => r !== 'super_admin').map((r) => ({ id: r, name: roleLabelPlural(r, lang) })),
        positions: jobs.map((j) => ({ id: j.id, name: j.name })), rooms: s.areas(),
        support: { jobCodeId: bbk?.id || '', room: mine[0]?.area ? knownRoom(mine[0].area) : '' },
        canManage: mgrOf(u), canCreate: s.canQuick(u, settings()), today: today(),
      };
    },
    // Create or change a saved list: its name, lines (product, par, unit, note, in shelf order) and, for managers, who
    // it's for. People it's shared with to edit change the lines; the owner and managers everything.
    'stock.saved.save': (actor, a = {}) => {
      needAuth(actor);
      s.ready();
      const u = s.fresh(actor);
      const found = a.id ? visible(u, a.id) : null;
      const cur = found?.l || null;
      if (cur ? !canEdit(found.a) : !s.canQuick(u, settings())) fail(403, 'You can’t change this list');
      const name = text(a.name ?? cur?.name, 60);
      if (!name) fail(400, 'Give the list a name');
      const lines = cleanLines(a.lines, cur?.lines || []);
      if (!lines.length) fail(400, 'Add at least one product');
      let scope = cur?.scope || { type: 'personal' };
      if ('scope' in a && (!cur || JSON.stringify(a.scope) !== JSON.stringify(cur.scope))) {
        if (cur && !canShare(found.a)) fail(403, 'Only the owner or a manager can change who it’s for');
        scope = cleanScope(a.scope, u);
      }
      const doc = {
        name, notes: text(a.notes ?? cur?.notes, 300), lines, scope,
        eightySixListId: 'eightySixListId' in a ? (store.get('eightySixLists', a.eightySixListId) ? a.eightySixListId : null) : cur?.eightySixListId || null,
      };
      if (!cur) {
        const at = nowIso();
        const l = store.insert('stockParLists', { id: uid('spl'), ...doc, owner: u.id, shares: [], runs: [], requests: [], templateId: null,
          createdBy: u.id, createdAt: at, updatedBy: u.id, updatedAt: at, log: [{ at, by: u.id, what: 'created' }] });
        audit(u, l, 'created', { scope: l.scope.type, lines: lines.length });
        return fullView(l, u);
      }
      const pars = lines.filter((x) => { const o = cur.lines.find((y) => y.id === x.id); return o && o.par !== x.par; }).length;
      const out = savePatch(cur, u, doc, { what: 'edited', pars, lines: lines.length }, 'edited', { pars, lines: lines.length, scope: scope.type });
      return fullView(out, u);
    },
    'stock.saved.delete': (actor, { id } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canShare(a)) fail(403, 'Only the owner or a manager can do that');
      audit(u, l, 'deleted', { lines: l.lines.length, runs: (l.runs || []).length });
      store.remove('stockParLists', l.id);
      return { ok: true };
    },
    // Share with a person, a role level, a position or a room: use (run it) or edit (lines and pars). Again for the
    // same people changes what they may do. A person is told.
    'stock.saved.share': (actor, { id, to, can = 'use' } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canShare(a)) fail(403, 'Only the owner or a manager can do that');
      const target = cleanShareTo(to);
      if (target.type === 'person' && target.userId === l.owner) fail(400, 'It’s already theirs');
      const level = can === 'edit' ? 'edit' : 'use';
      const shares = [...(l.shares || [])];
      const i = shares.findIndex((x) => sameTo(x.to, target));
      if (i < 0 && shares.length >= MAX_SHARES) fail(400, 'A list can be shared up to 60 times');
      const share = { id: i >= 0 ? shares[i].id : uid('sps'), to: target, can: level, by: u.id, at: nowIso() };
      if (i >= 0) shares[i] = share; else shares.push(share);
      const label = shareLabel(target, 'en');
      const out = savePatch(l, u, { shares }, { what: i >= 0 ? 'shareChanged' : 'shared', to: label, can: level }, 'shared', { to: target, can: level });
      if (target.type === 'person' && target.userId !== u.id && (i < 0 || shares[i]?.can !== l.shares[i]?.can)) {
        notify([target.userId], (lang) => (SAVED_TEXT[lang] || SAVED_TEXT.en).shared(u.name, l.name), `#/stock/saved/${l.id}`);
      }
      return fullView(out, u);
    },
    'stock.saved.unshare': (actor, { id, shareId } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canShare(a)) fail(403, 'Only the owner or a manager can do that');
      const sh = (l.shares || []).find((x) => x.id === shareId);
      if (!sh) fail(404, 'That share isn’t on the list');
      const out = savePatch(l, u, { shares: l.shares.filter((x) => x.id !== sh.id) }, { what: 'unshared', to: shareLabel(sh.to, 'en') }, 'unshared', { to: sh.to, can: sh.can });
      return fullView(out, u);
    },
    // A par, right away (the owner, managers, people it's shared with to edit). Open requests for the line are answered.
    'stock.saved.setPar': (actor, { id, lineId, par } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canEdit(a)) fail(403, 'Ask the owner to change the par');
      const line = l.lines.find((x) => x.id === lineId);
      if (!line) fail(404, 'That product isn’t on the list');
      const to = cleanPar(par);
      const at = nowIso();
      const requests = (l.requests || []).map((r) => (r.lineId === line.id && r.status === 'open' ? { ...r, status: r.to === to ? 'accepted' : 'declined', answeredBy: u.id, answeredAt: at } : r));
      const out = savePatch(l, u, { lines: l.lines.map((x) => (x.id === line.id ? { ...x, par: to } : x)), requests },
        { what: 'par', lineId: line.id, from: line.par, to }, 'par', { product: product(line.productId)?.name || '', from: line.par, to });
      return fullView(out, u);
    },
    // Add a product to the list on the fly (during a run, after the add-product flow's duplicate check).
    'stock.saved.addLine': (actor, { id, productId, par = 1, note = '' } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canEdit(a)) fail(403, 'You can’t change this list');
      if (l.lines.some((x) => x.productId === productId)) fail(400, 'It’s already on the list');
      const lines = cleanLines([...l.lines, { productId, par, note }], l.lines);
      const out = savePatch(l, u, { lines }, { what: 'added', productId }, 'added', { product: product(productId)?.name || '', par: lines[lines.length - 1].par });
      return fullView(out, u);
    },
    // Someone who may only use the list asks for a different par: the owner (or the managers) are told; logged.
    'stock.saved.requestPar': (actor, { id, lineId, par, note = '' } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      const line = l.lines.find((x) => x.id === lineId);
      if (!line) fail(404, 'That product isn’t on the list');
      const to = cleanPar(par);
      if (to === line.par) fail(400, 'That’s already the par');
      const req = { id: uid('spr'), lineId: line.id, productId: line.productId, from: line.par, to, note: text(note, 200), by: u.id, at: nowIso(), status: 'open' };
      const requests = [...(l.requests || []).filter((r) => !(r.by === u.id && r.lineId === line.id && r.status === 'open')), req].slice(-100);
      const out = savePatch(l, u, { requests }, { what: 'parAsked', lineId: line.id, from: line.par, to }, 'parAsked', { product: product(line.productId)?.name || '', from: line.par, to, access: a });
      const owner = l.owner && store.get('users', l.owner)?.active !== false ? [l.owner] : [];
      const tell = (owner.length ? owner : store.list('users', (x) => x.active !== false && mgrOf(x)).map((x) => x.id)).filter((x) => x !== u.id);
      const pName = product(line.productId)?.name || '';
      if (tell.length) notify(tell, (lang) => (SAVED_TEXT[lang] || SAVED_TEXT.en).parAsk(u.name, pName, l.name, line.par, to), `#/stock/saved/${l.id}`);
      return { ...fullView(out, u), requestId: req.id, notified: tell.length };
    },
    'stock.saved.answerRequest': (actor, { id, requestId, accept = true } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l, a } = visible(u, id);
      if (!canEdit(a)) fail(403, 'Only the owner or a manager can do that');
      const r = (l.requests || []).find((x) => x.id === requestId && x.status === 'open');
      if (!r) fail(404, 'That request was already answered');
      const at = nowIso();
      const ok = accept !== false && l.lines.some((x) => x.id === r.lineId);
      const requests = l.requests.map((x) => (x.id === r.id ? { ...x, status: ok ? 'accepted' : 'declined', answeredBy: u.id, answeredAt: at } : x));
      const lines = ok ? l.lines.map((x) => (x.id === r.lineId ? { ...x, par: r.to } : x)) : l.lines;
      const pName = product(r.productId)?.name || '';
      const out = savePatch(l, u, { requests, lines }, { what: ok ? 'parAccepted' : 'parDeclined', lineId: r.lineId, from: r.from, to: r.to, for: r.by },
        ok ? 'parAccepted' : 'parDeclined', { product: pName, from: r.from, to: r.to });
      if (r.by !== u.id) notify([r.by], (lang) => (ok ? (SAVED_TEXT[lang] || SAVED_TEXT.en).parYes(pName, l.name, r.to) : (SAVED_TEXT[lang] || SAVED_TEXT.en).parNo(pName, l.name)), `#/stock/saved/${l.id}`);
      return fullView(out, u);
    },
    // The run-down's math, without saving anything (the phone does it as you go; the Claude tools ask the server).
    'stock.saved.needs.get': (actor, { id, counts } = {}) => {
      needAuth(actor);
      const u = s.fresh(actor);
      const { l } = visible(u, id);
      const lines = compute(l, counts, langOf(u));
      return { id: l.id, name: l.name, lines, needs: needsOf(lines), counted: lines.filter((x) => x.onHand !== null).length, skipped: lines.filter((x) => x.onHand === null).length };
    },
    // Finish a run: save it in the list's history, and
    //   send 'support': a quick list of just the needed lines to `assign` (the barbacks on duty in a room, a position,
    //                   a room, or a person), with the usual notifications
    //   send 'self':    the same list, assigned to me, to work with Got it / Short / Out
    //   send 'none':    only the history (nothing needed, or I'll deal with it)
    //   out:            lines (lineId, or productId for one added during the run) with none on hand and none in the
    //                   storeroom: reported out on the 86 List (its buyer is told) and left off the list
    'stock.saved.run': (actor, { id, counts, send = 'none', assign = null, out = [], name = '', note = '' } = {}) => {
      needAuth(actor);
      s.ready();
      const u = s.fresh(actor);
      const { l } = visible(u, id);
      if (!['support', 'self', 'none'].includes(send)) fail(400, 'Send it to support, work it yourself, or just save the counts');
      const lines = compute(l, counts, langOf(u));
      if (!lines.some((x) => x.onHand !== null)) fail(400, 'Count at least one product');
      const outKeys = new Set((Array.isArray(out) ? out : []).map(String));
      const outLines = lines.filter((x) => outKeys.has(x.lineId || '') || outKeys.has(x.productId));
      if (outLines.some((x) => x.onHand !== 0)) fail(400, 'Only a product with none on hand can be marked out');
      const outSet = new Set(outLines.map(keyOf));
      const toSend = needsOf(lines).filter((x) => !outSet.has(keyOf(x)));
      let made = null;
      if (send !== 'none') {
        if (!toSend.length) fail(400, 'Nothing is needed');
        s.setRunAssign(true);
        try {
          made = s.api['stock.save'](actor, {
            kind: 'list', quick: true, name: text(name, 60) || l.name, notes: text(note, 300),
            lines: toSend.map((x) => ({ productId: x.productId, qty: x.need, note: x.note })),
            assign: send === 'self' ? { type: 'me' } : assign, eightySixListId: l.eightySixListId || null,
          });
        } finally { s.setRunAssign(false); }
      }
      // Out → the 86 List (and its buyer), through the 86 List's own rules.
      const eightySix = [];
      for (const x of outLines) {
        const r = s.report86(actor, u, product(x.productId), l, { status: 'out' });
        eightySix.push({ productId: x.productId, name: x.name, listId: r.target.id, listName: r.target.name, buyers: r.buyers.length });
      }
      const at = nowIso();
      const run = {
        id: uid('spu'), at, by: u.id, counts: lines.map((x) => ({ lineId: x.lineId, productId: x.productId, par: x.par, onHand: x.onHand, need: x.need })),
        send, listId: made?.id || null, to: made?.assignLabel || '', out: outLines.map((x) => x.productId),
      };
      if (made) store.update('stockLists', made.id, { savedListId: l.id, runId: run.id });
      const saved = store.update('stockParLists', l.id, { runs: [...(l.runs || []), run].slice(-MAX_RUNS), log: logEntry(l, { by: u.id, what: 'ran', runId: run.id, needs: toSend.length, send }) });
      audit(u, l, 'ran', { needs: toSend.length, send, out: outLines.length, listId: run.listId });
      return {
        run: runView(run, saved, langOf(u)), needs: toSend.map((x) => ({ ...x })), list: made ? s.fullView(store.get('stockLists', made.id), u) : null,
        notified: made?.notified || 0, eightySix, saved: fullView(saved, u),
      };
    },
  };

  /** The template-shaped summary the old 'templates' scope and aliases answer with (core/stock.js). */
  function asTemplate(l, u) {
    return {
      id: l.id, kind: 'template', savedList: true, name: l.name, notes: l.notes || '', date: '', due: '', status: 'open', quick: false,
      assign: null, assignLabel: scopeLabel(l.scope, langOf(u)), assignees: [], mine: false,
      counts: { lines: l.lines.length, done: 0, got: 0, short: 0, out: 0 }, createdBy: { id: l.createdBy, name: s.nameOf(l.createdBy) },
      createdAt: l.createdAt, updatedAt: l.updatedAt, startedAt: null, doneAt: null, doneBy: null, templateId: null, overdue: false,
    };
  }
  /** A saved list by its id or the id of the template it came from. */
  const byIdOrTemplate = (id) => (id ? store.get('stockParLists', String(id)) || all().find((l) => l.templateId === String(id)) || null : null);
  return { api, access, asTemplate, byIdOrTemplate, fullView, all };
}
