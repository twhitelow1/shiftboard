// Time off: requests (to approve, everyone's upcoming, mine), each with when it was requested and its place in line
// ("1st of 3 for Sat, Dec 13", core/time-off.js), the form (yours, or for a manager: someone else's that came in by
// email, text, a call… approved by default, with clashing shifts shown first), standing requests off for several people
// at once, and Availability.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Icon, Avatar, Field, Empty, useAction, Modal } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { tx, useT, prettyDate, stamp, dowShort } from '../i18n/index.js';
import { AvailabilityPage } from './AvailabilityEditor.jsx'; // the week, its history, and (for managers) anyone's
import { TeamAvailabilityList, AvailabilitySheet } from './TeamAvailability.jsx'; // everyone's week (managers): a list and the house sheet
import { MyApprovalScope } from './ApprovalScope.jsx'; // "You approve: Bar positions"
import { SmartImportButton } from './SmartImportButton.jsx';
import '../availability.css';

// Catalog keys for a request's status (web/src/i18n).
export const STATUS = { pending: 'timeOff.statusPending', approved: 'timeOff.statusApproved', denied: 'timeOff.statusDenied', cancelled: 'timeOff.statusCancelled' };
export const SOURCES = ['email', 'text', 'phone', 'in_person', 'sheet', 'other'];
const ord = (t, n) => t(`timeOffQueue.ord${n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 'N'}`, { n });

/** "Requested Nov 3, 4:12 pm" (approx.) · "Added by Moe · requested by email on Nov 3" · "1st of 3 for Sat, Dec 13". */
export function RequestedLine({ info, mine }) {
  const t = useT();
  if (!info) return null;
  const when = info.requestedAt ? stamp(info.requestedAt) : t('timeOffQueue.unknown');
  const how = info.source && info.source !== 'app' ? t(`timeOffQueue.src_${info.source}`) : '';
  return (
    <div className="tiny muted to-requested">
      {info.enteredByName ? t('timeOffQueue.addedBy', { name: info.enteredByName, how: how || t('timeOffQueue.src_other'), when })
        : t('timeOffQueue.requested', { when })}{info.approx ? ` ${t('timeOffQueue.approx')}` : ''}
      {info.place && (
        <span className={`badge ${info.place === 1 ? 'ok' : 'warn'}`} style={{ marginLeft: 6 }} title={info.others?.map((o) => `${o.place}. ${o.name} · ${o.requestedAt ? stamp(o.requestedAt) : '—'}`).join('\n')}>
          {mine ? t('timeOffQueue.yourPlace', { place: ord(t, info.place), of: info.of, date: prettyDate(info.date) }) : t('timeOffQueue.place', { place: ord(t, info.place), of: info.of, date: prettyDate(info.date) })}
        </span>
      )}
      {info.others?.length > 0 && <div>{t('timeOffQueue.others', { list: info.others.map((o) => `${ord(t, o.place)} ${o.name} (${o.requestedAt ? stamp(o.requestedAt) : '—'})`).join(', ') })}</div>}
    </div>
  );
}

