// OpenTable → ShiftBoard. Reservations (covers, party sizes, times, special requests, the requested
// server) and reviews (stars, text, dining date, the server), from OpenTable's exports (Guest Center →
// Reporting, read in the browser by core/guest-csv.js) or, once OpenTable grants API access, from its API
// (server/opentable*.js). Both land in the same documents, keyed by OpenTable's own ids (the confirmation
// number, the review id) or a stable hash, so importing again or syncing after an import never counts twice.
// Research, what's verified and what isn't: docs/integrations/OPENTABLE.md.
//
// Collections written here:
//   otReservations   `otr_<key>`: date, time, partySize, status (booked/seated/done/cancelled/noShow), notes
//                    (special requests and host notes, contact details blanked), requestedServer, server,
//                    table, area, guest as "Dana K." at most. Never a phone number or an email address.
//   guestReviews     through core/impact.js (applyReviews), source 'opentable'
//   integrations     'opentable': imports, remembered columns, last sync / cron, the run in progress
//
// Forecast (bookingBlend): booked covers feed the projected covers for upcoming days. For a day from
// today on, projected = booked covers × (1 − the no-show rate) + the usual walk-ins for that weekday,
// and the forecast takes it when it's higher than the forecast from sales history (bookings never pull a
// forecast down: they're a floor, since more bookings come in until the day). The no-show rate and walk-ins
// come from the last forecastWeeks weeks with both reservations and actual covers (walk-ins = actual covers
// − covers seated from reservations); without that history, walk-ins are 0 and no-shows 0. A manager's
// override wins, as always. Staff "projected covers" (forecast.covers) follow, since they're the same days.
import { addDays, dow, todayStr } from './time.js';
import { localStamp } from './toast.js';
import { parseWhen as tsWhen } from './tripleseat.js';
import { scrub, shortName, cleanId, hashKey, reservationStatus, parseRating, FIELDS } from './guest-csv.js';
import { cleanReviewItems, findRequests, findRequestedServer } from './impact.js';

export const SOURCE = 'opentable';
export const INTEGRATION_ID = 'opentable';
export const MAX_RESERVATIONS = 5000; // per request; the browser sends a big file in parts
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DINED = new Set(['seated', 'done']);
const COUNTED = new Set(['booked', 'seated', 'done']); // on the books (not cancelled, not a no-show)

