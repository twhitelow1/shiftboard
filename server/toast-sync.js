// Pull Toast data into ShiftBoard, one business day at a time, inside a time budget so each
// call fits Vercel's 30 s function limit. Whatever doesn't fit is returned as `next`, and the
// caller (the Sync now button, or tomorrow's cron) continues from there. Every day is written in
// its own transaction with ids taken from Toast, so running a day again never duplicates anything.
import { addDays, todayStr, daysBetween } from '../core/time.js';
import { applyDay, applyLists, integration, saveIntegration } from '../core/toast.js';
import { createToastClient, ToastError } from './toast.js';

export const MAX_RANGE_DAYS = 92;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Clamp a requested range: valid dates, oldest first, never today or later, at most MAX_RANGE_DAYS. */
export function syncRange({ from, to } = {}, today = todayStr()) {
  const yesterday = addDays(today, -1);
  let end = DAY.test(to || '') ? to : yesterday;
  if (end > yesterday) end = yesterday;
  let start = DAY.test(from || '') ? from : addDays(end, -13); // default: the last 14 days
  if (start > end) start = end;
  if (daysBetween(start, end) >= MAX_RANGE_DAYS) start = addDays(end, -(MAX_RANGE_DAYS - 1));
  return { from: start, to: end };
}

/**
 * @param {object} o
 * @param {import('./db.js').DocDb} o.db
 * @param {object} [o.client]   from createToastClient
 * @param {object} [o.env]
 * @param {string} o.from / o.to  business dates, inclusive
 * @param {boolean} [o.refresh] also reload Toast's restaurant, employees and jobs first
 * @param {boolean} [o.replaceManual] overwrite sales days typed in by hand
 * @param {string} [o.by]       user id, or 'cron'
 * @param {object} [o.run]      { id, from, to }: the whole Sync-now run this chunk belongs to
 * @param {number} [o.budgetMs] stop starting new days after this long
 * @returns {Promise<{ ok, done: object[], next: string|null, lists?: object, error?: string }>}
 */
export async function runToastSync({ db, env = process.env, client, from, to, refresh = false, replaceManual = false, by = null, run = null,
  budgetMs = 20_000, clock = () => Date.now() }) {
  const started = clock();
  client ||= createToastClient({ env });
  const out = { ok: true, done: [], next: null, from, to };
  const stamp = () => new Date().toISOString();

  try {
    if (refresh) {
      // Restaurant info is optional (needs restaurants:read); employees and jobs are required.
      const [restaurant, employees, jobs] = await Promise.all([
        client.restaurant().catch((e) => { out.warning = `Restaurant name not loaded: ${e.message}`; return null; }),
        client.employees(),
        client.jobs(),
      ]);
      out.lists = await db.run((store) => applyLists(store, { employees, jobs, restaurant, at: stamp() }), { write: true });
    }
    const timeZone = integration(db.store).timeZone || env.TIMEZONE || process.env.TZ || '';
    let slowest = 0;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const elapsed = clock() - started;
      if (out.done.length && elapsed + Math.max(slowest, 1500) > budgetMs) { out.next = date; break; }
      const t0 = clock();
      const [orders, entries] = await Promise.all([client.orders(date), client.timeEntries(date)]);
      const result = await db.run((store) => applyDay(store, { date, orders, entries, replaceManual, timeZone, at: stamp() }), { write: true });
      out.done.push(result);
      slowest = Math.max(slowest, clock() - t0);
    }
  } catch (e) {
    out.ok = false;
    out.error = e instanceof ToastError ? e.message : `Sync failed: ${e.message}`;
    if (!(e instanceof ToastError)) console.error('Toast sync failed:', e);
    out.next = null;
  }

  // Remember how it went (shown in Settings and on Labor review). Chunks of one run add up.
  await db.run((store) => {
    const i = integration(store);
    const prev = run?.id && i.lastSync?.runId === run.id ? i.lastSync : null;
    const totals = sumDays(out.done, prev?.totals);
    const lastSync = {
      runId: run?.id || null, at: stamp(), by,
      from: run?.from || prev?.from || from, to: run?.to || prev?.to || to,
      days: (prev?.days || 0) + out.done.length, totals,
      ok: out.ok, error: out.error || null, warning: out.warning || prev?.warning || null,
      finished: !out.next,
    };
    const patch = by === 'cron' ? { lastCron: lastSync } : {};
    if (by === 'cron' && out.done.length) {
      const through = out.done[out.done.length - 1].date;
      if (!i.cronThrough || through > i.cronThrough) patch.cronThrough = through;
    }
    saveIntegration(store, { ...patch, lastSync, history: [lastSync, ...(i.history || []).filter((h) => !lastSync.runId || h.runId !== lastSync.runId)].slice(0, 10) });
  }, { write: true }).catch((e) => console.error('Could not save Toast sync status:', e.message));

  return out;
}

function sumDays(days, base = {}) {
  const t = { sales: 0, covers: 0, orders: 0, salesKept: 0, entries: 0, unmatched: 0, removed: 0, ...base };
  for (const d of days) {
    if (d.sales) {
      t.sales = Math.round((t.sales + d.sales.sales) * 100) / 100;
      t.covers += d.sales.covers; t.orders += d.sales.orders;
      if (d.sales.saved === 'kept') t.salesKept++;
    }
    if (d.entries) { t.entries += d.entries.found; t.unmatched += d.entries.unmatched; t.removed += d.entries.removed; }
  }
  return t;
}

/**
 * The daily cron: the last 3 days (late clock-outs and tip edits land the next day), reaching
 * back to the day after the last one it finished (at most 14 days) if it missed some runs.
 */
export function cronRange(store, today = todayStr()) {
  const through = integration(store).cronThrough;
  let from = addDays(today, -3);
  if (through && addDays(through, 1) < from) from = addDays(through, 1);
  if (from < addDays(today, -14)) from = addDays(today, -14);
  return { from, to: addDays(today, -1) };
}
