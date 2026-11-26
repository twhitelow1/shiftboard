// Events & BEOs → Import BEOs (PDF). The PDF is read in the browser (web/src/pdf.js → core/beo-import.js),
// the manager checks each event it found (date, time, guests, room, what's new or changed), ticks the ones
// to import, and events.importBeos saves them. Afterwards, events with no staffing can get suggested staffing
// lines from the guest count (core/beo.js); open shifts are only created from the event's page, when a
// manager confirms there. Duplicates (core/beo-match.js): the same BEO twice in the file is one; an event already
// here by Tripleseat id, invoice # or an earlier import is updated; one that only looks like an event here is a
// "possible duplicate" shown side by side, and Import stays off until each one is decided (update, skip, or new).
// A PDF that isn't Tripleseat's layout can be read with AI (server/beo-ai-routes.js), into the same preview.
import React, { useMemo, useState } from 'react';
import { useApp, Modal, Icon, money, JobDot } from '../ui.jsx';
import { parseBeos, matchRooms, beoToEvent, beoText } from '../../../core/beo-import.js';
import { dedupeBeos } from '../../../core/beo-match.js';
import { visibleSections, sectionsFound } from '../../../core/beo-sections.js';
import { demoBeoSamples } from '../../../core/beo-demo.js';
import { readBeoWithAi } from '../beo-api.js';
import { SectionBody, SectionChips, SectionChanges, sectionTitle } from './BeoSections.jsx';
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
  const [items, setItems] = useState(null); // the PDF's text items, kept for "Read it with AI"
  const [noLayout, setNoLayout] = useState(false); // the PDF isn't laid out like a Tripleseat BEO
  const [ai, setAi] = useState({ busy: false, error: '' });
  const [found, setFound] = useState(null); // parsed BEOs, one per event (copies in the same file merged)
  const [verdicts, setVerdicts] = useState([]); // events.importBeos dryRun, by index
  const [picks, setPicks] = useState({}); // index → { on, room, date, name, decision }
  const [open, setOpen] = useState({});
  const [newStatus, setNewStatus] = useState('confirmed');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { rows: [{ ev, result }] }

  const rooms = venue || [];
  const names = settings.rooms || [];
  const bookings = names.filter((n) => !rooms.some((r) => norm(r.name) === norm(n)));
  const matches = useMemo(() => (found || []).map((ev) => matchRooms(ev.areas, rooms, names)), [found, venue, settings.rooms]);

  /** A possible duplicate (not an identifier match): someone decides update, skip or new. */
  const isDup = (i) => !!verdicts[i]?.candidates?.length && (!verdicts[i].match || verdicts[i].match.how === 'chosen');
  /** The room choice: 'id:<roomId>', 'name:<booking or room name>', 'text' (as the BEO writes it), 'keep' (what the event has) or ''. */
  const defaultRoom = (i, evs = found) => {
    const m = matchRooms(evs[i].areas, rooms, names), v = verdicts[i];
    if (m?.roomId) return `id:${m.roomId}`;
    if (m?.room) return `name:${m.room}`;
    if (v?.id && (v.roomId || v.room)) return 'keep';
    return '';
  };
  const pickOf = (i, list = picks, evs = found) => {
    const p = list[i] || {};
    const v = verdicts[i];
    const date = p.date ?? evs[i].date;
    const name = p.name ?? evs[i].name;
    const decision = p.decision || null;
    const on = isDup(i) ? !!decision && decision.action !== 'skip' : p.on ?? (LIVE.includes(v?.status) && !!date && !!name);
    return { on, room: p.room ?? defaultRoom(i, evs), date, name, decision };
  };
  const payloadOf = (i, list = picks, evs = found) => {
    const ev = evs[i], p = pickOf(i, list, evs), v = verdicts[i];
    let roomId = null, roomName = '';
    if (p.room.startsWith('id:')) { roomId = p.room.slice(3); roomName = rooms.find((r) => r.id === roomId)?.name || ''; }
    else if (p.room.startsWith('name:')) roomName = p.room.slice(5);
    else if (p.room === 'text') roomName = ev.areas;
    else if (p.room === 'keep') { roomId = v?.roomId || null; roomName = v?.room || ''; }
    return { ...beoToEvent(ev, { roomId, room: roomName, date: p.date }), name: p.name, ...(p.decision ? { decision: p.decision } : {}) };
  };

  /** What importing would do to each one (events.importBeos dryRun): the same duplicate checks the import runs. */
  const check = async (evs, list = {}) => {
    const r = await call('events.importBeos', { events: evs.map((_, i) => payloadOf(i, list, evs)), dryRun: true });
    setVerdicts(r.events.reduce((a, x) => { a[x.index] = x; return a; }, []));
  };
  /** Found BEOs → the preview (the same BEO twice in the file becomes one: the newest). */
  const show = async (evs) => {
    const list = dedupeBeos(evs).map(({ index, ...ev }) => ev);
    setPicks({}); setOpen({}); setVerdicts([]);
    await check(list);
    setFound(list);
  };

  const reset = (name) => { setFileName(name); setFound(null); setVerdicts([]); setPicks({}); setOpen({}); setDone(null); setNoLayout(false); setItems(null); setAi({ busy: false, error: '' }); };
  const loadFile = async (f) => {
    if (!f) return;
    reset(f.name);
    const reader = __DEMO__ ? null : await import('../pdf.js');
    if (!reader) return toast(tx('beoImport.pdfOnlyInTheApp'), 'bad');
    setReading(true);
    try {
      const { items: its } = await reader.pdfToItems(f);
      setItems(its);
      const evs = parseBeos(its);
      if (!evs.length) { setNoLayout(true); return; } // offer "Read it with AI"
      await show(evs);
    } catch (e) {
      toast(tx('beoImport.couldntReadThatPdf', { message: e.message }), 'bad');
    } finally {
      setReading(false);
    }
  };
  /** The demo has no PDFs: invented BEOs as if read from one (core/beo-demo.js). */
  const loadSample = async () => {
    reset(t('beo.sampleFile'));
    setReading(true);
    try { await show(demoBeoSamples(await call('events.list', {}))); } catch (e) { toast(e.message, 'bad'); } finally { setReading(false); }
  };
  /** "Read it with AI" (server/beo-ai-routes.js): its events get the same preview and duplicate checks. */
  const readWithAi = async () => {
    if (__DEMO__ || !items) { setAi({ busy: false, error: t('beo.aiNotSetUp') }); return; }
    setAi({ busy: true, error: '' });
    try {
      const evs = await readBeoWithAi(beoText(items));
      if (!evs.length) { setAi({ busy: false, error: t('beo.aiNothing') }); return; }
      setNoLayout(false);
      await show(evs);
      setAi({ busy: false, error: '' });
    } catch (e) {
      const why = e.reason;
      setAi({ busy: false, error: ['no_key', 'off', 'plan'].includes(why) ? t('beo.aiNotSetUp') : why === 'cap' ? t('beo.aiCap') : e.status === 403 || e.status === 401 ? e.message : t('beo.aiFailed') });
    }
  };

  const setPick = (i, patch) => setPicks((m) => ({ ...m, [i]: { ...m[i], ...patch } }));
  /** A decision on a possible duplicate: the preview asks the server again, so it shows what will happen. */
  const decide = async (i, decision) => {
    const next = { ...picks, [i]: { ...picks[i], decision } };
    setPicks(next);
    try { await check(found, next); } catch (e) { toast(e.message, 'bad'); }
  };

  const chosen = (found || []).map((_, i) => i).filter((i) => pickOf(i).on);
  const missing = chosen.filter((i) => !pickOf(i).date || !pickOf(i).name);
  const undecided = (found || []).map((_, i) => i).filter((i) => isDup(i) && !pickOf(i).decision);
  const doImport = async () => {
    setBusy(true);
    try {
      const r = await call('events.importBeos', { events: chosen.map((i) => payloadOf(i)), status: newStatus });
      setDone({ rows: r.events.filter((x) => x.id).map((x) => ({ result: x, ev: { ...found[chosen[x.index]], ...payloadOf(chosen[x.index]) } })) });
      const made = r.events.filter((x) => x.status === 'new').length;
      toast(tx('beoImport.importedSummary', { made, updated: r.events.filter((x) => x.id).length - made }));
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
        {undecided.length > 0 && <span className="small beo-undecided">{t('beo.decideCount', { count: undecided.length })}</span>}
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!chosen.length || missing.length > 0 || undecided.length > 0 || busy} onClick={doImport}>
          <Icon name="upload" />{t('beoImport.importCount', { count: chosen.length })}
        </button>
      </>}>
      <div className="alert info"><Icon name="sparkle" size={16} /><div>{t('beoImport.howItWorks')}</div></div>
      <div className="row wrap">
        <label className="btn primary sm"><Icon name="upload" />{reading ? t('beoImport.reading') : t('beoImport.uploadPdf')}
          <input type="file" accept=".pdf,application/pdf" hidden disabled={reading} onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {__DEMO__ && <button className="btn sm" disabled={reading} onClick={loadSample}><Icon name="glass" />{t('beo.sampleButton')}</button>}
        {fileName && <span className="small muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{fileName}</span>}
      </div>

      {(noLayout || ai.error || ai.busy) && (
        <div className="beo-ai">
          {noLayout && <div><b>{t('beo.noLayout')}</b> <span className="small muted">{t('beo.aiHelp')}</span></div>}
          {ai.error && <div className="alert warn"><Icon name="alert" size={16} /><div>{ai.error}</div></div>}
          {noLayout && <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} disabled={ai.busy} onClick={readWithAi}><Icon name="sparkle" />{ai.busy ? t('beo.aiReading') : t('beo.aiOffer')}</button>}
          {!noLayout && ai.busy && <div className="small muted">{t('beo.aiReading')}</div>}
        </div>
      )}

      {found && (
        <>
          <div className="small muted">{t('beoImport.foundCount', { count: found.length })}</div>
          <div className="beo-imp-list">
            {found.map((ev, i) => {
              const p = pickOf(i), v = verdicts[i] || {}, m = matches[i];
              const warn = (ev.warnings || []).filter((w) => w.code !== 'noDate' || !p.date);
              const needsRoom = m.how === 'none' && !p.room;
              const fields = (v.changes || []).filter((c) => c !== 'sections');
              const dup = isDup(i);
              return (
                <div key={i} className={`beo-imp-ev ${p.on ? 'on' : ''}`}>
                  <div className="beo-imp-head">
                    <label className="check" style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={p.on} disabled={!p.date || !p.name || dup} onChange={(e) => setPick(i, { on: e.target.checked })} />
                      <span style={{ minWidth: 0 }}>
                        <b className="beo-imp-name">{p.name || t('beoImport.noName')}</b>
                        <span className="small muted beo-imp-meta">
                          {p.date ? prettyDate(p.date) : t('beoImport.noDateShort')}
                          {ev.start ? ` · ${timeText(ev.start, ev.end)}` : ''}
                          {ev.guestCount ? ` · ${t('beoImport.guests', { count: ev.guestCount })}` : ''}
                          {ev.serviceStyle ? ` · ${styleLabel(SERVICE_STYLES[ev.serviceStyle], t.lang)}` : ''}
                          {ev.pages ? ` · ${t('beoImport.pages', { from: ev.pages[0], to: ev.pages[1] })}` : ''}
                        </span>
                      </span>
                    </label>
                    {ev.via === 'ai' && <span className="badge brand"><Icon name="sparkle" size={11} />{t('beo.viaAi')}</span>}
                    <StatusBadge v={v} />
                  </div>

                  {ev.merged?.length > 0 && <div className="small muted beo-merged">{t('beo.mergedNote', { count: ev.merged.length + 1, when: ev.beoUpdatedAt ? stamp(ev.beoUpdatedAt) : t('beo.laterPages') })}</div>}

                  {!ev.name && <input className="input sm" placeholder={t('events.eventName')} value={p.name} onChange={(e) => setPick(i, { name: e.target.value })} />}
                  {!ev.date && (
                    <label className="beo-imp-ctl"><span>{t('beoImport.pickTheDate')}</span>
                      <input className="input sm" type="date" value={p.date || ''} onChange={(e) => setPick(i, { date: e.target.value, on: !!e.target.value && (picks[i]?.on ?? true) })} />
                    </label>
                  )}

                  {dup && <DuplicateCheck ev={{ ...ev, name: p.name, date: p.date }} idx={i} v={v} decision={p.decision} onDecide={(d) => decide(i, d)} />}
                  {v.match && v.match.how !== 'chosen' && <div className="small muted"><Icon name="link" size={12} /> {t(`beo.match_${v.match.how}`)}</div>}

                  {p.decision?.action !== 'skip' && (
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
                  )}

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
                  {['update', 'older'].includes(v.status) && (fields.length > 0 || v.sectionChanges?.length > 0) && (
                    <div className="beo-imp-changes col" style={{ gap: 4 }}>
                      <div className="small"><b>{t('beo.whatChanged')}</b>{fields.length > 0 ? <span className="muted"> · {t('beoImport.changes', { list: [...new Set(fields.map((c) => (c === 'roomId' ? 'room' : c)))].map(fieldLabel(t)).join(', ') })}</span> : ''}</div>
                      <SectionChanges changes={v.sectionChanges} />
                    </div>
                  )}
                  {p.decision?.action !== 'skip' && <SectionChips found={v.sections || sectionsFound(ev)} />}

                  <button className="btn sm ghost beo-imp-toggle" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))} aria-expanded={!!open[i]}>
                    <Icon name={open[i] ? 'up' : 'down'} />{open[i] ? t('beoImport.hideDetails') : t('beoImport.showDetails')}
                  </button>
                  {open[i] && <BeoPreview ev={ev} />}
                </div>
              );
            })}
          </div>
          {!__DEMO__ && items && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} disabled={ai.busy} onClick={readWithAi}><Icon name="sparkle" />{ai.busy ? t('beo.aiReading') : t('beo.aiTryInstead')}</button>}
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

