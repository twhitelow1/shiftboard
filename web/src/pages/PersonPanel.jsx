// A person's panel, opened by clicking their name on the schedule (managers): Overview (positions and rooms, primary
// room, contact, this week's shifts, a link to the full Team profile), Availability (the week editor with standing
// requests off, notes and history: AvailabilityEditor.jsx) and Requests off (their time off with status and when it was
// requested; approve or deny pending ones when this manager may; add time off for them with the manager flow,
// TimeOff.jsx's RequestForm). Every save goes through useAction, which refreshes the schedule behind it.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Icon, Avatar, Empty, useAction } from '../ui.jsx';
import { useT, tx, prettyDate, fmtTime, stamp } from '../i18n/index.js';
import { AvailabilityWeek, AvailabilityHistory } from './AvailabilityEditor.jsx';
import { RequestForm, STATUS } from './TimeOff.jsx';
import '../conflicts.css';
import '../availability.css';

export default function PersonPanel({ userId, weekShifts = [], onClose }) {
  const t = useT();
  const { people } = useApp();
  const [tab, setTab] = useState('availability');
  const person = people?.[userId];
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!person) return null;
  return createPortal(
    <>
      <div className="pp-back" onMouseDown={onClose} />
      <aside className="drawer pp" role="dialog" aria-modal="true" aria-label={person.name}>
        <div className="pp-head">
          <Avatar user={person} />
          <h2 style={{ flex: 1, minWidth: 0 }}>{person.name}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label={t('common.close')}><Icon name="x" /></button>
        </div>
        <div className="tabs pp-tabs" role="tablist">
          {[['overview', 'personPanel.tabOverview'], ['availability', 'personPanel.tabAvailability'], ['requests', 'personPanel.tabRequests']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(label)}</button>
          ))}
        </div>
        <div className="pp-body">
          {tab === 'overview' && <Overview person={person} weekShifts={weekShifts.filter((s) => s.userId === userId)} onClose={onClose} />}
          {tab === 'availability' && <AvailabilityTab userId={userId} />}
          {tab === 'requests' && <Requests person={person} />}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function Overview({ person, weekShifts, onClose }) {
  const t = useT();
  const { jobs } = useApp();
  const entries = person.jobCodes || [];
  const sorted = [...weekShifts].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return (
    <>
      <div className="card card-pad col" style={{ gap: 6 }}>
        <b>{t('personPanel.positions')}</b>
        {entries.length ? entries.map((e) => (
          <div key={e.jobCodeId} className="small">
            {jobs?.[e.jobCodeId]?.name || e.jobCodeId}{e.primary ? ` · ${t('personPanel.primary')}` : ''}{e.areas?.length ? ` · ${e.areas.join(', ')}` : ''}
            {e.primaryRoom && <div className="tiny muted">{t('personPanel.primaryRoom', { room: e.primaryRoom })}</div>}
          </div>
        )) : <div className="small muted">—</div>}
      </div>
      <div className="card card-pad col" style={{ gap: 4 }}>
        <b>{t('personPanel.contact')}</b>
        {person.phone && <a className="small" href={`tel:${person.phone}`}>{person.phone}</a>}
        {person.email && <a className="small" href={`mailto:${person.email}`}>{person.email}</a>}
        {!person.phone && !person.email && <div className="small muted">{t('personPanel.noContact')}</div>}
      </div>
      <div className="card card-pad col" style={{ gap: 6 }}>
        <b>{t('personPanel.thisWeek')}</b>
        {sorted.length ? <div className="pp-shifts">{sorted.map((s) => (
          <div key={s.id} className="small">{prettyDate(s.date)} · {fmtTime(s.start)}{s.end ? `–${fmtTime(s.end)}` : ''} · {jobs?.[s.jobCodeId]?.name || ''}{s.area ? ` · ${s.area}` : ''}{!s.published ? ` (${t('personPanel.draft')})` : ''}</div>
        ))}</div> : <div className="small muted">{t('personPanel.noShifts')}</div>}
      </div>
      <a className="btn" href={`#/team/${person.id}`} onClick={onClose}><Icon name="user" />{t('personPanel.fullProfile')}</a>
    </>
  );
}

function AvailabilityTab({ userId }) {
  const t = useT();
  const [sub, setSub] = useState('week');
  return (
    <>
      <div className="tabs" style={{ margin: 0 }}>
        <button className={sub === 'week' ? 'on' : ''} onClick={() => setSub('week')}>{t('personPanel.week')}</button>
        <button className={sub === 'history' ? 'on' : ''} onClick={() => setSub('history')}><Icon name="clock" size={14} />{t('personPanel.history')}</button>
      </div>
      {sub === 'week' ? <AvailabilityWeek userId={userId} /> : <AvailabilityHistory userId={userId} />}
    </>
  );
}

function Requests({ person }) {
  const t = useT();
  const { call, version, canApprove, isMgr, me } = useApp();
  const [list, setList] = useState(null);
  const [queue, setQueue] = useState({});
  const [adding, setAdding] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => {
    call('timeOff.list').then((all) => setList(all.filter((x) => x.userId === person.id).sort((a, b) => b.startDate.localeCompare(a.startDate))), () => setList([]));
    call('timeOff.queue').then(setQueue, () => setQueue({}));
  }, [person.id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const mayDecide = (x) => canApprove && x.status === 'pending' && !x.outOfScope && (isMgr || x.userId !== me.id);
  return (
    <>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="small muted" style={{ flex: '1 1 200px' }}>{t('personPanel.standingNote')}</div>
        {canApprove && person.id !== me.id && <button className="btn sm" onClick={() => setAdding(true)}><Icon name="sun" />{t('personPanel.addTimeOff')}</button>}
      </div>
      <div className="card list">
        {!list && <div className="empty">{t('common.loading')}</div>}
        {list && !list.length && <Empty icon="sun" title={t('personPanel.noRequests')} />}
        {(list || []).map((x) => {
          const asked = queue[x.id]?.requestedAt || x.requestedAt;
          return (
            <div key={x.id} className="list-item pp-req">
              <div className="grow">
                <b className="small">{prettyDate(x.startDate)}{x.endDate !== x.startDate ? ` – ${prettyDate(x.endDate)}` : ''}</b>
                {x.reason && <span className="small muted"> · {x.reason}</span>}
                {asked && <div className="tiny muted">{t('personPanel.requestedOn', { date: stamp(asked) })}</div>}
                {x.status === 'pending' && x.outOfScope && <div className="tiny muted">{t('personPanel.outOfScope')}</div>}
              </div>
              <span className={`badge ${x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : x.status === 'denied' ? 'bad' : ''}`}>{STATUS[x.status] ? tx(STATUS[x.status]) : x.status}</span>
              {mayDecide(x) && <>
                <button className="btn sm danger" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: x.id, status: 'denied' }), tx('timeOff.denied'))}>{tx('timeOff.deny')}</button>
                <button className="btn sm ok" disabled={busy} onClick={() => run(() => call('timeOff.decide', { id: x.id, status: 'approved' }), tx('timeOff.approved'))}>{tx('timeOff.approve')}</button>
              </>}
            </div>
          );
        })}
      </div>
      {adding && createPortal(<RequestForm forOther userId={person.id} onClose={() => setAdding(false)} />, document.body)}
    </>
  );
}
