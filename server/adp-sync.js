// Pull ADP time cards into ShiftBoard, one day at a time, inside a time budget so each call fits
// Vercel's 30 s function limit (the same shape as server/toast-sync.js). ADP hands out time cards a
// pay period at a time, so each period is fetched once per call and its days are written one by one.
// Whatever doesn't fit is returned as `next`; the Sync now button (or tomorrow's cron) continues.
// Every day is written in its own transaction with ids from ADP, so running a day again changes nothing.
import { addDays, todayStr } from '../core/time.js';
import { applyAdpDay, applyWorkers, integration, saveIntegration, payPeriodStart, timeCardPunches } from '../core/adp.js';
import { createAdpClient, AdpError } from './adp.js';

export { syncRange } from './toast-sync.js'; // same rules: valid dates, never today, at most 92 days

/**
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} [o.client]   from createAdpClient
 * @param {string} o.from / o.to  dates, inclusive
 * @param {boolean} [o.refresh] reload ADP's workers (and the current pay period) first
 * @param {string} [o.by]       user id, or 'cron'
 * @param {object} [o.run]      { id, from, to }: the whole Sync-now run this chunk belongs to
 * @param {number} [o.budgetMs] stop starting new days after this long
 */
export async function runAdpSync({ db, env = process.env, client, from, to, refresh = false, by = null, run = null, budgetMs = 20_000, clock = () => Date.now() }) {
  const started = clock();
  client ||= createAdpClient({ env });
  const out = { ok: true, done: [], next: null, from, to };
  const stamp = () => new Date().toISOString();

  try {
    if (refresh || !db.store.list('adpWorkers', (w) => w.aoid).length) {
      const workers = await client.workers();
      out.lists = await db.run((store) => applyWorkers(store, workers, { at: stamp() }), { write: true });
    }
    const aoids = () => db.store.list('adpWorkers', (w) => w.aoid && !w.deleted).map((w) => w.aoid);
    let anchor = integration(db.store).payPeriod;
    if (refresh || !anchor) {
      anchor = await client.currentPeriod({ aoids: aoids() });
      if (!anchor) throw new AdpError('ADP returned no time cards for the current pay period. Check that Time & Attendance is on for these employees and that the app can read time cards.');
      await db.run((store) => saveIntegration(store, { payPeriod: anchor }), { write: true });
    }
    const timeZone = env.TIMEZONE || process.env.TZ || '';
    const periods = new Map(); // period start -> punches
    let slowest = 0;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const elapsed = clock() - started;
      if (out.done.length && elapsed + Math.max(slowest, 1500) > budgetMs) { out.next = date; break; }
      const t0 = clock();
      const start = payPeriodStart(date, anchor);
      if (!periods.has(start)) periods.set(start, timeCardPunches(await client.timeCards({ periodStart: start, aoids: aoids() }), { timeZone }));
      const punches = periods.get(start).filter((p) => p.date === date);
      out.done.push(await db.run((store) => applyAdpDay(store, { date, punches, at: stamp() }), { write: true }));
      slowest = Math.max(slowest, clock() - t0);
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof AdpError ? e.message : `Sync failed: ${e.message}`;
    if (!(e instanceof AdpError)) console.error('ADP sync failed:', e);
    out.next = null;
  }

  // Remember how it went (Settings → Integrations → ADP, and Labor review). Chunks of one run add up.
  await db.run((store) => {
    const i = integration(store);
    const prev = run?.id && i.lastSync?.runId === run.id ? i.lastSync : null;
    const totals = { entries: 0, unmatched: 0, removed: 0, ...prev?.totals };
    for (const d of out.done) { totals.entries += d.found; totals.unmatched += d.unmatched; totals.removed += d.removed; }
    const lastSync = {
      runId: run?.id || null, at: stamp(), by, from: run?.from || prev?.from || from, to: run?.to || prev?.to || to,
      days: (prev?.days || 0) + out.done.length, totals, ok: out.ok, error: out.error || null, finished: !out.next,
    };
    const patch = by === 'cron' ? { lastCron: lastSync } : {};
    if (by === 'cron' && out.done.length) {
      const through = out.done.at(-1).date;
      if (!i.cronThrough || through > i.cronThrough) patch.cronThrough = through;
    }
    saveIntegration(store, { ...patch, lastSync, history: [lastSync, ...(i.history || []).filter((h) => !lastSync.runId || h.runId !== lastSync.runId)].slice(0, 10) });
  }, { write: true }).catch((e) => console.error('Could not save ADP sync status:', e.message));

  return out;
}

/** The daily cron: the last 3 days (late punch edits), reaching back to the day after the last one it finished (at most 14). */
export function cronRange(store, today = todayStr()) {
  const through = integration(store).cronThrough;
  let from = addDays(today, -3);
  if (through && addDays(through, 1) < from) from = addDays(through, 1);
  if (from < addDays(today, -14)) from = addDays(today, -14);
  return { from, to: addDays(today, -1) };
}
