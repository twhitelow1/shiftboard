import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, shiftTime, money, useAction, JobDot, Empty } from '../ui.jsx';
import { addDays, weekStart, range, dow, prettyDate, DOW_SHORT, parseDate, MONTHS, fmtTime } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import ShiftDialog from './ShiftDialog.jsx';
import ImportDialog from './ImportDialog.jsx';
import { IS_DEMO } from '../api.js';

export function useWeek() {
  const { today, settings } = useApp();
  const [ws, setWs] = useState(() => {
    const saved = sessionStorageGet('sb_week');
    return saved || weekStart(addDays(today, 1), settings.weekStartDow);
  });
  useEffect(() => sessionStorageSet('sb_week', ws), [ws]);
  return [ws, setWs];
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

export function weekLabel(ws) {
  const a = parseDate(ws), b = parseDate(addDays(ws, 6));
  const m1 = MONTHS[a.getUTCMonth()].slice(0, 3), m2 = MONTHS[b.getUTCMonth()].slice(0, 3);
  return m1 === m2 ? `${m1} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${m1} ${a.getUTCDate()} – ${m2} ${b.getUTCDate()}`;
}

export function WeekNav({ ws, setWs }) {
  const { today, settings } = useApp();
  return (
    <div className="weeknav">
      <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))} aria-label="Previous week"><Icon name="left" /></button>
      <div className="label">{weekLabel(ws)}</div>
      <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))} aria-label="Next week"><Icon name="right" /></button>
      <button className="btn sm ghost" onClick={() => setWs(weekStart(today, settings.weekStartDow))}>Today</button>
    </div>
  );
}

