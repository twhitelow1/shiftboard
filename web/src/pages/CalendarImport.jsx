// "Import from a calendar page" (core/calendar-import.js, server/calendar/): a venue's public events page read into
// regular programming (what repeats each week) and one-off events, reviewed here before anything is saved.
//   CalendarImportDialog  Settings → Programming's button, and Ask ShiftBoard's "Review & import": the page's link
//                         (remembered, with "Check for new events"), then every suggestion with a checkbox, its room,
//                         name, Start date / End date, and Import (confirm first)
//   CalendarCard          Ask ShiftBoard's card under the reply: ticks and room pickers, Review & import, Import now
//                         (which becomes the usual Confirm / Cancel card)
// Names and rooms are the venue's and never translated.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal } from '../ui.jsx';
import { useT, fmtTime, dowShort, prettyDate, stamp, getLang } from '../i18n/index.js';
import '../calendar-import.css';

/** POST /api/programming/calendar/read: read the page (no url: the remembered one). */
async function readPage(url, remember) {
  const res = await fetch('/api/programming/calendar/read', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() }, body: JSON.stringify({ url, remember }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data.result;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
const timeRange = (s, e) => `${s ? fmtTime(s) : ''}${e ? `–${fmtTime(e)}` : ''}`;

/** The choices the RPC takes: { recurring: { key: {...} }, oneOffs: { key: {...} } } from the rows' state. */
export function selectionsOf(rows) {
  const out = { recurring: {}, oneOffs: {} };
  for (const r of rows.recurring) out.recurring[r.key] = { include: r.include, room: r.room, name: r.name, from: r.from, to: r.to };
  for (const o of rows.oneOffs) out.oneOffs[o.key] = { include: o.include, room: o.room };
  return out;
}
const rowsOf = (imp) => ({ recurring: imp.recurring.map((r) => ({ ...r })), oneOffs: imp.oneOffs.map((o) => ({ ...o })) });

/** A room picker: the venue's rooms, Whole venue (recurring) or No room (events). */
function RoomSelect({ value, rooms, kind, onChange, disabled, label }) {
  const t = useT();
  return (
    <select className={`input sm ${kind === 'recurring' && !value ? 'cal-need' : ''}`} value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {kind === 'recurring' ? <option value="">{t('calImport.pickRoom')}</option> : <option value="">{t('calImport.noRoom')}</option>}
      {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
      {kind === 'recurring' && <option value="*">{t('calImport.wholeVenue')}</option>}
    </select>
  );
}

function Badges({ x }) {
  const t = useT();
  const d = x.duplicateOf;
  return (
    <>
      {d && <span className="badge warn">{d.why === 'imported' ? t('calImport.dupImported') : d.kind === 'event' ? t('calImport.dupEvent', { name: d.name }) : t('calImport.dupProgramming', { name: d.name })}</span>}
      {x.repeat === 'biweekly' && <span className="badge">{t('calImport.everyOther')}</span>}
      {x.repeat === 'monthly' && <span className="badge">{t('calImport.monthly')}</span>}
    </>
  );
}

/** One recurring suggestion, editable. */
function RecurringRow({ r, rooms, set, compact = false, disabled = false }) {
  const t = useT();
  return (
    <div className={`cal-row ${r.include ? '' : 'off'}`}>
      <input type="checkbox" checked={r.include} disabled={disabled} aria-label={t('calImport.include', { name: r.name })} onChange={(e) => set({ include: e.target.checked })} />
      <div className="cal-main">
        <div className="cal-line">
          {compact ? <b>{r.name}</b> : <input className="input sm cal-name" value={r.name} maxLength={60} aria-label={t('calImport.name')} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />}
          <span className="cal-when">{r.days.map((d) => dowShort(d)).join(', ')} · {timeRange(r.start, r.end)}</span>
          <Badges x={r} />
        </div>
        <div className="cal-line">
          <RoomSelect value={r.room} rooms={rooms} kind="recurring" disabled={disabled} label={t('calImport.room')} onChange={(room) => set({ room })} />
          {!compact && (
            <>
              <label className="cal-date"><span className="tiny muted">{t('calImport.startDate')}</span><input type="date" className="input sm" value={r.from || ''} disabled={disabled} onChange={(e) => set({ from: e.target.value })} /></label>
              <label className="cal-date"><span className="tiny muted">{t('calImport.endDate')}</span><input type="date" className="input sm" value={r.to || ''} disabled={disabled} title={t('calImport.endBlank')} onChange={(e) => set({ to: e.target.value })} /></label>
            </>
          )}
          <span className="tiny muted">{t('calImport.matched', { count: r.count })}{compact && r.from ? ` · ${prettyDate(r.from)} – ${r.to ? prettyDate(r.to) : '…'}` : ''}</span>
        </div>
        {!compact && r.acts?.length > 0 && <div className="tiny muted">{t('calImport.actsVary', { acts: r.acts.join(', ') })}</div>}
        {!compact && !r.room && r.roomText && <div className="tiny muted">{t('calImport.calendarSays', { text: r.roomText })}</div>}
        {!compact && r.parsFrom && <div className="tiny muted">{t('calImport.parsCopied', { name: r.parsFrom })}</div>}
      </div>
    </div>
  );
}

function OneOffRow({ o, rooms, set, disabled = false }) {
  const t = useT();
  return (
    <div className={`cal-row ${o.include ? '' : 'off'}`}>
      <input type="checkbox" checked={o.include} disabled={disabled} aria-label={t('calImport.include', { name: o.name })} onChange={(e) => set({ include: e.target.checked })} />
      <div className="cal-main">
        <div className="cal-line"><b className="cal-ename">{o.name}</b><span className="cal-when">{prettyDate(o.date)}{o.start ? ` · ${timeRange(o.start, o.end)}` : ''}</span><Badges x={o} /></div>
        <div className="cal-line"><RoomSelect value={o.room} rooms={rooms} kind="event" disabled={disabled} label={t('calImport.room')} onChange={(room) => set({ room })} /></div>
      </div>
    </div>
  );
}

/** The two lists, with their rows' state. */
function Suggestions({ imp, rows, setRows, compact = false, disabled = false }) {
  const t = useT();
  const [all, setAll] = useState(!compact);
  const setR = (i, patch) => setRows((x) => ({ ...x, recurring: x.recurring.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const setO = (i, patch) => setRows((x) => ({ ...x, oneOffs: x.oneOffs.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  return (
    <div className="col" style={{ gap: 10 }}>
      <div>
        <div className="cal-h">{t('calImport.recurring')}</div>
        {!compact && <div className="help" style={{ marginTop: 0 }}>{t('calImport.recurringHelp')}</div>}
        {!rows.recurring.length ? <div className="small muted">{t('calImport.noneRecurring')}</div>
          : rows.recurring.map((r, i) => <RecurringRow key={r.key} r={r} rooms={imp.rooms} compact={compact} disabled={disabled} set={(p) => setR(i, p)} />)}
      </div>
      <div>
        <div className="cal-h">{t('calImport.oneOffs')}</div>
        {!compact && <div className="help" style={{ marginTop: 0 }}>{t('calImport.oneOffsHelp')}</div>}
        {!rows.oneOffs.length ? <div className="small muted">{t('calImport.noneOneOff')}</div> : all
          ? <>{rows.oneOffs.map((o, i) => <OneOffRow key={o.key} o={o} rooms={imp.rooms} disabled={disabled} set={(p) => setO(i, p)} />)}{compact && <button type="button" className="btn sm ghost" onClick={() => setAll(false)}>{t('calImport.hide')}</button>}</>
          : <button type="button" className="btn sm ghost" onClick={() => setAll(true)}>{t('calImport.showAll', { count: rows.oneOffs.length })}</button>}
      </div>
    </div>
  );
}

function Summary({ imp }) {
  const t = useT();
  return (
    <div className="small">
      <b>{t('calImport.found', { count: imp.events, host: hostOf(imp.url) })}</b>{' '}
      <span className="muted">{t('calImport.via', { source: t(`calImport.src_${imp.source}`) })} · {prettyDate(imp.from)} – {prettyDate(imp.to)}</span>
    </div>
  );
}

/** Settings → Programming's dialog (and Ask ShiftBoard's Review & import with importId). */
export function CalendarImportDialog({ importId = null, onClose }) {
  const t = useT();
  const { call, toast, refresh } = useApp();
  const [url, setUrl] = useState('');
  const [remember, setRemember] = useState(true);
  const [source, setSource] = useState(null);
  const [imp, setImp] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const show = (out) => { setSource(out.source); if (out.import) { setImp(out.import); setRows(rowsOf(out.import)); } };
  useEffect(() => {
    call('programming.calendar.get', importId ? { id: importId } : {}).then((out) => {
      setSource(out.source);
      if (out.source?.url) setUrl(out.source.url);
      if (importId && out.import) { setUrl(out.import.url); show(out); }
    }).catch((e) => toast(e.message, 'bad'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const read = async (again = false) => {
    setBusy(true);
    try { show(await readPage(again ? '' : url.trim(), !again && remember)); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const forget = async () => { try { await call('programming.calendar.forget'); setSource(null); } catch (e) { toast(e.message, 'bad'); } };
  const needRoom = rows ? rows.recurring.filter((r) => r.include && !r.room).length : 0;
  const ticked = rows ? rows.recurring.filter((r) => r.include).length + rows.oneOffs.filter((o) => o.include).length : 0;
  const doImport = async () => {
    setBusy(true);
    try {
      const selections = selectionsOf(rows);
      const dry = await call('programming.calendar.apply', { id: imp.id, selections, dryRun: true });
      if (!window.confirm(t('calImport.confirm', { line: dry.line }))) return;
      const r = await call('programming.calendar.apply', { id: imp.id, selections });
      toast(t('calImport.done', { line: r.line }));
      refresh?.();
      onClose(true);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal wide title={t('calImport.title')} onClose={() => onClose(false)}
      footer={imp ? (
        <>
          {needRoom > 0 && <span className="small cal-warn"><Icon name="alert" size={14} />{t('calImport.needsRoom', { count: needRoom })}</span>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
          <button type="button" className="btn primary" disabled={busy || !ticked || needRoom > 0} onClick={doImport}><Icon name="check" size={16} />{t('calImport.importN')}</button>
        </>
      ) : null}>
      <div className="col" style={{ gap: 12 }}>
        {!imp && <div className="help" style={{ margin: 0 }}>{t('calImport.help')}</div>}
        <form className="cal-url" onSubmit={(e) => { e.preventDefault(); if (url.trim()) read(); }}>
          <label className="field" style={{ flex: '1 1 260px', margin: 0 }}>
            <span>{t('calImport.url')}</span>
            <input className="input" type="url" inputMode="url" value={url} placeholder={t('calImport.urlPlaceholder')} onChange={(e) => setUrl(e.target.value)} maxLength={2000} />
          </label>
          <button type="submit" className="btn primary" disabled={busy || !url.trim()}>{busy ? t('calImport.reading') : t('calImport.read')}</button>
        </form>
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('calImport.remember')}</label>
          {source?.url && (
            <>
              <span className="spacer" />
              <span className="tiny muted cal-src">{t('calImport.remembered', { url: hostOf(source.url) })}{source.checkedAt ? ` · ${t('calImport.lastChecked', { when: stamp(source.checkedAt) })}` : ''}</span>
              <button type="button" className="btn sm" disabled={busy} onClick={() => read(true)}><Icon name="rotateRight" size={14} />{t('calImport.checkNew')}</button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={forget}>{t('calImport.forget')}</button>
            </>
          )}
        </div>
        {imp && rows && (
          <>
            <Summary imp={imp} />
            <Suggestions imp={imp} rows={rows} setRows={setRows} />
          </>
        )}
      </div>
    </Modal>
  );
}

/** Ask ShiftBoard's card: card = the message's summary ({ id, url, recurring, oneOffs, status, result }). */
export function CalendarCard({ card, busy, onReview, onImportNow }) {
  const t = useT();
  const { call } = useApp();
  const [imp, setImp] = useState(null);
  const [rows, setRows] = useState(null);
  const [gone, setGone] = useState(false);
  const done = card.status === 'done';
  useEffect(() => {
    if (done) return;
    call('programming.calendar.get', { id: card.id }).then((out) => { setImp(out.import); setRows(rowsOf(out.import)); }).catch(() => setGone(true));
  }, [card.id, done]); // eslint-disable-line react-hooks/exhaustive-deps
  const needRoom = rows ? rows.recurring.filter((r) => r.include && !r.room).length : card.unmatched || 0;
  const ticked = rows ? rows.recurring.filter((r) => r.include).length + rows.oneOffs.filter((o) => o.include).length : 0;
  return (
    <div className={`ask-import cal-card ${done ? 'done' : 'ready'}`}>
      <div className="ask-import-head">
        <Icon name="calendar" size={16} />
        <b>{t('calImport.title')}</b>
        {done && <span className="badge ok"><Icon name="check" size={12} />{t('assistant.st_done')}</span>}
      </div>
      <Summary imp={{ ...card, events: card.events }} />
      {done ? (card.result && <div className="small">{card.result}</div>) : gone ? <div className="small muted">{t('calImport.gone')}</div> : !rows ? <div className="small muted">{t('common.loading')}</div> : (
        <>
          <Suggestions imp={imp} rows={rows} setRows={setRows} compact disabled={busy} />
          {needRoom > 0 && <div className="small ask-import-warn"><Icon name="alert" size={14} />{t('calImport.needsRoom', { count: needRoom })}</div>}
          <div className="ask-action-buttons">
            <button type="button" className="btn" disabled={busy} onClick={() => onReview(card)}><Icon name="eye" size={16} />{t('calImport.review')}</button>
            <button type="button" className="btn primary" disabled={busy || !ticked || needRoom > 0} onClick={() => onImportNow(card, selectionsOf(rows))}><Icon name="check" size={16} />{t('calImport.importNow')}</button>
          </div>
        </>
      )}
    </div>
  );
}
