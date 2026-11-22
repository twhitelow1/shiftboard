// Pull Tripleseat events into Events & BEOs inside a time budget, so each call fits Vercel's 30 s
// function limit; whatever doesn't fit comes back as `next` (a cursor), and the caller (Sync now, or the
// next cron run) continues from there. Every write goes through core/tripleseat.js with ids taken from
// Tripleseat (evt_ts_<id>), so running any part again never duplicates anything.
//
// One run, in phases:
//   lists    the site and locations, their rooms (matched to venue rooms by name) and the menus' item names
//   changed  events changed since the last finished run (newest first), wherever their date is
//   window   every event from a week ago through 120 days out, page by page
//   missing  events ShiftBoard has in that window that Tripleseat didn't list: each is fetched on its
//            own, so a deleted one (404) or one moved out of the window is noticed without a webhook
// A webhook (server/tripleseat-routes.js) syncs one event with syncOneEvent().
import { addDays, todayStr } from '../core/time.js';
import { createService } from '../core/service.js';
import { integration, saveIntegration, rulesOf, menuLines, menuItemIndex, syncWindow, readEvent, mapStatus, eventDocId, SOURCE } from '../core/tripleseat.js';
import { createTripleseatClient, TripleseatError } from './tripleseat.js';

const MISSING_BATCH = 8; // events fetched one by one per write in the missing phase
const MAX_CHANGED_PAGES = 5;
const stamp = () => new Date().toISOString();

/** A fresh run: its id, the window around today, and the day the last finished run started (for "changed"). */
export function newCursor(store, { runId, today = todayStr() } = {}) {
  const i = integration(store);
  const last = i.lastFullAt ? String(i.lastFullAt).slice(0, 10) : null;
  return {
    runId: String(runId || Math.random().toString(36).slice(2, 10)).slice(0, 40),
    phase: 'lists', page: 1, ...syncWindow(today),
    since: last ? addDays(last, -1) : null, // a day of overlap; time zones and clocks never line up exactly
    initial: !i.firstSyncAt, startedAt: stamp(),
  };
}

/** Clean a cursor that came back from the browser: known phase, dates and page only. */
export function cleanCursor(c) {
  if (!c || typeof c !== 'object') return null;
  const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  if (!['lists', 'changed', 'window', 'missing'].includes(c.phase) || !day(c.from) || !day(c.to)) return null;
  return {
    runId: String(c.runId || '').slice(0, 40) || null, phase: c.phase, page: Math.min(Math.max(1, Math.floor(Number(c.page) || 1)), 200),
    from: c.from, to: c.to, since: day(c.since), initial: !!c.initial, startedAt: typeof c.startedAt === 'string' ? c.startedAt.slice(0, 40) : stamp(),
    firstId: c.firstId == null ? null : String(c.firstId).slice(0, 40),
  };
}

/** True when Tripleseat's updated_at ('MM/DD/YYYY hh:mm AM' or ISO) is on or after `since` (a date). Unreadable counts as changed. */
function changedSince(updatedAt, since) {
  const s = String(updatedAt || '');
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  const d = us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : iso?.[1];
  return !d || d >= since;
}

/**
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} [o.client]   from createTripleseatClient
 * @param {object} [o.cursor]   where the last chunk stopped (null: a new run)
 * @param {string} [o.by]       user id, 'cron' or 'webhook'
 * @param {number} [o.budgetMs] stop starting new work after this long
 * @param {Function} [o.onCommit] after each write (notifications: email, push, texts)
 * @returns {Promise<{ ok, next, counts, warnings?, error? }>}
 */