export default function Schedule() {
  const app = useApp();
  const { isMgr, jobCodes, employees, jobs, people, me, settings, call, version, today } = app;
  const [ws, setWs] = useWeek();
  const [data, setData] = useState(null);
  const [fc, setFc] = useState(null);
  const [groupBy, setGroupBy] = useState('job');
  const [dept, setDept] = useState('');
  const [hideEmpty, setHideEmpty] = useState(!isMgr);
  const [mine, setMine] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [selDay, setSelDay] = useState(() => (today >= ws && today <= addDays(ws, 6) ? today : range(ws, 7).find((d) => !settings.closedDays.includes(dow(d))) || ws));
  const [importOpen, setImportOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [run, busy] = useAction();
  const days = range(ws, 7);

  const load = () => {
    call('shifts.list', { start: ws, end: addDays(ws, 6) }).then(setData).catch((e) => app.toast(e.message, 'bad'));
    if (isMgr) call('forecast.summary', { weekStart: ws }).then(setFc).catch(() => setFc(null));
  };
  useEffect(load, [ws, version]);
  useEffect(() => { if (!(selDay >= ws && selDay <= addDays(ws, 6))) setSelDay(today >= ws && today <= addDays(ws, 6) ? today : days.find((d) => !settings.closedDays.includes(dow(d))) || ws); }, [ws]);

  const shifts = data?.shifts || [];
  const drafts = shifts.filter((s) => !s.published).length;
  const departments = [...new Set(jobCodes.filter((j) => !j.archived).map((j) => j.department))];
  const visibleJobs = jobCodes.filter((j) => !j.archived && (!dept || j.department === dept));

  const timeOffOn = (userId, date) => data?.timeOff?.find((t) => t.userId === userId && t.startDate <= date && t.endDate >= date);
  const hoursByUser = useMemo(() => {
    const m = {};
    for (const s of shifts) if (s.userId) m[s.userId] = (m[s.userId] || 0) + hoursOf(s, settings);
    return m;
  }, [shifts, settings]);

  const openDialog = (shift) => setDialog({ shift, warnings: data?.warnings?.[shift.id] });
  const addAt = (date, jobCodeId, userId) => isMgr && setDialog({ shift: { date, jobCodeId, userId, start: '16:00' } });
  const closeDialog = (changed) => { setDialog(null); if (changed) load(); };

  const sections = useMemo(() => {
    if (!data) return [];
    const activeEmps = employees.filter((e) => e.active !== false && e.role !== 'events');
    if (groupBy === 'emp') {
      const rows = activeEmps.filter((e) => (!mine || e.id === me.id) && (!dept || e.jobCodes?.some((j) => jobs[j.jobCodeId]?.department === dept)))
        .map((e) => ({ user: e, shifts: shifts.filter((s) => s.userId === e.id && (!dept || jobs[s.jobCodeId]?.department === dept)) }))
        .filter((r) => !hideEmpty || r.shifts.length || days.some((d) => timeOffOn(r.user.id, d)));
      const open = shifts.filter((s) => !s.userId && (!dept || jobs[s.jobCodeId]?.department === dept));
      return [{ key: 'all', label: 'Everyone', rows, open }];
    }
    return visibleJobs.map((j) => {
      const jobShifts = shifts.filter((s) => s.jobCodeId === j.id);
      const users = new Set(activeEmps.filter((e) => e.jobCodes?.some((x) => x.jobCodeId === j.id)).map((e) => e.id));
      jobShifts.forEach((s) => s.userId && users.add(s.userId));
      let rows = [...users].map((id) => people[id]).filter(Boolean)
        .map((u) => ({ user: u, shifts: jobShifts.filter((s) => s.userId === u.id) }));
      // Keep the sheet's order: people with a primary job here first, then alphabetical.
      rows.sort((a, b) => a.user.name.localeCompare(b.user.name));
      if (mine) rows = rows.filter((r) => r.user.id === me.id);
      if (hideEmpty) rows = rows.filter((r) => r.shifts.length);
      return { key: j.id, job: j, label: j.name, rows, open: mine ? [] : jobShifts.filter((s) => !s.userId) };
    }).filter((s) => s.rows.length || s.open.length || (isMgr && !hideEmpty && !mine));
  }, [data, groupBy, dept, hideEmpty, mine, employees, jobCodes]);

  const publish = () => run(() => call('shifts.publish', { start: ws, end: addDays(ws, 6) }), (r) => `Published ${r.published} shifts · ${r.notified} people notified`).then(load);

  const exportCsv = () => {
    const rows = [['date', 'employee', 'job', 'start', 'end', 'tag', 'notes', 'status']];
    for (const s of [...shifts].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) {
      rows.push([s.date, people[s.userId]?.name || 'OPEN', jobs[s.jobCodeId]?.name, s.start, s.end || '', s.tag, s.notes, s.published ? 'published' : 'draft']);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `schedule-${ws}.csv`;
    a.click();
  };

  const isClosed = (d) => settings.closedDays.includes(dow(d));
  const fcDay = (d) => fc?.days?.find((x) => x.date === d);

  const ShiftChip = ({ s, showJob }) => {
    const j = jobs[s.jobCodeId];
    const w = data?.warnings?.[s.id];
    return (
      <button className={`shift ${s.published ? '' : 'draft'} ${!s.userId ? 'open' : ''} ${s.userId === me.id ? 'mine' : ''}`} style={{ '--jc': j?.color || '#888' }}
        onClick={(e) => { e.stopPropagation(); openDialog(s); }} title={w?.join('\n') || ''}>
        <span className="t">{shiftTime(s)}</span>
        {s.tag && <span className="tag">{s.tag}</span>}
        {w && <span className="warn-ico">!</span>}
        {s.pending && <span className="pend" title="Swap pending">⇄</span>}
        {(showJob || !s.userId) && <div className="sub">{!s.userId ? 'Open' : ''}{!s.userId && showJob ? ' · ' : ''}{showJob ? j?.name : ''}</div>}
      </button>
    );
  };

  const Cell = ({ date, userId, list, jobCodeId }) => {
    const to = userId && timeOffOn(userId, date);
    const closed = isClosed(date);
    const canAdd = isMgr && !closed;
    return (
      <td className={`cell ${date === today ? 'today' : ''} ${closed && !list.length ? 'closed' : ''} ${canAdd ? 'can-add' : ''}`} onClick={() => canAdd && addAt(date, jobCodeId || people[userId]?.jobCodes?.[0]?.jobCodeId, userId)}>
        {list.sort((a, b) => a.start.localeCompare(b.start)).map((s) => <ShiftChip key={s.id} s={s} showJob={groupBy === 'emp'} />)}
        {!list.length && to && <span className="reqoff" title={to.reason || ''}>{to.status === 'approved' ? 'REQUEST OFF' : 'REQ PENDING'}</span>}
        {!list.length && !to && !closed && userId && <span className="off">{isMgr ? '' : 'OFF'}</span>}
      </td>
    );
  };

  return (
    <div>
      <div className="toolbar">
        <WeekNav ws={ws} setWs={setWs} />
        <span className="spacer" />
        <div className="seg desktop-only">
          <button className={groupBy === 'job' ? 'on' : ''} onClick={() => setGroupBy('job')}>By job code</button>
          <button className={groupBy === 'emp' ? 'on' : ''} onClick={() => setGroupBy('emp')}>By employee</button>
        </div>
        {isMgr && <>
          <button className="btn sm desktop-only" onClick={() => setDialog({ shift: { date: selDay, start: '16:00' } })}><Icon name="plus" />Add shift</button>
          <button className={`btn sm ${drafts ? 'primary' : ''}`} onClick={publish} disabled={!drafts || busy}><Icon name="send" />Publish{drafts ? ` (${drafts})` : 'ed'}</button>
        </>}
      </div>
      <div className="toolbar" style={{ marginTop: -6 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={`chip ${!dept ? 'on' : ''}`} onClick={() => setDept('')}>All</button>
          {departments.map((d) => <button key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => setDept(dept === d ? '' : d)}>{d}</button>)}
        </div>
        <span className="spacer" />
        <label className="check small desktop-only"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Only me</label>
        <label className="check small desktop-only"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />Hide people not scheduled</label>
        {isMgr && <div className="row desktop-only" style={{ gap: 4 }}>
          <button className="btn sm ghost" onClick={() => setCopyOpen(true)} title="Copy another week"><Icon name="copy" />Copy week</button>
          <button className="btn sm ghost" onClick={() => setImportOpen(true)} title="Paste from Excel / CSV"><Icon name="upload" />Import</button>
          {!IS_DEMO && <button className="btn sm ghost" onClick={exportCsv}><Icon name="download" />CSV</button>}
          {!IS_DEMO && <button className="btn sm ghost" onClick={() => window.print()}><Icon name="print" />Print</button>}
        </div>}
      </div>

      {fc && isMgr && (
        <div className="row wrap small desktop-only" style={{ marginBottom: 10, gap: 14 }}>
          <span className="muted">Week forecast: <b className="num">{fc.totals.covers.toLocaleString()}</b> covers · <b className="num">{money(fc.totals.sales)}</b> sales</span>
          <span className="muted">Scheduled: <b className="num">{fc.totals.hours}</b> hrs · <b className="num">{money(fc.totals.cost)}</b></span>
          <span className={`badge ${fc.totals.laborPct > fc.targetLaborPct ? 'bad' : 'ok'}`}>Labor {fc.totals.laborPct ?? '—'}% (target {fc.targetLaborPct}%)</span>
          {drafts > 0 && <span className="badge warn">{drafts} draft shift{drafts > 1 ? 's' : ''} not visible to staff yet</span>}
        </div>
      )}

      <div className="print-title">{settings.restaurantName} — Schedule {weekLabel(ws)}</div>

      {!data ? <div className="empty">Loading…</div> : (
        <>
          {/* Desktop grid */}
          <div className="sched-wrap desktop-only">
            <table className="sched">
              <thead>
                <tr>
                  <th className="namecol">
                    <div className="small faint">{shifts.filter((s) => s.userId).length} shifts · {shifts.filter((s) => !s.userId).length} open</div>
                  </th>
                  {days.map((d) => {
                    const f = fcDay(d);
                    const evs = data.events.filter((e) => e.date === d);
                    return (
                      <th key={d} className={`dayhead ${d === today ? 'today' : ''}`}>
                        <div className="d1">{DOW_SHORT[dow(d)]}</div>
                        <div className="d2">{parseDate(d).getUTCMonth() + 1}/{parseDate(d).getUTCDate()}</div>
                        {isClosed(d) ? <div className="meta">Closed</div> : f && <div className="meta num">~{f.totalCovers} cvrs · {f.laborPct ?? '—'}%</div>}
                        {evs.map((e) => <a key={e.id} className="evt-pill" href={`#/events/${e.id}`} title={`${e.name} · ${fmtTime(e.start)} · ${e.guestCount} guests`}>{fmtTime(e.start)} {e.name}{e.guestCount ? ` (${e.guestCount})` : ''}</a>)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sections.map((sec) => (
                  <React.Fragment key={sec.key}>
                    {groupBy === 'job' && (
                      <tr className="section"><td colSpan={8}><div className="row"><JobDot job={sec.job} />{sec.label}<span className="faint" style={{ fontWeight: 600 }}>{sec.job.department}</span></div></td></tr>
                    )}
                    {sec.rows.map(({ user, shifts: us }) => {
                      const hrs = hoursByUser[user.id] || 0;
                      return (
                        <tr key={user.id} className={user.id === me.id ? 'me' : ''}>
                          <td className="namecol">
                            <div className="emp">
                              <Avatar user={user} size="sm" />
                              <div style={{ minWidth: 0 }}>
                                <div className="emp-name">{user.name}</div>
                                {(isMgr || user.id === me.id) && <div className={`emp-hrs ${hrs > settings.overtimeHours ? 'ot' : ''}`}>{hrs ? `${hrs.toFixed(1)} hrs` : '—'}</div>}
                              </div>
                            </div>
                          </td>
                          {days.map((d) => <Cell key={d} date={d} userId={user.id} jobCodeId={sec.job?.id} list={us.filter((s) => s.date === d)} />)}
                        </tr>
                      );
                    })}
                    {sec.open.length > 0 && (
                      <tr>
                        <td className="namecol"><div className="emp"><span className="avatar sm" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>+</span><div className="emp-name faint">Open shifts</div></div></td>
                        {days.map((d) => <Cell key={d} date={d} jobCodeId={sec.job?.id} list={sec.open.filter((s) => s.date === d)} />)}
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {!sections.length && <tr><td colSpan={8}><Empty title="Nothing scheduled">{isMgr ? 'Click any cell to add a shift, copy last week, or import your spreadsheet.' : 'The schedule for this week hasn’t been posted yet.'}</Empty></td></tr>}
              </tbody>
              {isMgr && (
                <tfoot>
                  <tr className="totals">
                    <td className="namecol">Scheduled</td>
                    {days.map((d) => {
                      const f = fcDay(d);
                      const n = shifts.filter((s) => s.date === d).length;
                      return <td key={d} className="num">{n ? `${n} shifts · ${f?.hours ?? 0}h · ${money(f?.laborCost)}` : '—'}</td>;
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Mobile day view */}
          <div className="mobile-only">
            <MobileDay days={days} selDay={selDay} setSelDay={setSelDay} data={data} sections={sections} mine={mine} setMine={setMine} openDialog={openDialog} isClosed={isClosed} fcDay={fcDay} addAt={addAt} />
          </div>
        </>
      )}

      {dialog && <ShiftDialog shift={dialog.shift} warnings={dialog.warnings} events={data?.events || []} onClose={closeDialog} />}
      {importOpen && <ImportDialog ws={ws} onClose={(changed) => { setImportOpen(false); if (changed) load(); }} />}
      {copyOpen && <CopyWeekDialog ws={ws} onClose={(changed) => { setCopyOpen(false); if (changed) load(); }} />}
    </div>
  );
}

function MobileDay({ days, selDay, setSelDay, data, sections, mine, setMine, openDialog, isClosed, fcDay, addAt }) {
  const { jobs, people, me, isMgr, today } = useApp();
  const evs = data.events.filter((e) => e.date === selDay);
  const f = fcDay(selDay);
  const daySecs = sections.map((sec) => ({
    ...sec,
    items: [...sec.rows.flatMap((r) => r.shifts.filter((s) => s.date === selDay)), ...sec.open.filter((s) => s.date === selDay)].sort((a, b) => a.start.localeCompare(b.start)),
  })).filter((s) => s.items.length);
  const offToday = (data.timeOff || []).filter((t) => t.startDate <= selDay && t.endDate >= selDay && t.status === 'approved');
  return (
    <div>
      <div className="daystrip">
        {days.map((d) => (
          <button key={d} className={`${d === selDay ? 'on' : ''} ${isClosed(d) ? 'closed' : ''}`} onClick={() => setSelDay(d)}>
            <span className="a">{DOW_SHORT[dow(d)]}</span>
            <span className="b">{parseDate(d).getUTCDate()}</span>
            {data.shifts.some((s) => s.date === d && s.userId === me.id) ? <span className="c" /> : <span style={{ height: 7 }} />}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg">
          <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Everyone</button>
          <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Just me</button>
        </div>
        <span className="spacer" />
        {isMgr && f && !f.closed && <span className="small muted num">~{f.totalCovers} cvrs · {f.laborPct ?? '—'}%</span>}
        {isMgr && !isClosed(selDay) && <button className="btn sm primary" onClick={() => addAt(selDay)}><Icon name="plus" />Add</button>}
      </div>
      {evs.map((e) => (
        <a key={e.id} href={`#/events/${e.id}`} className="alert warn" style={{ marginBottom: 8 }}>
          <Icon name="glass" size={16} />
          <div><b>{e.name}</b><div className="small">{fmtTime(e.start)} · {e.room} · {e.guestCount} guests</div></div>
        </a>
      ))}
      {isClosed(selDay) && <Empty title="Closed" />}
      {!isClosed(selDay) && !daySecs.length && <Empty title={mine ? 'You’re off' : 'No shifts'} />}
      {daySecs.map((sec) => (
        <div key={sec.key} className="dgroup">
          <div className="dgroup-h">{sec.job && <JobDot job={sec.job} />}{sec.label}<span className="faint">{sec.items.length}</span></div>
          {sec.items.map((s) => (
            <div key={s.id} className={`mshift ${s.userId === me.id ? 'mine' : ''} ${!s.userId ? 'open' : ''}`} style={{ '--jc': jobs[s.jobCodeId]?.color }} onClick={() => openDialog(s)}>
              <Avatar user={people[s.userId]} size="sm" />
              <div className="who">
                {s.userId ? people[s.userId]?.name : 'Open shift'}
                <div className="small muted" style={{ fontWeight: 500 }}>{jobs[s.jobCodeId]?.short}{s.tag ? ` · ${s.tag}` : ''}{!s.published ? ' · draft' : ''}{s.pending ? ' · swap pending' : ''}</div>
              </div>
              <div className="when">{shiftTime(s)}</div>
            </div>
          ))}
        </div>
      ))}
      {!mine && offToday.length > 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>Off (requested): {offToday.map((t) => people[t.userId]?.name).filter(Boolean).join(', ')}</div>
      )}
    </div>
  );
}

function CopyWeekDialog({ ws, onClose }) {
  const { call } = useApp();
  const [from, setFrom] = useState(addDays(ws, -7));
  const [replace, setReplace] = useState(true);
  const [run, busy] = useAction();
  const go = async () => {
    const r = await run(() => call('shifts.copyWeek', { fromWeek: from, toWeek: ws, replace }), (r) => `Copied ${r.copied} shifts as drafts`);
    if (r) onClose(true);
  };
  return (
    <Modal title="Copy a week" sub={`Into ${weekLabel(ws)}`} onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={go}>Copy as drafts</button></>}>
      <Field label="Copy from week of" help="Event shifts aren't copied — they come from each event's BEO.">
        <div className="row">
          <button className="btn icon sm" onClick={() => setFrom(addDays(from, -7))}><Icon name="left" /></button>
          <div style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{weekLabel(from)}</div>
          <button className="btn icon sm" onClick={() => setFrom(addDays(from, 7))}><Icon name="right" /></button>
        </div>
      </Field>
      <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />Replace existing draft shifts in this week</label>
      <div className="help">Copied shifts stay as drafts until you publish. Conflicts with approved time off are flagged in red.</div>
    </Modal>
  );
}
