// A person's names. `name` is the common name: what everyone calls them, shown everywhere (the
// schedule, Team, notifications, the phone app). legalFirstName / legalLastName are the optional
// legal name, as on payroll ("Moe" goes by Moe; payroll has his legal name). Empty means the same
// as `name`, so older data needs no migration.
//
// Who sees the legal name: the person themselves, admins, and managers who can manage that person
// (core/roles.js canManageUser). Coworkers never do: every RPC that returns people strips it for them.
//
// Matching: payroll-type sources (ADP imports and sync, Toast employees) try the legal name first and
// then the common name; the house schedule (which writes MOE) tries the common name first.
import { canChangeSettings, canManageUser } from './roles.js';

export const LEGAL_FIELDS = ['legalFirstName', 'legalLastName'];
const MAX = 60;
const tidy = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX);
/** Lowercase letters and digits, single spaces, accents dropped: for comparing names. */
export const nameKey = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** 'Carlos Javier Ortiz', or '' when no legal name is saved. */
export const legalNameOf = (u) => [u?.legalFirstName, u?.legalLastName].map(tidy).filter(Boolean).join(' ');
/** The name for payroll: the legal name, else the common name. */
export const payrollName = (u) => legalNameOf(u) || tidy(u?.name);
/** A legal name is saved and isn't just the common name again. */
export const legalDiffers = (u) => { const l = legalNameOf(u); return !!l && nameKey(l) !== nameKey(u?.name); };
/** 'CJ (Carlos Javier Ortiz)' when the legal name differs, else 'CJ'. Only for people who may see it. */
export const nameWithLegal = (u) => (legalDiffers(u) ? `${tidy(u.name)} (${legalNameOf(u)})` : tidy(u?.name));

/**
 * Every name a person answers to, for other features that look for people in free text (reviews,
 * notes): the common name, the legal first name, the legal full name. No duplicates, no blanks.
 */
export function aliasesOf(u) {
  const seen = new Set();
  const out = [];
  for (const n of [u?.name, u?.legalFirstName, legalNameOf(u)].map(tidy)) {
    const k = nameKey(n);
    if (k && !seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}

/**
 * The keys a matcher compares, most preferred first: [legal keys, common keys] for payroll-type
 * sources (ADP, Toast, payroll files), [common keys, legal keys] otherwise.
 */
export function nameTiers(u, { payroll = true } = {}) {
  const legal = [nameKey(legalNameOf(u))].filter(Boolean);
  const common = [nameKey(u?.name), nameKey(u?.sheetName)].filter(Boolean);
  return payroll ? [legal, common] : [common, legal];
}

/** Search: every word typed is in the common name, the name on the schedule or the legal name. */
export function nameMatches(u, query) {
  const words = nameKey(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = nameKey([u?.name, u?.sheetName, legalNameOf(u)].join(' '));
  return words.every((w) => hay.includes(w));
}

/** Whether `actor` may see `target`'s legal name: themselves, admins, and managers who can manage them. */
export function canSeeLegalName(actor, target) {
  if (!actor || !target) return false;
  return actor.id === target.id || canChangeSettings(actor) || canManageUser(actor, target);
}

/** `view` (a person as sent to `actor`) with the legal name when the actor may see it, without it otherwise. */
export function legalNameFor(actor, target, view = target) {
  const out = { ...view };
  for (const k of LEGAL_FIELDS) delete out[k];
  if (!canSeeLegalName(actor, target)) return out;
  return { ...out, legalFirstName: tidy(target.legalFirstName), legalLastName: tidy(target.legalLastName) };
}

/** The legal-name fields of a save request, cleaned: only the ones it sends (a missing field is left as it is). */
export function legalNamePatch(a = {}) {
  const patch = {};
  for (const k of LEGAL_FIELDS) if (k in a) patch[k] = tidy(a[k]);
  return patch;
}

/**
 * The two name columns payroll and tip exports carry: the legal name (empty legal name = the common
 * name), then the common name. `u` is the person as the exporting manager got them: when the legal
 * name was held back from them (legalNameFor), the legal column stays blank rather than guess.
 */
export const NAME_COLUMNS = ['Legal name', 'Name'];
export function nameColumns(u, fallbackName = '') {
  const name = tidy(u?.name) || tidy(fallbackName);
  const shown = !!u && LEGAL_FIELDS.some((k) => k in u);
  return [shown ? legalNameOf(u) || name : '', name];
}