export default function TimeOff({ parts = [] }) {
  const t = useT();
  const { call, version, canApprove, isMgr, people, me, today, features } = useApp();
  // Everyone's availability (Team, Sheet): managers and up; supervisors when "Edit staff availability" is on for them.
  const canTeam = isMgr || (me.role === 'supervisor' && features?.editAvailability === true);
  const [avView, setAvView] = useState(canTeam && ['team', 'sheet'].includes(parts[2]) ? parts[2] : 'person');
  const [list, setList] = useState(null);
  const [queue, setQueue] = useState({});
  const [tab, setTab] = useState(parts[1] === 'availability' ? 'availability' : canApprove ? 'pending' : 'mine');
  const [form, setForm] = useState(parts[1] === 'new' ? {} : null);
  const [standing, setStanding] = useState(false);
  // Links like #/timeoff/new (from My Shifts) open the form; the address goes back to #/timeoff after.
  useEffect(() => {
    if (parts[1] === 'new') setForm({});
    if (parts[1] === 'availability') setTab('availability');
    if (parts[1] === 'availability' && canTeam && ['team', 'sheet'].includes(parts[2])) setAvView(parts[2]);
    if (parts[1]) history.replaceState(null, '', '#/timeoff');
  }, [parts[1], parts[2]]);
  const [run, busy] = useAction();
  useEffect(() => { call('timeOff.list').then(setList); call('timeOff.queue').then(setQueue, () => setQueue({})); }, [version]);

  const tabs = [
    ...(canApprove ? [{ key: 'pending', label: t('timeOff.toApprove') }, { key: 'upcoming', label: t('timeOff.everyoneUpcoming') }] : []),
    { key: 'mine', label: t('timeOff.myRequests') },
    { key: 'availability', label: t('timeOff.myAvailability') },
  ];
  const reqAt = (x) => queue[x.id]?.requestedAt || '9';
  // To approve: only what's in my "Approves for" scope (the server marks the rest outOfScope), oldest request first.
  const rows = !list ? [] : tab === 'pending' ? list.filter((x) => x.status === 'pending' && !x.outOfScope).sort((a, b) => reqAt(a).localeCompare(reqAt(b)))
    : tab === 'upcoming' ? list.filter((x) => x.status === 'approved' && x.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate)) : list.filter((x) => x.userId === me.id);
  const pendingCount = list?.filter((x) => x.status === 'pending' && !x.outOfScope).length || 0;
  const elsewhere = list?.filter((x) => x.status === 'pending' && x.outOfScope).length || 0;

  return (
    <div style={{ maxWidth: tab === 'availability' && avView !== 'person' ? 1280 : 860, minWidth: 0 }}>
      <div className="toolbar to-toolbar">
        <div className="tabs" style={{ margin: 0, flex: 1, borderBottom: 0 }}>
          {tabs.map((x) => <button key={x.key} className={tab === x.key ? 'on' : ''} onClick={() => setTab(x.key)}>{x.label}{x.key === 'pending' && pendingCount > 0 && <span className="count">{pendingCount}</span>}</button>)}
        </div>
        {canApprove && <button className="btn" onClick={() => setForm({ forOther: true })}><Icon name="user" />{t('timeOffAdd.addForSomeone')}</button>}
        {canApprove && <button className="btn" onClick={() => setStanding(true)}><Icon name="calendar" />{t('timeOffAdd.standingButton')}</button>}
        <button className="btn primary" onClick={() => setForm({})}><Icon name="plus" />{t('timeOff.requestTimeOff')}</button>
      </div>

      {tab === 'pending' && <MyApprovalScope kind="timeOff" />}
      {tab === 'pending' && rows.length > 1 && <div className="tiny faint" style={{ marginBottom: 6 }}>{t('timeOffQueue.oldestFirst')}</div>}
      {tab === 'pending' && elsewhere > 0 && <div className="small muted" style={{ marginBottom: 8 }}>{t('approvals.elsewhere', { count: elsewhere })}</div>}
      {tab === 'availability' && (canTeam || isMgr) && (
        <div className="row wrap no-print" style={{ marginBottom: 8, gap: 8 }}>
          {canTeam && (
            <div className="seg av-views" role="tablist" aria-label={t('teamAv.viewsLabel')}>
              {[['person', 'teamAv.viewPerson'], ['team', 'teamAv.viewTeam'], ['sheet', 'teamAv.viewSheet']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={avView === k} className={avView === k ? 'on' : ''} onClick={() => setAvView(k)}>{t(label)}</button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {isMgr && <SmartImportButton target="availability" />}
        </div>
      )}
      {tab === 'availability' ? (avView === 'team' && canTeam ? <TeamAvailabilityList /> : avView === 'sheet' && canTeam ? <AvailabilitySheet /> : <AvailabilityPage />) : (
        <div className="card list">
          {!list && <div className="empty">{t('common.loading')}</div>}
          {list && !rows.length && <Empty icon="sun" title={tab === 'pending' ? t('timeOff.noRequestsWaiting') : t('timeOff.noTimeOff')} />}
          {rows.map((x) => (
            <div key={x.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <Avatar user={people[x.userId]} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <b>{people[x.userId]?.name}</b>
                <div className="small muted">{prettyDate(x.startDate)}{x.endDate !== x.startDate ? ` – ${prettyDate(x.endDate)}` : ''}{x.reason ? ` · ${x.reason === 'Imported: request off' ? tx('timeOff.importedRequestOff') : x.reason}` : ''}</div>
                <RequestedLine info={queue[x.id]} mine={x.userId === me.id && !canApprove} />
              </div>
              <span className={`badge ${x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : x.status === 'denied' ? 'bad' : ''}`}>{STATUS[x.status] ? tx(STATUS[x.status]) : x.status}</span>
              {canApprove && x.status === 'pending' && (isMgr || x.userId !== me.id) && <>
                <button className="btn sm danger" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: x.id, status: 'denied' }), tx('timeOff.denied'))}>{tx('timeOff.deny')}</button>
                <button className="btn sm ok" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: x.id, status: 'approved' }), tx('timeOff.approved'))}>{tx('timeOff.approve')}</button>
              </>}
              {x.userId === me.id && ['pending', 'approved'].includes(x.status) && x.startDate > today && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('timeOff.cancel', { id: x.id }), tx('timeOff.cancelled'))}>{tx('common.cancel')}</button>}
            </div>
          ))}
        </div>
      )}
      {form && <RequestForm forOther={!!form.forOther} userId={form.userId} onClose={() => { setForm(null); if (tab === 'availability') setTab(canApprove ? 'pending' : 'mine'); }} />}
      {standing && <StandingForm onClose={() => setStanding(false)} />}
    </div>
  );
}

