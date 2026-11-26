// A BEO's details as sections, copied from core/beo-sections.js eventSections() (keep them in step): the event's own
// fields and the BEO's sections (events.get beoSections), in order, leaving out anything empty. The server already
// leaves out the client's contact and every phone number and email for people who aren't on the events team, and
// says which mirrored fields a manager edited since the import (beoEdited): those show instead of the BEO's copy.
import type { EventDetail } from './types';

export type SectionKind = 'timeline' | 'menu' | 'list' | 'keyvalue' | 'text';
export interface TimelineItem { time: string; end?: string; text: string }
export interface MenuItem { course?: string; item?: string; notes?: string; qty?: number; dietary?: string[] }
export interface KeyValueItem { label?: string; labelKey?: string; value: string; drink?: boolean }
export type SectionItem = TimelineItem | MenuItem | KeyValueItem | string;
export interface BeoSection { key: string; title?: string; kind: SectionKind; items: SectionItem[]; from?: string[] }

/** The client's contact and who signed for them: the server sends these only to the events team. */
export const PRIVATE = ['contacts', 'signatures'];
export const SECTION_KEYS = ['timeline', 'menu', 'dietary', 'bar', 'kitchen', 'setup', 'rentals', 'av', 'decor', 'vendors', 'staffing',
  'arrival', 'parking', 'instructions', 'notes', 'signatures', 'contacts', 'other'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export const isSectionKey = (k: string): k is SectionKey => (SECTION_KEYS as readonly string[]).includes(k);
export const LABEL_KEYS = ['package', 'bar', 'notes', 'client', 'contact', 'phone', 'email', 'guaranteed', 'updated', 'signed'] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
export const isLabelKey = (k: string | undefined): k is LabelKey => (LABEL_KEYS as readonly string[]).includes(k || '');

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lines = (s: unknown) => String(s || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
const unbullet = (s: string) => clean(s).replace(/^[•◦▪●○*–-]\s*/, '');

function hasItem(kind: SectionKind, x: SectionItem): boolean {
  if (kind === 'timeline') return !!((x as TimelineItem)?.time && clean((x as TimelineItem).text));
  if (kind === 'menu') return !!(clean((x as MenuItem)?.item) || clean((x as MenuItem)?.notes));
  if (kind === 'keyvalue') return !!clean((x as KeyValueItem)?.value);
  return !!clean(x);
}

function fieldSections(e: EventDetail, client: boolean): (BeoSection & { fields: string[] })[] {
  const out: (BeoSection & { fields: string[] })[] = [];
  const add = (key: string, kind: SectionKind, items: SectionItem[], fields: string[]) => { if (items.length) out.push({ key, kind, items, fields }); };
  add('timeline', 'timeline', (e.timeline || []).filter((x) => x?.time && clean(x.item)).map((x) => ({ time: x.time, ...(x.end ? { end: x.end } : {}), text: clean(x.item) })), ['timeline']);
  add('menu', 'menu', (e.menu || []).filter((m) => clean(m?.item) || clean(m?.notes)), ['menu']);
  add('dietary', 'list', lines(e.dietaryNotes).map(unbullet).filter(Boolean), ['dietaryNotes']);
  const b = e.beverage || {};
  add('bar', 'keyvalue', [
    ...(clean(b.package) ? [{ labelKey: 'package', value: clean(b.package) }] : []),
    ...(clean(b.bar) ? [{ labelKey: 'bar', value: clean(b.bar) }] : []),
    ...(lines(b.notes).length ? [{ labelKey: 'notes', value: lines(b.notes).join('\n') }] : []),
    ...(e.specialDrinks || []).filter((d) => clean(d?.name)).map((d) => ({ label: `${clean(d.name)}${d.qty ? ` ×${d.qty}` : ''}`, value: [...lines(d.recipe), ...lines(d.notes), ...lines(d.batch)].join('\n'), drink: true })),
  ], ['beverage', 'specialDrinks']);
  add('setup', 'text', lines(e.setupNotes), ['setupNotes']);
  add('av', 'list', lines(e.avNotes).map(unbullet).filter(Boolean), ['avNotes']);
  add('arrival', 'text', lines(e.arrivalNotes), ['arrivalNotes']);
  add('instructions', 'text', lines(e.specialInstructions), ['specialInstructions']);
  add('notes', 'text', lines(e.notes), ['notes']);
  if (client) {
    add('contacts', 'keyvalue', [
      ...(clean(e.client) ? [{ labelKey: 'client', value: clean(e.client) }] : []),
      ...(clean(e.contactName) && clean(e.contactName) !== clean(e.client) ? [{ labelKey: 'contact', value: clean(e.contactName) }] : []),
      ...(clean(e.contactPhone) ? [{ labelKey: 'phone', value: clean(e.contactPhone) }] : []),
      ...(clean(e.contactEmail) ? [{ labelKey: 'email', value: clean(e.contactEmail) }] : []),
      ...lines(e.contactNotes).map((v) => ({ value: unbullet(v) })),
    ], ['client', 'contactName', 'contactPhone', 'contactEmail', 'contactNotes']);
  }
  return out;
}

/** The sections this person sees, in order. client: the events team (the only ones who see the client's contact). */
export function eventSections(e: EventDetail, client: boolean): BeoSection[] {
  const edited = new Set(e.beoEdited || []);
  const kept = (e.beoSections || []).filter((s) => s && !(s.from || []).some((f) => edited.has(f)) && (client || !PRIVATE.includes(s.key)));
  const covered = new Set(kept.flatMap((s) => s.from || []));
  const fromFields = fieldSections(e, client).map((s) => {
    if (s.key === 'contacts') return covered.has('contactNotes') ? { ...s, items: s.items.filter((x) => (x as KeyValueItem).labelKey) } : s;
    return s.fields.some((f) => covered.has(f)) ? null : s;
  }).filter((s): s is BeoSection & { fields: string[] } => !!s);
  const order = (k: string) => { const i = (SECTION_KEYS as readonly string[]).indexOf(k); return i < 0 ? SECTION_KEYS.length : i; };
  const all = [...fromFields.map(({ fields, ...s }) => s), ...kept.map((s) => ({ key: s.key, title: s.title || '', kind: s.kind, items: s.items || [] }))]
    .map((s, at) => ({ ...s, items: s.items.filter((x) => hasItem(s.kind, x)), at }))
    .filter((s) => s.items.length);
  const merged: (BeoSection & { at: number })[] = [];
  for (const s of all) {
    const same = s.key !== 'other' && merged.find((m) => m.key === s.key && m.kind === s.kind);
    if (same) same.items = [...same.items, ...s.items]; else merged.push({ ...s });
  }
  return merged.sort((a, b) => order(a.key) - order(b.key) || a.at - b.at).map(({ at, ...s }) => s);
}
