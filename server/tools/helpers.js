// Shared bits for the tools: who's who and what's what (from app.bootstrap, the same view the app gets), and
// compact shapes for shifts, so answers stay small. Names are matched loosely ("alex" finds "Alex D").
import { AppError } from '../../core/service.js';
import { dow, DOW_SHORT } from '../../core/time.js';
import { z } from 'zod';
import { DATE_HELP } from './dates.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/** What this person's app knows (people they may see, positions, settings, layout), read once per call. */
export async function lookupOf(ctx) {
  if (ctx._look) return ctx._look;
  const b = await ctx.read('app.bootstrap');
  const people = Object.fromEntries(b.employees.map((e) => [e.id, e]));
  const jobs = Object.fromEntries(b.jobCodes.map((j) => [j.id, j]));
  ctx._look = { ...b, people, jobs };
  return ctx._look;
}

function pick(list, query, label, nameOf = (x) => x.name) {
  const q = norm(query);
  if (!q) return null;
  const byId = list.find((x) => x.id === query);
  if (byId) return byId;
  const exact = list.filter((x) => norm(nameOf(x)) === q);
  if (exact.length === 1) return exact[0];
  const some = (exact.length ? exact : list.filter((x) => norm(nameOf(x)).includes(q) || q.split(' ').every((w) => norm(nameOf(x)).includes(w))));
  if (some.length === 1) return some[0];
  if (!some.length) throw new AppError(404, `No ${label} matches “${query}”`);
  throw new AppError(400, `More than one ${label} matches “${query}”: ${some.slice(0, 6).map(nameOf).join(', ')}`);
}
/** A person by id or name (active people only), among those this person can see. */
export const findPerson = (look, query) => pick(look.employees.filter((e) => e.active !== false), query, 'person');
/** A position (job code) by id, name or short name. */
export const findPosition = (look, query) => {
  const list = look.jobCodes.filter((j) => !j.archived);
  try { return pick(list, query, 'position'); } catch (e) {
    const short = list.filter((j) => norm(j.short) === norm(query));
    if (short.length === 1) return short[0];
    throw e;
  }
};

/** A shift as the tools show it. */
export function shiftOut(s, look, { mine = false } = {}) {
  const job = look.jobs[s.jobCodeId];
  return {
    id: s.id, date: s.date, day: DOW_SHORT[dow(s.date)], start: s.start, end: s.end || (look.settings.startTimesOnly ? null : 'close'),
    position: job?.name || '', room: s.area || '', ...(mine ? {} : { person: s.userId ? look.people[s.userId]?.name || '' : null }),
    ...(s.tag ? { tag: s.tag } : {}), ...(s.notes ? { notes: s.notes } : {}), ...(s.eventId ? { eventId: s.eventId } : {}),
    ...(s.published ? {} : { draft: true }), ...(s.pending ? { pendingRequest: s.pending } : {}),
    ...(s.hours != null ? { hours: s.hours } : {}),
  };
}

export const byTime = (a, b) => (a.date + a.start).localeCompare(b.date + b.start);

// Input pieces the tools share.
export const dateArg = (what = 'The date') => z.string().max(40).describe(`${what}: ${DATE_HELP}`);
export const confirmArg = z.boolean().optional().describe('Set to true only after the user has said yes to exactly this change.');
export const idArg = (what) => z.string().min(1).max(80).describe(what);
