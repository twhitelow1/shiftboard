// Server sections on the floor plan: which room each shift works, and which tables (see core/venue-links.js).
// - SectionsBoard: the Venue page for a room and date. Managers tap tables, then pick who gets them.
// - ShiftSection / ShiftSectionCard: "Restaurant · T1, T4" on My Shifts, and the plan on a shift's details.
// - useSectionField: the room and tables picker in the shift editor.
// - EventPlans: the floor plans on a BEO, with the event staff's sections.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Field, Avatar, JobDot, colorFor, shiftTime, useAction } from '../ui.jsx';
import { addDays, weekStart, dow } from '../../../core/time.js';
import { eventRoom } from '../../../core/venue-links.js';
import { PlanViewer, SEATED, planStats, statsText } from './FloorPlan.jsx';
import { tx, useT, dowLong, prettyDate } from '../i18n/index.js';

const EXTRA_COLORS = ['#6366f1', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0f766e', '#db2777', '#2563eb', '#65a30d',
  '#f59e0b', '#84cc16', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444', '#0ea5e9', '#f97316'];
function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };
/** The unused color that looks most different from the ones already on the plan. */
const freshColor = (used) => EXTRA_COLORS.filter((c) => !used.has(c))
  .map((c) => [c, Math.min(360, ...[...used].map((u) => hueGap(c, u)))]).sort((a, b) => b[1] - a[1])[0]?.[0];
const OPEN_COLOR = '#64748b';
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
export const tablesText = (labels) => labels.join(', ');

