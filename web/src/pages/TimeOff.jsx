import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, Field, Empty, useAction, Modal } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { tx, useT, dowLong, fmtTime, prettyDate } from '../i18n/index.js';

export default function TimeOff({ parts = [] }) {
  const t = useT();
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
    ...(canApprove ? [{ key: 'pending', label: t('timeOff.toApprove') }, { key: 'upcoming', label: t('timeOff.everyoneUpcoming') }] : []),
    { key: 'mine', label: t('timeOff.myRequests') },
    { key: 'availability', label: t('timeOff.myAvailability') },
  ];
  const rows = !list ? [] : tab === 'pending' ? list.filter((t) => t.status === 'pending') : tab === 'upcoming' ? list.filter((t) => t.status === 'approved' && t.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate)) : list.filter((t) => t.userId === me.id);
  const pendingCount = list?.filter((t) => t.status === 'pending').length || 0;

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="toolbar to-toolbar">
        <div className="tabs" style={{ margin: 0, flex: 1, borderBottom: 0 }}>
          {tabs.map((t) => <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}{t.key === 'pending' && pendingCount > 0 && <span className="count">{pendingCount}</span>}</button>)}
        </div>
        <button className="btn primary" onClick={() => setForm(true)}><Icon name="plus" />{t('timeOff.requestTimeOff')}</button>
      </div>

      {tab === 'availability' ? <Availability /> : (
        <div className="card list">
          {!list && <div className="empty">{t('common.loading')}</div>}
          {list && !rows.length && <Empty icon="sun" title={tab === 'pending' ? t('timeOff.noRequestsWaiting') : t('timeOff.noTimeOff')} />}
          {rows.map((t) => (
            <div key={t.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <Avatar user={people[t.userId]} />
              <div style={{ flex: 1, minWidth: 160 }}>
                <b>{people[t.userId]?.name}</b>
                <div className="small muted">{prettyDate(t.startDate)}{t.endDate !== t.startDate ? ` – ${prettyDate(t.endDate)}` : ''}{t.reason ? ` · ${t.reason === 'Imported: request off' ? tx('timeOff.importedRequestOff') : t.reason}` : ''}</div>
              </div>
              <span className={`badge ${t.status === 'approved' ? 'ok' : t.status === 'pending' ? 'warn' : t.status === 'denied' ? 'bad' : ''}`}>{t.status}</span>
              {canApprove && t.status === 'pending' && (isMgr || t.userId !== me.id) && <>
                <button className="btn sm danger" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: t.id, status: 'denied' }), tx('timeOff.denied'))}>{tx('timeOff.deny')}</button>
                <button className="btn sm ok" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: t.id, status: 'approved' }), tx('timeOff.approved'))}>{tx('timeOff.approve')}</button>
              </>}
              {t.userId === me.id && ['pending', 'approved'].includes(t.status) && t.startDate > today && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('timeOff.cancel', { id: t.id }), tx('timeOff.cancelled'))}>{tx('common.cancel')}</button>}
            </div>
          ))}
        </div>
      )}
      {form && <RequestForm onClose={() => { setForm(false); if (tab === 'availability') setTab(canApprove ? 'pending' : 'mine'); }} />}
    </div>
  );
}

function RequestForm({ onClose }) {
  const t = useT();
  const { call, today, isMgr, employees, me } = useApp();
  const [f, setF] = useState({ startDate: addDays(today, 14), endDate: addDays(today, 14), reason: '', userId: me.id });
  const [run, busy] = useAction();
  const save = async () => {
    const r = await run(() => call('timeOff.create', f), (r) => (r.status === 'approved' ? t('timeOff.timeOffRecorded') : `${t('timeOff.requestSent')}${r.clashes ? t('timeOff.clashesNote', { count: r.clashes }) : ''}`));
    if (r) onClose();
  };
  return (
    <Modal title={t('timeOff.requestTimeOff')} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy} onClick={save}>{t('timeOff.submit')}</button></>}>
      {isMgr && (
        <Field label={t('timeOff.for')} help={t('timeOff.timeOffYouEnterFor')}>
          <select className="input" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>{employees.filter((e) => e.active !== false).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        </Field>
      )}
      <div className="grid2">
        <Field label={t('timeOff.from')}><input className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} /></Field>
        <Field label={t('timeOff.to')}><input className="input" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
      </div>
      <Field label={t('timeOff.reasonOptional')}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
    </Modal>
  );
}

function Availability() {
  const t = useT();
  const { me, call, settings } = useApp();
  const [av, setAv] = useState(() => ({ ...(me.availability || {}) }));
  const [run, busy] = useAction();
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + settings.weekStartDow) % 7);
  const set = (d, patch) => setAv({ ...av, [d]: { ...(av[d] || { available: true }), ...patch } });
  return (
    <div className="card">
      <div className="card-pad small muted">{t('timeOff.letManagersKnowWhenYou')}</div>
      <div className="list">
        {order.map((d) => {
          const a = av[d] || { available: true };
          return (
            <div key={d} className="list-item" style={{ flexWrap: 'wrap' }}>
              <div style={{ width: 96, fontWeight: 700 }}>{dowLong(d)}</div>
              <div className="seg">
                <button className={a.available !== false && !a.from && !a.to ? 'on' : ''} onClick={() => set(d, { available: true, from: '', to: '' })}>{t('timeOff.anyTime')}</button>
                <button className={a.available !== false && (a.from || a.to) ? 'on' : ''} onClick={() => set(d, { available: true, from: a.from || '16:00', to: a.to || '' })}>{t('timeOff.someHours')}</button>
                <button className={a.available === false ? 'on' : ''} onClick={() => set(d, { available: false })}>{t('timeOff.unavailable')}</button>
              </div>
              {a.available !== false && (a.from || a.to) && (
                <div className="row">
                  <input className="input sm" type="time" value={a.from || ''} onChange={(e) => set(d, { from: e.target.value })} style={{ width: 120 }} />
                  <span className="faint">{t('timeOff.to2')}</span>
                  <input className="input sm" type="time" value={a.to || ''} onChange={(e) => set(d, { to: e.target.value })} style={{ width: 120 }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="card-pad row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={() => run(() => call('employees.setAvailability', { availability: av }), t('timeOff.availabilitySaved'))}>{t('timeOff.saveAvailability')}</button></div>
    </div>
  );
}
