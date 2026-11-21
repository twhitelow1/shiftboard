// Forecast & Labor → Labor review: a past week's schedule against the time clock (Toast).
import React, { useEffect, useState } from 'react';
import { useApp, Icon, money, JobDot, Empty } from '../ui.jsx';
import { addDays, DOW_SHORT, fmtTime, parseDate, prettyDate, weekStart as weekStartOf } from '../../../core/time.js';
import { IS_DEMO } from '../api.js';
import { weekLabel } from './Schedule.jsx';
import { ToastSetupButton, useToast, useToastSync, SyncProgress } from './ToastSettings.jsx';
import '../labor.css';

const h = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const pctTxt = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const hm = (stamp) => (stamp ? fmtTime(stamp.slice(11, 16)) : '?');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function Diff({ a, b, unit = 'h', money: isMoney }) {
  if (a == null || b == null) return <span className="faint">—</span>;
  const d = Math.round((a - b) * 10) / 10;
  if (Math.abs(d) < (isMoney ? 1 : 0.1)) return <span className="faint">0</span>;
  const txt = isMoney ? money(Math.abs(d)) : `${h(Math.abs(d))}${unit}`;
  return <span className={`lr-diff ${d > 0 ? 'over' : 'under'}`}>{d > 0 ? '+' : '−'}{txt}</span>;
}

function PctBadge({ value, target }) {
  if (value == null) return <span className="faint">—</span>;
  return <span className={`badge ${target != null && value > target ? 'bad' : 'ok'}`}>{pctTxt(value)}</span>;
}

const STORE_KEY = 'sb_labor_week';
const saved = () => { try { return sessionStorage.getItem(STORE_KEY); } catch { return null; } };

