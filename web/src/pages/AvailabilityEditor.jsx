// Weekly availability on the web: the week editor (yours, or someone else's for managers), its history, and the
// person picker. Time Off → My availability shows them for the person (and, for whoever may edit staff availability, a
// picker); Team → a person opens them in a dialog. Saving is employees.setAvailability; every change is logged and,
// when it's someone else's, they're told (core/availability-api.js). The history is availability.history.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Icon, Modal, Field, useAction, Empty } from '../ui.jsx';
import { useT, dowLong, fmtTime, stamp, prettyDate } from '../i18n/index.js';
import '../availability.css';

const blank = { available: true, from: '', to: '', note: '' };
const viewOf = (a) => ({ ...blank, ...(a || {}), from: a?.from || '', to: a?.to || '', note: a?.note || '', available: a?.available !== false });
/** "Any time" · "Unavailable" · "4:00 PM – close" · "Opening – 3:00 PM", with the note. */
export function dayText(t, d) {
  const v = viewOf(d);
  // A standing request off (green REQ OFF, or added by a manager) says so, with when it was first asked.
  const main = !v.available ? (v.standing ? `${t('availability.standing')}${v.requestedAt ? ` · ${prettyDate(v.requestedAt.slice(0, 10))}` : ''}` : t('availability.unavailable')) : v.from || v.to
    ? t('availability.hours', { from: v.from ? fmtTime(v.from) : t('availability.opening'), to: v.to ? fmtTime(v.to) : t('availability.close') }) : t('availability.anyTime');
  return v.note ? `${main} · ${v.note}` : main;
}
/** Days in the restaurant's week order. */
export const weekOrder = (settings) => [0, 1, 2, 3, 4, 5, 6].map((i) => (i + (settings?.weekStartDow ?? 1)) % 7);

/** One day's controls: any time / some hours / unavailable, the hours, and a note. */
export function DayControls({ value, onChange, compact = false }) {
  const t = useT();
  const v = viewOf(value);
  const mode = !v.available ? 'off' : v.from || v.to ? 'some' : 'any';
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <div className={`av-controls ${compact ? 'compact' : ''}`}>
      <div className="seg" role="radiogroup">
        <button type="button" role="radio" aria-checked={mode === 'any'} className={mode === 'any' ? 'on' : ''} onClick={() => set({ available: true, from: '', to: '', standing: undefined, requestedAt: undefined })}>{t('availability.anyTime')}</button>
        <button type="button" role="radio" aria-checked={mode === 'some'} className={mode === 'some' ? 'on' : ''} onClick={() => set({ available: true, from: v.from || '16:00', to: v.to, standing: undefined, requestedAt: undefined })}>{t('availability.someHours')}</button>
        <button type="button" role="radio" aria-checked={mode === 'off'} className={mode === 'off' ? 'on' : ''} onClick={() => set({ available: false, from: '', to: '' })}>{t('availability.unavailable')}</button>
      </div>
      {mode === 'some' && (
        <div className="row av-times">
          <input className="input sm" type="time" value={v.from} onChange={(e) => set({ from: e.target.value })} aria-label={t('availability.from')} />
          <span className="faint">{t('availability.to')}</span>
          <input className="input sm" type="time" value={v.to} onChange={(e) => set({ to: e.target.value })} aria-label={t('availability.until')} />
        </div>
      )}
      <input className="input sm av-note" value={v.note} maxLength={200} placeholder={t('availability.notePlaceholder')} onChange={(e) => set({ note: e.target.value })} aria-label={t('availability.note')} />
    </div>
  );
}

