// Events & BEOs → Import BEOs (PDF). The PDF is read in the browser (web/src/pdf.js → core/beo-import.js),
// the manager checks each event it found (date, time, guests, room, what's new or changed), ticks the ones
// to import, and events.importBeos saves them. Afterwards, events with no staffing can get suggested staffing
// lines from the guest count (core/beo.js); open shifts are only created from the event's page, when a
// manager confirms there. BeoExtras shows what only a BEO carries on the event's page.
import React, { useMemo, useState } from 'react';
import { useApp, Modal, Icon, money, JobDot } from '../ui.jsx';
import { parseBeos, matchRooms, beoToEvent } from '../../../core/beo-import.js';
import { SERVICE_STYLES, styleLabel } from '../../../core/beo.js';
import { useVenueRooms } from './Sections.jsx';
import { tx, useT, fmtTime, prettyDate, stamp } from '../i18n/index.js';

const LIVE = ['new', 'update']; // ticked by default; 'same', 'older' and 'invalid' wait for the manager
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const timeText = (a, b) => (a ? `${fmtTime(a)}${b ? `–${fmtTime(b)}` : ''}` : '');

export default function BeoImport({ onClose }) {
  const t = useT();
  const { call, settings, toast, jobs, isMgr } = useApp();
  const venue = useVenueRooms();
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [found, setFound] = useState(null); // parsed BEOs
  const [verdicts, setVerdicts] = useState([]); // events.importBeos dryRun, by index
  const [picks, setPicks] = useState({}); // index → { on, room, date, name }
  const [open, setOpen] = useState({});
  const [newStatus, setNewStatus] = useState('confirmed');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { rows: [{ ev, result }] }

  const rooms = venue || [];
  const names = settings.rooms || [];
  const bookings = names.filter((n) => !rooms.some((r) => norm(r.name) === norm(n)));
  const matches = useMemo(() => (found || []).map((ev) => matchRooms(ev.areas, rooms, names)), [found, venue, settings.rooms]);

  /** The room choice: 'id:<roomId>', 'name:<booking or room name>', 'text' (as the BEO writes it), 'keep' (what the event has) or ''. */
  const defaultRoom = (i) => {
    const m = matches[i], v = verdicts[i];
    if (m?.roomId) return `id:${m.roomId}`;
    if (m?.room) return `name:${m.room}`;
    if (v?.id && (v.roomId || v.room)) return 'keep';
    return '';
  };
  const pickOf = (i) => {
    const p = picks[i] || {};
    const v = verdicts[i];
    const date = p.date ?? found[i].date;
    const name = p.name ?? found[i].name;
    return { on: p.on ?? (LIVE.includes(v?.status) && !!date && !!name), room: p.room ?? defaultRoom(i), date, name };
  };
  const setPick = (i, patch) => setPicks((m) => ({ ...m, [i]: { ...m[i], ...patch } }));
  const payloadOf = (i, room = pickOf(i).room) => {
    const ev = found[i], p = pickOf(i), v = verdicts[i];
    let roomId = null, name = '';
    if (room.startsWith('id:')) { roomId = room.slice(3); name = rooms.find((r) => r.id === roomId)?.name || ''; }
    else if (room.startsWith('name:')) name = room.slice(5);
    else if (room === 'text') name = ev.areas;
    else if (room === 'keep') { roomId = v?.roomId || null; name = v?.room || ''; }
    return { ...beoToEvent(ev, { roomId, room: name, date: p.date }), name: p.name };
  };

  const loadFile = async (f) => {
    if (!f) return;
    setFileName(f.name);
    setFound(null); setVerdicts([]); setPicks({}); setOpen({}); setDone(null);
    const reader = __DEMO__ ? null : await import('../pdf.js');
    if (!reader) return toast(tx('beoImport.pdfOnlyInTheApp'), 'bad');
    setReading(true);
    try {
      const { items } = await reader.pdfToItems(f);
      const evs = parseBeos(items);
      if (!evs.length) { toast(tx('beoImport.noBeosFound'), 'bad'); return; }
      // What importing would do to each one: new, an update to an event already here, no changes, older.
      const auto = evs.map((ev) => matchRooms(ev.areas, venue || [], settings.rooms || []));
      const r = await call('events.importBeos', { events: evs.map((ev, i) => beoToEvent(ev, { roomId: auto[i].roomId, room: auto[i].room || ev.areas })), dryRun: true });
      setVerdicts(r.events.reduce((a, x) => { a[x.index] = x; return a; }, []));
      setFound(evs);
    } catch (e) {
      toast(tx('beoImport.couldntReadThatPdf', { message: e.message }), 'bad');
    } finally {
      setReading(false);
    }
  };

  const chosen = (found || []).map((_, i) => i).filter((i) => pickOf(i).on);
  const missing = chosen.filter((i) => !pickOf(i).date || !pickOf(i).name);
  const doImport = async () => {
    setBusy(true);
    try {
      const r = await call('events.importBeos', { events: chosen.map((i) => payloadOf(i)), status: newStatus });
      setDone({ rows: r.events.map((x) => ({ result: x, ev: { ...found[chosen[x.index]], ...payloadOf(chosen[x.index]) } })) });
      const made = r.events.filter((x) => x.status === 'new').length;
      toast(tx('beoImport.importedSummary', { made, updated: r.events.length - made }));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (done) return <AfterImport done={done} onClose={onClose} call={call} jobs={jobs} isMgr={isMgr} toast={toast} />;

  return (
    <Modal wide title={t('beoImport.title')} sub={t('beoImport.sub')} onClose={() => onClose(false)}
      footer={<>
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!chosen.length || missing.length > 0 || busy} onClick={doImport}>
          <Icon name="upload" />{t('beoImport.importCount', { count: chosen.length })}
        </button>
      </>}>
      <div className="alert info"><Icon name="sparkle" size={16} /><div>{t('beoImport.howItWorks')}</div></div>
      <div className="row wrap">
        <label className="btn primary sm"><Icon name="upload" />{reading ? t('beoImport.reading') : t('beoImport.uploadPdf')}
          <input type="file" accept=".pdf,application/pdf" hidden disabled={reading} onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {fileName && <span className="small muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{fileName}</span>}
      </div>

      {found && (
        <>
          <div className="small muted">{t('beoImport.foundCount', { count: found.length })}</div>
          <div className="beo-imp-list">
            {found.map((ev, i) => {
              const p = pickOf(i), v = verdicts[i] || {}, m = matches[i];
              const warn = ev.warnings.filter((w) => w.code !== 'noDate' || !p.date);
              const needsRoom = m.how === 'none' && !p.room;
              return (
                <div key={i} className={`beo-imp-ev ${p.on ? 'on' : ''}`}>
                  <div className="beo-imp-head">
                    <label className="check" style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={p.on} disabled={!p.date || !p.name} onChange={(e) => setPick(i, { on: e.target.checked })} />
                      <span style={{ minWidth: 0 }}>
                        <b className="beo-imp-name">{p.name || t('beoImport.noName')}</b>
                        <span className="small muted beo-imp-meta">
                          {p.date ? prettyDate(p.date) : t('beoImport.noDateShort')}
                          {ev.start ? ` · ${timeText(ev.start, ev.end)}` : ''}
                          {ev.guestCount ? ` · ${t('beoImport.guests', { count: ev.guestCount })}` : ''}
                          {ev.serviceStyle ? ` · ${styleLabel(SERVICE_STYLES[ev.serviceStyle], t.lang)}` : ''}
                          {` · ${t('beoImport.pages', { from: ev.pages[0], to: ev.pages[1] })}`}
                        </span>
                      </span>
                    </label>
                    <StatusBadge v={v} />
                  </div>

                  {!ev.name && <input className="input sm" placeholder={t('events.eventName')} value={p.name} onChange={(e) => setPick(i, { name: e.target.value })} />}
                  {!ev.date && (
                    <label className="beo-imp-ctl"><span>{t('beoImport.pickTheDate')}</span>
                      <input className="input sm" type="date" value={p.date || ''} onChange={(e) => setPick(i, { date: e.target.value, on: !!e.target.value && (picks[i]?.on ?? true) })} />
                    </label>
                  )}

                  <label className="beo-imp-ctl">
                    <span>{t('events.room')}{ev.areas ? <span className="faint"> · {t('beoImport.beoSays', { areas: ev.areas })}</span> : ''}</span>
                    <select className="input sm" value={p.room} onChange={(e) => setPick(i, { room: e.target.value })}>
                      <option value="">{t('events.notSet')}</option>
                      {v.id && (v.roomId || v.room) && <option value="keep">{t('beoImport.keepRoom', { room: v.room })}</option>}
                      {rooms.length > 0 && <optgroup label={t('events.rooms')}>{rooms.map((r) => <option key={r.id} value={`id:${r.id}`}>{r.name}</option>)}</optgroup>}
                      {(rooms.length ? bookings : names).length > 0 && <optgroup label={rooms.length ? t('events.otherRoom') : t('events.rooms')}>{(rooms.length ? bookings : names).map((n) => <option key={n} value={`name:${n}`}>{n}</option>)}</optgroup>}
                      {ev.areas && <option value="text">{t('beoImport.asWritten', { areas: ev.areas.slice(0, 60) })}</option>}
                    </select>
                  </label>

                  {(warn.length > 0 || needsRoom || m.how === 'several' || v.status === 'older') && (
                    <div className="alert warn beo-imp-warn"><Icon name="alert" size={16} />
                      <ul>
                        {warn.map((w, k) => <li key={k}>{t(`beoImport.warn_${w.code}`, w)}</li>)}
                        {needsRoom && <li>{t('beoImport.warn_room')}</li>}
                        {m.how === 'several' && <li>{t('beoImport.warn_severalRooms', { rooms: m.matches.join(', '), room: m.room })}</li>}
                        {v.status === 'older' && <li>{t('beoImport.warn_older', { when: v.beoUpdatedAt ? stamp(v.beoUpdatedAt) : '' })}</li>}
                      </ul>
                    </div>
                  )}
                  {v.status === 'update' && v.changes?.length > 0 && <div className="small muted">{t('beoImport.changes', { list: [...new Set(v.changes.map((c) => (c === 'roomId' ? 'room' : c)))].map((c) => t(`beoImport.field_${c}`)).join(', ') })}</div>}

                  <button className="btn sm ghost beo-imp-toggle" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))} aria-expanded={!!open[i]}>
                    <Icon name={open[i] ? 'up' : 'down'} />{open[i] ? t('beoImport.hideDetails') : t('beoImport.showDetails')}
                  </button>
                  {open[i] && <BeoPreview ev={ev} />}
                </div>
              );
            })}
          </div>
          <label className="beo-imp-ctl">
            <span>{t('beoImport.addNewEventsAs')}</span>
            <select className="input sm" value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
              <option value="confirmed">{t('events.confirmed')}</option>
              <option value="tentative">{t('events.tentativeHiddenFromStaff')}</option>
            </select>
          </label>
          <div className="help">{t('beoImport.keptNote')}</div>
        </>
      )}
    </Modal>
  );
}