export default function LaborReview() {
  const { call, version, today, settings, jobs, isMgr } = useApp();
  const current = weekStartOf(today, settings.weekStartDow);
  const [ws, setWsState] = useState(() => saved() || addDays(current, -7));
  const setWs = (v) => { setWsState(v); try { sessionStorage.setItem(STORE_KEY, v); } catch { /* ignore */ } };
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('people');
  const { status } = useToast();
  const [sync, progress] = useToastSync();

  useEffect(() => { setErr(''); call('labor.week', { weekStart: ws }).then(setR).catch((e) => setErr(e.message)); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!r) return <div className="empty">Loading…</div>;

  const weeks = Array.from({ length: 16 }, (_, i) => addDays(current, -7 * i));
  if (!weeks.includes(ws)) weeks.push(ws);
  const t = r.totals;
  const target = r.targetLaborPct;
  const weekEnd = addDays(r.weekStart, 6);
  const syncTo = weekEnd < today ? weekEnd : addDays(today, -1);
  const canSync = !IS_DEMO && status?.configured && r.weekStart < today;
  const hasClock = r.clockDays.length > 0;
  const lastSync = r.toast?.lastSync;
  const issues = r.noShift.length + r.noClockIn.length + r.overtime.length + r.noClockOut.length;

  return (
    <div className="lr">
      <div className="toolbar">
        <div className="weeknav">
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))} aria-label="Previous week"><Icon name="left" /></button>
          <select className="input sm lr-week" value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Week">
            {weeks.sort().reverse().map((w) => <option key={w} value={w}>{weekLabel(w)}{w === current ? ' (this week)' : w === addDays(current, -7) ? ' (last week)' : ''}</option>)}
          </select>
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))} disabled={ws >= current} aria-label="Next week"><Icon name="right" /></button>
        </div>
        <span className="spacer" />
        {canSync && <button className="btn sm primary" disabled={!!progress} onClick={() => sync({ from: r.weekStart, to: syncTo })}><Icon name="download" />Sync this week</button>}
        {isMgr && <ToastSetupButton />}
      </div>
      {progress && <div className="card card-pad section"><SyncProgress progress={progress} /></div>}

      <div className="small muted lr-source">
        {IS_DEMO ? 'Sample clock-ins (demo data, as if synced from Toast).'
          : lastSync ? `Clock-ins and sales from Toast. Last synced ${when(lastSync.at)}.`
            : 'Scheduled shifts compared with clock-ins from Toast.'}
        {' '}Overtime is counted at 1.5× pay.
      </div>
      {!r.anyEntries && !IS_DEMO && (
        <div className="alert info section"><Icon name="clock" size={16} /><div>No clock-ins yet. {status?.configured ? 'Sync from Toast to see what was actually worked.' : 'Connect Toast (Toast setup) to compare the schedule with what was actually worked.'}</div></div>
      )}
      {r.anyEntries && !hasClock && <div className="alert warn section"><Icon name="alert" size={16} />No clock-ins for this week{canSync ? ' yet. Sync this week to load them.' : '.'}</div>}
      {r.unmatched.entries > 0 && (
        <div className="alert warn section"><Icon name="alert" size={16} /><div>{r.unmatched.entries} clock-in{r.unmatched.entries === 1 ? '' : 's'} ({h(r.unmatched.hours)} hrs) aren't matched to a person. Match them in Toast setup.</div></div>
      )}

      <div className="kpis">
        <div className="card kpi"><div className="l">Sales</div><div className="v">{money(t.sales)}</div><div className="s">{t.covers.toLocaleString()} covers</div></div>
        <div className="card kpi"><div className="l">Labor cost</div><div className="v">{hasClock ? money(t.actual.cost) : '—'}</div><div className="s">scheduled {money(t.sched.cost)}</div></div>
        <div className="card kpi"><div className="l">Labor %</div>
          <div className="v" style={{ color: t.actualPct == null ? undefined : target != null && t.actualPct > target ? 'var(--bad)' : 'var(--ok)' }}>{pctTxt(t.actualPct)}</div>
          <div className="s">scheduled {pctTxt(t.schedPct)}{target != null ? ` · target ${target}%` : ''}</div></div>
        <div className="card kpi"><div className="l">Hours worked</div><div className="v">{hasClock ? h(t.actual.hours) : '—'}</div>
          <div className="s">scheduled {h(t.sched.hours)}{t.actual.ot > 0 ? ` · ${h(t.actual.ot)} OT` : ''}</div></div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>By day</h2><span className="small muted">Scheduled → worked</span></div>
        <div className="table-wrap">
          <table className="table lr-table">
            <thead><tr><th>Day</th><th>Sales</th><th>Sched hrs</th><th>Worked</th><th>+/−</th><th>Sched $</th><th>Actual $</th><th>Sched %</th><th>Actual %</th><th>OT hrs</th></tr></thead>
            <tbody>
              {r.days.map((d) => (
                <tr key={d.date} className={d.closed && !d.sched.shifts && !d.actual.entries ? 'lr-closed' : ''}>
                  <td className="lr-stick"><b>{DOW_SHORT[d.dow]} {parseDate(d.date).getUTCDate()}</b>{d.closed && <span className="tiny faint"> closed</span>}</td>
                  <td className="num">{d.sales == null ? <span className="faint">—</span> : money(d.sales)}</td>
                  <td className="num">{h(d.sched.hours)}</td>
                  <td className="num">{d.hasClock ? h(d.actual.hours) : <span className="faint">—</span>}</td>
                  <td className="num">{d.hasClock ? <Diff a={d.actual.hours} b={d.sched.hours} /> : <span className="faint">—</span>}</td>
                  <td className="num">{money(d.sched.cost)}</td>
                  <td className="num">{d.hasClock ? money(d.actual.cost) : <span className="faint">—</span>}</td>
                  <td><PctBadge value={d.schedPct} target={target} /></td>
                  <td><PctBadge value={d.actualPct} target={target} /></td>
                  <td className="num">{d.actual.ot > 0 ? <b className="lr-diff over">{h(d.actual.ot)}</b> : <span className="faint">—</span>}</td>
                </tr>
              ))}
              <tr className="lr-total">
                <td className="lr-stick">Week</td>
                <td className="num">{money(t.sales)}</td>
                <td className="num">{h(t.sched.hours)}</td>
                <td className="num">{hasClock ? h(t.actual.hours) : '—'}</td>
                <td className="num">{hasClock ? <Diff a={t.actual.hours} b={t.sched.hours} /> : '—'}</td>
                <td className="num">{money(t.sched.cost)}</td>
                <td className="num">{hasClock ? money(t.actual.cost) : '—'}</td>
                <td><PctBadge value={t.schedPct} target={target} /></td>
                <td><PctBadge value={t.actualPct} target={target} /></td>
                <td className="num">{t.actual.ot > 0 ? h(t.actual.ot) : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {r.openShifts > 0 && <div className="card-pad small faint" style={{ paddingTop: 8 }}>{r.openShifts} open shift{r.openShifts === 1 ? ' was' : 's were'} never filled and {r.openShifts === 1 ? "isn't" : "aren't"} counted as scheduled.</div>}
      </div>

      {hasClock && (
        <div className="card section">
          <div className="card-head"><h2 style={{ flex: 1 }}>Needs a look</h2>{issues > 0 && <span className="badge warn">{issues}</span>}</div>
          {!issues ? <div className="card-pad small muted"><Icon name="check" size={14} /> Everyone worked their shifts and nobody went into overtime.</div> : (
            <div className="lr-issues">
              <IssueGroup title="Clocked in without a shift" items={r.noShift} render={(e) => (
                <><b>{e.name}</b><span className="muted">{e.job || 'No position'}</span><span>{prettyDate(e.date)} · {hm(e.inLocal)}–{e.outLocal ? hm(e.outLocal) : '?'} ({h(e.hours)} h)</span></>
              )} />
              <IssueGroup title="Had a shift, never clocked in" items={r.noClockIn} render={(s) => (
                <><b>{s.name}</b><span className="muted">{s.job}</span><span>{prettyDate(s.date)} · {fmtTime(s.start)}–{s.estimatedEnd ? 'CL' : fmtTime(s.end)}</span></>
              )} />
              <IssueGroup title={`Overtime (over ${r.otAfter} hrs)`} items={r.overtime} render={(o) => (
                <><b>{o.name}</b><span className="muted">worked {h(o.actualHours)} h, scheduled {h(o.schedHours)} h</span><span><span className="lr-diff over">{h(o.actualOt)} h OT</span>{o.schedOt > 0 ? ` (${h(o.schedOt)} h scheduled)` : ''}</span></>
              )} />
              <IssueGroup title="No clock-out (closed by Toast)" items={r.noClockOut} render={(e) => (
                <><b>{e.name}</b><span className="muted">{e.job || 'No position'}</span><span>{prettyDate(e.date)} · in {hm(e.inLocal)}</span></>
              )} />
            </div>
          )}
        </div>
      )}

      <div className="card section">
        <div className="card-head row wrap">
          <h2 style={{ flex: 1 }}>{view === 'people' ? 'By person' : 'By position'}</h2>
          <div className="seg"><button className={view === 'people' ? 'on' : ''} onClick={() => setView('people')}>People</button><button className={view === 'positions' ? 'on' : ''} onClick={() => setView('positions')}>Positions</button></div>
        </div>
        {!(view === 'people' ? r.people : r.positions).length ? <Empty icon="users" title="Nobody scheduled or clocked in this week" /> : (
          <div className="table-wrap">
            <table className="table lr-table">
              <thead><tr><th>{view === 'people' ? 'Name' : 'Position'}</th><th>Sched hrs</th><th>Worked</th><th>+/−</th><th>Sched $</th><th>Actual $</th><th>OT hrs</th><th>Tips</th></tr></thead>
              <tbody>
                {(view === 'people' ? r.people : r.positions).map((p) => (
                  <tr key={p.key}>
                    <td className="lr-stick">
                      {view === 'people'
                        ? <div><b>{p.name}</b>{!p.matched && <span className="badge warn" style={{ marginLeft: 6 }}>Not matched</span>}<div className="tiny faint">{p.jobs.map((id) => jobs[id]?.name).filter(Boolean).join(', ')}</div></div>
                        : <span className="row" style={{ gap: 6 }}>{p.jobCodeId ? <JobDot job={jobs[p.jobCodeId]} /> : null}<b>{p.name}</b>{p.matched === false && <span className="badge warn">Toast job</span>}</span>}
                    </td>
                    <td className="num">{h(p.sched.hours)}</td>
                    <td className="num">{hasClock ? h(p.actual.hours) : '—'}</td>
                    <td className="num">{hasClock ? <Diff a={p.actual.hours} b={p.sched.hours} /> : '—'}</td>
                    <td className="num">{money(p.sched.cost)}</td>
                    <td className="num">{hasClock ? money(p.actual.cost) : '—'}</td>
                    <td className="num">{p.actual.ot > 0 ? <b className="lr-diff over">{h(p.actual.ot)}</b> : <span className="faint">—</span>}</td>
                    <td className="num">{p.actual.tips > 0 ? money(p.actual.tips) : <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad help" style={{ paddingTop: 8 }}>Actual cost uses each clock-in's Toast wage (or the pay rate in ShiftBoard when Toast has none). Tips are declared cash plus card tips, and aren't part of labor cost.</div>
      </div>
    </div>
  );
}

function IssueGroup({ title, items, render }) {
  const [open, setOpen] = useState(items.length <= 6);
  if (!items.length) return null;
  return (
    <div className="lr-group">
      <button className="lr-group-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'down' : 'right'} size={14} /><span>{title}</span><span className="badge">{items.length}</span>
      </button>
      {open && <div className="lr-items">{items.map((x) => <div key={x.id || x.key} className="lr-item">{render(x)}</div>)}</div>}
    </div>
  );
}