// ----- small caches so lists of shifts don't ask the server once per row -----
const cache = new Map();
function cached(key, load) {
  if (!cache.has(key)) {
    if (cache.size > 60) cache.clear();
    cache.set(key, load().catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
/** The venue's rooms (with plans). */
export function useVenueRooms() {
  const { call, version, has } = useApp();
  const [rooms, setRooms] = useState(null);
  useEffect(() => {
    let live = true;
    if (has && !has('venue')) { setRooms([]); return undefined; } // not in the restaurant's plan
    cached(`venue|${version}`, () => call('venue.get')).then((v) => live && setRooms(v.rooms)).catch(() => live && setRooms([]));
    return () => { live = false; };
  }, [version]);
  return rooms;
}
/** The section (room and tables) of one shift, or null. Loads the shift's week once for all its rows. */
export function useShiftSection(shift) {
  const { call, version, settings, has } = useApp();
  const [hit, setHit] = useState(null);
  useEffect(() => {
    let live = true;
    if (!shift?.id || !shift.date || (has && !has('venue'))) { setHit(null); return undefined; }
    const ws = weekStart(shift.date, settings.weekStartDow);
    cached(`week|${version}|${ws}`, () => call('sections.list', { start: ws, end: addDays(ws, 6) })).then((days) => {
      if (!live) return;
      for (const d of days) {
        const e = d.entries.find((x) => x.shiftId === shift.id);
        if (e) return setHit({ ...e, roomId: d.roomId, roomName: d.roomName, date: d.date, day: d });
      }
      setHit(null);
    }).catch(() => live && setHit(null));
    return () => { live = false; };
  }, [shift?.id, shift?.date, version]);
  return hit;
}

/**
 * Colors and names for a room's sections: each person's own color, unless someone else in the room
 * already has it. Returns { colorOf(entry), marks: Map(tableId → mark) }.
 */
export function sectionMarks(entries, people, { highlight, faded } = {}) {
  const used = new Set();
  const colors = new Map();
  for (const e of entries) {
    const u = e.userId ? people[e.userId] : null;
    let c = e.userId ? (u?.color || colorFor(e.userId)) : OPEN_COLOR;
    // Too close to someone else's color in this room (or the same): pick one that stands out.
    if (e.userId && [...used].some((x) => x === c || hueGap(x, c) < 25)) c = freshColor(used) || c;
    used.add(c);
    colors.set(e.shiftId, c);
  }
  const marks = new Map();
  for (const e of entries) {
    const mine = highlight ? highlight(e) : false;
    const name = mine === 'you' ? tx('sections.markYou') : e.userId ? firstName(people[e.userId]?.name) || tx('sections.staff') : tx('sections.markOpen');
    for (const t of e.tableIds) {
      marks.set(t, { color: colors.get(e.shiftId), name, strong: !!mine, faded: faded ? faded(e) : false, title: e.userId ? people[e.userId]?.name : tx('common.openShift') });
    }
  }
  return { colorOf: (e) => colors.get(e.shiftId), marks };
}

function Legend({ entries, colorOf, onRemove, onPick, busy }) {
  const t = useT();
  const { people, jobs, me } = useApp();
  if (!entries.length) return null;
  return (
    <div className="sec-legend">
      {entries.map((e) => (
        <div key={e.shiftId} className={`sec-row ${e.userId === me.id ? 'me' : ''}`} style={{ '--mark': colorOf(e) }}>
          <span className="sec-dot" />
          <button type="button" className="sec-who" onClick={onPick ? () => onPick(e) : undefined} disabled={!onPick} title={onPick ? t('sections.selectTheirTables') : undefined}>
            <b>{e.userId ? people[e.userId]?.name || t('sections.staff') : t('common.openShift')}</b>
            <span className="small muted"> · {jobs[e.jobCodeId]?.name || t('sections.shift')} {shiftTime(e)}{e.published === false ? t('sections.draft') : ''}</span>
            <span className="small sec-tables">{e.tables.length ? <>{tablesText(e.tables)}<span className="muted">{' '}{t('sections.seatsSeats', { seats: e.seats })}</span></> : <span className="muted">{t('sections.inTheRoomNoTables')}</span>}</span>
          </button>
          {onRemove && <button type="button" className="btn sm icon ghost" disabled={busy} title={t('sections.takeOffThisRoom')} aria-label={t('sections.takeOffThisRoom')} onClick={() => onRemove(e)}><Icon name="x" /></button>}
        </div>
      ))}
    </div>
  );
}

// ---------- Venue page: a room's sections for a day ----------
export function SectionsBoard({ room, date, setDate, onEditLayout }) {
  const t = useT();
  const { call, people, jobs, me, isMgr, today, version, toast } = useApp();
  const [run, busy] = useAction();
  const [day, setDay] = useState(null);
  const [picked, setPicked] = useState([]);
  const [chooser, setChooser] = useState(false);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let live = true;
    setPicked([]); setInfo(null);
    Promise.all([call('shifts.list', { start: date, end: date }), call('sections.list', { start: date, end: date })])
      .then(([s, sections]) => live && setDay({ shifts: s.shifts, events: s.events, sections }))
      .catch((e) => { if (live) { setDay({ shifts: [], events: [], sections: [] }); toast(e.message, 'bad'); } });
    return () => { live = false; };
  }, [room.id, date, version]);

  const plan = room.plan || { items: [] };
  const tables = plan.items.filter((i) => SEATED.has(i.type));
  const label = (id) => plan.items.find((i) => i.id === id)?.label || '?';
  const entries = day?.sections.find((d) => d.roomId === room.id)?.entries || [];
  const elsewhere = new Map((day?.sections || []).filter((d) => d.roomId !== room.id).flatMap((d) => d.entries.map((e) => [e.shiftId, d.roomName])));
  const { colorOf, marks } = useMemo(() => sectionMarks(entries, people, { highlight: (e) => (!isMgr && e.userId === me.id ? 'you' : false) }), [entries, people]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const assigned = new Set(entries.flatMap((e) => e.tableIds));
  const events = (day?.events || []).filter((e) => norm(e.room) === norm(room.name));
  const pickedSeats = picked.reduce((t, id) => t + (Number(plan.items.find((i) => i.id === id)?.seats) || 0), 0);

  // Who's working that day: people in this room first, then the room's area, then everyone else.
  const working = useMemo(() => {
    const here = new Set(entries.map((e) => e.shiftId));
    const rank = (s) => (here.has(s.id) ? 0 : norm(s.area) === norm(room.name) ? 1 : elsewhere.has(s.id) ? 3 : 2);
    return (day?.shifts || []).slice().sort((a, b) => rank(a) - rank(b) || (jobs[a.jobCodeId]?.order ?? 0) - (jobs[b.jobCodeId]?.order ?? 0)
      || a.start.localeCompare(b.start) || (people[a.userId]?.name || '~').localeCompare(people[b.userId]?.name || '~'));
  }, [day, entries]);

  const tap = (it) => {
    if (!it || !SEATED.has(it.type)) { setInfo(null); return; }
    if (isMgr) { setPicked((p) => (p.includes(it.id) ? p.filter((x) => x !== it.id) : [...p, it.id])); return; }
    const e = entries.find((x) => x.tableIds.includes(it.id));
    setInfo(`${it.label || t('sections.tableWord')}${it.seats ? ` · ${t('floorPlan.seatsCount', { count: it.seats })}` : ''} · ${e ? (e.userId ? people[e.userId]?.name : t('common.openShift')) : t('sections.noOneYet')}`);
  };
  const give = async (s) => {
    const name = s.userId ? people[s.userId]?.name : t('sections.theOpenShift');
    const msg = picked.length ? `${tablesText(picked.map(label))} → ${name}` : t('sections.nameIsInRoom', { name, room: room.name });
    const r = await run(() => call('sections.assign', { shiftId: s.id, roomId: room.id, tableIds: picked, mode: 'add' }), msg);
    if (r) { setChooser(false); setPicked([]); }
  };
  const clearPicked = () => run(() => call('sections.clear', { roomId: room.id, date, tableIds: picked }), t('sections.tablesCleared')).then((r) => r && setPicked([]));
  const remove = (e) => run(() => call('sections.assign', { shiftId: e.shiftId, roomId: null }), t('sections.takenOff', { name: e.userId ? people[e.userId]?.name : t('common.openShift'), room: room.name }));
  const lastWeek = addDays(date, -7);
  const copy = () => run(() => call('sections.copy', { fromDate: lastWeek, toDate: date, roomId: room.id }),
    (r) => (r.copied ? t('sections.copiedCountSectionsFromLast', { count: r.copied, value: dowLong(dow(date)) }) : t('sections.nothingToCopyFromLast', { value: dowLong(dow(date)) })));

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="sec-day">
        <button type="button" className="btn sm icon" aria-label={t('sections.dayBefore')} onClick={() => setDate(addDays(date, -1))}><Icon name="left" /></button>
        <input className="input sm" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label={t('common.day')} />
        <button type="button" className="btn sm icon" aria-label={t('sections.nextDay')} onClick={() => setDate(addDays(date, 1))}><Icon name="right" /></button>
        {date !== today && <button type="button" className="btn sm ghost" onClick={() => setDate(today)}>{t('common.today')}</button>}
        <span className="spacer" />
        {isMgr && !entries.length && day && <button type="button" className="btn sm ghost" disabled={busy} onClick={copy} title={t('sections.samePeopleSameTablesAs', { date: prettyDate(lastWeek) })}><Icon name="copy" />{t('sections.copyLastValue', { value: dowLong(dow(date)).slice(0, 3) })}</button>}
      </div>
      {events.map((e) => (
        <a key={e.id} className="alert info" href={`#/events/${e.id}`}><Icon name="glass" size={16} /><span><b>{e.name}</b>{e.guestCount ? t('sections.guestcountGuests', { guestCount: e.guestCount }) : ''}{' '}{t('sections.openBeo')}</span></a>
      ))}
      {!tables.length ? (
        <div className="alert warn col" style={{ alignItems: 'stretch' }}>
          <span>{t('sections.thereAreNoTablesOn')}</span>
          {isMgr && onEditLayout && <div><button type="button" className="btn sm primary" onClick={onEditLayout}>{t('sections.drawTheFloorPlan')}</button></div>}
        </div>
      ) : (
        <PlanViewer plan={plan} title={t('sections.nameSectionsDate', { name: room.name, date: prettyDate(date) })} marks={marks} picked={pickedSet} onTapItem={tap} />
      )}
      {!day ? <div className="empty">{t('common.loading')}</div> : <>
        {isMgr && tables.length > 0 && (
          <div className={`sec-bar ${picked.length ? 'on' : ''}`} aria-live="polite">
            {picked.length ? <>
              <span>{t('sections.bCountBTables', { count: picked.length })}{pickedSeats ? t('sections.pickedseatsSeats', { pickedSeats }) : ''}</span>
              <span className="spacer" />
              <button type="button" className="btn sm primary" onClick={() => setChooser(true)}><Icon name="user" />{t('sections.giveTo')}</button>
              {picked.some((t) => assigned.has(t)) && <button type="button" className="btn sm" disabled={busy} onClick={clearPicked}>{t('sections.clear')}</button>}
              <button type="button" className="btn sm icon ghost" aria-label={t('sections.unselectTables')} onClick={() => setPicked([])}><Icon name="x" /></button>
            </> : <>
              <span className="small muted">{t('sections.tapTablesThenPickWho')}{' '}{tables.length - assigned.size ? t('sections.valueOfTablescountOpen', { value: tables.length - assigned.size, tablesCount: tables.length }) : t('sections.allTablesHaveAServer')}</span>
              <span className="spacer" />
              <button type="button" className="btn sm ghost" onClick={() => setChooser(true)}><Icon name="plus" />{t('sections.addPerson')}</button>
            </>}
          </div>
        )}
        {!isMgr && info && <div className="small sec-info">{info}</div>}
        <Legend entries={entries} colorOf={colorOf} busy={busy} onRemove={isMgr ? remove : null}
          onPick={isMgr ? (e) => setPicked(e.tableIds) : null} />
        {!entries.length && <div className="small muted">{isMgr ? t('sections.noSectionsInNameOn', { name: room.name, date: prettyDate(date) }) : t('sections.noSectionsPostedForDate', { date: prettyDate(date) })}</div>}
      </>}
      {chooser && (
        <Modal title={picked.length ? t('sections.whoGetsTablestext', { tablesText: tablesText(picked.map(label)) }) : t('sections.whosWorkingName', { name: room.name })} sub={prettyDate(date)} onClose={() => setChooser(false)}>
          {!working.length ? <div className="muted">{t('sections.noOneIsOnThe', { date: prettyDate(date) })}</div> : (
            <div className="list" style={{ margin: '-8px -18px' }}>
              {working.map((s) => {
                const mine = entries.find((e) => e.shiftId === s.id);
                const other = elsewhere.get(s.id);
                return (
                  <button type="button" key={s.id} className="list-item click sec-person" disabled={busy} onClick={() => give(s)}>
                    {s.userId ? <Avatar user={people[s.userId]} size="sm" /> : <span className="avatar sm" style={{ background: OPEN_COLOR }}>?</span>}
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <div style={{ fontWeight: 700 }}>{s.userId ? people[s.userId]?.name : t('common.openShift')}</div>
                      <div className="small muted row" style={{ gap: 6 }}><JobDot job={jobs[s.jobCodeId]} />{jobs[s.jobCodeId]?.name} · {shiftTime(s)}{s.area ? ` · ${s.area}` : ''}{!s.published ? t('sections.draft') : ''}</div>
                    </div>
                    {mine ? <span className="badge brand">{mine.tables.length ? tablesText(mine.tables) : t('sections.here')}</span> : other ? <span className="badge">{other}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---------- My Shifts and shift details ----------
/** "Restaurant · Tables T1, T4" for a shift, or nothing. The room is left out when it's the shift's area too (unless full). */
export function ShiftSection({ shift, full, className = '' }) {
  const hit = useShiftSection(shift);
  if (!hit) return null;
  const tables = hit.tables.length ? tx('sections.tablesList', { count: hit.tables.length, tables: tablesText(hit.tables) }) : '';
  const room = full || !tables || norm(hit.roomName) !== norm(shift.area);
  return (
    <div className={`sec-where ${className}`}>
      <Icon name="pin" size={13} />
      <span>{room && <b>{hit.roomName}</b>}{room && tables ? ' · ' : ''}{tables}</span>
    </div>
  );
}

/** A shift's room and tables, with its tables highlighted on the room's plan. */
export function ShiftSectionCard({ shift }) {
  const t = useT();
  const { people, me } = useApp();
  const hit = useShiftSection(shift);
  const rooms = useVenueRooms();
  const room = hit && rooms?.find((r) => r.id === hit.roomId);
  const others = hit?.day.entries || [];
  const { marks } = useMemo(() => sectionMarks(others, people, {
    highlight: (e) => (e.shiftId === shift.id ? (e.userId === me.id ? 'you' : true) : false),
    faded: (e) => e.shiftId !== shift.id,
  }), [hit, people]);
  if (!hit) return null;
  const mine = shift.userId === me.id;
  return (
    <div className="sec-card">
      <div className="row" style={{ gap: 6 }}>
        <Icon name="pin" size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{hit.roomName}</div>
          <div className="small muted">{hit.tables.length
            ? `${tx(mine ? 'sections.yourTablesList' : 'sections.tablesList', { count: hit.tables.length, tables: tablesText(hit.tables) })} · ${tx('floorPlan.seatsCount', { count: hit.seats })}`
            : t('sections.noTablesAssigned')}</div>
        </div>
      </div>
      {room?.plan?.items?.length > 0 && <PlanViewer plan={room.plan} title={t('sections.nameFloorPlan', { name: room.name })} marks={marks} focus={hit.tableIds} />}
    </div>
  );
}

// ---------- shift editor ----------
/**
 * The room and tables field for the shift editor. Returns { field, save(shiftId) }: render `field`,
 * and call save with the shift's id after the shift is saved. Nothing shows until the venue has rooms.
 */
export function useSectionField(shift, date) {
  const { call, people, toast, refresh, has } = useApp();
  const rooms = useVenueRooms();
  const [day, setDay] = useState(null);
  const [pick, setPick] = useState(null);
  useEffect(() => {
    let live = true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || (has && !has('venue'))) { setDay([]); return undefined; }
    call('sections.list', { start: date, end: date }).then((d) => live && setDay(d)).catch(() => live && setDay([]));
    return () => { live = false; };
  }, [date]);
  const current = useMemo(() => {
    for (const d of day || []) {
      const e = d.entries.find((x) => x.shiftId === shift.id);
      if (shift.id && e) return { roomId: d.roomId, tableIds: e.tableIds };
    }
    return { roomId: '', tableIds: [] };
  }, [day, shift.id]);
  const value = pick || current;

  const save = async (shiftId) => {
    if (!pick || !shiftId) return;
    if (shiftId === shift.id && pick.roomId === current.roomId && pick.tableIds.join() === current.tableIds.join()) return;
    try { await call('sections.assign', { shiftId, roomId: pick.roomId || null, tableIds: pick.tableIds }); refresh(); }
    catch (e) { toast(tx('sections.shiftSavedButNotIts', { message: e.message }), 'bad'); }
  };
  if (!rooms?.length) return { field: null, save };

  const room = rooms.find((r) => r.id === value.roomId);
  const tables = (room?.plan?.items || []).filter((i) => SEATED.has(i.type));
  const taken = new Map();
  for (const e of day?.find((d) => d.roomId === value.roomId)?.entries || []) {
    if (e.shiftId !== shift.id) for (const t of e.tableIds) taken.set(t, e.userId ? firstName(people[e.userId]?.name) : tx('sections.markOpen'));
  }
  const toggle = (id) => setPick({ roomId: value.roomId, tableIds: value.tableIds.includes(id) ? value.tableIds.filter((x) => x !== id) : [...value.tableIds, id] });
  const field = (
    <Field label={tx('sections.roomTables')} help={room ? tx('sections.theirSectionOnTheFloor') : tx('sections.whereTheyWorkPickA')}>
      <select className="input" value={value.roomId} onChange={(e) => setPick({ roomId: e.target.value, tableIds: [] })}>
        <option value="">{tx('sections.noRoom')}</option>
        {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {tables.length > 0 && (
        <div className="sec-chips">
          {tables.map((t) => {
            const on = value.tableIds.includes(t.id);
            return (
              <button type="button" key={t.id} className={`chip ${on ? 'on' : ''} ${!on && taken.has(t.id) ? 'taken' : ''}`} aria-pressed={on} onClick={() => toggle(t.id)}
                title={taken.has(t.id) ? tx('sections.getHasItNow', { get: taken.get(t.id) }) : tx('sections.valueSeats', { value: t.seats || 0 })}>
                {t.label || '?'}{!on && taken.has(t.id) && <span className="tiny"> · {taken.get(t.id)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
  return { field, save };
}

// ---------- BEO ----------
/** The event's floor plans: its room, and any room where its staff have sections, with those sections. */
export function EventPlans({ event }) {
  const { call, version, people, isMgr, has } = useApp();
  const rooms = useVenueRooms();
  const [days, setDays] = useState(null);
  useEffect(() => {
    let live = true;
    if (!event?.date || (has && !has('venue'))) return undefined;
    call('sections.list', { start: event.date, end: event.date }).then((d) => live && setDays(d)).catch(() => live && setDays([]));
    return () => { live = false; };
  }, [event?.id, event?.date, version]);
  if (!rooms || !days) return null;
  const home = eventRoom(event, rooms);
  const staffed = days.map((d) => ({ ...d, entries: d.entries.filter((e) => e.eventId === event.id) })).filter((d) => d.entries.length);
  const ids = [...new Set([home?.id, ...staffed.map((d) => d.roomId)].filter(Boolean))];
  const shown = ids.map((id) => rooms.find((r) => r.id === id)).filter((r) => r && (r.plan?.items?.length || staffed.some((d) => d.roomId === r.id)));
  return shown.map((r) => <EventRoomPlan key={r.id} room={r} event={event} entries={staffed.find((d) => d.roomId === r.id)?.entries || []} people={people} isMgr={isMgr} />);
}

function EventRoomPlan({ room, event, entries, people, isMgr }) {
  const t = useT();
  const { me } = useApp();
  const { colorOf, marks } = useMemo(() => sectionMarks(entries, people, { highlight: (e) => (e.userId === me.id ? 'you' : false) }), [entries, people]);
  return (
    <div className="card card-pad section">
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <h2 style={{ flex: 1 }}>{t('sections.floorPlanName', { name: room.name })}</h2>
        <span className="small muted">{statsText(planStats(room.plan))}</span>
        {isMgr && <a className="btn sm no-print" href={`#/venue/${room.id}/${event.date}`}><Icon name="map" />{entries.length ? t('sections.editSections') : t('sections.assignSections')}</a>}
      </div>
      <PlanViewer plan={room.plan} title={t('sections.nameFloorPlan', { name: room.name })} marks={marks} />
      {entries.length > 0 && <>
        <h3 style={{ margin: '12px 0 6px' }}>{t('sections.sections')}</h3>
        <Legend entries={entries} colorOf={colorOf} />
      </>}
    </div>
  );
}
