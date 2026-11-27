import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, Avatar, Warnings, shiftTime, startTimesOnly, useAction, JobDot } from '../ui.jsx';
import { addDays, dow } from '../../../core/time.js';
import { shiftChoices, roomOfShift, findRoom, areaForRoom } from '../../../core/layout.js';
import { ShiftSectionCard } from './Sections.jsx';
import { CallOutPanel } from './TrainingShared.jsx';
import '../quick-shift.css';
import { clipTime } from './ShiftPaste.jsx';
import { useConflictConfirm, TimeOffApproved, PendingRequest } from './ScheduleConflicts.jsx'; // ask before scheduling over a blocked day; time off on the day
import { useT, fmtTime, prettyDate, dowShort } from '../i18n/index.js';

/**
 * Opens the right dialog for the viewer: managers edit other people's shifts; your own shift (any
 * role) opens its details with trade and give-away options, and managers can switch to editing it.
 * startIn opens straight into 'swap' or 'drop'.
 * quick: opened from a person × day cell on the schedule (web/src/pages/Schedule.jsx): the person, date, room and
 * position come from the row and only the times, tag and notes change, with one-tap times copied from the week
 * (weekShifts), a Day off action (daysOff: the week's days off) and "Move this shift" to unlock everything.
 */
export default function ShiftDialog({ shift, onClose, warnings, events = [], startIn, quick = false, weekShifts = [], daysOff = [], clip = null, onPaste, onCopy }) {
  const { isMgr, me } = useApp();
  const mine = !!shift.id && shift.userId === me.id;
  const [editing, setEditing] = useState(isMgr && !mine);
  if (editing) return <ShiftEditor shift={shift} onClose={onClose} warnings={warnings} events={events} quick={quick} weekShifts={weekShifts} daysOff={daysOff} clip={clip} onPaste={onPaste} onCopy={onCopy} />;
  return <ShiftDetail shift={shift} onClose={onClose} events={events} startIn={startIn} onEdit={isMgr ? () => setEditing(true) : null} onCopy={isMgr ? onCopy : undefined} />;
}

/**
 * The times to copy into a quick shift: this person's other days this week (same times and tag together:
 * "4p–Close · BAR (Mon, Tue)"), then the times most used for the position this week. At most 9 (keys 1–9).
 */
export function copyChoices({ weekShifts, userId, date, jobCodeId, shiftId }) {
  const mine = new Map();
  for (const s of weekShifts) {
    if (s.userId !== userId || s.date === date || s.id === shiftId) continue;
    const k = `${s.start}|${s.end || ''}|${s.tag || ''}`;
    const e = mine.get(k) || { key: `m:${k}`, start: s.start, end: s.end || null, tag: s.tag || '', days: [] };
    if (!e.days.includes(s.date)) e.days.push(s.date);
    mine.set(k, e);
  }
  const theirs = [...mine.values()].map((e) => ({ ...e, days: e.days.sort() })).sort((a, b) => a.days[0].localeCompare(b.days[0]) || a.start.localeCompare(b.start));
  const taken = new Set(theirs.map((e) => `${e.start}|${e.end || ''}`));
  const counts = new Map();
  for (const s of weekShifts) {
    if (s.jobCodeId !== jobCodeId || s.id === shiftId) continue;
    const k = `${s.start}|${s.end || ''}`;
    if (taken.has(k)) continue;
    const e = counts.get(k) || { key: `c:${k}`, start: s.start, end: s.end || null, tag: '', count: 0 };
    e.count++;
    counts.set(k, e);
  }
  const mineShown = theirs.slice(0, 9);
  const common = [...counts.values()].sort((a, b) => b.count - a.count || a.start.localeCompare(b.start)).slice(0, Math.min(4, 9 - mineShown.length));
  return { mine: mineShown, common };
}

/**
 * Add or edit a shift: the room first, then that room's positions (Settings → Rooms & positions;
 * hidden ones aren't offered), then the person. People who work that position in that room come
 * first; "Show everyone" lists the rest, and picking one of them gives them the position there.
 * Changing an existing shift's date, person, position or room moves it (shifts.move: the same shift).
 * A shift's floor room & tables are set on the Sections page, not here.
 */
