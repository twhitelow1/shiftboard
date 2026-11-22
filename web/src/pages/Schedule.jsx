import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, shiftTime, money, useAction, JobDot, Empty } from '../ui.jsx';
import { addDays, weekStart, range, dow, parseDate } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import { scheduleAreas, findArea, sameArea } from '../../../core/areas.js';
import ShiftDialog from './ShiftDialog.jsx';
import ImportDialog from './ImportDialog.jsx';
import ScheduleSheet from './ScheduleSheet.jsx';
import TradeHint, { canTrade } from './TradeHint.jsx';
import { EightySixBanner } from './EightySix.jsx';
import { IS_DEMO } from '../api.js';
import { useT, dowShort, fmtTime, monthShort, prettyDate, num , getLang } from '../i18n/index.js';

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
// The schedule's layout, remembered per device: 'sheet' (like the house PDF), 'job' (grid; the day
// view on phones) or 'emp'. Desktops open on the sheet, phones on the day view.
const VIEW_KEY = () => { try { return window.matchMedia('(max-width: 900px)').matches ? 'sb_view_phone' : 'sb_view'; } catch { return 'sb_view'; } };
function initialView() {
  try { const v = localStorage.getItem(VIEW_KEY()); if (['sheet', 'job', 'emp'].includes(v)) return v; } catch { /* ignore */ }
  return VIEW_KEY() === 'sb_view_phone' ? 'job' : 'sheet';
}
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

/** 'Sep 28 – Oct 4', 'Dec 1 – 7' · '28 sep – 4 oct', '1–7 dic'. */
export function weekLabel(ws) {
  const a = parseDate(ws), b = parseDate(addDays(ws, 6));
  const m1 = monthShort(a.getUTCMonth()), m2 = monthShort(b.getUTCMonth());
  if (getLang() === 'es') return m1 === m2 ? `${a.getUTCDate()}–${b.getUTCDate()} ${m1}` : `${a.getUTCDate()} ${m1} – ${b.getUTCDate()} ${m2}`;
  return m1 === m2 ? `${m1} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${m1} ${a.getUTCDate()} – ${m2} ${b.getUTCDate()}`;
}

export function WeekNav({ ws, setWs }) {
  const t = useT();
  const { today, settings } = useApp();
  return (
    <div className="weeknav">
      <button className="btn icon sm" onClick={() => setWs(addDays(ws, -7))} aria-label={t('schedule.previousWeek')}><Icon name="left" /></button>
      <div className="label">{weekLabel(ws)}</div>
      <button className="btn icon sm" onClick={() => setWs(addDays(ws, 7))} aria-label={t('common.nextWeek')}><Icon name="right" /></button>
      <button className="btn sm ghost" onClick={() => setWs(weekStart(today, settings.weekStartDow))}>{t('common.today')}</button>
    </div>
  );
}

