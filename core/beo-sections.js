// A BEO's details as sections: everything a banquet event order says (except money), shown only where the BEO
// (or a manager) said something. Pure, so the server, the web app, the demo and the tests share it.
//
// A section: { key, title, kind, items, from? }
//   key    one of SECTION_KEYS ('other' for a heading this reader doesn't know)
//   title  the heading as the BEO wrote it (shown for 'other'; known keys show their own translated label)
//   kind   'timeline' items [{ time, end?, text }]       a run of show
//          'menu'     items [{ course, item, notes, qty?, dietary? }]
//          'list'     items [string]                     one line each
//          'keyvalue' items [{ label?|labelKey?, value }] label: as the BEO wrote it; labelKey: a word the app translates
//          'text'     items [string]                     paragraphs
//   from   the event fields this section's text also went into (setupNotes, contactNotes). While those fields are
//          as the import left them, the section shows instead of the field; once a manager edits the field, the
//          field shows and these sections don't, so nothing shows twice and a manager's edit always wins.
//
// The event keeps its usual fields (timeline, menu, beverage, dietaryNotes, setupNotes…: the editor edits those)
// and, when a BEO was imported, `beoSections`: what the BEO said beyond them. eventSections(e) puts both together,
// in a sensible order; visibleSections(e, { client }) is what one person may see: without client access (staff),
// no client contact section and no phone numbers or email addresses anywhere (vendors' included).