function ShiftEditor({ shift, onClose, warnings, events, quick, weekShifts, daysOff, clip, onPaste, onCopy }) {
  const t = useT();
  const { employees, settings, jobs, call, toast, layout, people } = useApp();
  const [f, setF] = useState(() => {
    // Where it starts: the shift's own room and position, else (a new shift with neither) the first room's first position.
    let jobCodeId = shift.jobCodeId && jobs[shift.jobCodeId] ? shift.jobCodeId : '';
    let room = jobCodeId ? roomOfShift(shift, jobs[jobCodeId]) : '';
    // A new shift for someone, with no room picked yet (not added from a room's section): their primary room for it.
    if (!shift.id && !shift.area && shift.userId && jobCodeId) {
      const primary = employees.find((e) => e.id === shift.userId)?.jobCodes?.find((j) => j.jobCodeId === jobCodeId)?.primaryRoom;
      if (primary) room = primary;
    }
    room = findRoom(layout, room)?.room || room;
    const first = shiftChoices({ layout, jobs, employees }).rooms;
    if (!room) room = (jobCodeId && first.find((r) => r.positions.some((j) => j.id === jobCodeId))?.room) || first[0]?.room || '';
    if (!jobCodeId) jobCodeId = first.find((r) => r.room === room)?.positions[0]?.id || '';
    return {
      id: shift.id, date: shift.date, start: shift.start || '16:00', end: shift.end || '', jobCodeId, room,
      userId: shift.userId || '', tag: shift.tag || '', notes: shift.notes || '', breakMin: shift.breakMin || 0, eventId: shift.eventId || '', staffingLineId: shift.staffingLineId || null,
      untilClose: shift.id ? !shift.end : true,
    };
  });
  const [orig] = useState(() => ({ date: f.date, userId: f.userId, jobCodeId: f.jobCodeId, room: f.room }));
  const [run, busy] = useAction();
  const conflict = useConflictConfirm();
  const [publishNow, setPublishNow] = useState(!!shift.published);
  const [everyone, setEveryone] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  // The person's day (schedule.conflicts, managers): approved time off (who approved it) or a pending request (deny it first).
  const [dayInfo, setDayInfo] = useState(null);
  const [infoTick, setInfoTick] = useState(0);
  useEffect(() => {
    if (!f.userId || !/^\d{4}-\d{2}-\d{2}$/.test(f.date || '')) { setDayInfo(null); return undefined; }
    let live = true;
    call('schedule.conflicts', { start: f.date, end: f.date }).then((d) => live && setDayInfo(d?.cells?.find((c) => c.userId === f.userId && c.date === f.date) || null), () => live && setDayInfo(null));
    return () => { live = false; };
  }, [f.userId, f.date, infoTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const choices = shiftChoices({ layout, jobs, employees, room: f.room, jobCodeId: f.jobCodeId });
  // A shift already in a section that doesn't show (hidden, or not in Rooms & positions) keeps it as a choice.
  const roomListed = choices.rooms.some((r) => r.room === f.room);
  const posListed = choices.positions.some((j) => j.id === f.jobCodeId);
  const job = jobs[f.jobCodeId];
  const person = employees.find((e) => e.id === f.userId);
  const holder = !!person && choices.holders.includes(person);
  const showOthers = everyone || (person && !holder);
  const dayEvents = events.filter((e) => e.date === f.date);
  const pickRoom = (e) => {
    const room = e.target.value;
    const positions = shiftChoices({ layout, jobs, employees, room }).positions;
    setF((x) => ({ ...x, room, jobCodeId: positions.some((j) => j.id === x.jobCodeId) ? x.jobCodeId : positions[0]?.id || '' }));
  };

  // Quick mode: the row decides who, when and where; it needs a person and a position to stay locked.
  const locked = quick && !unlocked && !!orig.userId && !!orig.jobCodeId;
  const moving = !!shift.id && (f.date !== orig.date || (f.userId || '') !== (orig.userId || '') || f.jobCodeId !== orig.jobCodeId || f.room !== orig.room);
  const dayOff = (daysOff || []).find((d) => d.userId === f.userId && d.date === f.date);
  const origDayOff = (daysOff || []).find((d) => d.userId === orig.userId && d.date === orig.date);
  const theirShiftsThatDay = (weekShifts || []).filter((s) => s.userId === orig.userId && s.date === orig.date);
  const copy = useMemo(() => (quick ? copyChoices({ weekShifts: weekShifts || [], userId: orig.userId, date: orig.date, jobCodeId: f.jobCodeId, shiftId: shift.id }) : { mine: [], common: [] }),
    [quick, weekShifts, orig, f.jobCodeId, shift.id]);
  const chips = [...copy.mine, ...copy.common];
  const applyChip = (c) => setF((x) => ({ ...x, start: c.start, end: c.end || '', untilClose: !c.end, tag: c.tag || x.tag }));
  const chipOn = (c) => f.start === c.start && (f.untilClose ? !c.end : f.end === c.end);
  // Keys 1–9 pick a time (not while typing in a field).
  useEffect(() => {
    if (!locked || !chips.length) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= chips.length) { e.preventDefault(); applyChip(chips[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, chips]);

  const save = async () => {
    const payload = { ...f, area: areaForRoom(f.room, job, settings), end: f.untilClose ? null : f.end, userId: f.userId || null, eventId: f.eventId || null,
      published: shift.id ? undefined : publishNow, listPerson: !!f.userId && !holder };
    delete payload.room;
    // Onto a blocked day (unavailable, standing request off, time off): asks first, then sends overrideConflict (ScheduleConflicts.jsx).
    // A shift on a day the manager marked off replaces the day off: clear it first (no "marked as a day off" warning), put it back if the save fails.
    const clearOff = dayOff && f.userId && !shift.id;
    if (clearOff) await call('schedule.dayOff.clear', { userId: dayOff.userId, date: dayOff.date }).catch(() => {});
    const r = await run(() => conflict.save((x) => call(moving ? 'shifts.move' : 'shifts.save', { ...payload, ...x })));
    if (!r && clearOff) await call('schedule.dayOff.set', { userId: dayOff.userId, date: dayOff.date, removeShifts: false }).catch(() => {});
    if (r) {
      if (r.warnings?.length) toast(t('shiftDialog.savedHeadsUpValue', { value: r.warnings[0] }), 'bad');
      else toast(moving ? t('quickShift.moved') : shift.id ? t('shiftDialog.shiftUpdated') : t('shiftDialog.shiftAdded'));
      onClose(true);
    }
  };
  const del = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    const r = await run(() => call('shifts.delete', { id: shift.id }), t('shiftDialog.shiftDeleted'));
    if (r) onClose(true);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const markOff = async () => {
    if (theirShiftsThatDay.length && !confirmOff) return setConfirmOff(true);
    const who = people?.[orig.userId]?.name || person?.name || '';
    const r = await run(() => call('schedule.dayOff.set', { userId: orig.userId, date: orig.date, removeShifts: true }), t('quickShift.dayOffDone', { name: who, date: prettyDate(orig.date) }));
    if (r) onClose(true);
  };
  const undoOff = async () => {
    const r = await run(() => call('schedule.dayOff.clear', { userId: orig.userId, date: orig.date }), t('quickShift.dayOffCleared'));
    if (r) onClose(true);
  };

  const timeFields = (
    <>
      <div className={locked ? 'grid2' : 'grid3'}>
        {!locked && <Field label={t('common.date')}><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>}
        <Field label={locked ? t('quickShift.timeIn') : t('shiftDialog.start')}><input className="input" type="time" value={f.start} onChange={set('start')} step="900" /></Field>
        <Field label={locked ? t('quickShift.timeOut') : t('shiftDialog.end')}>
          {f.untilClose
            ? <button type="button" className="input" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setF((x) => ({ ...x, untilClose: false, end: x.end || '22:00' }))}>{t('shiftDialog.untilClose')}{' '}<span className="faint small">{t('shiftDialog.setTime')}</span></button>
            : <input className="input" type="time" value={f.end} onChange={set('end')} step="900" />}
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.untilClose} onChange={set('untilClose')} />{t('shiftDialog.untilCloseNoSetEnd')}</label>
    </>
  );
  const tagField = (
    <Field label={t('shiftDialog.tagSection')} help={t('shiftDialog.showsOnTheScheduleNext')}>
      <input className="input" value={f.tag} onChange={set('tag')} placeholder={t('shiftDialog.optional')} />
      <div className="row wrap" style={{ marginTop: 4 }}>
        {settings.tags.map((tg) => <button type="button" key={tg} className={`chip ${f.tag === tg ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, tag: x.tag === tg ? '' : tg }))}>{tg}</button>)}
      </div>
    </Field>
  );
  const notesField = <Field label={t('common.notes')}><textarea className="input" rows="2" value={f.notes} onChange={set('notes')} placeholder={t('shiftDialog.visibleToTheEmployee')} /></Field>;
  const chipLabel = (c) => `${shiftTime(c)}${c.tag ? ` · ${c.tag}` : ''}`;
  const chipButton = (c, n, extra) => (
    <button type="button" key={c.key} className={`chip quick-chip ${chipOn(c) ? 'on' : ''}`} onClick={() => applyChip(c)} aria-keyshortcuts={locked ? String(n) : undefined}>
      {locked && <kbd className="quick-kbd desktop-only">{n}</kbd>}{chipLabel(c)} <span className="quick-chip-x">{extra}</span>
    </button>
  );
  const copyBlock = quick && (
    <div className="quick-copy" role="group" aria-label={t('quickShift.copyTime')}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="small" style={{ fontWeight: 700 }}>{t('quickShift.copyTime')}</span>
        {locked && chips.length > 0 && <span className="small faint desktop-only">{t('quickShift.keyHint')}</span>}
      </div>
      {!chips.length && <div className="small faint">{t('quickShift.noTimesYet')}</div>}
      {copy.mine.length > 0 && <div className="small muted">{t('quickShift.theirWeek')}</div>}
      {copy.mine.length > 0 && <div className="row wrap" style={{ gap: 6 }}>{copy.mine.map((c, i) => chipButton(c, i + 1, `(${c.days.map((d) => dowShort(dow(d))).join(', ')})`))}</div>}
      {copy.common.length > 0 && <div className="small muted">{t('quickShift.commonFor', { position: job?.name || '' })}</div>}
      {copy.common.length > 0 && <div className="row wrap" style={{ gap: 6 }}>{copy.common.map((c, i) => chipButton(c, copy.mine.length + i + 1, t('quickShift.timesCount', { count: c.count })))}</div>}
    </div>
  );
  const dayOffNote = dayOff && (
    <div className="alert warn"><Icon name="sun" size={16} /><span style={{ flex: 1 }}>{t('quickShift.isDayOff', { name: person?.name || '' })}</span>
      {quick && dayOff === origDayOff && <button type="button" className="btn sm" disabled={busy} onClick={undoOff}>{t('quickShift.undoDayOff')}</button>}</div>
  );
  const who = person || people?.[f.userId];
  // Up front, before the times: approved time off says who approved it; a pending request has to be denied first (only
  // for a new shift or one moving onto that day: editing a shift in place never asks).
  const timeOffNote = <>
    {dayInfo?.block?.timeOff && <TimeOffApproved info={dayInfo.block.timeOff} />}
    {dayInfo?.request && (!shift.id || moving) && <PendingRequest userId={f.userId} request={dayInfo.request} onDenied={() => setInfoTick((n) => n + 1)} />}
  </>;
  // Copy & paste (pages/ShiftPaste.jsx): with a shift copied, a cell's quick dialog offers pasting it here first (phones too).
  const pasteOffer = quick && clip && onPaste && clip.id !== shift.id && (
    <div className="paste-offer">
      <button type="button" className="btn primary sm" onClick={onPaste} disabled={busy}><Icon name="copy" />{t('shiftPaste.pasteHere')}</button>
      <span className="small">{clipTime(clip, t)}{jobs[clip.jobCodeId] ? ` · ${jobs[clip.jobCodeId].name}` : ''}{clip.tag ? ` · ${clip.tag}` : ''}</span>
      <div className="help">{t('shiftPaste.pasteHereHelp')}</div>
    </div>
  );

  return (
    <Modal title={shift.id ? t('shiftDialog.editShift') : t('shiftDialog.addShift')} sub={`${prettyDate(f.date)}${shift.id && !shift.published ? t('shiftDialog.draftSuffix') : ''}`} onClose={() => onClose(false)}
      footer={<>
        {shift.id && <button className={`btn danger ${confirmDelete ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{confirmDelete ? t('shiftDialog.tapAgainToDelete') : t('common.delete')}</button>}
        {quick && shift.id && onCopy && <button type="button" className="btn" onClick={() => { onCopy(shift); onClose(false); }} title={t('shiftPaste.copyTitle')}><Icon name="copy" />{t('shiftPaste.copy')}</button>}
        {quick && orig.userId && !moving && !origDayOff && (
          <button type="button" className={`btn quick-dayoff ${confirmOff ? 'danger solid' : ''}`} onClick={markOff} disabled={busy}><Icon name="sun" />{confirmOff ? t('quickShift.dayOffConfirm', { count: theirShiftsThatDay.length }) : t('quickShift.dayOff')}</button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={save} disabled={busy || !f.jobCodeId}>{moving ? <><Icon name="swap" />{t('quickShift.saveMove')}</> : shift.id ? t('common.save') : t('shiftDialog.addShift')}</button>
      </>}>
      <Warnings items={warnings} />
      {pasteOffer}
      {locked ? <>
        <div className="quick-fixed">
          <Avatar user={who} size="sm" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{who?.name}</div>
            <div className="small muted row wrap" style={{ gap: 6 }}><span>{prettyDate(f.date)}</span><span>·</span><JobDot job={job} /><span>{job?.name}</span>{f.room && <><span>·</span><span>{f.room}</span></>}</div>
          </div>
          <Icon name="lock" size={14} />
        </div>
        <div className="help" style={{ marginTop: -4 }}>{t('quickShift.fixedHelp')}</div>
        {dayOffNote}
        {timeOffNote}
        {copyBlock}
        {timeFields}
        {tagField}
        {notesField}
        {!shift.id && <label className="check"><input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />{t('shiftDialog.publishImmediatelyNotifyTheEmployee')}</label>}
        <div className="quick-move">
          <button type="button" className="btn sm" onClick={() => setUnlocked(true)}><Icon name={shift.id ? 'swap' : 'edit'} />{shift.id ? t('quickShift.moveShift') : t('quickShift.changeAll')}</button>
          {shift.id && <div className="help">{t('quickShift.moveHelp')}</div>}
        </div>
      </> : <>
        {moving && <div className="alert info"><Icon name="swap" size={16} /><span>{t('quickShift.moving')}</span></div>}
        {!choices.rooms.length && !f.room && <div className="alert info"><Icon name="alert" size={16} /><span>{t('shiftDialog.noRooms')}</span></div>}
        <div className="grid2">
          <Field label={t('shiftDialog.room')} help={t('shiftDialog.roomHelp')}>
            <select className="input" value={f.room} onChange={pickRoom}>
              {!roomListed && <option value={f.room}>{f.room ? t('shiftDialog.notOnSchedule', { name: f.room }) : '—'}</option>}
              {choices.rooms.map((r) => <option key={r.room} value={r.room}>{r.room}</option>)}
            </select>
          </Field>
          <Field label={t('common.position')}>
            <select className="input" value={f.jobCodeId} onChange={set('jobCodeId')}>
              {!posListed && <option value={f.jobCodeId}>{job ? t('shiftDialog.notOnSchedule', { name: job.name }) : '—'}</option>}
              {choices.positions.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('shiftDialog.employee')}>
          <select className="input" value={f.userId} onChange={set('userId')}>
            <option value="">{t('shiftDialog.openShiftAnyoneCanPick')}</option>
            {job && f.room && (
              <optgroup label={t('shiftDialog.worksHere', { position: job.name, room: f.room })}>
                {choices.holders.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </optgroup>
            )}
            {showOthers && (
              <optgroup label={t('shiftDialog.everyoneElse')}>
                {choices.others.filter((e) => everyone || e.id === f.userId).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </optgroup>
            )}
          </select>
          <label className="check small" style={{ marginTop: 2 }}><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />{t('shiftDialog.showEveryone')}</label>
          {job && f.room && !choices.holders.length && !person && <div className="help">{t('shiftDialog.noOneHere', { position: job.name, room: f.room })}</div>}
        </Field>
        {person && !holder && job && f.room && (
          <div className="alert warn"><Icon name="alert" size={16} /><span>{t('shiftDialog.willGetPosition', { name: person.name, position: job.name, room: f.room })}</span></div>
        )}
        {dayOffNote}
        {timeOffNote}
        {copyBlock}
        {timeFields}
        {tagField}
        <div className="grid2">
          <Field label={t('shiftDialog.linkedEvent')}>
            <select className="input" value={f.eventId} onChange={set('eventId')}>
              <option value="">{t('shiftDialog.none')}</option>
              {dayEvents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
          <Field label={t('shiftDialog.unpaidBreakMin')}><input className="input" type="number" min="0" step="5" value={f.breakMin} onChange={set('breakMin')} /></Field>
        </div>
        {notesField}
        {!shift.id && <label className="check"><input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />{t('shiftDialog.publishImmediatelyNotifyTheEmployee')}</label>}
      </>}
      {conflict.element}
    </Modal>
  );
}

function ShiftDetail({ shift, onClose, events, startIn, onEdit, onCopy }) {
  const t = useT();
  const { me, jobs, people, call, today, settings } = useApp();
  const [run, busy] = useAction();
  const [mode, setMode] = useState(startIn && shift.published ? startIn : null); // 'drop' | 'swap'
  const [sent, setSent] = useState(null); // what was just requested, for the "what happens next" screen
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [target, setTarget] = useState(null);
  const [coworkers, setCoworkers] = useState([]);
  const job = jobs[shift.jobCodeId];
  const mine = shift.userId === me.id;
  const isOpen = !shift.userId;
  const qualified = me.jobCodes?.some((j) => j.jobCodeId === shift.jobCodeId);
  const future = shift.date >= today;
  const event = events.find((e) => e.id === shift.eventId);

  useEffect(() => {
    call('shifts.list', { start: shift.date, end: shift.date }).then((r) => {
      setCoworkers(r.shifts.filter((s) => s.id !== shift.id && s.userId && s.userId !== shift.userId && (s.jobCodeId === shift.jobCodeId || (shift.eventId && s.eventId === shift.eventId))));
    });
  }, [shift.id]);

  useEffect(() => {
    if (mode !== 'swap') return;
    call('shifts.list', { start: today, end: addDays(today, 21) }).then((r) => {
      const myJobs = new Set(me.jobCodes.map((j) => j.jobCodeId));
      setCandidates(r.shifts.filter((s) => s.userId && s.userId !== me.id && s.published && s.date >= today && !s.pending && myJobs.has(s.jobCodeId) &&
        people[s.userId]?.jobCodes?.some((j) => j.jobCodeId === shift.jobCodeId)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)));
    });
  }, [mode]);

  const approval = settings.requireSwapApproval !== false;
  const submit = async (type) => {
    const r = await run(() => call('swaps.create', { shiftId: shift.id, type, targetShiftId: target?.id, note }));
    if (r) setSent({ type, target });
  };
  const shown = (candidates || []).filter((c) => !filter || (people[c.userId]?.name || '').toLowerCase().includes(filter.toLowerCase()));
  const byDay = shown.reduce((m, c) => ((m[c.date] ||= []).push(c), m), {});

  if (sent) {
    const who = sent.target ? people[sent.target.userId]?.name : '';
    const steps = sent.type === 'swap'
      ? [t('shiftDialog.stepGetsRequest', { who }), approval && t('shiftDialog.stepManagerApproves'), t('shiftDialog.stepUpdatesBoth')]
      : sent.type === 'drop'
        ? [t('shiftDialog.stepEveryoneNotified', { job: job?.name }), t('shiftDialog.stepSomeonePicks'), approval && t('shiftDialog.stepManagerApproves'), t('shiftDialog.stepUpdatesYou')]
        : [approval ? t('shiftDialog.stepManagerApprovesPickup') : t('shiftDialog.stepYours'), t('shiftDialog.stepUpdatesYou')];
    return (
      <Modal title={sent.type === 'swap' ? t('shiftDialog.tradeRequestSent') : sent.type === 'drop' ? t('shiftDialog.yourShiftIsUpFor') : t('shiftDialog.pickupRequested')} onClose={() => onClose(true)}
        footer={<><a className="btn" href="#/swaps" onClick={() => onClose(true)}>{t('shiftDialog.seeMyRequests')}</a><span className="spacer" /><button className="btn primary" onClick={() => onClose(true)}>{t('common.done')}</button></>}>
        <div className="alert ok"><Icon name="check" size={16} /><span>{sent.type === 'pickup' ? t('shiftDialog.requested') : t(approval ? 'shiftDialog.stillOnUntilApproved' : 'shiftDialog.stillOnUntilTaken', { date: prettyDate(shift.date) })}</span></div>
        <div className="small" style={{ fontWeight: 700 }}>{t('shiftDialog.whatHappensNext')}</div>
        <ol className="trade-steps">{steps.filter(Boolean).map((x) => <li key={x}>{x}</li>)}</ol>
        <div className="help">{t('shiftDialog.trackItOrCancelIt')}</div>
      </Modal>
    );
  }

  return (
    <Modal title={`${job?.name || t('shiftDialog.shiftWord')}${shift.tag ? ' · ' + shift.tag : ''}`} sub={`${prettyDate(shift.date)} · ${shiftTime(shift)}${!shift.end && !startTimesOnly() && t.lang === 'en' ? ' (until close)' : ''}${shift.area ? ` · ${shift.area}` : ''}`} onClose={() => onClose(false)}
      footer={mode ? <>
        <button className="btn" onClick={() => { setMode(null); setTarget(null); }}>{t('shiftDialog.back')}</button>
        <span className="spacer" />
        {mode === 'drop' && <button className="btn primary" disabled={busy} onClick={() => submit('drop')}><Icon name="send" />{t('shiftDialog.postForPickup')}</button>}
        {mode === 'swap' && <button className="btn primary" disabled={busy || !target} onClick={() => submit('swap')}><Icon name="swap" />{target ? (people[target.userId]?.name ? t('shiftDialog.sendTradeTo', { name: people[target.userId].name.split(' ')[0] }) : t('shiftDialog.sendTrade')) : t('shiftDialog.pickAShiftFirst')}</button>}
      </> : onEdit ? <><button className="btn" onClick={onEdit}><Icon name="edit" />{t('shiftDialog.editShift')}</button>
        {onCopy && <button type="button" className="btn" onClick={() => { onCopy(shift); onClose(false); }} title={t('shiftPaste.copyTitle')}><Icon name="copy" />{t('shiftPaste.copy')}</button>}<span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('shiftDialog.close')}</button></> : null}>
      {!mode && <>
        <div className="row">
          <Avatar user={people[shift.userId]} size="lg" />
          <div>
            <div style={{ fontWeight: 700 }}>{isOpen ? t('common.openShift') : people[shift.userId]?.name}</div>
            <div className="small muted row" style={{ gap: 6 }}><JobDot job={job} />{job?.name}{job?.department ? ` · ${job.department}` : ''}</div>
          </div>
        </div>
        <ShiftSectionCard shift={shift} />
        {shift.pending && <div className="alert warn"><Icon name="clock" size={16} />{t(shift.pending === 'drop' ? 'shiftDialog.pendingDrop' : shift.pending === 'swap' ? 'shiftDialog.pendingSwap' : 'shiftDialog.pendingPickup')}</div>}
        {event && (
          <a className="card card-pad row" href={`#/events/${event.id}`} style={{ color: 'inherit', boxShadow: 'none' }}>
            <Icon name="glass" size={20} />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{event.name}</div><div className="small muted">{t('shiftDialog.roomGuestcountGuestsStartsTime', { room: event.room, guestCount: event.guestCount, time: fmtTime(event.start) })}</div></div>
            <span className="badge brand">{t('shiftDialog.viewBeo')}</span>
          </a>
        )}
        {shift.notes && <div><div className="small faint" style={{ fontWeight: 600 }}>{t('common.notes')}</div>{shift.notes}</div>}
        {!shift.end && <div className="help">{t('shiftDialog.untilCloseShiftsEndWhen', { openEndHours: settings.openEndHours })}</div>}
        {coworkers.length > 0 && (
          <div>
            <div className="small faint" style={{ fontWeight: 600, marginBottom: 6 }}>{t('shiftDialog.workingWithYou')}</div>
            <div className="row wrap">{coworkers.map((c) => <span key={c.id} className="badge"><JobDot job={jobs[c.jobCodeId]} />{people[c.userId]?.name} · {fmtTime(c.start)}</span>)}</div>
          </div>
        )}
        {future && mine && !shift.pending && !shift.published && (
          <div className="alert info"><Icon name="clock" size={16} />{t('shiftDialog.thisShiftIsStillA')}</div>
        )}
        {future && mine && !shift.pending && shift.published && (
          <div className="col" style={{ gap: 8 }}>
            <div style={{ fontWeight: 700 }}>{t('shiftDialog.cantMakeIt')}</div>
            <div className="trade-choices">
              <button type="button" className="trade-choice" onClick={() => setMode('swap')}>
                <Icon name="swap" size={22} />{t('shiftDialog.bTradeWithACoworker')}
                <span>{t('shiftDialog.swapItForSomeoneElses')}{approval ? t('shiftDialog.thenAManagerApproves') : ''}.</span>
              </button>
              <button type="button" className="trade-choice" onClick={() => setMode('drop')}>
                <Icon name="hand" size={22} />{t('shiftDialog.bGiveItAwayB')}
                <span>{t('shiftDialog.anyoneTrainedAsNameCan', { name: job?.name })}{approval ? t('shiftDialog.thenAManagerApproves') : ''}.</span>
              </button>
            </div>
            <div className="help">{t('shiftDialog.youKeepTheShiftUntil')}{settings.minSwapNoticeHours ? t('shiftDialog.tradesNeedMinswapnoticehoursHoursNotice', { minSwapNoticeHours: settings.minSwapNoticeHours }) : ''}</div>
          </div>
        )}
        {future && mine && <CallOutPanel />}
        {future && isOpen && qualified && <button className="btn primary block" disabled={busy} onClick={() => submit('pickup')}><Icon name="plus" />{t('shiftDialog.requestToPickUp')}</button>}
        {future && isOpen && !qualified && <div className="help">{t('shiftDialog.youreNotSetUpAs', { name: job?.name })}</div>}
      </>}

      {mode === 'drop' && <>
        <div className="alert info"><Icon name="hand" size={16} />{t('shiftDialog.everyoneTrainedAsNameGets', { name: job?.name })}{approval ? t('shiftDialog.andAManagerApproves') : ''}.</div>
        <Field label={t('shiftDialog.noteToCoworkersOptional')}><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('shiftDialog.eGFamilyEventWill')} /></Field>
      </>}

      {mode === 'swap' && <>
        <div className="small">{t('shiftDialog.bWhichShiftWouldYou', { date: prettyDate(shift.date), time: shiftTime(shift), name: job?.name })}</div>
        {!candidates && <div className="empty">{t('common.loading')}</div>}
        {candidates?.length === 0 && (
          <div className="alert warn col" style={{ alignItems: 'stretch', gap: 8 }}>
            <span>{t('shiftDialog.noOneHasAShift')}</span>
            <div><button type="button" className="btn sm primary" onClick={() => { setMode('drop'); setTarget(null); }}><Icon name="hand" />{t('shiftDialog.giveItAwayInstead')}</button></div>
          </div>
        )}
        {(candidates?.length || 0) > 6 && <input className="input sm" placeholder={t('shiftDialog.findACoworker')} value={filter} onChange={(e) => setFilter(e.target.value)} />}
        {candidates?.length > 0 && (
          <div className="list card" style={{ boxShadow: 'none', maxHeight: 320, overflowY: 'auto' }}>
            {Object.entries(byDay).map(([day, list]) => (
              <React.Fragment key={day}>
                <div className="trade-day">{prettyDate(day)}</div>
                {list.map((s) => (
                  <label key={s.id} className="list-item click" style={{ background: target?.id === s.id ? 'var(--brand-soft)' : undefined }}>
                    <input type="radio" name="t" checked={target?.id === s.id} onChange={() => setTarget(s)} style={{ accentColor: 'var(--brand)' }} />
                    <Avatar user={people[s.userId]} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{people[s.userId]?.name}</div>
                      <div className="small muted">{shiftTime(s)} · {jobs[s.jobCodeId]?.name}{s.area ? ' · ' + s.area : ''}{s.tag ? ' · ' + s.tag : ''}</div>
                    </div>
                  </label>
                ))}
              </React.Fragment>
            ))}
          </div>
        )}
        {target && <div className="alert info"><Icon name="swap" size={16} /><span>{t('shiftDialog.youdWorkBDateTime', { date: prettyDate(target.date), time: shiftTime(target), name: people[target.userId]?.name, date2: prettyDate(shift.date), time2: shiftTime(shift) })}</span></div>}
        <Field label={t('shiftDialog.noteOptional')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('shiftDialog.eGHaveAWedding')} /></Field>
      </>}
    </Modal>
  );
}