/** The week for one person: read, or edit when allowed. onSaved after a save. */
export function AvailabilityWeek({ userId, onSaved }) {
  const t = useT();
  const { call, settings, me, version } = useApp();
  const [data, setData] = useState(null);
  const [av, setAv] = useState({});
  const [extra, setExtra] = useState({ notes: '', maxHours: '', maxDays: '' });
  const [run, busy] = useAction();
  const load = () => call('availability.get', { userId }).then((d) => {
    setData(d);
    setAv(Object.fromEntries(Object.entries(d.availability || {}).map(([k, v]) => [k, viewOf(v)])));
    setExtra({ notes: d.notes || '', maxHours: d.maxHours ?? '', maxDays: d.maxDays ?? '' });
  });
  useEffect(() => { load(); }, [userId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const mine = data.userId === me.id;
  const edit = data.canEdit;
  const order = weekOrder(settings);
  const save = async () => {
    const r = await run(() => call('employees.setAvailability', { ...(mine ? {} : { userId }), availability: av, notes: extra.notes, maxHours: extra.maxHours, maxDays: extra.maxDays }),
      mine ? t('availability.saved') : t('availability.savedFor', { name: data.name }));
    if (r) { await load(); onSaved?.(); }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">{mine ? t('availability.helpMine') : edit ? t('availability.helpOther', { name: data.name }) : t('availability.readOnly', { name: data.name })}</div>
      {data.effectiveFrom && <div className="alert info"><Icon name="calendar" size={16} /><div>{t('availability.effectiveFrom', { date: prettyDate(data.effectiveFrom) })}</div></div>}
      <div className="card list av-week">
        {order.map((d) => (
          <div key={d} className="list-item av-day">
            <div className="av-dayname">{dowLong(d)}</div>
            {edit ? <DayControls value={av[d]} onChange={(v) => setAv({ ...av, [d]: v })} /> : <div className="small">{dayText(t, av[d])}</div>}
          </div>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-start' }}>
        <Field label={t('availability.weekNotes')}>
          <textarea className="input" rows={2} value={extra.notes} disabled={!edit} maxLength={500} onChange={(e) => setExtra({ ...extra, notes: e.target.value })} style={{ minWidth: 220 }} />
        </Field>
        <Field label={t('availability.maxHours')}><input className="input" type="number" min="0" max="80" value={extra.maxHours} disabled={!edit} onChange={(e) => setExtra({ ...extra, maxHours: e.target.value })} style={{ width: 100 }} /></Field>
        <Field label={t('availability.maxDays')}><input className="input" type="number" min="0" max="7" value={extra.maxDays} disabled={!edit} onChange={(e) => setExtra({ ...extra, maxDays: e.target.value })} style={{ width: 100 }} /></Field>
      </div>
      {edit && (
        <div className="row wrap" style={{ gap: 8 }}>
          {!mine && data.notifies && <span className="small muted"><Icon name="bell" size={13} /> {t('availability.willNotify', { name: data.name })}</span>}
          <span className="spacer" />
          <button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t('availability.save')}</button>
        </div>
      )}
    </div>
  );
}

const VIA = { app: 'availability.viaApp', import: 'availability.viaImport', connector: 'availability.viaConnector', assistant: 'availability.viaAssistant' };
const FIELD = { notes: 'availability.weekNotes', maxHours: 'availability.maxHours', maxDays: 'availability.maxDays', effectiveFrom: 'availability.fromDate' };

/** Every change to someone's availability (2 years), newest first: who, when, how, each day before → after. */
export function AvailabilityHistory({ userId }) {
  const t = useT();
  const { call, version } = useApp();
  const [rows, setRows] = useState(null);
  useEffect(() => { call('availability.history', { userId }).then(setRows, () => setRows([])); }, [userId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <div className="empty">{t('common.loading')}</div>;
  if (!rows.length) return <Empty icon="clock" title={t('availability.noHistory')} />;
  const val = (f, v) => (v === '' || v == null ? '—' : f === 'effectiveFrom' ? prettyDate(v) : String(v));
  return (
    <div className="col av-history" style={{ gap: 8 }}>
      <div className="tiny faint">{t('availability.keptTwoYears')}</div>
      {rows.map((e) => (
        <div key={e.id} className="card card-pad av-entry">
          <div className="row wrap" style={{ gap: 6 }}>
            <b>{e.self ? t('availability.byThemselves', { name: e.actorName }) : e.actorName || t('availability.someone')}</b>
            <span className="badge">{t(VIA[e.via] || VIA.app)}</span>
            {e.fileName && <span className="tiny faint">{e.fileName}</span>}
            <span className="spacer" />
            <span className="small muted">{stamp(e.at)}</span>
          </div>
          <ul className="av-changes">
            {e.days.map((d) => (
              <li key={d.day}><span className="av-dayname">{dowLong(d.day)}</span><span className="si-before">{dayText(t, d.before)}</span><span aria-hidden="true"> → </span><b>{dayText(t, d.after)}</b></li>
            ))}
            {e.fields.map((f) => (
              <li key={f.field}><span className="av-dayname">{t(FIELD[f.field] || 'availability.weekNotes')}</span><span className="si-before">{val(f.field, f.before)}</span><span aria-hidden="true"> → </span><b>{val(f.field, f.after)}</b></li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Time Off → Availability: mine, or (for whoever may edit staff availability) anyone's, with tabs for the week and its history. */
export function AvailabilityPage() {
  const t = useT();
  const { call, me } = useApp();
  const [people, setPeople] = useState(null);
  const [who, setWho] = useState(me.id);
  const [tab, setTab] = useState('week');
  useEffect(() => { call('availability.people').then(setPeople, () => setPeople([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 10 }}>
      {people && people.length > 1 && (
        <Field label={t('availability.person')} help={t('availability.personHelp')}>
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 320 }}>
            {[...people].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0)).map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? t('availability.meName', { name: p.name }) : p.name}</option>)}
          </select>
        </Field>
      )}
      <div className="tabs" style={{ margin: 0 }}>
        <button className={tab === 'week' ? 'on' : ''} onClick={() => setTab('week')}>{t('availability.week')}</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}><Icon name="clock" size={14} />{t('availability.history')}</button>
      </div>
      {tab === 'week' ? <AvailabilityWeek userId={who} /> : <AvailabilityHistory userId={who} />}
    </div>
  );
}

/** Team → a person: their availability in a dialog (week and history). */
export function AvailabilityDialog({ person, onClose }) {
  const t = useT();
  const [tab, setTab] = useState('week');
  return (
    <Modal wide title={t('availability.titleFor', { name: person.name })} onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>{t('common.done')}</button></>}>
      <div className="tabs" style={{ marginTop: 0 }}>
        <button className={tab === 'week' ? 'on' : ''} onClick={() => setTab('week')}>{t('availability.week')}</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}><Icon name="clock" size={14} />{t('availability.history')}</button>
      </div>
      {tab === 'week' ? <AvailabilityWeek userId={person.id} /> : <AvailabilityHistory userId={person.id} />}
    </Modal>
  );
}

/** A short summary for Team → person: "Mon unavailable · Fri from 4 PM", with Edit / History. */
export function AvailabilitySummary({ person }) {
  const t = useT();
  const { settings } = useApp();
  const [open, setOpen] = useState(false);
  const av = person.availability || {};
  const days = weekOrder(settings).filter((d) => av[d] && (av[d].available === false || av[d].from || av[d].to || av[d].note));
  return (
    <div className="card card-pad col" style={{ gap: 6 }}>
      <div className="row"><b style={{ flex: 1 }}>{t('availability.title')}</b>
        <button type="button" className="btn sm" onClick={() => setOpen(true)}><Icon name="clock" />{t('availability.openFor')}</button></div>
      <div className="small muted">{days.length ? days.map((d) => `${dowLong(d)}: ${dayText(t, av[d])}`).join(' · ') : t('availability.anyTimeAllWeek')}</div>
      {open && createPortal(<AvailabilityDialog person={person} onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}
