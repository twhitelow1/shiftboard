// Schedule areas: where a shift is worked (Restaurant, Rabbit Hole, Moon Rabbit, Back Host Stand…).
// An area is separate from the position (the job code): a Bartender can work the Restaurant bar one
// night and the Moon Rabbit the next. The house sheet shows areas as banners over its sections.

const BOOKING_ONLY = /full buyout/i; // listed with the rooms for events, but nobody works "in" it

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Clean an area name: single spaces, at most 60 characters. */
export const cleanArea = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** True when two area names mean the same place ("RABBIT HOLE" and "Rabbit Hole"). */
export const sameArea = (a, b) => !!key(a) && key(a) === key(b);

/**
 * The areas offered on the schedule, in display order: the schedule's own list (settings.areas,
 * kept in the sheet's order by the importer), then any rooms that aren't in it yet.
 */
export function scheduleAreas(settings = {}) {
  const out = [];
  for (const a of [...(settings.areas || []), ...(settings.rooms || []).filter((r) => !BOOKING_ONLY.test(r))]) {
    const name = cleanArea(a);
    if (name && !out.some((x) => sameArea(x, name))) out.push(name);
  }
  return out;
}

/** The existing spelling of an area, or null. */
export const findArea = (name, areas) => areas.find((a) => sameArea(a, name)) || null;

/** Unique, cleaned list of areas (first spelling wins). */
export function uniqueAreas(list) {
  const out = [];
  for (const a of list || []) {
    const name = cleanArea(a);
    if (name && !out.some((x) => sameArea(x, name))) out.push(name);
  }
  return out;
}