export default function Schedule() {
  const t = useT();
  const app = useApp();
  const { isMgr, jobCodes, employees, jobs, people, me, settings, call, version, today } = app;
  const [ws, setWs] = useWeek();
  const [data, setData] = useState(null);
  const [fc, setFc] = useState(null);
  const [view, setViewState] = useState(initialView);
  const setView = (v) => { setViewState(v); try { localStorage.setItem(VIEW_KEY(), v); } catch { /* ignore */ } };
  const groupBy = view === 'emp' ? 'emp' : 'job';
  const [dept, setDept] = useState('');
  const [hideEmpty, setHideEmpty] = useState(!isMgr);
  const [mine, setMine] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [selDay, setSelDay] = useState(() => (today >= ws && today <= addDays(ws, 6) ? today : range(ws, 7).find((d) => !settings.closedDays.includes(dow(d))) || ws));
  const [importOpen, setImportOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [run, busy] = useAction();
  const days = range(ws, 7);

  const load = () => {
    call('shifts.list', { start: ws, end: addDays(ws, 6) }).then(setData).catch((e) => app.toast(e.message, 'bad'));
    call(isMgr ? 'forecast.summary' : 'forecast.covers', { weekStart: ws }).then(setFc).catch(() => setFc(null));
  };
  useEffect(load, [ws, version]);
  useEffect(() => { if (!(selDay >= ws && selDay <= addDays(ws, 6))) setSelDay(today >= ws && today <= addDays(ws, 6) ? today : days.find((d) => !settings.closedDays.includes(dow(d))) || ws); }, [ws]);

  const shifts = data?.shifts || [];
  const drafts = shifts.filter((s) => !s.published).length;
  const areaList = useMemo(() => scheduleAreas(settings), [settings]);
  // The banner a shift sits under: its area (Restaurant, Moon Rabbit…), else its job's department.
  const bannerOf = (s) => s.area || jobs[s.jobCodeId]?.department || '';

  const timeOffOn = (userId, date) => data?.timeOff?.find((t) => t.userId === userId && t.startDate <= date && t.endDate >= date);
  const hoursByUser = useMemo(() => {
    const m = {};
    for (const s of shifts) if (s.userId) m[s.userId] = (m[s.userId] || 0) + hoursOf(s, settings);
    return m;
  }, [shifts, settings]);

  const openDialog = (shift, startIn) => setDialog({ shift, startIn, warnings: data?.warnings?.[shift.id] });
  const addAt = (date, jobCodeId, userId, area = '') => isMgr && setDialog({ shift: { date, jobCodeId, userId, area, start: '16:00' } });
  const closeDialog = (changed) => { setDialog(null); if (changed) load(); };

  // Sections like the house sheet: an area banner (RESTAURANT, RABBIT HOLE…), then each position
  // worked there. Shifts go under their area; people also show under the areas their job code lists,
  // so a manager sees the whole roster. Without areas, a job's department is the banner.
  const allSections = useMemo(() => {
    if (!data) return [];
    const activeEmps = employees.filter((e) => e.active !== false && e.onSchedule !== false);
    const groups = new Map();
    const add = (banner, job) => {
      const name = findArea(banner, areaList) || banner || '';
      const k = `${name.toLowerCase()}|${job.id}`;
      if (!groups.has(k)) groups.set(k, { banner: name, isArea: !!findArea(name, areaList), job, users: new Set(), shifts: [] });
      return groups.get(k);
    };
    for (const sh of shifts) {
      const j = jobs[sh.jobCodeId];
      if (!j) continue;
      const g = add(bannerOf(sh), j);
      g.shifts.push(sh);
      if (sh.userId) g.users.add(sh.userId);
    }
    for (const e of activeEmps) {
      for (const entry of e.jobCodes || []) {
        const j = jobs[entry.jobCodeId];
        if (!j || j.archived) continue;
        for (const b of entry.areas?.length ? entry.areas : [j.department || '']) add(b, j).users.add(e.id);
      }
    }
    if (isMgr) for (const j of jobCodes) if (!j.archived && ![...groups.values()].some((g) => g.job.id === j.id)) add(j.department || '', j);
    // Department banners first (in job order, e.g. Leadership), then areas in the schedule's area order.
    const firstJob = {};
    for (const g of groups.values()) firstJob[g.banner] = Math.min(firstJob[g.banner] ?? 1e9, g.job.order ?? 1e9);
    const rank = (g) => (g.isArea ? 1e6 + areaList.findIndex((a) => sameArea(a, g.banner)) : firstJob[g.banner]);
    const byJob = (a, b) => (a.job.order ?? 0) - (b.job.order ?? 0) || a.job.name.localeCompare(b.job.name);
    return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.banner.localeCompare(b.banner) || byJob(a, b)).map((g) => {
      // The imported sheet's layout for this section: names in its order, its label and heading.
      const area = g.isArea ? g.banner : '';
      const roster = (data.rosters || []).find((r) => r.jobCodeId === g.job.id && (r.area ? sameArea(r.area, area) : !area));
      const at = (id) => { const i = roster?.userIds?.indexOf(id) ?? -1; return i < 0 ? 1e9 : i; };
      const rows = [...g.users].map((id) => people[id]).filter(Boolean).map((u) => ({ user: u, shifts: g.shifts.filter((x) => x.userId === u.id) }));
      rows.sort((a, b) => at(a.user.id) - at(b.user.id) || (a.user.order ?? 1e9) - (b.user.order ?? 1e9) || a.user.name.localeCompare(b.user.name));
      return { key: `${g.banner}|${g.job.id}`, job: g.job, banner: g.banner, area, label: g.job.name, rows, open: g.shifts.filter((x) => !x.userId),
        sheetLabel: roster ? roster.label : null, sheetBanner: roster?.banner || '' };
    });
  }, [data, employees, jobCodes, areaList, people, isMgr]);
  const banners = [...new Set(allSections.map((x) => x.banner).filter(Boolean))];

  const sections = useMemo(() => {
    if (!data) return [];
    const inBanner = (b) => !dept || sameArea(b, dept);
    if (groupBy === 'emp') {
      const activeEmps = employees.filter((e) => e.active !== false && e.onSchedule !== false);
      const worksIn = (e) => e.jobCodes?.some((x) => (x.areas?.length ? x.areas : [jobs[x.jobCodeId]?.department]).some(inBanner));
      const rows = activeEmps.filter((e) => (!mine || e.id === me.id))
        .map((e) => ({ user: e, shifts: shifts.filter((x) => x.userId === e.id && inBanner(bannerOf(x))) }))
        .filter((r) => (!dept || r.shifts.length || worksIn(r.user)) && (!hideEmpty || r.shifts.length || days.some((d) => timeOffOn(r.user.id, d))));
      const open = shifts.filter((x) => !x.userId && inBanner(bannerOf(x)));
      return [{ key: 'all', label: t('schedule.everyone'), rows, open }];
    }
    return allSections.filter((x) => inBanner(x.banner)).map((x) => {
      let rows = x.rows;
      if (mine) rows = rows.filter((r) => r.user.id === me.id);
      if (hideEmpty) rows = rows.filter((r) => r.shifts.length);
      return { ...x, rows, open: mine ? [] : x.open };
    }).filter((x) => x.rows.length || x.open.length || (isMgr && !hideEmpty && !mine));
  }, [allSections, data, employees, groupBy, dept, hideEmpty, mine]);

  // The sheet lists everyone on the roster (like the PDF), whatever the grid's filters are.
  const sheetSections = allSections.filter((x) => (!dept || sameArea(x.banner, dept)) && (x.rows.length || x.open.length));

  const publish = () => run(() => call('shifts.publish', { start: ws, end: addDays(ws, 6) }), (r) => t('schedule.publishedPublishedShiftsNotifiedPeople', { published: r.published, notified: r.notified })).then(load);

  const exportCsv = () => {
    const rows = [['date', 'employee', 'job', 'area', 'start', 'end', 'tag', 'notes', 'status']];
    for (const s of [...shifts].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) {
      rows.push([s.date, people[s.userId]?.name || 'OPEN', jobs[s.jobCodeId]?.name, s.area || '', s.start, s.end || '', s.tag, s.notes, s.published ? 'published' : 'draft']);
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
        onClick={(e) => { e.stopPropagation(); openDialog(s); }} title={[...(w || []), canTrade(s, me, today) && t('schedule.yourShiftTapToTrade')].filter(Boolean).join('\n')}>
        <span className="t">{shiftTime(s)}</span>
        {s.tag && <span className="tag">{s.tag}</span>}
        {w && <span className="warn-ico">!</span>}
        {s.pending && <span className="pend" title={t('schedule.swapPending')}>⇄</span>}
        {(showJob || !s.userId) && <div className="sub">{!s.userId ? t('common.open') : ''}{!s.userId && showJob ? ' · ' : ''}{showJob ? `${j?.name || ''}${s.area ? ` · ${s.area}` : ''}` : ''}</div>}
      </button>
    );
  };

  const Cell = ({ date, userId, list, jobCodeId, area }) => {
    const to = userId && timeOffOn(userId, date);
    const closed = isClosed(date);
    const canAdd = isMgr && !closed;
    return (
      <td className={`cell ${date === today ? 'today' : ''} ${closed && !list.length ? 'closed' : ''} ${canAdd ? 'can-add' : ''}`} onClick={() => {
        if (!canAdd) return;
        const entry = jobCodeId ? null : people[userId]?.jobCodes?.find((x) => x.primary) || people[userId]?.jobCodes?.[0];
        addAt(date, jobCodeId || entry?.jobCodeId, userId, area ?? entry?.areas?.[0] ?? '');
      }}>
        {list.sort((a, b) => a.start.localeCompare(b.start)).map((s) => <ShiftChip key={s.id} s={s} showJob={groupBy === 'emp'} />)}
        {!list.length && to && <span className="reqoff" title={to.reason || ''}>{to.status === 'approved' ? t('schedule.requestOff') : t('schedule.reqPending')}</span>}
        {!list.length && !to && !closed && userId && <span className="off">{isMgr ? '' : t('schedule.off')}</span>}
      </td>
    );
  };

  return (
    <div>
      <div className="toolbar">
        <WeekNav ws={ws} setWs={setWs} />
        <span className="spacer" />
        <div className="seg desktop-only">
          <button className={view === 'sheet' ? 'on' : ''} onClick={() => setView('sheet')} title={t('schedule.laidOutLikeTheSchedule')}>{t('schedule.sheet')}</button>
          <button className={view === 'job' ? 'on' : ''} onClick={() => setView('job')}>{t('schedule.grid')}</button>
          <button className={view === 'emp' ? 'on' : ''} onClick={() => setView('emp')}>{t('schedule.byEmployee')}</button>
        </div>
        <div className="seg mobile-only">
          <button className={view !== 'sheet' ? 'on' : ''} onClick={() => setView('job')}>{t('common.day')}</button>
          <button className={view === 'sheet' ? 'on' : ''} onClick={() => setView('sheet')}>{t('schedule.sheet')}</button>
        </div>
        {isMgr && <>
          <button className="btn sm desktop-only" onClick={() => setDialog({ shift: { date: selDay, start: '16:00' } })}><Icon name="plus" />{t('schedule.addShift')}</button>
          <button className={`btn sm ${drafts ? 'primary' : ''}`} onClick={publish} disabled={!drafts || busy}><Icon name="send" />{drafts ? t('schedule.publishCount', { count: drafts }) : t('schedule.published')}</button>
        </>}
      </div>
      <div className="toolbar" style={{ marginTop: -6 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={`chip ${!dept ? 'on' : ''}`} onClick={() => setDept('')}>{t('schedule.all')}</button>
          {banners.map((d) => <button key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => setDept(dept === d ? '' : d)}>{d}</button>)}
        </div>
        <span className="spacer" />
        {view !== 'sheet' && <>
          <label className="check small desktop-only"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />{t('schedule.onlyMe')}</label>
          <label className="check small desktop-only"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />{t('schedule.hidePeopleNotScheduled')}</label>
        </>}
        {/* Copy week and Import work on phones too; CSV and Print are desk tasks. */}
        {isMgr && <div className="row wrap" style={{ gap: 4 }}>
          <button className="btn sm ghost" onClick={() => setCopyOpen(true)} title={t('schedule.copyAWeek')}><Icon name="copy" />{t('schedule.copyWeek')}</button>
          <button className="btn sm ghost" onClick={() => setImportOpen(true)} title={t('schedule.importASchedulePdfExcel')}><Icon name="upload" />{t('schedule.import')}</button>
          <button className="btn sm ghost" onClick={() => setClearOpen(true)} title={t('schedule.deleteThisWeeksShiftsAnd')}><Icon name="trash" />{t('schedule.clearWeek')}</button>
          {!IS_DEMO && <button className="btn sm ghost desktop-only" onClick={exportCsv}><Icon name="download" />{t('schedule.csv')}</button>}
          {!IS_DEMO && <button className="btn sm ghost desktop-only" onClick={() => window.print()}><Icon name="print" />{t('schedule.print')}</button>}
        </div>}
      </div>

      {fc && isMgr && (
        <div className="row wrap small desktop-only no-print" style={{ marginBottom: 10, gap: 14 }}>
          <span className="muted">{t('schedule.weekForecastLine', { covers: <b className="num">{num(fc.totals.covers)}</b>, sales: <b className="num">{money(fc.totals.sales)}</b> })}</span>
          <span className="muted">{t('schedule.scheduledLine', { hours: <b className="num">{fc.totals.hours}</b>, cost: <b className="num">{money(fc.totals.cost)}</b> })}</span>
          <span className={`badge ${fc.totals.laborPct > fc.targetLaborPct ? 'bad' : 'ok'}`}>{t('schedule.labor')}{' '}{fc.totals.laborPct ?? '—'}{t('schedule.targetTargetlaborpct', { targetLaborPct: fc.targetLaborPct })}</span>
          {drafts > 0 && <span className="badge warn">{t('schedule.countDraftShiftsNotVisible', { count: drafts })}</span>}
        </div>
      )}

      {!data ? <div className="empty">{t('common.loading')}</div> : (
        <>
          <TradeHint shifts={shifts} />
          {/* Like the house PDF. Print always uses this layout. */}
          <ScheduleSheet className={view === 'sheet' ? 'sheet-print' : 'sheet-print print-only'} sections={sheetSections} days={days} data={data} fc={fc} ws={ws}
            onAdd={addAt} onOpen={openDialog} onSaved={load} />

          {/* Desktop grid */}
          {view !== 'sheet' && <div className="sched-wrap desktop-only no-print">
            <table className="sched">
              <thead>
                <tr>
                  <th className="namecol">
                    <div className="small faint">{t('schedule.filtercountShiftsFiltercount2Open', { count: shifts.filter((s) => s.userId).length, open: shifts.filter((s) => !s.userId).length })}</div>
                  </th>
                  {days.map((d) => {
                    const f = fcDay(d);
                    const evs = data.events.filter((e) => e.date === d);
                    return (
                      <th key={d} className={`dayhead ${d === today ? 'today' : ''}`}>
                        <div className="d1">{dowShort(dow(d))}</div>
                        <div className="d2">{parseDate(d).getUTCMonth() + 1}/{parseDate(d).getUTCDate()}</div>
                        {isClosed(d) ? <div className="meta">{t('common.closed')}</div> : f && <div className="meta num">{t('schedule.totalcoversCvrs', { totalCovers: f.totalCovers })}{isMgr ? ` · ${f.laborPct ?? '—'}%` : ''}</div>}
                        {evs.map((e) => <a key={e.id} className="evt-pill" href={`#/events/${e.id}`} title={t('schedule.nameTimeGuestcountGuests', { name: e.name, time: fmtTime(e.start), guestCount: e.guestCount })}>{fmtTime(e.start)} {e.name}{e.guestCount ? ` (${e.guestCount})` : ''}</a>)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sections.map((sec, i) => (
                  <React.Fragment key={sec.key}>
                    {/* Area banner when the area changes, like the house sheet (RESTAURANT, RABBIT HOLE…). */}
                    {groupBy === 'job' && sec.banner && sec.banner !== sections[i - 1]?.banner && (
                      <tr className="section area"><td colSpan={8}><div className="row">{sec.banner}</div></td></tr>
                    )}
                    {groupBy === 'job' && (
                      <tr className="section"><td colSpan={8}><div className="row"><JobDot job={sec.job} />{sec.label}</div></td></tr>
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
                                {(isMgr || user.id === me.id) && <div className={`emp-hrs ${hrs > settings.overtimeHours ? 'ot' : ''}`}>{hrs ? t('schedule.hrsHrs', { hrs: hrs.toFixed(1) }) : '—'}</div>}
                              </div>
                            </div>
                          </td>
                          {days.map((d) => <Cell key={d} date={d} userId={user.id} jobCodeId={sec.job?.id} area={sec.job ? sec.area : undefined} list={us.filter((s) => s.date === d)} />)}
                        </tr>
                      );
                    })}
                    {sec.open.length > 0 && (
                      <tr>
                        <td className="namecol"><div className="emp"><span className="avatar sm" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>+</span><div className="emp-name faint">{t('schedule.openShifts')}</div></div></td>
                        {days.map((d) => <Cell key={d} date={d} jobCodeId={sec.job?.id} area={sec.area} list={sec.open.filter((s) => s.date === d)} />)}
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {!sections.length && <tr><td colSpan={8}><Empty title={t('schedule.nothingScheduled')}>{isMgr ? t('schedule.clickAnyCellToAdd') : t('schedule.theScheduleForThisWeek')}</Empty></td></tr>}
              </tbody>
              {isMgr && (
                <tfoot>
                  <tr className="totals">
                    <td className="namecol">{t('schedule.scheduled2')}</td>
                    {days.map((d) => {
                      const f = fcDay(d);
                      const n = shifts.filter((s) => s.date === d).length;
                      return <td key={d} className="num">{n ? t('schedule.nShiftsValueHAmount', { count: n, value: f?.hours ?? 0, amount: money(f?.laborCost) }) : '—'}</td>;
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>}

          {/* Mobile day view */}
          {view !== 'sheet' && <div className="mobile-only no-print">
            <MobileDay days={days} selDay={selDay} setSelDay={setSelDay} data={data} sections={sections} mine={mine} setMine={setMine} openDialog={openDialog} isClosed={isClosed} fcDay={fcDay} addAt={addAt} />
          </div>}
        </>
      )}

      {dialog && <ShiftDialog shift={dialog.shift} startIn={dialog.startIn} warnings={dialog.warnings} events={data?.events || []} onClose={closeDialog} />}
      {importOpen && <ImportDialog ws={ws} onClose={(changed) => { setImportOpen(false); if (changed) load(); }} />}
      {clearOpen && <ClearWeekDialog ws={ws} data={data} onClose={(changed) => { setClearOpen(false); if (changed) load(); }} />}
      {copyOpen && <CopyWeekDialog ws={ws} onClose={(changed, goTo) => { setCopyOpen(false); if (goTo && goTo !== ws) setWs(goTo); else if (changed) load(); }} />}
    </div>
  );
}

function MobileDay({ days, selDay, setSelDay, data, sections, mine, setMine, openDialog, isClosed, fcDay, addAt }) {
  const t = useT();
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
            <span className="a">{dowShort(dow(d))}</span>
            <span className="b">{parseDate(d).getUTCDate()}</span>
            {data.shifts.some((s) => s.date === d && s.userId === me.id) ? <span className="c" /> : <span style={{ height: 7 }} />}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg">
          <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>{t('schedule.everyone')}</button>
          <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>{t('schedule.justMe')}</button>
        </div>
        <span className="spacer" />
        {f && !f.closed && <span className="small muted num">{t('schedule.totalcoversCvrs', { totalCovers: f.totalCovers })}{isMgr ? ` · ${f.laborPct ?? '—'}%` : ''}</span>}
        {isMgr && !isClosed(selDay) && <button className="btn sm primary" onClick={() => addAt(selDay)}><Icon name="plus" />{t('schedule.add')}</button>}
      </div>
      {selDay === today && <EightySixBanner />}
      {evs.map((e) => (
        <a key={e.id} href={`#/events/${e.id}`} className="alert warn" style={{ marginBottom: 8 }}>
          <Icon name="glass" size={16} />
          <div><b>{e.name}</b><div className="small">{t('schedule.timeRoomGuestcountGuests', { time: fmtTime(e.start), room: e.room, guestCount: e.guestCount })}</div></div>
        </a>
      ))}
      {(data.notes || []).filter((n) => n.kind === 'day' && n.date === selDay).map((n) => <div key={n.id} className="alert info" style={{ marginBottom: 8 }}><Icon name="alert" size={16} /><b>{n.text}</b></div>)}
      {isClosed(selDay) && <Empty title={t('common.closed')} />}
      {!isClosed(selDay) && !daySecs.length && <Empty title={mine ? t('schedule.youreOff') : t('schedule.noShifts')} />}
      {daySecs.map((sec, i) => (
        <div key={sec.key} className="dgroup">
          {sec.banner && sec.banner !== daySecs[i - 1]?.banner && <div className="dbanner">{sec.banner}</div>}
          <div className="dgroup-h">{sec.job && <JobDot job={sec.job} />}{sec.label}<span className="faint">{sec.items.length}</span></div>
          {sec.items.map((s) => (
            <div key={s.id} className={`mshift ${s.userId === me.id ? 'mine' : ''} ${!s.userId ? 'open' : ''}`} style={{ '--jc': jobs[s.jobCodeId]?.color }} onClick={() => openDialog(s)}>
              <Avatar user={people[s.userId]} size="sm" />
              <div className="who">
                {s.userId ? people[s.userId]?.name : t('common.openShift')}
                <div className="small muted" style={{ fontWeight: 500 }}>{jobs[s.jobCodeId]?.short}{s.area && !sec.area ? ` · ${s.area}` : ''}{s.tag ? ` · ${s.tag}` : ''}{!s.published ? t('schedule.draft') : ''}{s.pending ? t('schedule.swapPending2') : ''}</div>
              </div>
              <div className="when">{shiftTime(s)}</div>
              {canTrade(s, me, today) && <button className="btn sm" onClick={(e) => { e.stopPropagation(); openDialog(s); }}><Icon name="swap" />{t('common.trade')}</button>}
            </div>
          ))}
        </div>
      ))}
      {!mine && offToday.length > 0 && (
        <div className="small muted" style={{ marginTop: 8 }}>{t('schedule.offRequested')}{' '}{offToday.map((t) => people[t.userId]?.name).filter(Boolean).join(', ')}</div>
      )}
    </div>
  );
}

function ClearWeekDialog({ ws, data, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [published, setPublished] = useState(false);
  const [notes, setNotes] = useState(false);
  const [run, busy] = useAction();
  const shifts = (data?.shifts || []).filter((s) => !s.eventId);
  const drafts = shifts.filter((s) => !s.published).length;
  const posted = shifts.length - drafts;
  const eventShifts = (data?.shifts || []).length - shifts.length;
  const noteCount = (data?.notes || []).length;
  const count = drafts + (published ? posted : 0);
  const go = async () => {
    const r = await run(() => call('shifts.clearWeek', { weekStart: ws, published, notes }),
      (r) => [`Deleted ${r.removed} shifts from ${weekLabel(ws)}`, r.published && `${r.published} were posted; those people were notified`, r.notes && `${r.notes} notes cleared`].filter(Boolean).join(' · '));
    if (r) onClose(true);
  };
  return (
    <Modal title={t('schedule.clearWeek2', { week: weekLabel(ws) })} sub={t('schedule.deleteThisWeeksShiftsAnd2')} onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn danger solid" disabled={busy || (!count && !(notes && noteCount))} onClick={go}><Icon name="trash" />{count ? t('schedule.deleteCountShifts', { count }) : t('schedule.clear')}</button></>}>
      <div className="col" style={{ gap: 10 }}>
        <div>{t('schedule.bCountBDraftShifts', { count: drafts })}{!drafts && t('schedule.thereAreNone')}</div>
        {posted > 0 && (
          <label className="check"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            <span>{t('schedule.alsoDeleteTheBCount', { count: posted })}</span></label>
        )}
        {noteCount > 0 && <label className="check"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />{t('schedule.alsoClearThisWeeksDay', { noteCount })}</label>}
        {eventShifts > 0 && <div className="help">{t('schedule.countEventShiftsFromBeos', { count: eventShifts })}</div>}
        <div className="help">{t('schedule.peopleJobCodesEventsTime')}</div>
      </div>
    </Modal>
  );
}

function CopyWeekDialog({ ws, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [mode, setMode] = useState('forward'); // forward: this week → another week; into: another week → this week
  const [other, setOther] = useState(addDays(ws, 7));
  const [replace, setReplace] = useState(true);
  const [run, busy] = useAction();
  const switchMode = (m) => { setMode(m); setOther(addDays(ws, m === 'forward' ? 7 : -7)); };
  const from = mode === 'forward' ? ws : other;
  const to = mode === 'forward' ? other : ws;
  const go = async () => {
    const r = await run(() => call('shifts.copyWeek', { fromWeek: from, toWeek: to, replace }),
      (r) => `${t('schedule.copiedShifts', { count: r.copied, week: weekLabel(to) })}${r.skipped ? t('schedule.skippedInactive', { count: r.skipped }) : ''}`);
    if (r) onClose(true, to);
  };
  return (
    <Modal title={t('schedule.copyAWeek')} sub={t('schedule.buildANewWeekIn')} onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || from === to} onClick={go}><Icon name="copy" />{t('schedule.copyAsDrafts')}</button></>}>
      <div className="tabs" style={{ marginBottom: 4 }}>
        <button className={mode === 'forward' ? 'on' : ''} onClick={() => switchMode('forward')}>{t('schedule.thisWeekAnotherWeek')}</button>
        <button className={mode === 'into' ? 'on' : ''} onClick={() => switchMode('into')}>{t('schedule.anotherWeekThisWeek')}</button>
      </div>
      <Field label={mode === 'forward' ? t('schedule.copyWeekIntoTheWeek', { week: weekLabel(ws) }) : t('schedule.copyIntoWeekFromThe', { week: weekLabel(ws) })}
        help={t('schedule.everyoneKeepsTheSameJob')}>
        <div className="row">
          <button className="btn icon sm" onClick={() => setOther(addDays(other, -7))}><Icon name="left" /></button>
          <div style={{ fontWeight: 700, minWidth: 140, textAlign: 'center' }}>{weekLabel(other)}</div>
          <button className="btn icon sm" onClick={() => setOther(addDays(other, 7))}><Icon name="right" /></button>
        </div>
      </Field>
      {from === to && <div className="alert warn"><Icon name="alert" size={16} />{t('schedule.pickADifferentWeek')}</div>}
      <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />{t('schedule.replaceDraftShiftsAlreadyIn', { week: weekLabel(to) })}</label>
      <div className="help">{t('schedule.copiedShiftsStayAsDrafts')}</div>
    </Modal>
  );
}
