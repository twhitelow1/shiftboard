// Where actual worked hours come from: ADP (the time clock most restaurants run payroll from),
// Toast (POS clock-ins), or both with ADP winning. Every reader of `timeEntries` (Labor review, the
// tip pool, the staffing calibration) goes through here, so one shift is never counted twice.
//
// settings.clockSource:
//   'auto' (default)  ADP when there's any ADP data, otherwise Toast
//   'adp'             ADP only
//   'toast'           Toast only
//   'both'            ADP wins: per person per day, ADP's entries if they have any, else Toast's
//
// Toast stays the source of tips. A Toast entry whose hours lose to ADP is kept as a tips-only
// entry (no hours, no times), so "use Toast's tips" in the tip pool and the tips column still work.
export const CLOCK_SOURCES = ['auto', 'adp', 'toast', 'both'];
export const ADP = 'adp';
export const TOAST = 'toast';

const tipsOf = (e) => (Number(e.declaredCashTips) || 0) + (Number(e.nonCashTips) || 0);

/** The setting as saved ('auto' when unset or unknown). */
export const clockSetting = (settings) => (CLOCK_SOURCES.includes(settings?.clockSource) ? settings.clockSource : 'auto');

/** 'adp' | 'toast' | 'both': the setting with 'auto' worked out. */
export function resolveClockSource(settings, hasAdp) {
  const s = clockSetting(settings);
  if (s !== 'auto') return s;
  return hasAdp ? ADP : TOAST;
}

/** True when the store holds any ADP time entries (what 'auto' looks at). */
export const hasAdpEntries = (store) => store.list('timeEntries', (t) => t.source === ADP).length > 0;

/** A Toast entry that lost its hours to ADP, keeping only its tips. */
function tipsOnly(e) {
  return { ...e, regularHours: 0, overtimeHours: 0, inLocal: null, outLocal: null, inAt: null, outAt: null, breakMinutes: 0, tipsOnly: true };
}

/**
 * Pick the entries that count, for a resolved source. Entries from other sources are dropped, except
 * Toast entries with tips, which come back as tips-only (no hours).
 * @param {object[]} entries  timeEntries (any sources, any dates)
 * @param {'adp'|'toast'|'both'} source
 * @returns {{ entries: object[], ignored: { adp: number, toast: number } }}
 */
export function pickEntries(entries, source) {
  const out = [];
  const ignored = { adp: 0, toast: 0 };
  const lose = (e) => {
    ignored[e.source === ADP ? 'adp' : 'toast']++;
    if (e.source !== ADP && e.userId && tipsOf(e) > 0) out.push(tipsOnly(e));
  };
  if (source === TOAST) {
    for (const e of entries) (e.source === ADP ? lose(e) : out.push(e));
    return { entries: out, ignored };
  }
  if (source === ADP) {
    for (const e of entries) (e.source === ADP ? out.push(e) : lose(e));
    return { entries: out, ignored };
  }
  // 'both': ADP wins. On a day ADP has, a person's Toast entries count only if ADP has nothing for
  // them that day and every ADP entry that day is matched to a person (an unmatched ADP entry could
  // be anyone, so Toast fills nothing that day). Unmatched Toast entries on an ADP day could be anyone too.
  const adpDays = new Map(); // date -> { people: Set, unmatched: boolean }
  for (const e of entries) {
    if (e.source !== ADP) continue;
    const d = adpDays.get(e.date) || { people: new Set(), unmatched: false };
    if (e.userId) d.people.add(e.userId); else d.unmatched = true;
    adpDays.set(e.date, d);
  }
  for (const e of entries) {
    if (e.source === ADP) { out.push(e); continue; }
    const day = adpDays.get(e.date);
    if (!day) { out.push(e); continue; }
    if (day.unmatched || !e.userId || day.people.has(e.userId)) lose(e);
    else out.push(e);
  }
  return { entries: out, ignored };
}

/**
 * The time entries that count, straight from a store. `filter` narrows the dates (always pass one
 * for a week; the source is resolved over the whole store).
 * @returns {{ entries: object[], source: 'adp'|'toast'|'both', setting: string, ignored: object }}
 */
export function clockEntries(store, settings, filter) {
  const setting = clockSetting(settings);
  const source = resolveClockSource(settings, setting === 'auto' ? hasAdpEntries(store) : false);
  const picked = pickEntries(store.list('timeEntries', filter), source);
  return { ...picked, source, setting };
}

/** Where a day's (or a person's) hours came from: 'adp', 'toast', 'adp+toast' or null. */
export function sourcesLabel(entries) {
  const set = new Set(entries.filter((e) => !e.tipsOnly).map((e) => (e.source === ADP ? ADP : TOAST)));
  if (!set.size) return null;
  return set.size > 1 ? 'adp+toast' : [...set][0];
}