export const SECTION_KINDS = ['timeline', 'menu', 'list', 'keyvalue', 'text'];
/** Every section, in the order the event page shows them, with its usual kind. */
export const SECTIONS = [
  ['timeline', 'timeline'], ['menu', 'menu'], ['dietary', 'list'], ['bar', 'keyvalue'], ['kitchen', 'list'],
  ['setup', 'text'], ['rentals', 'list'], ['av', 'list'], ['decor', 'list'], ['vendors', 'list'], ['staffing', 'list'],
  ['arrival', 'text'], ['parking', 'list'], ['instructions', 'text'], ['notes', 'text'], ['signatures', 'keyvalue'],
  ['contacts', 'keyvalue'], ['other', 'text'],
];
export const SECTION_KEYS = SECTIONS.map(([k]) => k);
const KIND_OF = Object.fromEntries(SECTIONS);
/** The client's contact details and who signed the BEO for them: managers and the events team only (like the event's contact fields). */
export const PRIVATE_SECTIONS = ['contacts', 'signatures'];
/** Fields a BEO section can mirror (see `from`). */
export const MIRRORED_FIELDS = ['setupNotes', 'contactNotes'];
/** Labels the app translates (keyvalue items' labelKey). */
export const LABEL_KEYS = ['package', 'bar', 'notes', 'client', 'contact', 'phone', 'email', 'guaranteed', 'updated', 'signed'];
/** What staff (and the import preview) call the sections, in English; the web app has them in both languages. */
export const SECTION_TITLES = {
  timeline: 'Timeline', menu: 'Menu', dietary: 'Dietary & allergies', bar: 'Bar', kitchen: 'Kitchen notes', setup: 'Setup & floor plan',
  rentals: 'Rentals & room', av: 'A/V & entertainment', decor: 'Linens, decor & florals', vendors: 'Vendors', staffing: 'Staffing',
  arrival: 'Arrival', parking: 'Parking & coat check', instructions: 'Special instructions', notes: 'Notes', signatures: 'Signed & updated',
  contacts: 'Client contact', other: 'Other',
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lines = (s) => String(s || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
const unbullet = (s) => clean(s).replace(/^[•◦▪●○*–-]\s*/, '');

/** A short fingerprint of a value, to tell later whether someone changed it in ShiftBoard. */
export function fingerprint(v) {
  const s = JSON.stringify(v ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------- phone numbers and email addresses (staff don't see them) ----------
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 10 or 11 digits with or without separators ("(555) 010-3000", "555 - 010 - 4001", "7327421797", "+1 555.010.2000"),
// or 7 with a dash ("555-0100"). Times ("5:30 - 7:00"), counts and dates don't look like this.
const PHONE = /(?:\+?1[\s.-]*)?(?:\(\d{3}\)|\b\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b|\b\d{3}-\d{4}\b/g;
/** Text without phone numbers or email addresses ("Florist: Petal 555-010-5000" → "Florist: Petal"). */
export function redactContacts(text) {
  const s = String(text ?? '');
  if (!hasContact(s)) return s;
  return s.replace(EMAIL, ' ').replace(PHONE, ' ').replace(/\(\s*\)/g, ' ').replace(/\s*[|·,/–-]\s*$/, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}
/** Text with a phone number or an email address in it. */
export const hasContact = (s) => new RegExp(EMAIL.source).test(String(s ?? '')) || new RegExp(PHONE.source).test(String(s ?? ''));

// ---------- sections from the event's own fields ----------
function fieldSections(e) {
  const out = [];
  const add = (key, kind, items, fields) => { if (items.length) out.push({ key, title: '', kind, items, fields }); };
  add('timeline', 'timeline', (e.timeline || []).filter((x) => x?.time && clean(x.item)).map((x) => ({ time: x.time, ...(x.end ? { end: x.end } : {}), text: clean(x.item) })), ['timeline']);
  add('menu', 'menu', (e.menu || []).filter((m) => clean(m?.item) || clean(m?.notes)), ['menu']);
  add('dietary', 'list', lines(e.dietaryNotes).map(unbullet).filter(Boolean), ['dietaryNotes']);
  const b = e.beverage || {};
  add('bar', 'keyvalue', [
    ...(clean(b.package) ? [{ labelKey: 'package', value: clean(b.package) }] : []),
    ...(clean(b.bar) ? [{ labelKey: 'bar', value: clean(b.bar) }] : []),
    ...(lines(b.notes).length ? [{ labelKey: 'notes', value: lines(b.notes).join('\n') }] : []),
    ...(e.specialDrinks || []).filter((d) => clean(d?.name)).map((d) => ({
      label: `${clean(d.name)}${d.qty ? ` ×${d.qty}` : ''}`, value: [...lines(d.recipe), ...lines(d.notes), ...lines(d.batch)].join('\n'), drink: true,
    })),
  ], ['beverage', 'specialDrinks']);
  add('setup', 'text', lines(e.setupNotes), ['setupNotes']);
  add('av', 'list', lines(e.avNotes).map(unbullet).filter(Boolean), ['avNotes']);
  add('arrival', 'text', lines(e.arrivalNotes), ['arrivalNotes']);
  add('instructions', 'text', lines(e.specialInstructions), ['specialInstructions']);
  add('notes', 'text', lines(e.notes), ['notes']);
  add('contacts', 'keyvalue', [
    ...(clean(e.client) ? [{ labelKey: 'client', value: clean(e.client) }] : []),
    ...(clean(e.contactName) && clean(e.contactName) !== clean(e.client) ? [{ labelKey: 'contact', value: clean(e.contactName) }] : []),
    ...(clean(e.contactPhone) ? [{ labelKey: 'phone', value: clean(e.contactPhone) }] : []),
    ...(clean(e.contactEmail) ? [{ labelKey: 'email', value: clean(e.contactEmail) }] : []),
    ...lines(e.contactNotes).map((v) => ({ value: unbullet(v) })),
  ], ['client', 'contactName', 'contactPhone', 'contactEmail', 'contactNotes']);
  return out;
}

/** The fields someone changed in ShiftBoard since the import wrote them (the server sends this as beoEdited). */
export function editedFields(e) {
  if (Array.isArray(e?.beoEdited)) return e.beoEdited;
  const prints = e?.beoPrints;
  if (!prints) return [];
  return MIRRORED_FIELDS.filter((f) => f in prints && prints[f] !== fingerprint(e[f]));
}

const hasItem = (kind, x) => {
  if (kind === 'timeline') return !!(x?.time && clean(x.text));
  if (kind === 'menu') return !!(clean(x?.item) || clean(x?.notes));
  if (kind === 'keyvalue') return !!clean(x?.value);
  return !!clean(x);
};

/**
 * Every section the event has something for, in order: the event's fields and the BEO's own sections. Sections the
 * BEO mirrored into a field show while that field is as imported; a section with nothing in it is left out.
 */
export function eventSections(e = {}) {
  const beo = (Array.isArray(e.beoSections) ? e.beoSections : Array.isArray(e.sections) ? e.sections : []).filter((s) => s && typeof s === 'object');
  const edited = new Set(editedFields(e));
  const kept = beo.filter((s) => !(s.from || []).some((f) => edited.has(f)));
  const covered = new Set(kept.flatMap((s) => s.from || []));
  const fromFields = fieldSections(e).map((s) => {
    if (s.key === 'contacts') {
      // The contact fields always show; contactNotes only when no BEO section carries it.
      return covered.has('contactNotes') ? { ...s, items: s.items.filter((x) => x.labelKey) } : s;
    }
    return s.fields.some((f) => covered.has(f)) ? null : s;
  }).filter(Boolean).map(({ fields, ...s }) => s);
  const order = (k) => { const i = SECTION_KEYS.indexOf(k); return i < 0 ? SECTION_KEYS.length : i; };
  const all = [...fromFields, ...kept.map((s) => ({ key: s.key, title: s.title || '', kind: s.kind || KIND_OF[s.key] || 'text', items: s.items || [] }))]
    .map((s, i) => ({ ...s, items: s.items.filter((x) => hasItem(s.kind, x)), at: i }))
    .filter((s) => s.items.length);
  // One section per key and kind (the field's first, then the BEO's), except "other", which keeps each heading.
  const merged = [];
  for (const s of all) {
    const same = s.key !== 'other' && merged.find((m) => m.key === s.key && m.kind === s.kind);
    if (same) same.items = [...same.items, ...s.items]; else merged.push({ ...s });
  }
  return merged.sort((a, b) => order(a.key) - order(b.key) || a.at - b.at).map(({ at, ...s }) => s);
}

/** A value with phone numbers and email addresses taken out, deep (section items). */
function redactDeep(v) {
  if (typeof v === 'string') return redactContacts(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'time' || k === 'end' || k === 'labelKey' ? x : redactDeep(x)]));
  return v;
}

/**
 * The sections one person sees. viewer.client: may see the client's details (managers and the events team).
 * Others get no client contact section and no phone numbers or email addresses in any section.
 */
export function visibleSections(e, { client = false } = {}) {
  const all = eventSections(e);
  if (client) return all;
  return all.filter((s) => !PRIVATE_SECTIONS.includes(s.key)).map((s) => {
    const kind = s.kind;
    return { ...s, items: redactDeep(s.items).filter((x) => hasItem(kind, x)) };
  }).filter((s) => s.items.length);
}

/** The BEO sections staff may be sent (server: events.get for people without client access). */
export function sectionsForStaff(list) {
  return (list || []).filter((s) => !PRIVATE_SECTIONS.includes(s.key)).map((s) => ({ ...s, title: redactContacts(s.title), items: redactDeep(s.items || []).filter((x) => hasItem(s.kind, x)) })).filter((s) => s.items.length);
}

const sig = (s) => `${s.key}|${s.key === 'other' ? clean(s.title).toLowerCase() : ''}`;
/**
 * What changed between two versions of an event, section by section: [{ key, title, change: 'new'|'changed'|'removed' }].
 */
export function sectionChanges(before, after) {
  const a = eventSections(before || {}), b = eventSections(after || {});
  const byA = new Map(a.map((s) => [sig(s), s])), byB = new Map(b.map((s) => [sig(s), s]));
  const out = [];
  for (const s of b) {
    const was = byA.get(sig(s));
    if (!was) out.push({ key: s.key, title: s.title, change: 'new' });
    else if (JSON.stringify(was.items) !== JSON.stringify(s.items)) out.push({ key: s.key, title: s.title, change: 'changed' });
  }
  for (const s of a) if (!byB.has(sig(s))) out.push({ key: s.key, title: s.title, change: 'removed' });
  return out;
}

/** The sections a parsed BEO has, for the preview: [{ key, title, count }]. */
export function sectionsFound(e) {
  return eventSections(e).map((s) => ({ key: s.key, title: s.title, count: s.items.length }));
}

/** Which section a heading the BEO uses belongs to ('DECOR' → decor, 'ENTERTAINMENT' → av…), else 'other'. */
export function sectionKeyFor(heading) {
  const h = clean(heading).toLowerCase();
  if (!h) return 'other';
  const rules = [
    ['timeline', /\b(timeline|run of show|itinerary|schedule of events|agenda)\b/],
    ['menu', /\b(menu|food|catering|courses?)\b/],
    ['dietary', /\b(dietary|allerg|restrictions?)\b/],
    ['bar', /\b(beverage|bar|drinks?|wine|liquor|cocktails?)\b/],
    ['kitchen', /\b(kitchen|chef|culinary|boh)\b/],
    ['rentals', /\b(rentals?|equipment|furniture|room rental|venue)\b/],
    ['av', /\b(a\/?v|audio|visual|entertainment|music|dj|band|lighting|sound|tech)\b/],
    ['decor', /\b(decor|décor|linens?|flor(?:al|ist)s?|flowers|centerpieces?|d[eé]cor)\b/],
    ['vendors', /\b(vendors?|suppliers?)\b/],
    ['staffing', /\b(staff(?:ing)?|labor|servers?|bartenders?|personnel)\b/],
    ['arrival', /\b(arrival|load[- ]?in|load[- ]?out|access|entrance)\b/],
    ['parking', /\b(parking|valet|coat ?check|shuttle|transport)\b/],
    ['setup', /\b(set ?up|floor ?plan|layout|seating|room set)\b/],
    ['instructions', /\b(special instructions?|instructions?)\b/],
    ['signatures', /\b(signatures?|signed|approval|last updated)\b/],
    ['contacts', /\b(contacts?|client|host)\b/],
    ['notes', /\b(notes?|comments?|remarks?|details?)\b/],
  ];
  return rules.find(([, re]) => re.test(h))?.[0] || 'other';
}
export const kindFor = (key) => KIND_OF[key] || 'text';
