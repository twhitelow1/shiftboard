// Weekday names as spreadsheets write them, English and Spanish, full and short ("Monday", "Mon", "Lunes",
// "Lun", "Mié"), for reading a column header as a weekday (smart import's availability target). Day numbers are
// JavaScript's: 0 Sunday … 6 Saturday, the keys of a user's `availability`.
//
// Keys are compared after headerKey (core/smart-import.js): accents folded, lower case, letters and digits.

/** Every name for each day, longest (surest) first. */
export const DAY_HEADER_NAMES = [
  ['sunday', 'sundays', 'domingo', 'domingos', 'sun', 'dom', 'su', 'do'],
  ['monday', 'mondays', 'lunes', 'mon', 'lun', 'mo', 'lu'],
  ['tuesday', 'tuesdays', 'martes', 'tues', 'tue', 'mar', 'tu', 'ma'],
  ['wednesday', 'wednesdays', 'miercoles', 'weds', 'wed', 'mie', 'mier', 'we', 'mi'],
  ['thursday', 'thursdays', 'jueves', 'thurs', 'thur', 'thu', 'jue', 'th', 'ju'],
  ['friday', 'fridays', 'viernes', 'fri', 'vie', 'fr', 'vi'],
  ['saturday', 'saturdays', 'sabado', 'sabados', 'sat', 'sab', 'sa'],
];
/** The field key each day has in an availability import ('mon' … 'sun'). */
export const DAY_FIELDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FULL = new Map(DAY_HEADER_NAMES.flatMap((names, d) => names.filter((n) => n.length >= 5).map((n) => [n, d])));
const ANY = new Map(DAY_HEADER_NAMES.flatMap((names, d) => names.map((n) => [n, d])));

/**
 * The weekday a header names (an already folded key like "monday", "mon 9 28", "lunes lun", "availability monday"),
 * or -1. A full name anywhere in a short header counts; a short name ("Mon", "Do") only when the rest of the header
 * is a date or another name for the same day, so "Max hours" or "Do not schedule" never pass for days.
 */
export function dayOfHeader(key) {
  const words = String(key || '').split(' ').filter(Boolean);
  if (!words.length || words.length > 4) return -1;
  for (const w of words) if (FULL.has(w)) return FULL.get(w);
  if (!ANY.has(words[0])) return -1;
  const d = ANY.get(words[0]);
  return words.slice(1).every((w) => /^\d+$/.test(w) || ANY.get(w) === d) ? d : -1;
}