/** A field's name in the change summary. */
const fieldLabel = (t) => (c) => (['location', 'guaranteed'].includes(c) ? t(`beo.field_${c}`) : t(`beoImport.field_${c}`));

function StatusBadge({ v }) {
  const t = useT();
  if (!v?.status) return null;
  const kind = { new: 'ok', update: 'brand', same: '', older: 'warn', invalid: 'bad', duplicate: 'warn', skipped: '', merged: '' }[v.status];
  return <span className={`badge ${kind}`}>{['duplicate', 'skipped', 'merged'].includes(v.status) ? t(`beo.status_${v.status}`) : t(`beoImport.status_${v.status}`)}</span>;
}

/** "Possible duplicate — check": this BEO next to each event it looks like, why, how sure, and the choices. */
function DuplicateCheck({ ev, idx, v, decision, onDecide }) {
  const t = useT();
  const side = (x) => [
    x.date ? prettyDate(x.date) : '', x.start ? timeText(x.start, x.end) : '', x.room || x.areas || '', x.guestCount ? t('beoImport.guests', { count: x.guestCount }) : '',
  ].filter(Boolean).join(' · ');
  const is = (d) => decision?.action === d.action && (d.action !== 'update' || decision.id === d.id);
  const group = `beo-dup-${idx}`;
  return (
    <div className="beo-dup" role="radiogroup" aria-label={t('beo.dupTitle')}>
      <div className="beo-dup-h"><Icon name="alert" size={15} />{t('beo.dupTitle')}</div>
      <div className="small">{t('beo.dupHelp')}</div>
      {v.candidates.map((c) => (
        <div key={c.id} className="col" style={{ gap: 6 }}>
          <div className="beo-dup-pair">
            <div className="beo-dup-side"><span className="k">{t('beo.thisBeo')}</span><b>{ev.name}</b><span className="muted">{side(ev)}</span></div>
            <div className="beo-dup-side">
              <span className="k">{t('beo.alreadyHere')}</span><b>{c.name}</b><span className="muted">{side(c)}</span>
              {c.staffing > 0 && <span className="tiny faint">{t('beo.hasStaffing', { count: c.staffing })}</span>}
            </div>
          </div>
          <div className="beo-dup-reasons">
            <span className={`badge ${c.confidence === 'high' ? 'bad' : c.confidence === 'medium' ? 'warn' : ''}`}>{t(`beo.confidence_${c.confidence}`)}</span>
            {c.reasons.map((r) => <span key={r} className="badge">{t(`beo.reason_${r}`)}</span>)}
          </div>
        </div>
      ))}
      <div className="beo-dup-choices">
        {v.candidates.map((c) => (
          <label key={c.id}><input type="radio" name={group} checked={is({ action: 'update', id: c.id })} onChange={() => onDecide({ action: 'update', id: c.id })} /><span>{t('beo.decideUpdate', { name: c.name })}</span></label>
        ))}
        <label><input type="radio" name={group} checked={is({ action: 'skip' })} onChange={() => onDecide({ action: 'skip' })} /><span>{t('beo.decideSkip')}</span></label>
        <label><input type="radio" name={group} checked={is({ action: 'new' })} onChange={() => onDecide({ action: 'new' })} /><span>{t('beo.decideNew')}</span></label>
      </div>
    </div>
  );
}