export async function runTripleseatSync({ db, env = process.env, client, cursor = null, by = null, budgetMs = 18_000, clock = () => Date.now(), onCommit, today = todayStr() }) {
  const started = clock();
  client ||= createTripleseatClient({ env });
  const cfg = client.config;
  const timeZone = env.TIMEZONE || process.env.TZ || '';
  await db.sync();
  let cur = cleanCursor(cursor) || newCursor(db.store, { today });
  if (!cur.runId) cur.runId = newCursor(db.store, { today }).runId;
  const out = { ok: true, next: null, counts: {}, runId: cur.runId };
  // Things that didn't stop the sync, as codes the Settings page words in either language: { code, error }.
  const warnings = [];
  const warn = (code, e) => { if (!warnings.some((w) => w.code === code)) warnings.push({ code, error: String(e?.message || e).slice(0, 200) }); };
  const rules = rulesOf(db.store);
  let slowest = 0;
  let steps = 0;
  let menusOff = false;
  const enough = () => steps > 0 && clock() - started + Math.max(slowest, 1500) > budgetMs;
  const timed = async (fn) => { const t0 = clock(); try { return await fn(); } finally { slowest = Math.max(slowest, clock() - t0); steps++; } };
  const fatal = (e) => e instanceof TripleseatError && [401, 410].includes(e.status);

  /** The menu for an event that needs one read: new, changed since its menu was read, or never read. */
  async function menuFor(raw) {
    if (menusOff) return null;
    const ev = readEvent(raw, { timeZone });
    if (!ev || !['confirmed', 'tentative', 'completed'].includes(mapStatus(ev.status, rules))) return null;
    const doc = db.store.get('events', eventDocId(ev.id));
    if (doc?.tripleseat?.menuFor && ev.updatedAt && doc.tripleseat.menuFor === ev.updatedAt) return null;
    try {
      const selections = await client.menuSelections(ev.id);
      return { ...menuLines(selections, integration(db.store).menuItems || {}), for: ev.updatedAt || stamp() };
    } catch (e) {
      if (fatal(e)) throw e;
      menusOff = true; // one warning, not one per event
      warn('menus', e);
      return null;
    }
  }

  /** Apply events in one write; remember which this run has seen. */
  async function apply(items) {
    if (!items.length) return;
    const r = await db.run((store) => {
      const res = createService(store).tripleseat.applyBatch(items, { rules, timeZone, locationId: cfg.locationId, initial: cur.initial });
      const i = integration(store);
      const run = i.run?.id === cur.runId ? i.run : { id: cur.runId, seen: [] };
      const seen = new Set(run.seen);
      for (const it of items) { const id = it.raw ? readEvent(it.raw)?.id : it.deleted; if (id) seen.add(String(id)); }
      saveIntegration(store, { run: { id: cur.runId, seen: [...seen].slice(-5000) } });
      return res;
    }, { write: true, onCommit });
    for (const [k, n] of Object.entries(r.counts)) out.counts[k] = (out.counts[k] || 0) + n;
  }

  /** An item for applyBatch. menuFor (the event's updated_at) is kept, so an unchanged event's menu isn't read again. */
  async function itemFor(raw) {
    const menu = await menuFor(raw);
    return { raw, menu: menu ? { food: menu.food, drinks: menu.drinks } : null, menuFor: menu?.for || null };
  }
  async function applyRows(rows) {
    const items = [];
    for (const raw of rows) items.push(await itemFor(raw));
    await apply(items);
  }

  try {
    while (!out.next) {
      if (enough()) { out.next = cur; break; }
      if (cur.phase === 'lists') {
        await timed(async () => {
          const soft = async (fn, code) => { try { return await fn(); } catch (e) { if (fatal(e)) throw e; warn(code, e); return null; } };
          const [sites, locations] = await Promise.all([soft(() => client.sites(), 'sites'), soft(() => client.locations(), 'locations')]);
          const hasRooms = (locations || []).some((l) => Array.isArray(l?.rooms) && l.rooms.length);
          const rooms = hasRooms ? [] : (await soft(() => client.rooms(), 'rooms')) || [];
          const menus = await soft(() => client.menus(), 'menus');
          await db.run((store) => {
            createService(store).tripleseat.syncRooms({ locations: locations || [], rooms });
            const pick = (list, id) => (list || []).find((x) => String(x?.id) === String(id)) || ((list || []).length === 1 ? list[0] : null);
            const site = pick(sites, cfg.siteId);
            const loc = pick(locations, cfg.locationId);
            saveIntegration(store, {
              site: site ? { id: String(site.id), name: String(site.name || '').slice(0, 120) } : null,
              location: loc ? { id: String(loc.id), name: String(loc.name || '').slice(0, 120) } : cfg.locationId ? { id: cfg.locationId, name: '' } : null,
              locations: (locations || []).slice(0, 50).map((l) => ({ id: String(l?.id ?? ''), name: String(l?.name || '').slice(0, 120) })),
              ...(menus ? { menuItems: menuItemIndex(menus) } : {}),
              listsAt: stamp(),
            });
          }, { write: true });
        });
        cur = { ...cur, phase: cur.since ? 'changed' : 'window', page: 1, firstId: null };
      } else if (cur.phase === 'changed') {
        let p;
        try {
          p = await timed(() => client.searchEvents({ order: 'updated_at', direction: 'desc', from: null, to: null }, cur.page));
        } catch (e) {
          if (fatal(e)) throw e;
          warn('changed', e);
          cur = { ...cur, phase: 'window', page: 1, firstId: null };
          continue;
        }
        const fresh = p.rows.filter((r) => changedSince(r?.updated_at, cur.since));
        await timed(() => applyRows(fresh));
        const stop = client.lastPage(p) || fresh.length < p.rows.length || cur.page >= MAX_CHANGED_PAGES;
        cur = stop ? { ...cur, phase: 'window', page: 1, firstId: null } : { ...cur, page: cur.page + 1 };
      } else if (cur.phase === 'window') {
        const p = await timed(() => client.searchEvents({ from: cur.from, to: cur.to }, cur.page));
        // An API that ignores ?page answers page 1 again: that's the end, not more events.
        const repeat = cur.page > 1 && p.rows.length && cur.firstId != null && String(p.rows[0]?.id) === cur.firstId;
        if (!repeat) await timed(() => applyRows(p.rows));
        const firstId = cur.page === 1 ? (p.rows[0]?.id != null ? String(p.rows[0].id) : null) : cur.firstId;
        cur = repeat || client.lastPage(p) ? { ...cur, phase: 'missing', page: 1, firstId: null } : { ...cur, page: cur.page + 1, firstId };
      } else if (cur.phase === 'missing') {
        await db.sync();
        const i = integration(db.store);
        const seen = new Set(i.run?.id === cur.runId ? i.run.seen : []);
        const todo = db.store.list('events', (e) => e.source === SOURCE && e.date >= cur.from && e.date <= cur.to && e.status !== 'cancelled' && !seen.has(String(e.externalId)))
          .sort((a, b) => a.date.localeCompare(b.date)).slice(0, MISSING_BATCH);
        if (!todo.length) { cur = { ...cur, phase: 'done' }; break; }
        const items = [];
        for (const e of todo) {
          if (items.length && enough()) break;
          const raw = await timed(() => client.event(e.externalId));
          items.push(raw ? await itemFor(raw) : { deleted: String(e.externalId) });
        }
        await apply(items); // marks each as seen, so the next pass moves on even if Tripleseat moved it out of the window
      } else break;
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof TripleseatError ? e.message : `Sync failed: ${e.message}`;
    if (!(e instanceof TripleseatError)) console.error('Tripleseat sync failed:', e);
    out.next = null;
  }
  if (warnings.length) out.warnings = warnings;

  // Remember how it went (Settings → Integrations → Tripleseat). Chunks of one run add up.
  const finished = out.ok && !out.next;
  await db.run((store) => {
    const i = integration(store);
    const prev = i.lastSync?.runId === cur.runId ? i.lastSync : null;
    const counts = { ...(prev?.counts || {}) };
    for (const [k, n] of Object.entries(out.counts)) counts[k] = (counts[k] || 0) + n;
    const lastSync = {
      runId: cur.runId, at: stamp(), by, from: cur.from, to: cur.to, counts, ok: out.ok, error: out.error || null,
      warnings: [...(prev?.warnings || []), ...warnings].filter((w, i, a) => a.findIndex((x) => x.code === w.code) === i), finished,
    };
    const patch = { lastSync, history: [lastSync, ...(i.history || []).filter((h) => h.runId !== cur.runId)].slice(0, 10) };
    if (by === 'cron') { patch.lastCron = lastSync; patch.cronCursor = out.next ? { ...out.next, savedAt: stamp() } : null; }
    if (finished) Object.assign(patch, { lastFullAt: cur.startedAt, firstSyncAt: i.firstSyncAt || stamp(), run: null });
    saveIntegration(store, patch);
  }, { write: true }).catch((e) => console.error('Could not save Tripleseat sync status:', e.message));

  return out;
}

/**
 * The webhook's work: sync the one event Tripleseat named (the payload itself is never trusted; the
 * event is read back from the API). A 404 means it was deleted.
 */
export async function syncOneEvent({ db, env = process.env, client, eventId, trigger = '', onCommit }) {
  client ||= createTripleseatClient({ env });
  const timeZone = env.TIMEZONE || process.env.TZ || '';
  await db.sync();
  const rules = rulesOf(db.store);
  const out = { ok: true, eventId: String(eventId), action: null };
  try {
    const raw = await client.event(eventId);
    let item = { deleted: String(eventId) };
    if (raw) {
      const ev = readEvent(raw, { timeZone });
      let menu = null;
      if (ev && ['confirmed', 'tentative', 'completed'].includes(mapStatus(ev.status, rules))) {
        try { menu = menuLines(await client.menuSelections(ev.id), integration(db.store).menuItems || {}); } catch (e) { if (e instanceof TripleseatError && [401, 410].includes(e.status)) throw e; }
      }
      item = { raw, menu, menuFor: menu ? ev?.updatedAt || stamp() : null };
    }
    const r = await db.run((store) => createService(store).tripleseat.applyBatch([item], { rules, timeZone, locationId: client.config.locationId, initial: false }), { write: true, onCommit });
    out.action = r.results[0]?.action || null;
  } catch (e) {
    out.ok = false;
    out.error = e instanceof TripleseatError ? e.message : `Sync failed: ${e.message}`;
    if (!(e instanceof TripleseatError)) console.error('Tripleseat webhook sync failed:', e);
  }
  await db.run((store) => saveIntegration(store, {
    lastWebhook: { at: stamp(), trigger: String(trigger || '').slice(0, 60), eventId: out.eventId.slice(0, 40), action: out.action, ok: out.ok, error: out.error || null },
  }), { write: true }).catch((e) => console.error('Could not save Tripleseat webhook status:', e.message));
  return out;
}