const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/**
 * Your own request, or (forOther: approvers) time off for someone else: how it came in, when they asked (never the
 * future), approved or pending, whether to tell them. Their published shifts on those days are shown first; after
 * saving, each can be made an open shift (never removed silently).
 */
export function RequestForm({ onClose, forOther = false, userId: presetUser }) {
  const t = useT();
  const { call, today, employees, me } = useApp();
  const [f, setF] = useState({ startDate: addDays(today, 14), endDate: addDays(today, 14), reason: '', userId: presetUser || (forOther ? '' : me.id),
    source: 'email', requestedAt: nowLocal(), status: 'approved', notify: true });
  const [clashes, setClashes] = useState([]);
  const [saved, setSaved] = useState(null);
  const [run, busy] = useAction();
  const other = forOther && f.userId && f.userId !== me.id;
  useEffect(() => {
    if (!other) { setClashes([]); return; }
    call('timeOff.clashes', { userId: f.userId, startDate: f.startDate, endDate: f.endDate }).then(setClashes, () => setClashes([]));
  }, [other, f.userId, f.startDate, f.endDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const args = other ? { userId: f.userId, startDate: f.startDate, endDate: f.endDate, reason: f.reason, source: f.source, requestedAt: new Date(f.requestedAt).toISOString(), status: f.status, notify: f.notify }
      : { startDate: f.startDate, endDate: f.endDate, reason: f.reason };
    const r = await run(() => call('timeOff.create', args), (r) => (other ? t('timeOffAdd.added', { name: employees.find((e) => e.id === f.userId)?.name || '' })
      : r.status === 'approved' ? t('timeOff.timeOffRecorded') : `${t('timeOff.requestSent')}${r.clashes ? t('timeOff.clashesNote', { count: r.clashes }) : ''}`));
    if (!r) return;
    if (other && r.clashShifts?.length) setSaved(r); else onClose();
  };
  const openShift = (s) => run(async () => {
    const cur = (await call('shifts.list', { start: s.date, end: s.date })).shifts.find((x) => x.id === s.id);
    if (cur) await call('shifts.save', { ...cur, userId: '' });
    setSaved({ ...saved, clashShifts: saved.clashShifts.filter((x) => x.id !== s.id) });
  }, t('timeOffAdd.madeOpen'));
  if (saved) {
    return (
      <Modal title={t('timeOffAdd.shiftsTitle')} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>{t('common.done')}</button>}>
        <div className="alert warn"><Icon name="alert" size={16} /><div>{t('timeOffAdd.shiftsHelp')}</div></div>
        {saved.clashShifts.map((s) => (
          <div key={s.id} className="row wrap" style={{ gap: 8 }}>
            <span style={{ flex: 1 }}>{prettyDate(s.date)} · {s.start}{s.area ? ` · ${s.area}` : ''}</span>
            <button className="btn sm" disabled={busy} onClick={() => openShift(s)}><Icon name="hand" />{t('timeOffAdd.makeOpen')}</button>
          </div>
        ))}
        {!saved.clashShifts.length && <div className="small muted">{t('timeOffAdd.allCovered')}</div>}
      </Modal>
    );
  }
  return (
    <Modal title={forOther ? t('timeOffAdd.title') : t('timeOff.requestTimeOff')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || (forOther && !f.userId)} onClick={save}>{forOther ? t('timeOffAdd.add') : t('timeOff.submit')}</button></>}>
      {forOther && (
        <Field label={t('timeOff.for')}>
          <select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
            <option value="">{t('timeOffAdd.pickPerson')}</option>
            {employees.filter((e) => e.active !== false && e.id !== me.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
      )}
      <div className="grid2">
        <Field label={t('timeOff.from')}><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></Field>
        <Field label={t('timeOff.to')}><input className="input" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
      </div>
      <Field label={t('timeOff.reasonOptional')}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {other && <>
        <div className="grid2">
          <Field label={t('timeOffAdd.cameIn')}>
            <select className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{t(`timeOffQueue.src_${s}`)}</option>)}</select>
          </Field>
          <Field label={t('timeOffAdd.requestedOn')} help={t('timeOffAdd.requestedOnHelp')}>
            <input className="input" type="datetime-local" value={f.requestedAt} max={nowLocal()} onChange={(e) => setF({ ...f, requestedAt: e.target.value })} />
          </Field>
        </div>
        <div className="seg" role="radiogroup" aria-label={t('timeOffAdd.status')}>
          {['approved', 'pending'].map((s) => <button key={s} type="button" role="radio" aria-checked={f.status === s} className={f.status === s ? 'on' : ''} onClick={() => setF({ ...f, status: s })}>{tx(STATUS[s])}</button>)}
        </div>
        <label className="check small"><input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />{t('timeOffAdd.notify')}</label>
        {clashes.length > 0 && (
          <div className="alert warn"><Icon name="alert" size={16} /><div>
            <b>{t('timeOffAdd.clashTitle', { count: clashes.length })}</b>
            <div className="small">{clashes.map((s) => s.text).join(' · ')}</div>
            <div className="tiny">{t('timeOffAdd.clashHelp')}</div>
          </div></div>
        )}
      </>}
    </Modal>
  );
}

