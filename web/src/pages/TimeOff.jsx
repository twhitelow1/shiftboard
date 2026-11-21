import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, Field, Empty, useAction, Modal } from '../ui.jsx';
import { prettyDate, addDays, DOW_LONG, fmtTime } from '../../../core/time.js';

export default function TimeOff({ parts = [] }) {
  const { call, version, canApprove, isMgr, people, me, today } = useApp();
  const [list, setList] = useState(null);
  const [tab, setTab] = useState(parts[1] === 'availability' ? 'availability' : canApprove ? 'pending' : 'mine');
  const [form, setForm] = useState(parts[1] === 'new');
  // Links like #/timeoff/new (from My Shifts) open the form; the address goes back to #/timeoff after.
  useEffect(() => {
    if (parts[1] === 'new') setForm(true);
    if (parts[1] === 'availability') setTab('availability');
    if (parts[1]) history.replaceState(null, '', '#/timeoff');
  }, [parts[1]]);
  const [run, busy] = useAction();
  useEffect(() => { call('timeOff.list').then(setList); }, [version]);

  const tabs = [
    ...(canApprove ? [{ key: 'pending', label: 'To approve' }, { key: 'upcoming', label: 'Everyone upcoming' }] : []),
    { key: 'mine', label: 'My requests' },
    { key: 'availability', label: 'My availability' },
  ];
  const rows = !list ? [] : tab === 'pending' ? list.filter((t) => t.status === 'pending') : tab === 'upcoming' ? list.filter((t) => t.status === 'approved' && t.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate)) : list.filter((t) => t.userId === me.id);
  const pendingCount = list?.filter((t) => t.status === 'pending').length || 0;

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="toolbar to-toolbar">
        <div className="tabs" style={{ margin: 0, flex: 1, borderBottom: 0 }}>
          {tabs.map((t) => <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}{t.key === 'pending' && pendingCount > 0 && <span className="count">{pendingCount}</span>}</button>)}
        </div>
        <button className="btn primary" onClick={() => setForm(true)}><Icon name="plus" />Request time off</button>
      </div>

      {tab === 'availability' ? <Availability /> : (
        <div className="card list">
          {!list && <div className="empty">Loading…</div>}
          {list && !rows.length && <Empty icon="sun" title={tab === 'pending' ? 'No requests waiting' : 'No time off'} />}
          {rows.map((t) => (
            <div key={t.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <Avatar user={people[t.userId]} />
              <div style={{ flex: 1, minWidth: 160 }}>
                <b>{people[t.userId]?.name}</b>
                <div className="small muted">{prettyDate(t.startDate)}{t.endDate !== t.startDate ? ` – ${prettyDate(t.endDate)}` : ''}{t.reason ? ` · ${t.reason}` : ''}</div>
              </div>
              <span className={`badge ${t.status === 'approved' ? 'ok' : t.status === 'pending' ? 'warn' : t.status === 'denied' ? 'bad' : ''}`}>{t.status}</span>
              {canApprove && t.status === 'pending' && (isMgr || t.userId !== me.id) && <>
                <button className="btn sm danger" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: t.id, status: 'denied' }), 'Denied')}>Deny</button>
                <button className="btn sm ok" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: t.id, status: 'approved' }), 'Approved')}>Approve</button>
              </>}
              {t.userId === me.id && ['pending', 'approved'].includes(t.status) && t.startDate > today && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('timeOff.cancel', { id: t.id }), 'Cancelled')}>Cancel</button>}
            </div>
          ))}
        </div>
      )}
      {form && <RequestForm onClose={() => { setForm(false); if (tab === 'availability') setTab(canApprove ? 'pending' : 'mine'); }} />}
    </div>
  );
}

function RequestForm({ onClose }) {
  const { call, today, isMgr, employees, me } = useApp();
  const [f, setF] = useState({ startDate: addDays(today, 14), endDate: addDays(today, 14), reason: '', userId: me.id });
  const [run, busy] = useAction();
  const save = async () => {
    const r = await run(() => call('timeOff.create', f), (r) => (r.status === 'approved' ? 'Time off recorded' : `Request sent to managers${r.clashes ? ` — note: you have ${r.clashes} shift(s) then` : ''}`));
    if (r) onClose();
  };
  return (
    <Modal title="Request time off" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Submit</button></>}>
      {isMgr && (
        <Field label="For" help="Time off you enter for someone else is approved automatically.">
          <select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{employees.filter((e) => e.active !== false).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        </Field>
      )}
      <div className="grid2">
        <Field label="From"><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></Field>
        <Field label="To"><input className="input" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
      </div>
      <Field label="Reason (optional)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
    </Modal>
  );
}

function Availability() {
  const { me, call, settings } = useApp();
  const [av, setAv] = useState(() => ({ ...(me.availability || {}) }));
  const [run, busy] = useAction();
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + settings.weekStartDow) % 7);
  const set = (d, patch) => setAv({ ...av, [d]: { ...(av[d] || { available: true }), ...patch } });
  return (
    <div className="card">
      <div className="card-pad small muted">Let managers know when you can work. The schedule flags any shift outside your availability.</div>
      <div className="list">
        {order.map((d) => {
          const a = av[d] || { available: true };
          return (
            <div key={d} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div style={{ width: 110, fontWeight: 700 }}>{DOW_LONG[d]}</div>
              <div className="seg">
                <button className={a.available !== false && !a.from && !a.to ? 'on' : ''} onClick={() => set(d, { available: true, from: '', to: '' })}>Any time</button>
                <button className={a.available !== false && (a.from || a.to) ? 'on' : ''} onClick={() => set(d, { available: true, from: a.from || '16:00', to: a.to || '' })}>Some hours</button>
                <button className={a.available === false ? 'on' : ''} onClick={() => set(d, { available: false })}>Unavailable</button>
              </div>
              {a.available !== false && (a.from || a.to) && (
                <div className="row">
                  <input className="input sm" type="time" value={a.from || ''} onChange={(e) => set(d, { from: e.target.value })} style={{ width: 120 }} />
                  <span className="faint">to</span>
                  <input className="input sm" type="time" value={a.to || ''} onChange={(e) => set(d, { to: e.target.value })} style={{ width: 120 }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="card-pad row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={() => run(() => call('employees.setAvailability', { availability: av }), 'Availability saved')}>Save availability</button></div>
    </div>
  );
}