/** Everything read from one BEO, before it's imported: the details it has, then its sections. */
function BeoPreview({ ev }) {
  const t = useT();
  const sections = visibleSections(ev, { client: true });
  const details = [
    [t('events.type'), ev.type], [t('beoImport.areas'), ev.areas], [t('beo.location'), ev.location], [t('beo.label_guaranteed'), ev.guaranteed],
    [t('beoImport.salesManager'), ev.salesManager], [t('beoImport.eventManager'), ev.eventManager],
    [t('beoImport.fbMinimum'), ev.fbMinimum > 0 ? money(ev.fbMinimum) : ''],
    [t('beoImport.invoice'), ev.invoiceNumber ? `#${ev.invoiceNumber}${ev.beoUpdatedAt ? ` · ${t('beoImport.updatedOn', { when: stamp(ev.beoUpdatedAt) })}` : ''}` : ''],
  ].filter(([, x]) => x);
  return (
    <div className="beo-imp-details">
      {details.length > 0 && <dl className="kv">{details.map(([k, x]) => <React.Fragment key={k}><dt>{k}</dt><dd>{x}</dd></React.Fragment>)}</dl>}
      {ev.otherDates?.length > 0 && <OtherDates list={ev.otherDates} />}
      {sections.map((s, k) => <div key={k}><h4>{sectionTitle(t, s)}</h4><SectionBody s={s} /></div>)}
    </div>
  );
}

export function OtherDates({ list }) {
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