/** Team → a person: "Add time off" (a request that came in by email, a call…). */
export function AddTimeOffButton({ person }) {
  const t = useT();
  const { canApprove } = useApp();
  const [open, setOpen] = useState(false);
  if (!canApprove) return null;
  return (
    <div className="row">
      <button type="button" className="btn sm" onClick={() => setOpen(true)}><Icon name="sun" />{t('timeOffAdd.addFor', { name: person.name })}</button>
      {open && createPortal(<RequestForm forOther userId={person.id} onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}

/** Standing requests off for several people at once (initial setup): "Alex: every Sunday". */
function StandingForm({ onClose }) {
  const t = useT();
  const { call, employees, me, settings } = useApp();
  const blankRow = () => ({ userId: '', days: [], reason: '', requestedAt: new Date().toISOString().slice(0, 10), source: 'in_person' });
  const [rows, setRows] = useState([blankRow()]);
  const [notify, setNotify] = useState(true);
  const [run, busy] = useAction();
  const order = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => (i + (settings.weekStartDow ?? 1)) % 7), [settings.weekStartDow]);
  const set = (i, patch) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const ready = rows.filter((r) => r.userId && r.days.length);
  const save = async () => {
    const r = await run(() => call('timeOff.addStanding', { rows: ready, notify }), (out) => t('timeOffAdd.standingSaved', { count: out.added }));
    if (r) onClose();
  };
  return (
    <Modal wide title={t('timeOffAdd.standingTitle')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !ready.length} onClick={save}><Icon name="check" />{t('timeOffAdd.standingSave', { count: ready.length })}</button></>}>
      <div className="help">{t('timeOffAdd.standingHelp')}</div>
      {rows.map((r, i) => (
        <div key={i} className="card card-pad col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="input" value={r.userId} onChange={(e) => set(i, { userId: e.target.value })} style={{ flex: '1 1 200px' }} aria-label={t('timeOff.for')}>
              <option value="">{t('timeOffAdd.pickPerson')}</option>
              {employees.filter((e) => e.active !== false && e.id !== me.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {rows.length > 1 && <button type="button" className="btn ghost icon sm danger" onClick={() => setRows(rows.filter((_, k) => k !== i))} aria-label={t('common.remove')}><Icon name="trash" /></button>}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {order.map((d) => <button key={d} type="button" className={`chip ${r.days.includes(d) ? 'on' : ''}`} aria-pressed={r.days.includes(d)}
              onClick={() => set(i, { days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d] })}>{dowShort(d)}</button>)}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input sm" value={r.reason} placeholder={t('timeOff.reasonOptional')} onChange={(e) => set(i, { reason: e.target.value })} style={{ flex: '1 1 180px' }} />
            <label className="row small" style={{ gap: 6 }}>{t('timeOffAdd.requestedOn')}<input className="input sm" type="date" value={r.requestedAt} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set(i, { requestedAt: e.target.value })} /></label>
          </div>
        </div>
      ))}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => setRows([...rows, blankRow()])}><Icon name="plus" />{t('timeOffAdd.anotherPerson')}</button>
        <span className="spacer" />
        <label className="check small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{t('timeOffAdd.notifyThem')}</label>
      </div>
    </Modal>
  );
}