function StatusBadge({ v }) {
  const t = useT();
  if (!v?.status) return null;
  const kind = { new: 'ok', update: 'brand', same: '', older: 'warn', invalid: 'bad' }[v.status];
  return <span className={`badge ${kind}`}>{t(`beoImport.status_${v.status}`)}</span>;
}

/** Everything read from one BEO, before it's imported. */
function BeoPreview({ ev }) {
  const t = useT();
  const notes = [
    ['arrivalNotes', t('beoImport.arrivalNotes')], ['dietaryNotes', t('events.dietaryRestrictionsAllergies')], ['setupNotes', t('events.roomSetup')],
    ['specialInstructions', t('beoImport.specialInstructions')], ['avNotes', t('events.aV')], ['contactNotes', t('beoImport.contactNotes')],
  ].filter(([k]) => ev[k]);
  return (
    <div className="beo-imp-details">
      <dl className="kv">
        {ev.type && <><dt>{t('events.type')}</dt><dd>{ev.type}</dd></>}
        {ev.client && <><dt>{t('events.client')}</dt><dd>{ev.client}</dd></>}
        {(ev.contactName || ev.contactPhone || ev.contactEmail) && <><dt>{t('events.contact')}</dt><dd>{[ev.contactName, ev.contactPhone, ev.contactEmail].filter(Boolean).join(' · ')}</dd></>}
        {ev.salesManager && <><dt>{t('beoImport.salesManager')}</dt><dd>{ev.salesManager}</dd></>}
        {ev.eventManager && <><dt>{t('beoImport.eventManager')}</dt><dd>{ev.eventManager}</dd></>}
        {ev.fbMinimum > 0 && <><dt>{t('beoImport.fbMinimum')}</dt><dd>{money(ev.fbMinimum)}</dd></>}
        {ev.invoiceNumber && <><dt>{t('beoImport.invoice')}</dt><dd>#{ev.invoiceNumber}{ev.beoUpdatedAt ? ` · ${t('beoImport.updatedOn', { when: stamp(ev.beoUpdatedAt) })}` : ''}</dd></>}
      </dl>
      {ev.otherDates.length > 0 && <OtherDates list={ev.otherDates} />}

      <h4>{t('events.menu')}</h4>
      {!ev.menu.length ? <div className="small muted">{t('events.noMenuItems')}</div> : <MenuList menu={ev.menu} />}

      {(ev.beverage.package || ev.beverage.bar || ev.beverage.notes || ev.specialDrinks.length > 0) && <>
        <h4>{t('events.beverage')}</h4>
        <dl className="kv">
          {ev.beverage.package && <><dt>{t('events.package')}</dt><dd>{ev.beverage.package}</dd></>}
          {ev.beverage.bar && <><dt>{t('events.bar')}</dt><dd>{ev.beverage.bar}</dd></>}
          {ev.beverage.notes && <><dt>{t('common.notes')}</dt><dd className="pre">{ev.beverage.notes}</dd></>}
        </dl>
        {ev.specialDrinks.map((d, k) => (
          <div key={k} className="drink"><b>{d.name}{d.qty ? ` ×${d.qty}` : ''}</b>{d.recipe && <div className="small pre">{d.recipe}</div>}{d.notes && <div className="tiny faint">{d.notes}</div>}</div>
        ))}
      </>}

      <h4>{t('events.timeline')}</h4>
      {!ev.timeline.length ? <div className="small muted">{t('beoImport.noTimes')}</div> : (
        <ul className="beo-imp-times">{ev.timeline.map((x, k) => <li key={k}><b className="num">{timeText(x.time, x.end)}</b><span>{x.item}</span></li>)}</ul>
      )}

      {notes.map(([k, label]) => <div key={k}><h4>{label}</h4><div className="small pre">{ev[k]}</div></div>)}
    </div>
  );
}

function MenuList({ menu }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      {menu.map((m, i) => (
        <div key={i}>
          {m.course && m.course !== menu[i - 1]?.course && <div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase' }}>{m.course}</div>}
          {m.item && <div style={{ fontWeight: 600 }}>{m.item}{m.qty ? <span className="muted"> ×{m.qty}</span> : ''}{(m.dietary || []).map((d) => <span key={d} className="badge" style={{ marginLeft: 6 }}>{d}</span>)}</div>}
          {m.notes && <div className="small muted">{m.notes}</div>}
        </div>
      ))}
    </div>
  );
}

function OtherDates({ list }) {
  const t = useT();
  return (
    <div className="small">
      <b>{t('beoImport.alsoOnThisBeo')}</b>
      <ul className="beo-imp-times">{list.map((o, k) => (
        <li key={k}><span>{prettyDate(o.date)}{o.start ? ` · ${timeText(o.start, o.end)}` : ''}{o.areas ? ` · ${o.areas}` : ''}{o.guestCount ? ` · ${t('beoImport.guests', { count: o.guestCount })}` : ''}{o.type ? ` · ${o.type}` : ''}</span></li>
      ))}</ul>
    </div>
  );
}

/** After the import: what happened, and staffing for events that have none yet (no shifts until a manager confirms on the event's page). */
function AfterImport({ done, onClose, call, jobs, isMgr, toast }) {
  const t = useT();
  const [lines, setLines] = useState(null); // event id → suggested lines
  const [skip, setSkip] = useState({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const bare = done.rows.filter((r) => !r.result.staffing);
  const suggest = async () => {
    setBusy(true);
    try {
      const out = {};
      for (const r of bare) out[r.result.id] = await call('events.suggestStaffing', { guestCount: r.ev.guestCount, serviceStyle: r.ev.serviceStyle, start: r.ev.start, end: r.ev.end });
      setLines(out);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      let n = 0;
      for (const r of bare) {
        const l = lines[r.result.id];
        if (skip[r.result.id] || !l?.length) continue;
        await call('events.save', { id: r.result.id, name: r.ev.name, date: r.ev.date, start: r.ev.start, end: r.ev.end, guestCount: r.ev.guestCount, staffing: l });
        n++;
      }
      setSaved(true);
      toast(tx('beoImport.staffingSaved', { count: n }));
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const picked = bare.filter((r) => !skip[r.result.id] && lines?.[r.result.id]?.length).length;
  return (
    <Modal wide title={t('beoImport.imported')} onClose={() => onClose(true)}
      footer={<>
        {lines && !saved && <button className="btn primary" disabled={busy || !picked} onClick={save}><Icon name="check" />{t('beoImport.saveStaffing', { count: picked })}</button>}
        <button className={`btn ${lines && !saved ? '' : 'primary'}`} onClick={() => onClose(true)}>{t('beoImport.done')}</button>
      </>}>
      <div className="beo-imp-list">
        {done.rows.map((r) => (
          <div key={r.result.id} className="beo-imp-ev on">
            <div className="beo-imp-head">
              <span style={{ flex: 1, minWidth: 0 }}>
                <b className="beo-imp-name">{r.ev.name}</b>
                <span className="small muted beo-imp-meta">{prettyDate(r.ev.date)}{r.ev.start ? ` · ${timeText(r.ev.start, r.ev.end)}` : ''}{r.ev.guestCount ? ` · ${t('beoImport.guests', { count: r.ev.guestCount })}` : ''}</span>
              </span>
              <StatusBadge v={r.result} />
            </div>
            {r.result.staffing > 0 && <div className="small muted">{t('beoImport.staffingKept', { count: r.result.staffing })}</div>}
            {lines && !r.result.staffing && (
              !lines[r.result.id]?.length ? <div className="small muted">{t('beoImport.noSuggestion')}</div> : (
                <label className="check small" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={!skip[r.result.id]} disabled={saved} onChange={(e) => setSkip((s) => ({ ...s, [r.result.id]: !e.target.checked }))} />
                  <span className="row wrap" style={{ gap: 6 }}>
                    {lines[r.result.id].map((l, k) => <span key={k} className="badge"><JobDot job={jobs[l.jobCodeId]} />{l.count} × {jobs[l.jobCodeId]?.name} · {fmtTime(l.start)}</span>)}
                  </span>
                </label>
              )
            )}
            <a className="small" href={`#/events/${r.result.id}`} onClick={() => onClose(true)}>{t('beoImport.openEvent')}</a>
          </div>
        ))}
      </div>
      {bare.length > 0 && !lines && (
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={suggest}><Icon name="sparkle" />{t('beoImport.suggestStaffing', { count: bare.length })}</button>
          <span className="small muted">{t('beoImport.suggestHelp')}</span>
        </div>
      )}
      {saved && <div className="alert info"><Icon name="check" size={16} /><div>{isMgr ? t('beoImport.nextCreateShifts') : t('beoImport.nextManagers')}</div></div>}
    </Modal>
  );
}

/** On the event's page: what only a BEO carries (invoice, arrival notes, special instructions, other dates, contacts). */
export function BeoExtras({ e }) {
  const t = useT();
  const { isEvents } = useApp();
  const show = e.invoiceNumber || e.arrivalNotes || e.specialInstructions || e.otherDates?.length || e.salesManager || e.eventManager || (isEvents && (e.contactNotes || e.fbMinimum > 0));
  if (!show) return null;
  return (
    <div className="card card-pad">
      <h2 style={{ marginBottom: 10 }}>{t('beoImport.fromTheBeo')}</h2>
      <dl className="kv" style={{ marginBottom: 10 }}>
        {e.invoiceNumber && <><dt>{t('beoImport.invoice')}</dt><dd>#{e.invoiceNumber}{e.beoUpdatedAt ? ` · ${t('beoImport.updatedOn', { when: stamp(e.beoUpdatedAt) })}` : ''}</dd></>}
        {e.areas && norm(e.areas) !== norm(e.room) && <><dt>{t('beoImport.areas')}</dt><dd>{e.areas}</dd></>}
        {e.salesManager && <><dt>{t('beoImport.salesManager')}</dt><dd>{e.salesManager}</dd></>}
        {e.eventManager && <><dt>{t('beoImport.eventManager')}</dt><dd>{e.eventManager}</dd></>}
        {isEvents && e.fbMinimum > 0 && <><dt>{t('beoImport.fbMinimum')}</dt><dd>{money(e.fbMinimum)}</dd></>}
      </dl>
      {e.arrivalNotes && <><h3 className="beo-x-h">{t('beoImport.arrivalNotes')}</h3><p className="pre beo-x-p">{e.arrivalNotes}</p></>}
      {e.specialInstructions && <><h3 className="beo-x-h">{t('beoImport.specialInstructions')}</h3><p className="pre beo-x-p">{e.specialInstructions}</p></>}
      {e.otherDates?.length > 0 && <div className="beo-x-p"><OtherDates list={e.otherDates} /></div>}
      {isEvents && e.contactNotes && <><h3 className="beo-x-h">{t('beoImport.contactNotes')}</h3><p className="pre beo-x-p">{e.contactNotes}</p><div className="help">{t('events.clientContactInfoIsOnly')}</div></>}
    </div>
  );
}
