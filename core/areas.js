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

// Banner colors for areas that don't have one yet: light spreadsheet fills that take black text.
const FALLBACK_COLORS = ['#9bc2e6', '#a9d08e', '#f4b084', '#ffd966', '#b4c6e7', '#c9c9c9', '#f8cbad', '#c6e0b4'];

/** The banner color for an area or department (settings.areaColors, else a steady fallback). */
export function bannerColor(settings = {}, name = '', index = 0) {
  const colors = settings.areaColors || {};
  const hit = Object.keys(colors).find((k) => sameArea(k, name));
  return hit ? colors[hit] : FALLBACK_COLORS[Math.abs(index) % FALLBACK_COLORS.length];
}

/** Black or white text, whichever reads better on `hex` (black unless the fill is dark). */
export function textOn(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '#000';
  const lin = (v) => { const c = parseInt(v, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return L > 0.15 ? '#000' : '#fff';
}