export function integration(store) {
  return store.get('integrations', INTEGRATION_ID) || { id: INTEGRATION_ID };
}
export function saveIntegration(store, patch) {
  return store.get('integrations', INTEGRATION_ID) ? store.update('integrations', INTEGRATION_ID, patch) : store.insert('integrations', { id: INTEGRATION_ID, ...patch });
}
export const reservationDocId = (key) => `otr_${String(key).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Reservations from a browser or the API, checked: only the fields kept, notes scrubbed, the guest shortened. */
export function cleanReservationItems(list, { fail }) {
  if (!Array.isArray(list) || !list.length) fail(400, 'There are no reservations to import in that file');
  if (list.length > MAX_RESERVATIONS) fail(400, 'That file is too big. Import a few months at a time.');
  const out = [];
  for (const r of list) {
    if (!r || !DAY.test(r.date || '')) continue;
    const size = Math.round(Number(r.partySize));
    if (!(size >= 1 && size <= 500)) continue;
    const time = /^\d{2}:\d{2}$/.test(r.time || '') ? r.time : '';
    const notes = scrub(r.notes, 600);
    const key = /^[ch]_[A-Za-z0-9_-]{1,48}$/.test(String(r.key || '')) ? r.key
      : cleanId(r.externalId) ? `c_${cleanId(r.externalId)}` : `h_${hashKey(`${r.date}|${time}|${size}|${notes}`)}`;
    out.push({
      key, externalId: cleanId(r.externalId), date: r.date, time, partySize: size,
      status: ['booked', 'seated', 'done', 'cancelled', 'noShow'].includes(r.status) ? r.status : reservationStatus(r.status),
      guest: shortName(r.guest), notes, requestedServer: text(scrub(r.requestedServer, 60), 60), server: text(scrub(r.server, 60), 60),
      table: text(r.table, 20), area: text(r.area, 40), createdAt: DAY.test(r.createdAt || '') ? r.createdAt : '',
    });
  }
  if (!out.length) fail(400, 'There are no reservations to import in that file');
  return out;
}

// ---------------------------------------------------------------- the API's records (unverified field names)

const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o); if (v != null && v !== '') return v; } return undefined; };
/** A date and time from the API: ISO with an offset (converted to the restaurant's clock), local ISO, or MM/DD/YYYY. */
function when(v, timeZone) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const local = localStamp(s, timeZone);
    return local ? { date: local.slice(0, 10), time: local.slice(11, 16) } : null;
  }
  return tsWhen(s.replace(/(\.\d+)?$/, ''), timeZone);
}

/**
 * One reservation from OpenTable's API → an import item, or null. The field names are the ones OpenTable's
 * partners describe (ScheduledTime, PartySize, State, GuestRequest, VenueNotes, Server…) in their various
 * spellings; the real Sync API reference is behind OpenTable's partner portal (UNVERIFIED).
 */
export function readApiReservation(raw, { timeZone } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const at = when(pick(raw, ['scheduled_time', 'scheduledTime', 'ScheduledTime', 'reservation_datetime', 'reservationDateTime', 'date_time', 'dateTime', 'visit_date_time', 'start_time']), timeZone)
    || (() => { const d = when(pick(raw, ['visit_date', 'date', 'reservation_date']), timeZone); return d ? { ...d, time: String(pick(raw, ['visit_time', 'time']) || '').slice(0, 5) } : null; })();
  if (!at) return null;
  const conf = cleanId(pick(raw, ['confirmation_number', 'confirmationNumber', 'ConfirmationID', 'confirmation_id', 'confirmationId']));
  const id = cleanId(pick(raw, ['id', 'ID', 'reservation_id', 'reservationId', 'rid_reservation_id']));
  const guest = pick(raw, ['guest', 'Guest', 'diner']) || {};
  const first = pick(guest, ['first_name', 'firstName', 'FirstName']) ?? pick(raw, ['guest_first_name', 'first_name', 'firstName']);
  const last = pick(guest, ['last_name', 'lastName', 'LastName']) ?? pick(raw, ['guest_last_name', 'last_name', 'lastName']);
  const notes = [pick(raw, ['guest_request', 'guestRequest', 'GuestRequest', 'special_request', 'specialRequest', 'special_requests', 'notes']),
    pick(raw, ['venue_notes', 'venueNotes', 'VenueNotes', 'visit_notes', 'visitNotes']),
    pick(raw, ['opentable_notes', 'openTableNotes', 'OpenTableNotes'])].filter((x) => typeof x === 'string' && x.trim()).join('\n');
  const serverV = pick(raw, ['server', 'Server', 'server_name', 'serverName']);
  const reqV = pick(raw, ['requested_server', 'requestedServer', 'RequestedServer', 'server_request', 'preferred_server']);
  const nameOfV = (v) => (v && typeof v === 'object' ? [v.first_name ?? v.firstName ?? v.name, v.last_name ?? v.lastName].filter(Boolean).join(' ') : v);
  return {
    key: conf ? `c_${conf}` : id ? `c_${id}` : '', externalId: conf || id, date: at.date, time: at.time,
    partySize: Number(pick(raw, ['party_size', 'partySize', 'PartySize', 'covers', 'size'])) || 0,
    status: reservationStatus(pick(raw, ['state', 'State', 'status', 'reservation_state', 'reservationState'])),
    guest: shortName([first, last].filter(Boolean).join(' ')), notes,
    requestedServer: String(nameOfV(reqV) || ''), server: String(nameOfV(serverV) || ''),
    table: String(pick(raw, ['table_number', 'tableNumber', 'TableNumber', 'table']) || ''), area: String(pick(raw, ['table_category', 'tableCategory', 'TableCategory', 'area']) || ''),
    createdAt: when(pick(raw, ['created_date', 'createdDate', 'CreatedDate', 'created_at']), timeZone)?.date || '',
    updatedAt: String(pick(raw, ['updated_at', 'updatedAt', 'UpdatedAt', 'update_date_utc', 'updated_date']) || ''),
  };
}

/** One review from OpenTable's API (UNVERIFIED shape, see the docs) → an import item, or null. */
export function readApiReview(raw, { timeZone } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const posted = when(pick(raw, ['submitted_date_time', 'submittedDateTime', 'submitted_at', 'created_at', 'review_date', 'date', 'createdAt']), timeZone);
  const dined = when(pick(raw, ['dined_date_time', 'dinedDateTime', 'dining_date', 'dined_on', 'visit_date']), timeZone);
  if (!posted && !dined) return null;
  const ratings = pick(raw, ['ratings', 'rating_details']) || {};
  const rating = parseRating(pick(raw, ['overall_rating', 'overallRating', 'overall', 'rating', 'ratings.overall', 'star_rating']) ?? pick(ratings, ['overall']));
  if (rating == null) return null;
  const id = cleanId(pick(raw, ['id', 'review_id', 'reviewId']));
  const textV = [pick(raw, ['title', 'review_title']), pick(raw, ['text', 'review_text', 'reviewText', 'content', 'comments', 'body'])].filter((x) => typeof x === 'string' && x.trim()).join('\n');
  const diner = pick(raw, ['diner', 'reviewer', 'author']) || {};
  return {
    key: id ? `i_${id}` : '', externalId: id, source: SOURCE, date: posted?.date || dined.date, diningDate: dined?.date || '', rating,
    food: parseRating(pick(raw, ['food_rating', 'ratings.food']) ?? ratings.food), service: parseRating(pick(raw, ['service_rating', 'ratings.service']) ?? ratings.service),
    ambience: parseRating(pick(raw, ['ambience_rating', 'ambiance_rating', 'ratings.ambience', 'ratings.ambiance']) ?? ratings.ambience ?? ratings.ambiance),
    value: parseRating(pick(raw, ['value_rating', 'ratings.value']) ?? ratings.value),
    text: textV, reviewer: typeof diner === 'string' ? diner : [diner.first_name ?? diner.firstName ?? diner.display_name ?? diner.name, diner.last_name ?? diner.lastName].filter(Boolean).join(' '),
    server: String(pick(raw, ['server_name', 'serverName', 'server']) || ''),
  };
}

// ---------------------------------------------------------------- forecast

/**
 * Bookings for a forecast week: returns (forecastDay) → forecastDay with `booked` ({ covers, parties }) on days
 * with reservations, and the projected covers raised to the bookings' figure when that's higher (see the top).
 */
export function bookingBlend(store, settings, today, ws) {
  const weeks = settings.forecastWeeks || 8;
  const from = addDays(today < ws ? today : ws, -7 * weeks);
  const to = addDays(ws, 6);
  const byDate = new Map();
  store.list('otReservations', (r) => {
    if (r.date < from || r.date > to) return false;
    const d = byDate.get(r.date) || { covers: 0, parties: 0, dined: 0, noShow: 0 };
    if (COUNTED.has(r.status)) { d.covers += r.partySize; d.parties++; }
    if (DINED.has(r.status)) d.dined += r.partySize;
    if (r.status === 'noShow') d.noShow += r.partySize;
    byDate.set(r.date, d);
    return false;
  });
  if (!byDate.size) return (f) => f;
  // History: days before today with reservations, for the no-show rate and (with actual covers) the walk-ins.
  let noShow = 0, onBooks = 0, salesTotal = 0, coverTotal = 0;
  const walk = {};
  for (const [date, d] of byDate) {
    if (date >= today) continue;
    noShow += d.noShow; onBooks += d.covers + d.noShow;
    const actual = store.get('sales', date);
    if (actual?.covers > 0) {
      // Seated from reservations: the ones marked seated/done, else (a file without statuses) everything booked.
      const seated = d.dined || d.covers;
      (walk[dow(date)] ||= []).push(Math.max(0, actual.covers - seated));
      salesTotal += Number(actual.sales) || 0; coverTotal += actual.covers;
    }
  }
  const noShowRate = onBooks ? noShow / onBooks : 0;
  const walkIns = Object.fromEntries(Object.entries(walk).map(([k, l]) => [k, Math.round(l.reduce((a, b) => a + b, 0) / l.length)]));
  const avgCheck = coverTotal ? salesTotal / coverTotal : 0;
  return (f) => {
    const d = byDate.get(f.date);
    if (!d || !d.covers) return f;
    const booked = { covers: d.covers, parties: d.parties };
    if (f.date < today || f.closed || f.override) return { ...f, booked };
    const w = walkIns[dow(f.date)] ?? 0;
    const projected = Math.round(d.covers * (1 - noShowRate) + w);
    if (projected <= f.covers) return { ...f, booked };
    const check = f.covers > 0 ? f.sales / f.covers : avgCheck;
    return {
      ...f, covers: projected, sales: Math.round(projected * check), booked, history: f.covers,
      basis: `${d.covers} booked on OpenTable + ${w} usual walk-ins`, basisKey: 'bookings',
      basisParams: { booked: d.covers, walkIns: w, noShow: Math.round(noShowRate * 100), history: f.covers },
    };
  };
}

// ---------------------------------------------------------------- the store side

/** What importing these reservations would do: { rows (with status new/updated/same/duplicate), counts, dates }. */
function planReservations(store, items) {
  const counts = { new: 0, updated: 0, same: 0, duplicate: 0, covers: 0, requests: 0 };
  const rows = [];
  const seen = new Set();
  const fields = ['date', 'time', 'partySize', 'status', 'guest', 'notes', 'requestedServer', 'server', 'table', 'area', 'createdAt'];
  for (const it of items) {
    const id = reservationDocId(it.key);
    if (seen.has(id)) { counts.duplicate++; rows.push({ ...it, id, status: it.status, change: 'duplicate' }); continue; }
    seen.add(id);
    const cur = store.get('otReservations', id);
    const change = !cur ? 'new' : fields.every((k) => (cur[k] ?? '') === (it[k] ?? '')) ? 'same' : 'updated';
    counts[change]++;
    if (COUNTED.has(it.status)) counts.covers += it.partySize;
    rows.push({ ...it, id, change });
  }
  return { rows, counts, dates: [...new Set(items.map((r) => r.date))].sort() };
}

/**
 * The OpenTable logic, bound to one store: opentable.* methods on `api`, and applyReservations /
 * applyReviews for the server's sync. impact: the bound core/impact.js (it matches requests and names).
 */
export function openTableLinks({ store, api, fail, needMgr, now, settings, impact }) {
  const at = () => now().toISOString();
  const today = () => todayStr(now());

  function applyReservations(list, { origin = 'csv', importId = null } = {}) {
    // Cleaned here too, whoever calls: nothing but the kept fields, notes scrubbed, the guest shortened.
    const items = list.length ? cleanReservationItems(list, { fail }) : [];
    const plan = planReservations(store, items);
    const touched = [];
    for (const r of plan.rows) {
      if (r.change === 'same' || r.change === 'duplicate') continue;
      const { change, row, key, ...doc } = r;
      const cur = store.get('otReservations', r.id);
      touched.push(cur ? store.update('otReservations', r.id, { ...doc, source: SOURCE, origin, updatedAt: at() })
        : store.insert('otReservations', { ...doc, key, source: SOURCE, origin, importId, createdAt: doc.createdAt || '', importedAt: at() }));
    }
    const mentions = impact.scanMany({ reservations: touched });
    return { counts: plan.counts, mentions, from: plan.dates[0] || null, to: plan.dates.at(-1) || null };
  }
  const applyReviews = (items, meta) => impact.applyReviews(items.map((r) => ({ ...r, source: SOURCE })), meta);

  function remember(actor, kind, r, { fileName, columns }) {
    const i = integration(store);
    const rec = { id: r.importId, at: at(), by: actor.id, kind, fileName: text(fileName, 120), counts: r.counts, from: r.from, to: r.to };
    const cols = columns && typeof columns === 'object' ? Object.fromEntries(FIELDS[kind].map((f) => [f, columns[f] ? text(columns[f], 60) : null])) : null;
    // One file sent in parts: the parts after the first add to its record.
    const prev = (i.imports || []).find((x) => x.id === rec.id);
    const merged = prev ? { ...prev, counts: Object.fromEntries(Object.keys({ ...prev.counts, ...rec.counts }).map((k) => [k, (prev.counts?.[k] || 0) + (rec.counts?.[k] || 0)])),
      from: [prev.from, rec.from].filter(Boolean).sort()[0] || null, to: [prev.to, rec.to].filter(Boolean).sort().at(-1) || null } : rec;
    saveIntegration(store, {
      imports: [merged, ...(i.imports || []).filter((x) => x.id !== rec.id)].slice(0, 20),
      ...(cols ? { columns: { ...(i.columns || {}), [kind]: cols } } : {}),
    });
  }

  Object.assign(api, {
    /** Settings → Integrations → OpenTable: what's been imported or synced, the next two weeks' bookings. Managers. */
    'opentable.get': (actor) => {
      needMgr(actor);
      const i = integration(store);
      const t = today();
      const end = addDays(t, 13);
      const days = new Map();
      let total = 0, requests = 0, notes = 0;
      store.list('otReservations', (r) => {
        total++;
        if (r.notes) notes++;
        if (r.date >= t && r.date <= end && COUNTED.has(r.status)) { const d = days.get(r.date) || { date: r.date, covers: 0, parties: 0 }; d.covers += r.partySize; d.parties++; days.set(r.date, d); }
        return false;
      });
      store.list('impactMentions', (m) => { if (m.kind === 'request' && m.status === 'confirmed') requests++; return false; });
      let reviews = 0, fiveStar = 0;
      store.list('guestReviews', (r) => { if (r.source === SOURCE) { reviews++; if (r.rating >= 5) fiveStar++; } return false; });
      return {
        imports: i.imports || [], columns: i.columns || {}, lastSync: i.lastSync || null, lastCron: i.lastCron || null,
        totals: { reservations: total, withNotes: notes, requests, reviews, fiveStar },
        upcoming: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      };
    },
    /** What an OpenTable export would add, without saving. kind: 'reservations' | 'reviews'. Managers. */
    'opentable.previewImport': (actor, { kind, items } = {}) => {
      needMgr(actor);
      if (kind === 'reviews') return impact.previewReviews(cleanReviewItems(items, { source: SOURCE, fail }).map((r) => ({ ...r, source: SOURCE })));
      if (kind !== 'reservations') fail(400, 'Pick reservations or reviews');
      const clean = cleanReservationItems(items, { fail });
      const plan = planReservations(store, clean);
      const team = impact.team();
      let requests = 0;
      for (const r of plan.rows) if (r.change !== 'duplicate' && (findRequests(r.notes, team).length || findRequestedServer(r.requestedServer, team).length)) requests++;
      plan.counts.requests = requests;
      return { counts: plan.counts, dates: plan.dates, rows: plan.rows.slice(0, 200).map(({ row, date, time, partySize, status, notes, requestedServer, change }) => ({ row, date, time, partySize, status, notes: notes.slice(0, 120), requestedServer, change })) };
    },
    /**
     * Save an OpenTable export (one part of it: a big file comes in several calls with the same importId).
     * Re-importing the same rows changes nothing. Managers.
     */
    'opentable.import': (actor, { kind, items, fileName, columns, importId } = {}) => {
      needMgr(actor);
      const id = /^imp_[a-z0-9]{4,20}$/.test(String(importId || '')) ? importId : `imp_${hashKey(`${at()}|${Math.random()}`)}`;
      let r;
      if (kind === 'reviews') r = applyReviews(cleanReviewItems(items, { source: SOURCE, fail }), { origin: 'csv', importId: id });
      else if (kind === 'reservations') r = applyReservations(cleanReservationItems(items, { fail }), { origin: 'csv', importId: id });
      else fail(400, 'Pick reservations or reviews');
      remember(actor, kind, { ...r, importId: id }, { fileName, columns });
      return { ...r, importId: id };
    },
  });

  return { applyReservations, applyReviews };
}
