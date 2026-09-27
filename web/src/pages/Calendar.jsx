import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, shiftTime, JobDot, Empty } from '../ui.jsx';
import { addDays, weekStart, range, dow, parseDate, fmtDate, MONTHS, DOW_SHORT, toMin, prettyDate, fmtTime } from '../../../core/time.js';
import { effectiveShift } from '../../../core/forecast.js';
import ShiftDialog from './ShiftDialog.jsx';

export default function CalendarPage() {
  const { call, version, today, settings, me, jobs, people, jobCodes, isMgr } = useApp();
  const [month, setMonth] = useState(() => { const d = parseDate(addDays(today, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; });
  const [sel, setSel] = useState(() => addDays(today, 1));
  const [scope, setScope] = useState(isMgr ? 'all' : 'mine');
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);

  const first = `${month}-01`;
  const gridStart = weekStart(first, settings.weekStartDow);
  const days = range(gridStart, 42);
  const inMonth = (d) => d.slice(0, 7) === month;

  const load = () => call('shifts.list', { start: gridStart, end: days[41] }).then(setData);
  useEffect(() => { load(); }, [month, version]);

  const shiftMonth = (n) => {
    const d = parseDate(first);
    d.setUTCMonth(d.getUTCMonth() + n);
    const m = fmtDate(d).slice(0, 7);
    setMonth(m);
    setSel(`${m}-01`);
  };

  const shifts = (data?.shifts || []).filter((s) => scope === 'all' || s.userId === me.id);
  const byDay = useMemo(() => {
    const m = {};
    for (const s of shifts) (m[s.date] ||= []).push(s);
    return m;
  }, [data, scope]);

  const [y, mo] = month.split('-').map(Number);
  const heads = range(gridStart, 7).map((d) => DOW_SHORT[dow(d)]);

  return (
    <div>
      <div className="toolbar">
        <div className="weeknav">
          <button className="btn icon sm" onClick={() => shiftMonth(-1)}><Icon name="left" /></button>
          <div className="label">{MONTHS[mo - 1]} {y}</div>
          <button className="btn icon sm" onClick={() => shiftMonth(1)}><Icon name="right" /></button>
        </div>
        <span className="spacer" />
        <div className="seg">
          <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>My shifts</button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Everyone</button>
        </div>
      </div>

      <div className="month card" style={{ marginBottom: 16 }}>
        {heads.map((h) => <div key={h} className="mh">{h}</div>)}
        {days.map((d) => {
          const list = byDay[d] || [];
          const evs = (data?.events || []).filter((e) => e.date === d);
          const closed = settings.closedDays.includes(dow(d));
          return (
            <div key={d} className={`md ${inMonth(d) ? '' : 'other'} ${d === today ? 'today' : ''} ${d === sel ? 'sel' : ''}`} onClick={() => setSel(d)}>
              <div className="n">{parseDate(d).getUTCDate()}</div>
              {evs.slice(0, 2).map((e) => <div key={e.id} className="ev" title={e.name}>{e.name}</div>)}
              {scope === 'mine'
                ? list.map((s) => <div key={s.id} className="ms" style={{ '--jc': jobs[s.jobCodeId]?.color }}>{fmtTime(s.start)} {jobs[s.jobCodeId]?.short}</div>)
                : list.length > 0 && <div className="cnt">{list.filter((s) => s.userId).length} on{list.some((s) => !s.userId) ? ` · ${list.filter((s) => !s.userId).length} open` : ''}</div>}
              {closed && !list.length && inMonth(d) && <div className="cnt faint">Closed</div>}
            </div>
          );
        })}
      </div>

      <DayTimeline date={sel} shifts={(data?.shifts || []).filter((s) => s.date === sel && (scope === 'all' || s.userId === me.id))} events={(data?.events || []).filter((e) => e.date === sel)} onOpen={(s) => setDialog(s)} />
      {dialog && <ShiftDialog shift={dialog} events={data?.events || []} warnings={data?.warnings?.[dialog.id]} onClose={(c) => { setDialog(null); if (c) load(); }} />}
    </div>
  );
}

export function DayTimeline({ date, shifts, events, onOpen }) {
  const { jobs, people, jobCodes, settings, me } = useApp();
  const START = 9 * 60, END = 26 * 60; // 9am → 2am
  const span = END - START;
  const hours = [];
  for (let m = START; m < END; m += 60) hours.push(m);
  const pos = (m) => `${Math.max(0, Math.min(100, ((m - START) / span) * 100))}%`;
  const groups = jobCodes.map((j) => ({ job: j, items: shifts.filter((s) => s.jobCodeId === j.id).sort((a, b) => a.start.localeCompare(b.start)) })).filter((g) => g.items.length);

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ flex: 1 }}>{prettyDate(date)}</h2>
        <span className="small muted">{shifts.filter((s) => s.userId).length} scheduled</span>
      </div>
      {events.length > 0 && (
        <div className="card-pad row wrap" style={{ paddingBottom: 0 }}>
          {events.map((e) => <a key={e.id} className="badge warn" href={`#/events/${e.id}`}><Icon name="glass" size={12} />{fmtTime(e.start)} {e.name} · {e.guestCount}</a>)}
        </div>
      )}
      {!groups.length ? <Empty title="No shifts this day" /> : (
        <div className="timeline" style={{ padding: '10px 0' }}>
          <div className="tl-inner">
            <div className="tl-hours" style={{ gridTemplateColumns: `repeat(${hours.length}, 1fr)` }}>
              {hours.map((h) => <div key={h}>{fmtTime(`${String(Math.floor(h / 60) % 24).padStart(2, '0')}:00`)}</div>)}
            </div>
            {groups.map((g) => (
              <React.Fragment key={g.job.id}>
                <div className="tl-group row"><JobDot job={g.job} />{g.job.name}</div>
                {g.items.map((s) => {
                  const e = effectiveShift(s, settings);
                  const a = toMin(e.start);
                  let b = toMin(e.end); if (b <= a) b += 1440;
                  return (
                    <div key={s.id} className="tl-row">
                      <div className="tl-name" style={{ color: s.userId === me.id ? 'var(--brand)' : undefined }}>{s.userId ? people[s.userId]?.name : <span className="faint">Open</span>}</div>
                      <div className="tl-track">
                        <div className={`tl-bar ${s.end ? '' : 'est'}`} style={{ '--jc': g.job.color, left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }} onClick={() => onOpen(s)} title={shiftTime(s)}>
                          {shiftTime(s)}{s.tag ? ` · ${s.tag}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
