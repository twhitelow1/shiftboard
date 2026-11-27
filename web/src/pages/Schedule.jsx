import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, shiftTime, money, useAction, JobDot, Empty } from '../ui.jsx';
import { addDays, weekStart, range, dow, parseDate } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import { sameArea, bannerColor, textOn } from '../../../core/areas.js';
import { buildSections, shiftChoices, offPrimary } from '../../../core/layout.js';
import { dayList, daySort, positionSections } from '../../../core/day-list.js';
import ShiftDialog from './ShiftDialog.jsx';
import { useShiftPaste } from './ShiftPaste.jsx'; // copy & paste a shift (managers)
import ImportDialog from './ImportDialog.jsx';
import ScheduleSheet from './ScheduleSheet.jsx';
import SectionPeople from './SectionPeople.jsx';
import { RoomDialog } from './RoomsPositions.jsx';
import TradeHint, { canTrade } from './TradeHint.jsx';
import { EightySixBanner } from './EightySix.jsx';
import UnpublishWeek from './UnpublishWeek.jsx';
import PublishDialog from './PublishDialog.jsx';
import { useScheduleConflicts, BlockedLabel, WindowNote, ConflictMark } from './ScheduleConflicts.jsx'; // blocked days (managers)
import PersonPanel from './PersonPanel.jsx'; // a name opens the person's panel (managers)
import SchedulePdfDialog from './SchedulePdf.jsx';
import { useProgrammingDays, ParRow, CoveragePanel, DayProgramming } from './ProgrammingParts.jsx'; // regular programming, pars and coverage
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
// The schedule's layout, remembered per device: 'sheet' (like the house PDF), 'job' (the week grid by
// room; the day view on phones), 'pos' (the week grid by position across rooms), 'emp' (by employee) or
// 'day' (desktops: the day list). Desktops open on the sheet, phones on the day view.
const VIEW_KEY = () => { try { return window.matchMedia('(max-width: 900px)').matches ? 'sb_view_phone' : 'sb_view'; } catch { return 'sb_view'; } };
function initialView() {
  try { const v = localStorage.getItem(VIEW_KEY()); if (['sheet', 'job', 'pos', 'emp', 'day'].includes(v)) return v; } catch { /* ignore */ }
  return VIEW_KEY() === 'sb_view_phone' ? 'job' : 'sheet';
}
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }
// How the day list is sorted (core/day-list.js: room, position, time, name), remembered per device.
const SORT_KEY = 'sb_day_sort';
function initialSort() { try { return daySort(localStorage.getItem(SORT_KEY)); } catch { return 'room'; } }

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
  const { isMgr, employees, jobs, people, me, settings, call, version, today, layout } = app;
  const [ws, setWs] = useWeek();
  const [data, setData] = useState(null);
  const [daysOff, setDaysOff] = useState([]); // days off a manager marked (core/quick-shift.js): DAY OFF on the sheet and grid
  const [fc, setFc] = useState(null);
  const [view, setViewState] = useState(initialView);
  const setView = (v) => { setViewState(v); try { localStorage.setItem(VIEW_KEY(), v); } catch { /* ignore */ } };
  const groupBy = view === 'emp' ? 'emp' : view === 'pos' ? 'pos' : 'job';
  const [dept, setDept] = useState('');
  const [hideEmpty, setHideEmpty] = useState(!isMgr);
  const [mine, setMine] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [selDay, setSelDay] = useState(() => (today >= ws && today <= addDays(ws, 6) ? today : range(ws, 7).find((d) => !settings.closedDays.includes(dow(d))) || ws));
  const [importOpen, setImportOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false); // Publish: notify or not, the PDF attachment
  const [pdfOpen, setPdfOpen] = useState(false); // Download PDF (everyone: staff get the published week)
  const [run, busy] = useAction();
  const days = range(ws, 7);
  const cx = useScheduleConflicts(ws, isMgr); // blocked days and shifts over them (ScheduleConflicts.jsx)
  const [personId, setPersonId] = useState(null); // the person panel (PersonPanel.jsx)

  const load = () => {
    call('shifts.list', { start: ws, end: addDays(ws, 6) }).then(setData).catch((e) => app.toast(e.message, 'bad'));
    call('schedule.dayOff.list', { start: ws, end: addDays(ws, 6) }).then(setDaysOff).catch(() => setDaysOff([]));
    call(isMgr ? 'forecast.summary' : 'forecast.covers', { weekStart: ws }).then(setFc).catch(() => setFc(null));
    cx.reload();
  };
  useEffect(load, [ws, version]);
  const prog = useProgrammingDays(ws, addDays(ws, 6)); // the day notes' programming and (managers) coverage vs par
  const reloadAll = () => { load(); prog.reload(); };
  useEffect(() => { if (!(selDay >= ws && selDay <= addDays(ws, 6))) setSelDay(today >= ws && today <= addDays(ws, 6) ? today : days.find((d) => !settings.closedDays.includes(dow(d))) || ws); }, [ws]);

  const shifts = data?.shifts || [];
  const drafts = shifts.filter((s) => !s.published).length;

  const timeOffOn = (userId, date) => data?.timeOff?.find((t) => t.userId === userId && t.startDate <= date && t.endDate >= date);
  const hoursByUser = useMemo(() => {
    const m = {};
    for (const s of shifts) if (s.userId) m[s.userId] = (m[s.userId] || 0) + hoursOf(s, settings);
    return m;
  }, [shifts, settings]);

  const [editSection, setEditSection] = useState(null); // the section whose people a manager is editing
  const [arrange, setArrange] = useState(null); // the room whose positions a manager is arranging (Rooms & positions)
  const [strayOpen, setStrayOpen] = useState(false);
  // A shift or a cell that belongs to one person and one day opens in quick mode (ShiftDialog.jsx): only the time,
  // tag and notes change there. The toolbar's Add shift (no cell) opens the full form.
  // target: the cell it came from, for "Paste copied shift" (core/shift-paste.js): its person and day, and the row's position and room if it has one.
  const openDialog = (shift, startIn) => setDialog({ shift, startIn, warnings: data?.warnings?.[shift.id], quick: isMgr && !!shift.userId,
    target: shift.userId ? { userId: shift.userId, date: shift.date, jobCodeId: shift.jobCodeId, area: shift.area || '' } : null });
  const addAt = (date, jobCodeId, userId, area = '', target) => isMgr && setDialog({ shift: { date, jobCodeId, userId, area, start: '16:00' }, quick: !!userId,
    target: userId ? target || { userId, date, ...(jobCodeId ? { jobCodeId, area } : {}) } : null });
  const paste = useShiftPaste({ enabled: isMgr }); // Copy, Paste, Ctrl/Cmd+C and V, Shift+click or drag across cells
  const dayOffOn = (userId, date) => userId && daysOff.find((d) => d.userId === userId && d.date === date);
  const undoDayOff = async (userId, date) => { const r = await run(() => call('schedule.dayOff.clear', { userId, date }), t('quickShift.dayOffCleared')); if (r) load(); };
  const closeDialog = (changed) => { setDialog(null); if (changed) load(); };

  // Sections like the house sheet, from Settings → Rooms & positions (core/layout.js): each room's
  // banner (RESTAURANT, RABBIT HOLE…), then its shown positions in order. A section lists the people
  // who hold that position in that room, plus anyone with a shift there this week. Shifts in hidden
  // or unlisted sections (stray) never show; managers get a notice to move them or show the section.
  const { sections: allSections, stray } = useMemo(() => (data
    ? buildSections({ layout, jobs, employees, shifts, rosters: data.rosters, settings })
    : { sections: [], stray: [] }), [data, layout, jobs, employees, settings]);
  const strayIds = useMemo(() => new Set(stray.flatMap((x) => x.shifts.map((s) => s.id))), [stray]);
  const strayCount = strayIds.size;
  const banners = [...new Set(allSections.map((x) => x.banner).filter(Boolean))];

  const sections = useMemo(() => {
    if (!data) return [];
    const inBanner = (b) => !dept || sameArea(b, dept);
    if (groupBy === 'emp') {
      const activeEmps = employees.filter((e) => e.active !== false && e.onSchedule !== false);
      // By employee: the shifts the sections show (none from hidden or unlisted sections), per room filter.
      const roomOf = new Map(allSections.flatMap((sec) => [...sec.rows.flatMap((r) => r.shifts), ...sec.open].map((x) => [x.id, sec.banner])));
      const worksIn = (e) => allSections.some((sec) => inBanner(sec.banner) && sec.rows.some((r) => r.user.id === e.id));
      const rows = activeEmps.filter((e) => (!mine || e.id === me.id))
        .map((e) => ({ user: e, shifts: shifts.filter((x) => x.userId === e.id && !strayIds.has(x.id) && inBanner(roomOf.get(x.id))) }))
        .filter((r) => (!dept || r.shifts.length || worksIn(r.user)) && (!hideEmpty || r.shifts.length || days.some((d) => timeOffOn(r.user.id, d))));
      const open = shifts.filter((x) => !x.userId && !strayIds.has(x.id) && inBanner(roomOf.get(x.id)));
      return [{ key: 'all', label: t('schedule.everyone'), rows, open }];
    }
    const pick = (list) => list.map((x) => {
      let rows = x.rows;
      if (mine) rows = rows.filter((r) => r.user.id === me.id);
      if (hideEmpty) rows = rows.filter((r) => r.shifts.length);
      return { ...x, rows, open: mine ? [] : x.open };
    }).filter((x) => x.rows.length || x.open.length || (isMgr && !hideEmpty && !mine));
    const inRoom = allSections.filter((x) => inBanner(x.banner));
    // By position: each position once, across the rooms (core/day-list.js positionSections).
    return pick(groupBy === 'pos' ? positionSections(inRoom, getLang()) : inRoom);
  }, [allSections, strayIds, data, employees, groupBy, dept, hideEmpty, mine]);

  // The sheet lists everyone on the roster (like the PDF), whatever the grid's filters are.
  const sheetSections = allSections.filter((x) => (!dept || sameArea(x.banner, dept)) && (x.rows.length || x.open.length));


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

  // Plain functions (not components), so the cells keep their focus and selection across renders.
  const shiftChip = ({ s, showJob, room }) => {
    const j = jobs[s.jobCodeId];
    const w = data?.warnings?.[s.id];
    return (
      <div className="chip-wrap" key={s.id}>
      <button data-shift-id={s.id} className={`shift ${s.published ? '' : 'draft'} ${!s.userId ? 'open' : ''} ${s.userId === me.id ? 'mine' : ''} ${s.userId && offPrimary(s, people[s.userId], j) ? 'elsewhere' : ''}`} style={{ '--jc': j?.color || '#888' }}
        onClick={(e) => { e.stopPropagation(); openDialog(s); }} title={[...(w || []), canTrade(s, me, today) && t('schedule.yourShiftTapToTrade')].filter(Boolean).join('\n')}>
        <span className="t">{shiftTime(s)}</span>
        {s.tag && <span className="tag">{s.tag}</span>}
        {w && <span className="warn-ico">!</span>}<ConflictMark info={cx.shift(s.id)} />
        {s.pending && <span className="pend" title={t('schedule.swapPending')}>⇄</span>}
        {(showJob || room || !s.userId) && <div className="sub">{[!s.userId && t('common.open'), showJob && `${j?.name || ''}${s.area ? ` · ${s.area}` : ''}`, room].filter(Boolean).join(' · ')}</div>}
      </button>
      {s.userId && paste.copyButton(s)}
      </div>
    );
  };

  const cell = ({ date, userId, list, jobCodeId, area, roomOf, rowKey }) => {
    const to = userId && timeOffOn(userId, date);
    const off = dayOffOn(userId, date);
    const cxc = cx.cell(userId, date); // blocked (hatched) or the window they're available in
    const closed = isClosed(date);
    const canAdd = isMgr && !closed;
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    // The row's own position and room (by room, by position); by employee there's none: the paste decides (core/shift-paste.js).
    const target = userId && canAdd ? { userId, date, ...(jobCodeId ? { jobCodeId, area: area ?? '' } : {}) } : null;
    const pc = rowKey ? paste.cell('grid', rowKey, days.indexOf(date), target, sorted) : null;
    return (
      <td key={date} {...(pc?.props || {})} className={`cell ${date === today ? 'today' : ''} ${closed && !list.length ? 'closed' : ''} ${cxc?.block && !list.length ? 'cx-blocked' : ''} ${canAdd ? 'can-add' : ''} ${pc?.selected ? 'psel' : ''}`} onClick={() => {
        if (!canAdd) return;
        const entry = jobCodeId ? null : people[userId]?.jobCodes?.find((x) => x.primary) || people[userId]?.jobCodes?.[0];
        addAt(date, jobCodeId || entry?.jobCodeId, userId, area ?? entry?.areas?.[0] ?? '', target);
      }}>
        {sorted.map((s) => shiftChip({ s, showJob: groupBy === 'emp', room: roomOf?.[s.id] }))}
        {pc?.pasteButton(!list.length)}
        {!list.length && off && <span className="dayoff" title={t('quickShift.cellTitle')}>{t('quickShift.cell')}
          {isMgr && <button type="button" className="dayoff-undo no-print" disabled={busy} onClick={(e) => { e.stopPropagation(); undoDayOff(userId, date); }}>{t('quickShift.undo')}</button>}</span>}
        {!list.length && !off && cxc?.block && <BlockedLabel block={cxc.block} />}
        {!list.length && !off && !cxc?.block && cxc?.window && <WindowNote w={cxc.window} />}
        {!list.length && !off && !cxc?.block && to && <span className="reqoff" title={to.reason || ''}>{to.status === 'approved' ? t('schedule.requestOff') : t('schedule.reqPending')}</span>}
        {!list.length && !off && !to && !cxc && !closed && userId && <span className="off">{isMgr ? '' : t('schedule.off')}</span>}
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
          <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')} title={t('dayList.dayTitle')}>{t('common.day')}</button>
          <button className={view === 'job' ? 'on' : ''} onClick={() => setView('job')} title={t('dayList.gridRoomTitle')}>{t('dayList.byRoom')}</button>
          <button className={view === 'pos' ? 'on' : ''} onClick={() => setView('pos')} title={t('dayList.gridPositionTitle')}>{t('dayList.byPosition')}</button>
          <button className={view === 'emp' ? 'on' : ''} onClick={() => setView('emp')}>{t('schedule.byEmployee')}</button>
        </div>
        <div className="seg mobile-only">
          <button className={view !== 'sheet' ? 'on' : ''} onClick={() => setView('job')}>{t('common.day')}</button>
          <button className={view === 'sheet' ? 'on' : ''} onClick={() => setView('sheet')}>{t('schedule.sheet')}</button>
        </div>
        {isMgr && <>
          <button className="btn sm desktop-only" onClick={() => setDialog({ shift: { date: selDay, start: '16:00' } })}><Icon name="plus" />{t('schedule.addShift')}</button>
          <button className={`btn sm ${drafts ? 'primary' : ''}`} onClick={() => setPublishOpen(true)} disabled={!drafts || busy}><Icon name="send" />{drafts ? t('schedule.publishCount', { count: drafts }) : t('schedule.published')}</button>
          <UnpublishWeek ws={ws} shifts={shifts} rooms={banners} room={dept} />
        </>}
      </div>
      <div className="toolbar" style={{ marginTop: -6 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={`chip ${!dept ? 'on' : ''}`} onClick={() => setDept('')}>{t('schedule.all')}</button>
          {banners.map((d) => <button key={d} className={`chip ${dept === d ? 'on' : ''}`} onClick={() => setDept(dept === d ? '' : d)}>{d}</button>)}
        </div>
        <span className="spacer" />
        {view !== 'sheet' && view !== 'day' && <>
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
        <button className="btn sm ghost" onClick={() => setPdfOpen(true)} title={t('schedulePdf.buttonTitle')}><Icon name="download" />{t('schedulePdf.button')}</button>
      </div>

      {paste.pill}
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
          {isMgr && strayCount > 0 && (
            <button type="button" className="alert warn stray-note no-print" style={{ marginBottom: 10 }} onClick={() => setStrayOpen(true)}>
              <Icon name="alert" size={16} /><span>{t('schedule.strayShifts', { count: strayCount })}</span><span className="link">{t('schedule.review')}</span>
            </button>
          )}
          <TradeHint shifts={shifts} />
          {/* Like the house PDF. Print always uses this layout. */}
          <ScheduleSheet className={view === 'sheet' ? 'sheet-print' : 'sheet-print print-only'} sections={sheetSections} days={days} data={data} fc={fc} ws={ws} programming={prog.byDate}
            onAdd={addAt} onOpen={openDialog} onSaved={load} daysOff={daysOff} onUndoDayOff={isMgr ? undoDayOff : undefined} onEditSection={isMgr ? (sec) => setEditSection(allSections.find((x) => x.key === sec.key) || sec) : undefined}
            onArrange={isMgr ? setArrange : undefined} paste={view === 'sheet' ? paste : null} conflicts={isMgr ? cx : null} onPerson={isMgr ? setPersonId : undefined} />

          {/* Desktop grid */}
          {view !== 'sheet' && view !== 'day' && <div className="sched-wrap desktop-only no-print">
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
                        {!isClosed(d) && prog.byDate[d]?.note && <div className="meta prog-autonote" title={prog.byDate[d].note}>{prog.byDate[d].note}</div>}
                        {evs.map((e) => <a key={e.id} className="evt-pill" href={`#/events/${e.id}`} title={t('schedule.nameTimeGuestcountGuests', { name: e.name, time: fmtTime(e.start), guestCount: e.guestCount })}>{fmtTime(e.start)} {e.name}{e.guestCount ? ` (${e.guestCount})` : ''}</a>)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {paste.begin('grid')}
                {sections.map((sec, i) => (
                  <React.Fragment key={sec.key}>
                    {/* Area banner when the area changes, like the house sheet (RESTAURANT, RABBIT HOLE…). */}
                    {groupBy === 'job' && sec.banner && sec.banner !== sections[i - 1]?.banner && (
                      <tr className="section area"><td colSpan={8} style={(() => { const c = bannerColor(settings, sec.banner, sec.roomIndex ?? 0); return { background: c, color: textOn(c) }; })()}><div className="row">{sec.banner}
                        {isMgr && <button className="btn ghost sm no-print" style={{ marginLeft: 'auto', color: 'inherit' }} onClick={() => setArrange(sec.banner)}><Icon name="layers" />{t('arrange.button')}</button>}</div></td></tr>
                    )}
                    {groupBy !== 'emp' && (
                      <tr className="section"><td colSpan={8}><div className="row"><JobDot job={sec.job} />{sec.label}
                        {groupBy === 'pos' && sec.rooms?.length > 0 && <span className="faint" style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· {sec.rooms.join(' · ')}</span>}
                        {isMgr && sec.job && groupBy === 'job' && <button className="btn ghost sm no-print" style={{ marginLeft: 'auto' }} title={t('sectionPeople.editTitle')}
                          onClick={() => setEditSection(allSections.find((x) => x.key === sec.key) || sec)}><Icon name="users" />{t('sectionPeople.people')}</button>}</div></td></tr>
                    )}
                    {sec.rows.map(({ user, shifts: us, area: rowArea }) => {
                      const hrs = hoursByUser[user.id] || 0;
                      return (
                        <tr key={user.id} className={user.id === me.id ? 'me' : ''}>
                          <td className="namecol">
                            <div className="emp">
                              <Avatar user={user} size="sm" />
                              <div style={{ minWidth: 0 }}>
                                <div className="emp-name">{isMgr ? <button type="button" className="pp-name" onClick={() => setPersonId(user.id)} title={t('personPanel.open', { name: user.name })}>{user.name}</button> : user.name}</div>
                                {(isMgr || user.id === me.id) && <div className={`emp-hrs ${hrs > settings.overtimeHours ? 'ot' : ''}`}>{hrs ? t('schedule.hrsHrs', { hrs: hrs.toFixed(1) }) : '—'}</div>}
                              </div>
                            </div>
                          </td>
                          {days.map((d) => cell({ date: d, userId: user.id, jobCodeId: sec.job?.id, area: sec.job ? rowArea ?? sec.area : undefined, list: us.filter((s) => s.date === d),
                            roomOf: sec.rooms?.length > 1 ? sec.roomOf : undefined, rowKey: `${sec.key}|${user.id}` }))}
                        </tr>
                      );
                    })}
                    {sec.open.length > 0 && (
                      <tr>
                        <td className="namecol"><div className="emp"><span className="avatar sm" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>+</span><div className="emp-name faint">{t('schedule.openShifts')}</div></div></td>
                        {days.map((d) => cell({ date: d, jobCodeId: sec.job?.id, area: sec.area, list: sec.open.filter((s) => s.date === d), roomOf: sec.rooms?.length > 1 ? sec.roomOf : undefined }))}
                      </tr>
                    )}
                    {isMgr && groupBy === 'job' && sec.job && sec.banner && <ParRow banner={sec.banner} jobCodeId={sec.job.id} days={days} byDate={prog.byDate} />}
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

          {/* The day list: phones (any view but the sheet), and desktops' Day view. */}
          {view !== 'sheet' && <div className={`${view === 'day' ? 'day-desk' : 'mobile-only'} no-print`}>
            <MobileDay days={days} selDay={selDay} setSelDay={setSelDay} data={data} daysOff={daysOff} room={dept} mine={mine} setMine={setMine} openDialog={openDialog} isClosed={isClosed} fcDay={fcDay} addAt={addAt} prog={prog} />
          </div>}
          {isMgr && view !== 'sheet' && <CoveragePanel days={days} byDate={prog.byDate} onChanged={reloadAll} />}
        </>
      )}

      {arrange != null && <RoomDialog room={arrange} onClose={(changed) => { setArrange(null); if (changed) load(); }} />}
      {strayOpen && <StrayDialog stray={stray} ws={ws} onClose={(changed) => { setStrayOpen(false); if (changed) load(); }} />}

      {isMgr && employees.some((e) => (e.jobCodes || []).some((j) => j.primaryRoom)) && (
        <div className="sched-legend small muted no-print"><span className="swatch-elsewhere" aria-hidden="true" />{t('schedule.elsewhereLegend')}
          <a className="btn ghost sm" href="#/who-works-where" style={{ marginLeft: 'auto' }}><Icon name="users" />{t('whoWorks.open')}</a></div>
      )}
      {editSection && <SectionPeople section={editSection} ws={ws} sections={allSections} onClose={(changed) => { setEditSection(null); if (changed) load(); }} />}

      {dialog && <ShiftDialog shift={dialog.shift} startIn={dialog.startIn} warnings={dialog.warnings} events={data?.events || []} onClose={closeDialog}
        quick={dialog.quick} weekShifts={shifts} daysOff={daysOff}
        clip={paste.clip} onCopy={isMgr ? paste.copy : undefined}
        onPaste={paste.clip && dialog.target ? () => { const tg = dialog.target; setDialog(null); paste.pasteInto([tg]); } : undefined} />}
      {paste.overlays}
      {personId && <PersonPanel userId={personId} weekShifts={shifts} onClose={() => setPersonId(null)} />}
      {importOpen && <ImportDialog ws={ws} onClose={(changed) => { setImportOpen(false); if (changed) load(); }} />}
      {clearOpen && <ClearWeekDialog ws={ws} data={data} onClose={(changed) => { setClearOpen(false); if (changed) load(); }} />}
      {publishOpen && <PublishDialog ws={ws} label={weekLabel(ws)} drafts={drafts} onClose={(changed) => { setPublishOpen(false); if (changed) reloadAll(); }} />}
      {pdfOpen && <SchedulePdfDialog ws={ws} banners={banners} drafts={drafts} onClose={() => setPdfOpen(false)} />}
      {copyOpen && <CopyWeekDialog ws={ws} onClose={(changed, goTo) => { setCopyOpen(false); if (goTo && goTo !== ws) setWs(goTo); else if (changed) load(); }} />}
    </div>
  );
}

/**
 * Shifts this week in sections that don't show (hidden in Rooms & positions, or a room and position
 * that isn't there): move them to a section that shows, or show the section. Managers only.
 */
function StrayDialog({ stray, ws, onClose }) {
  const t = useT();
  const { call, jobs, people, layout, employees } = useApp();
  const [run, busy] = useAction();
  const [changed, setChanged] = useState(false);
  const [moving, setMoving] = useState(null); // the group being moved
  const [to, setTo] = useState('');
  const targets = shiftChoices({ layout, jobs, employees }).rooms.flatMap((r) => r.positions.map((j) => ({ k: `${r.room}|${j.id}`, room: r.room, jobCodeId: j.id, label: `${j.name} · ${r.room}` })));
  const done = () => onClose(changed);
  const show = async (g) => { const r = await run(() => call('layout.unhide', { room: g.room, jobCodeId: g.jobCodeId }), t('schedule.strayShown')); if (r) setChanged(true); };
  const move = async (g) => {
    const target = targets.find((x) => x.k === to);
    if (!target) return;
    const r = await run(() => call('layout.moveShifts', { room: g.room, jobCodeId: g.jobCodeId, start: ws, end: addDays(ws, 6), to: { room: target.room, jobCodeId: target.jobCodeId } }),
      (res) => t('schedule.strayMoved', { count: res.moved }));
    if (r) { setChanged(true); setMoving(null); setTo(''); }
  };
  return (
    <Modal title={t('schedule.strayTitle')} sub={t('schedule.straySub')} onClose={done}
      footer={<><a className="btn ghost sm" href="#/settings/rooms" onClick={done}><Icon name="settings" />{t('rooms.allRooms')}</a><span className="spacer" /><button className="btn primary" onClick={done}>{t('common.done')}</button></>}>
      {!stray.length && <div className="empty small">{t('schedule.strayNone')}</div>}
      <div className="list card">
        {stray.map((g) => {
          const k = `${g.room}|${g.jobCodeId}`;
          return (
            <div key={k} className="col" style={{ gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <JobDot job={jobs[g.jobCodeId]} /><b>{jobs[g.jobCodeId]?.name}</b><span className="muted">· {g.room || t('schedule.strayNoRoom')}</span>
                <span className={`badge ${g.hidden ? '' : 'warn'}`}>{g.hidden ? t('schedule.strayHidden') : t('schedule.strayUnlisted')}</span>
              </div>
              <div className="small muted">{t('schedule.strayCount', { count: g.shifts.length })}: {g.shifts.map((s) => `${people[s.userId]?.name || t('common.openShift')} ${dowShort(dow(s.date))} ${fmtTime(s.start)}`).join(', ')}</div>
              {moving === k ? (
                <div className="row wrap" style={{ gap: 6 }}>
                  <select className="input" style={{ flex: '1 1 200px' }} value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('schedule.strayMove')}>
                    <option value="">{t('schedule.pickSection')}</option>
                    {targets.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}
                  </select>
                  <button type="button" className="btn primary sm" disabled={busy || !to} onClick={() => move(g)}>{t('schedule.strayMoveBtn')}</button>
                  <button type="button" className="btn sm" onClick={() => setMoving(null)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div className="row wrap" style={{ gap: 6 }}>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => { setMoving(k); setTo(''); }}><Icon name="swap" />{t('schedule.strayMove')}</button>
                  {g.room && <button type="button" className="btn sm" disabled={busy} onClick={() => show(g)}><Icon name="eye" />{t('schedule.strayShow')}</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * One day's list: who's on the schedule, sorted by room (banners, then positions), by position across
 * rooms, by start time or by name (core/day-list.js). The order is remembered on this device. Shifts in
 * hidden or unlisted sections never show; "Just me" and the room chips filter every order.
 */
function MobileDay({ days, selDay, setSelDay, data, daysOff = [], room, mine, setMine, openDialog, isClosed, fcDay, addAt, prog }) {
  const t = useT();
  const { jobs, people, me, isMgr, today, has, layout, settings } = useApp();
  // Room banners in the room's color (Settings → Rooms & positions), like the sheet, the PDF and the phone app.
  const roomStyle = (room) => { const c = bannerColor(settings, room, Math.max(0, (layout?.rooms || []).findIndex((r) => sameArea(r.room, room)))); return { background: c, color: textOn(c) }; };
  const [sort, setSortState] = useState(initialSort);
  const setSort = (v) => { setSortState(v); try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } };
  const evs = data.events.filter((e) => e.date === selDay);
  const f = fcDay(selDay);
  const list = useMemo(() => dayList({ shifts: data.shifts.filter((s) => s.date === selDay), jobs, people, layout, mode: sort, lang: getLang(), meId: me.id, mine, room }),
    [data, selDay, jobs, people, layout, sort, mine, room, me.id]);
  const groups = list.groups;
  const offToday = (data.timeOff || []).filter((t) => t.startDate <= selDay && t.endDate >= selDay && t.status === 'approved');
  // What each line says besides the name and time: what the order doesn't already show.
  const detail = (x) => {
    const where = list.mode === 'room' ? [x.job?.short] : list.mode === 'position' ? [x.room] : [x.job?.name, x.room];
    return [...where, x.shift.tag].filter(Boolean).join(' · ');
  };
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
      <div className="row wrap day-ctl">
        <div className="seg">
          <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>{t('schedule.everyone')}</button>
          <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>{t('schedule.justMe')}</button>
        </div>
        <select className="input sm day-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('dayList.sortLabel')} title={t('dayList.sortLabel')}>
          <option value="room">{t('dayList.byRoom')}</option>
          <option value="position">{t('dayList.byPosition')}</option>
          <option value="time">{t('dayList.byTime')}</option>
          <option value="name">{t('dayList.byName')}</option>
        </select>
        <span className="spacer" />
        {f && !f.closed && <span className="small muted num">{t('schedule.totalcoversCvrs', { totalCovers: f.totalCovers })}{isMgr ? ` · ${f.laborPct ?? '—'}%` : ''}</span>}
        {isMgr && !isClosed(selDay) && <button className="btn sm primary" onClick={() => addAt(selDay)}><Icon name="plus" />{t('schedule.add')}</button>}
      </div>
      {selDay === today && has('eightySix') && <EightySixBanner />}
      {evs.map((e) => (
        <a key={e.id} href={`#/events/${e.id}`} className="alert warn" style={{ marginBottom: 8 }}>
          <Icon name="glass" size={16} />
          <div><b>{e.name}</b><div className="small">{t('schedule.timeRoomGuestcountGuests', { time: fmtTime(e.start), room: e.room, guestCount: e.guestCount })}</div></div>
        </a>
      ))}
      {(data.notes || []).filter((n) => n.kind === 'day' && n.date === selDay).map((n) => <div key={n.id} className="alert info" style={{ marginBottom: 8 }}><Icon name="alert" size={16} /><b>{n.text}</b></div>)}
      {prog && <DayProgramming day={prog.byDate[selDay]} onChanged={prog.reload} />}
      {isClosed(selDay) && <Empty title={t('common.closed')} />}
      {!isClosed(selDay) && !groups.length && <Empty title={mine ? t('schedule.youreOff') : t('schedule.noShifts')} />}
      {groups.map((g, i) => (
        <div key={g.key} className="dgroup">
          {g.room && g.room !== groups[i - 1]?.room && <div className="dbanner" style={roomStyle(g.room)}>{g.room}<span className="dbanner-n">{g.roomCount}</span></div>}
          <div className="dgroup-h">{g.job ? <><JobDot job={g.job} />{g.job.name}<span className="faint">{g.count}</span></> : t('dayList.shifts', { count: g.count })}</div>
          {g.items.map((x) => {
            const s = x.shift;
            return (
              <div key={s.id} className={`mshift ${s.userId === me.id ? 'mine' : ''} ${x.open ? 'open' : ''}`} style={{ '--jc': x.job?.color }} onClick={() => openDialog(s)}>
                <Avatar user={x.person} size="sm" />
                <div className="who">
                  {x.open ? t('common.openShift') : x.person?.name}
                  <div className="small muted" style={{ fontWeight: 500 }}>{detail(x)}{!s.published ? t('schedule.draft') : ''}{s.pending ? t('schedule.swapPending2') : ''}</div>
                </div>
                <div className="when">{shiftTime(s)}</div>
                {canTrade(s, me, today) && <button className="btn sm" onClick={(e) => { e.stopPropagation(); openDialog(s); }}><Icon name="swap" />{t('common.trade')}</button>}
              </div>
            );
          })}
        </div>
      ))}
      {!mine && daysOff.some((d) => d.date === selDay) && (
        <div className="small muted" style={{ marginTop: 8 }}>{t('quickShift.dayOff')}:{' '}{daysOff.filter((d) => d.date === selDay).map((d) => people[d.userId]?.name).filter(Boolean).join(', ')}</div>
      )}
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
