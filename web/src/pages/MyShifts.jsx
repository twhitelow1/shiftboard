import React, { useEffect, useState } from 'react';
import { useApp, Icon, shiftTime, JobDot, Empty, useAction } from '../ui.jsx';
import { addDays, weekStart, parseDate, MONTHS, DOW_SHORT, dow, prettyDate, fmtTime } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import { icalLink, IS_DEMO } from '../api.js';
import ShiftDialog from './ShiftDialog.jsx';

export default function MyShifts() {
  const { call, version, today, me, jobs, settings } = useApp();
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [ical, setIcal] = useState(null);
  const end = addDays(today, 35);

  const load = () => call('shifts.list', { start: addDays(today, -1), end }).then(setData);
  useEffect(() => { load(); }, [version]);

  if (!data) return <div className="empty">Loading…</div>;
  const mine = data.shifts.filter((s) => s.userId === me.id && s.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const myJobs = new Set((me.jobCodes || []).map((j) => j.jobCodeId));
  const open = data.shifts.filter((s) => !s.userId && s.date >= today && myJobs.has(s.jobCodeId)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const myTimeOff = data.timeOff.filter((t) => t.userId === me.id && t.endDate >= today);

  const weeks = {};
  for (const s of mine) (weeks[weekStart(s.date, settings.weekStartDow)] ||= []).push(s);
  const thisWeek = weekStart(today, settings.weekStartDow);
  const nextShift = mine[0];

  return (
    <div style={{ maxWidth: 820 }}>
      {nextShift && (
        <div className="card card-pad section" style={{ background: 'linear-gradient(135deg, var(--brand), #0891b2)', color: '#fff', border: 0 }}>
          <div className="small" style={{ opacity: .85, fontWeight: 600 }}>{nextShift.date === today ? 'Today' : 'Next shift'}</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{prettyDate(nextShift.date)} · {shiftTime(nextShift)}</div>
          <div style={{ opacity: .9 }}>{jobs[nextShift.jobCodeId]?.name}{nextShift.tag ? ` · ${nextShift.tag}` : ''}{nextShift.eventId ? ' · Event shift' : ''}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} onClick={() => setDialog(nextShift)}>Details & swap</button>
            {nextShift.eventId && <a className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} href={`#/events/${nextShift.eventId}`}>View BEO</a>}
          </div>
        </div>
      )}

      {open.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>Open shifts you can pick up</h2><span className="badge ok">{open.length}</span></div>
          <div className="card list">
            {open.slice(0, 8).map((s) => <ShiftRow key={s.id} s={s} onClick={() => setDialog(s)} right={<span className="badge ok">Pick up</span>} />)}
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title"><h2>My upcoming shifts</h2></div>
        {!mine.length && <div className="card"><Empty title="No upcoming shifts">Once your manager publishes the schedule, your shifts show up here.</Empty></div>}
        {Object.entries(weeks).map(([w, list]) => {
          const hrs = list.reduce((t, s) => t + hoursOf(s, settings), 0);
          return (
            <div key={w} style={{ marginBottom: 14 }}>
              <div className="row small muted" style={{ margin: '0 2px 6px', fontWeight: 700 }}>
                <span>{w === thisWeek ? 'This week' : w === addDays(thisWeek, 7) ? 'Next week' : `Week of ${prettyDate(w, { dow: false })}`}</span>
                <span className="spacer" /><span className="num">{list.length} shifts · ~{hrs.toFixed(1)} hrs</span>
              </div>
              <div className="card list">
                {list.map((s) => <ShiftRow key={s.id} s={s} onClick={() => setDialog(s)} right={s.pending ? <span className="badge warn">Swap pending</span> : null} />)}
              </div>
            </div>
          );
        })}
      </div>

      {myTimeOff.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>My time off</h2><a className="btn sm ghost" href="#/timeoff">Manage</a></div>
          <div className="card list">
            {myTimeOff.map((t) => (
              <div key={t.id} className="list-item"><Icon name="sun" size={18} /><div style={{ flex: 1 }}>{prettyDate(t.startDate)}{t.endDate !== t.startDate ? ` – ${prettyDate(t.endDate)}` : ''}</div><span className={`badge ${t.status === 'approved' ? 'ok' : 'warn'}`}>{t.status}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="card card-pad section">
        <h3>Sync to your phone calendar</h3>
        <p className="small muted" style={{ margin: '4px 0 10px' }}>Subscribe once and your shifts appear in Google Calendar or Apple Calendar automatically, including trades.</p>
        {IS_DEMO ? <span className="help">Available in the hosted app.</span> : ical
          ? <div className="row"><input className="input sm" readOnly value={ical} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={() => navigator.clipboard?.writeText(ical)}><Icon name="copy" /></button></div>
          : <button className="btn sm" onClick={async () => setIcal(await icalLink())}><Icon name="link" />Get calendar link</button>}
      </div>

      {!IS_DEMO && <PasswordCard />}

      {dialog && <ShiftDialog shift={dialog} events={data.events} onClose={(c) => { setDialog(null); if (c) load(); }} />}
    </div>
  );
}

function ShiftRow({ s, onClick, right }) {
  const { jobs } = useApp();
  const d = parseDate(s.date);
  const j = jobs[s.jobCodeId];
  return (
    <div className="scard" onClick={onClick}>
      <div className="date"><div className="m">{DOW_SHORT[d.getUTCDay()]}</div><div className="d">{d.getUTCDate()}</div></div>
      <div className="body">
        <div className="title num">{shiftTime(s)}{!s.end && <span className="faint small" style={{ fontWeight: 500 }}> until close</span>}</div>
        <div className="small muted row" style={{ gap: 6 }}><JobDot job={j} />{j?.name}{s.tag ? ` · ${s.tag}` : ''}{s.eventId ? ' · Event' : ''}</div>
      </div>
      {right}
      <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />
    </div>
  );
}

function PasswordCard() {
  const { call } = useApp();
  const [pw, setPw] = useState('');
  const [run, busy] = useAction();
  return (
    <div className="card card-pad section">
      <h3>Change my password</h3>
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input" type="password" placeholder="New password (6+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" style={{ maxWidth: 300 }} />
        <button className="btn" disabled={busy || pw.length < 6} onClick={() => run(() => call('employees.changePassword', { password: pw }), 'Password changed').then(() => setPw(''))}>Save</button>
      </div>
    </div>
  );
}
