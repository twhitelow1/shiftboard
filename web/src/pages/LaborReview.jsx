// Forecast & Labor → Labor review: a past week's schedule against the time clock: ADP, Toast, or both
// with ADP winning (Settings → Integrations → Clock-in source). Each day says where its hours came from.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, money, JobDot, Empty } from '../ui.jsx';
import { addDays, parseDate, weekStart as weekStartOf } from '../../../core/time.js';
import { IS_DEMO } from '../api.js';
import { weekLabel } from './Schedule.jsx';
import { useToast, useToastSync, SyncProgress } from './ToastSettings.jsx';
import { ClockSetupButton, useAdp, useAdpSync } from './AdpSettings.jsx';
import { AdpImportButton } from './AdpImport.jsx';
import '../labor.css';
import { hoursCsvRows, toCsv } from '../../../core/exports.js';
import { tx, dowShort, fmtTime, prettyDate, stamp, num } from '../i18n/index.js';

const h = (n) => (n == null ? '—' : num(Math.round(n * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const pctTxt = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
/** 'ADP', 'Toast' or 'ADP + Toast': where a day's (or a person's) hours came from. */
export const sourceName = (s) => (s === 'adp' ? 'ADP' : s === 'toast' ? 'Toast' : s === 'adp+toast' ? 'ADP + Toast' : '');
const hm = (stamp) => (stamp ? fmtTime(stamp.slice(11, 16)) : '?');
const when = (iso) => (iso ? stamp(iso) : '');

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

/** Save a CSV made in the browser (the hours export for payroll: legal name and name, core/exports.js). */
function downloadCsv(csv, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

export default function LaborReview() {
  const { call, version, today, settings, jobs, isMgr, has, employees } = useApp();
  const current = weekStartOf(today, settings.weekStartDow);
  const [ws, setWsState] = useState(() => saved() || addDays(current, -7));
  const setWs = (v) => { setWsState(v); try { sessionStorage.setItem(STORE_KEY, v); } catch { /* ignore */ } };
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('people');
  const { status } = useToast();
  const { status: adpStatus } = useAdp();
  const [syncToast, toastProgress] = useToastSync();
  const [syncAdp, adpProgress] = useAdpSync();
  const progress = adpProgress || toastProgress;
  // Sync this week: ADP's time cards (when the API is set up), then Toast's sales and clock-ins.
  const sync = async (range) => {
    if (adpStatus?.configured) await syncAdp(range);
    if (status?.configured) await syncToast(range);
  };

  useEffect(() => { setErr(''); call('labor.week', { weekStart: ws }).then(setR).catch((e) => setErr(e.message)); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!r) return <div className="empty">{tx('common.loading')}</div>;

  const weeks = Array.from({ length: 16 }, (_, i) => addDays(current, -7 * i));
  if (!weeks.includes(ws)) weeks.push(ws);
  const t = r.totals;
  const target = r.targetLaborPct;
  const weekEnd = addDays(r.weekStart, 6);
  const syncTo = weekEnd < today ? weekEnd : addDays(today, -1);
  const canSync = !IS_DEMO && (status?.configured || adpStatus?.configured) && r.weekStart < today;
  const hasClock = r.clockDays.length > 0;
  const lastSync = r.toast?.lastSync;
  const issues = r.noShift.length + r.noClockIn.length + r.overtime.length + r.noClockOut.length;
  const source = r.clock?.source || 'toast';
  const ignored = source === 'toast' ? r.clock?.ignored?.adp : r.clock?.ignored?.toast;
  const adpWhen = r.adp?.lastSync?.at || r.adp?.lastImport?.at;

  return (
    <div className="lr">
      <div className="toolbar">
        <div className="weeknav">
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))} aria-label={tx('laborReview.previousWeek')}><Icon name="left" /></button>
          <select className="input sm lr-week" value={ws} onChange={(e) => setWs(e.target.value)} aria-label={tx('laborReview.week')}>
            {weeks.sort().reverse().map((w) => <option key={w} value={w}>{weekLabel(w)}{w === current ? tx('laborReview.thisWeek') : w === addDays(current, -7) ? tx('laborReview.lastWeek') : ''}</option>)}
          </select>
          <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))} disabled={ws >= current} aria-label={tx('common.nextWeek')}><Icon name="right" /></button>
        </div>
        <span className="spacer" />
        {isMgr && <AdpImportButton className={canSync ? 'btn sm' : 'btn sm primary'} />}
        {canSync && <button className="btn sm primary" disabled={!!progress} onClick={() => sync({ from: r.weekStart, to: syncTo })}><Icon name="download" />{tx('laborReview.syncThisWeek')}</button>}
        {isMgr && (!has || has('adp') || has('toast')) && <ClockSetupButton />}
      </div>
      {progress && <div className="card card-pad section"><SyncProgress progress={progress} /></div>}

      <div className="small muted lr-source">
        {IS_DEMO ? tx('laborReview.sampleClockInsDemoData') : tx(`laborReview.clockInsFrom_${source === 'adp+toast' ? 'both' : source}`)}
        {!IS_DEMO && (source !== 'toast' && adpWhen ? ` ${tx('laborReview.adpUpdated', { when: when(adpWhen) })}` : '')}
        {!IS_DEMO && lastSync ? ` ${tx('laborReview.toastSynced', { when: when(lastSync.at) })}` : ''}
        {' '}{tx('laborReview.overtimeIsCountedAt1')}</div>
      {!r.anyEntries && !IS_DEMO && (
        <div className="alert info section"><Icon name="clock" size={16} /><div>{tx('laborReview.noClockInsYet')}{' '}{canSync ? tx('laborReview.syncToSee') : tx('laborReview.importOrConnect')}</div></div>
      )}
      {r.anyEntries && !hasClock && <div className="alert warn section"><Icon name="alert" size={16} />{tx('laborReview.noClockInsForThis')}{canSync ? tx('laborReview.yetSyncThisWeekTo') : tx('laborReview.yetImportThisWeek')}</div>}
      {ignored > 0 && <div className="help section">{tx(source === 'toast' ? 'laborReview.ignoredAdp' : 'laborReview.ignoredToast', { count: ignored })}</div>}
      {r.unmatched.entries > 0 && (
        <div className="alert warn section"><Icon name="alert" size={16} /><div>{tx('laborReview.countClockInsHHrs', { count: r.unmatched.entries, h: h(r.unmatched.hours) })}</div></div>
      )}

      <div className="kpis">
        <div className="card kpi"><div className="l">{tx('laborReview.sales')}</div><div className="v">{money(t.sales)}</div><div className="s">{tx('laborReview.coversCovers', { covers: num(t.covers) })}</div></div>
        <div className="card kpi"><div className="l">{tx('laborReview.laborCost')}</div><div className="v">{hasClock ? money(t.actual.cost) : '—'}</div><div className="s">{tx('laborReview.scheduledAmount', { amount: money(t.sched.cost) })}</div></div>
        <div className="card kpi"><div className="l">{tx('laborReview.labor')}</div>
          <div className="v" style={{ color: t.actualPct == null ? undefined : target != null && t.actualPct > target ? 'var(--bad)' : 'var(--ok)' }}>{pctTxt(t.actualPct)}</div>
          <div className="s">{tx('laborReview.scheduledPcttxt', { pctTxt: pctTxt(t.schedPct) })}{target != null ? tx('laborReview.targetTarget', { target }) : ''}</div></div>
        <div className="card kpi"><div className="l">{tx('laborReview.hoursWorked')}</div><div className="v">{hasClock ? h(t.actual.hours) : '—'}</div>
          <div className="s">{tx('laborReview.scheduledH', { h: h(t.sched.hours) })}{t.actual.ot > 0 ? tx('laborReview.hOt', { h: h(t.actual.ot) }) : ''}</div></div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>{tx('laborReview.byDay')}</h2><span className="small muted">{tx('laborReview.scheduledWorked')}</span></div>
        <div className="table-wrap">
          <table className="table lr-table">
            <thead><tr><th>{tx('common.day')}</th><th>{tx('laborReview.sales')}</th><th>{tx('laborReview.schedHrs')}</th><th>{tx('laborReview.worked')}</th><th>+/−</th><th>{tx('laborReview.sched')}</th><th>{tx('laborReview.actual')}</th><th>{tx('laborReview.sched2')}</th><th>{tx('laborReview.actual2')}</th><th>{tx('laborReview.otHrs')}</th></tr></thead>
            <tbody>
              {r.days.map((d) => (
                <tr key={d.date} className={d.closed && !d.sched.shifts && !d.actual.entries ? 'lr-closed' : ''}>
                  <td className="lr-stick"><b>{dowShort(d.dow)} {parseDate(d.date).getUTCDate()}</b>{d.closed && <span className="tiny faint">{' '}{tx('laborReview.closed')}</span>}
                    {d.source && <div className="tiny faint lr-src" title={tx('laborReview.hoursFrom', { source: sourceName(d.source) })}>{sourceName(d.source)}</div>}</td>
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
                <td className="lr-stick">{tx('laborReview.week')}</td>
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
        {r.openShifts > 0 && <div className="card-pad small faint" style={{ paddingTop: 8 }}>{tx('laborReview.countOpenShiftsWereNever', { count: r.openShifts })}</div>}
      </div>

      {hasClock && (
        <div className="card section">
          <div className="card-head"><h2 style={{ flex: 1 }}>{tx('laborReview.needsALook')}</h2>{issues > 0 && <span className="badge warn">{issues}</span>}</div>
          {!issues ? <div className="card-pad small muted"><Icon name="check" size={14} />{' '}{tx('laborReview.everyoneWorkedTheirShiftsAnd')}</div> : (
            <div className="lr-issues">
              <IssueGroup title={tx('laborReview.clockedInWithoutAShift')} items={r.noShift} render={(e) => (
                <><b>{e.name}</b><span className="muted">{e.job || tx('laborReview.noPosition')}</span><span>{prettyDate(e.date)} · {hm(e.inLocal)}–{e.outLocal ? hm(e.outLocal) : '?'}{' '}{tx('laborReview.hH', { h: h(e.hours) })}</span></>
              )} />
              <IssueGroup title={tx('laborReview.hadAShiftNeverClocked')} items={r.noClockIn} render={(s) => (
                <><b>{s.name}</b><span className="muted">{s.job}</span><span>{prettyDate(s.date)} · {fmtTime(s.start)}–{s.estimatedEnd ? tx('laborReview.cl') : fmtTime(s.end)}</span></>
              )} />
              <IssueGroup title={tx('laborReview.overtimeOverOtafterHrs', { otAfter: r.otAfter })} items={r.overtime} render={(o) => (
                <><b>{o.name}</b><span className="muted">{tx('laborReview.workedHHScheduledH2', { h: h(o.actualHours), h2: h(o.schedHours) })}</span><span><span className="lr-diff over">{tx('laborReview.hHOt', { h: h(o.actualOt) })}</span>{o.schedOt > 0 ? tx('laborReview.hHScheduled', { h: h(o.schedOt) }) : ''}</span></>
              )} />
              <IssueGroup title={tx('laborReview.noClockOutClosedBy')} items={r.noClockOut} render={(e) => (
                <><b>{e.name}</b><span className="muted">{e.job || tx('laborReview.noPosition')}</span><span>{tx('laborReview.dateInHm', { date: prettyDate(e.date), hm: hm(e.inLocal) })}</span></>
              )} />
            </div>
          )}
        </div>
      )}

      <div className="card section">
        <div className="card-head row wrap">
          <h2 style={{ flex: 1 }}>{view === 'people' ? tx('laborReview.byPerson') : tx('laborReview.byPosition')}</h2>
          <div className="seg"><button className={view === 'people' ? 'on' : ''} onClick={() => setView('people')}>{tx('common.people')}</button><button className={view === 'positions' ? 'on' : ''} onClick={() => setView('positions')}>{tx('laborReview.positions')}</button></div>
          {view === 'people' && r.people.length > 0 && <button className="btn sm ghost" title={tx('legalName.hoursCsvTitle')} onClick={() => downloadCsv(
            toCsv(hoursCsvRows(r, { people: Object.fromEntries(employees.map((e) => [e.id, e])), jobName: (id) => jobs[id]?.name })), `hours-${r.weekStart}.csv`)}>
            <Icon name="download" />{tx('legalName.hoursCsv')}</button>}
        </div>
        {!(view === 'people' ? r.people : r.positions).length ? <Empty icon="users" title={tx('laborReview.nobodyScheduledOrClockedIn')} /> : (
          <div className="table-wrap">
            <table className="table lr-table">
              <thead><tr><th>{view === 'people' ? tx('common.name') : tx('common.position')}</th><th>{tx('laborReview.schedHrs')}</th><th>{tx('laborReview.worked')}</th><th>+/−</th><th>{tx('laborReview.sched')}</th><th>{tx('laborReview.actual')}</th><th>{tx('laborReview.otHrs')}</th><th>{tx('laborReview.tips')}</th></tr></thead>
              <tbody>
                {(view === 'people' ? r.people : r.positions).map((p) => (
                  <tr key={p.key}>
                    <td className="lr-stick">
                      {view === 'people'
                        ? <div><b>{p.name}</b>{!p.matched && <span className="badge warn" style={{ marginLeft: 6 }}>{tx('laborReview.notMatched')}</span>}<div className="tiny faint">{[p.jobs.map((id) => jobs[id]?.name).filter(Boolean).join(', '), sourceName(p.source)].filter(Boolean).join(' · ')}</div></div>
                        : <span className="row" style={{ gap: 6 }}>{p.jobCodeId ? <JobDot job={jobs[p.jobCodeId]} /> : null}<b>{p.name}</b>{p.matched === false && <span className="badge warn">{tx('laborReview.clockJob', { source: sourceName(p.source) })}</span>}</span>}
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
        <div className="card-pad help" style={{ paddingTop: 8 }}>{tx('laborReview.actualCostUsesEachClock')}{r.otEstimated ? ` ${tx('laborReview.otEstimated', { otAfter: r.otAfter })}` : ''}</div>
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
