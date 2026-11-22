import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, Avatar, Warnings, shiftTime, startTimesOnly, useAction, JobDot } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { scheduleAreas, findArea } from '../../../core/areas.js';
import { ShiftSectionCard, useSectionField } from './Sections.jsx';
import { CallOutPanel } from './TrainingShared.jsx';
import { useT, fmtTime, prettyDate } from '../i18n/index.js';

/**
 * Opens the right dialog for the viewer: managers edit other people's shifts; your own shift (any
 * role) opens its details with trade and give-away options, and managers can switch to editing it.
 * startIn opens straight into 'swap' or 'drop'.
 */
export default function ShiftDialog({ shift, onClose, warnings, events = [], startIn }) {
  const { isMgr, me } = useApp();
  const mine = !!shift.id && shift.userId === me.id;
  const [editing, setEditing] = useState(isMgr && !mine);
  if (editing) return <ShiftEditor shift={shift} onClose={onClose} warnings={warnings} events={events} />;
  return <ShiftDetail shift={shift} onClose={onClose} events={events} startIn={startIn} onEdit={isMgr ? () => setEditing(true) : null} />;
}

function ShiftEditor({ shift, onClose, warnings, events }) {
  const t = useT();
  const { jobCodes, employees, settings, jobs, call, toast } = useApp();
  const [f, setF] = useState(() => ({
    id: shift.id, date: shift.date, start: shift.start || '16:00', end: shift.end || '', jobCodeId: shift.jobCodeId || jobCodes.find((j) => !j.archived)?.id,
    userId: shift.userId || '', area: shift.area || '', tag: shift.tag || '', notes: shift.notes || '', breakMin: shift.breakMin || 0, eventId: shift.eventId || '', staffingLineId: shift.staffingLineId || null,
    untilClose: shift.id ? !shift.end : true,
  }));
  const [run, busy] = useAction();
  const [publishNow, setPublishNow] = useState(!!shift.published);
  const section = useSectionField(shift, f.date); // room & tables (server section)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const active = employees.filter((e) => e.active !== false && e.onSchedule !== false);
  const trained = active.filter((e) => e.jobCodes?.some((j) => j.jobCodeId === f.jobCodeId));
  const others = active.filter((e) => !trained.includes(e));
  const dayEvents = events.filter((e) => e.date === f.date);
  const areas = scheduleAreas(settings);
  if (f.area && !findArea(f.area, areas)) areas.push(f.area);
  // Picking someone for a shift with no area yet uses the area they usually work this job in.
  const pickUser = (e) => {
    const userId = e.target.value;
    const entry = employees.find((x) => x.id === userId)?.jobCodes?.find((j) => j.jobCodeId === f.jobCodeId);
    setF((x) => ({ ...x, userId, area: x.area || entry?.areas?.[0] || '' }));
  };

  const save = async () => {
    const payload = { ...f, end: f.untilClose ? null : f.end, userId: f.userId || null, eventId: f.eventId || null, published: shift.id ? undefined : publishNow };
    const r = await run(() => call('shifts.save', payload));
    if (r) {
      await section.save(r.shift.id);
      if (r.warnings?.length) toast(t('shiftDialog.savedHeadsUpValue', { value: r.warnings[0] }), 'bad');
      else toast(shift.id ? t('shiftDialog.shiftUpdated') : t('shiftDialog.shiftAdded'));
      onClose(true);
    }
  };
  const del = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    const r = await run(() => call('shifts.delete', { id: shift.id }), t('shiftDialog.shiftDeleted'));
    if (r) onClose(true);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Modal title={shift.id ? t('shiftDialog.editShift') : t('shiftDialog.addShift')} sub={`${prettyDate(f.date)}${shift.id && !shift.published ? t('shiftDialog.draftSuffix') : ''}`} onClose={() => onClose(false)}
      footer={<>
        {shift.id && <button className={`btn danger ${confirmDelete ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{confirmDelete ? t('shiftDialog.tapAgainToDelete') : t('common.delete')}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{shift.id ? t('common.save') : t('shiftDialog.addShift')}</button>
      </>}>
      <Warnings items={warnings} />
      <div className="grid2">
        <Field label={t('shiftDialog.positionJobCode')}>
          <select className="input" value={f.jobCodeId} onChange={set('jobCodeId')}>
            {jobCodes.filter((j) => !j.archived || j.id === f.jobCodeId).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </Field>
        <Field label={t('shiftDialog.employee')}>
          <select className="input" value={f.userId} onChange={pickUser}>
            <option value="">{t('shiftDialog.openShiftAnyoneCanPick')}</option>
            <optgroup label={t('shiftDialog.trainedAsValue', { value: jobs[f.jobCodeId]?.name || '' })}>
              {trained.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
            <optgroup label={t('shiftDialog.notTrainedForThisJob')}>
              {others.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
          </select>
        </Field>
      </div>
      <div className="grid3">
        <Field label={t('common.date')}><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label={t('shiftDialog.start')}><input className="input" type="time" value={f.start} onChange={set('start')} step="900" /></Field>
        <Field label={t('shiftDialog.end')}>
          {f.untilClose
            ? <button type="button" className="input" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setF((x) => ({ ...x, untilClose: false, end: x.end || '22:00' }))}>{t('shiftDialog.untilClose')}{' '}<span className="faint small">{t('shiftDialog.setTime')}</span></button>
            : <input className="input" type="time" value={f.end} onChange={set('end')} step="900" />}
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.untilClose} onChange={set('untilClose')} />{t('shiftDialog.untilCloseNoSetEnd')}</label>
      <Field label={t('shiftDialog.area')} help={areas.length ? t('shiftDialog.whereThisShiftIsWorked') : t('shiftDialog.addAreasRestaurantRabbitHole')}>
        <select className="input" value={f.area} onChange={set('area')}>
          <option value="">{t('shiftDialog.noArea')}</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      {section.field}
      <Field label={t('shiftDialog.tagSection')} help={t('shiftDialog.showsOnTheScheduleNext')}>
        <input className="input" value={f.tag} onChange={set('tag')} placeholder={t('shiftDialog.optional')} />
        <div className="row wrap" style={{ marginTop: 4 }}>
          {settings.tags.map((t) => <button type="button" key={t} className={`chip ${f.tag === t ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, tag: x.tag === t ? '' : t }))}>{t}</button>)}
        </div>
      </Field>
      <div className="grid2">
        <Field label={t('shiftDialog.linkedEvent')}>
          <select className="input" value={f.eventId} onChange={set('eventId')}>
            <option value="">{t('shiftDialog.none')}</option>
            {dayEvents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label={t('shiftDialog.unpaidBreakMin')}><input className="input" type="number" min="0" step="5" value={f.breakMin} onChange={set('breakMin')} /></Field>
      </div>
      <Field label={t('common.notes')}><textarea className="input" rows="2" value={f.notes} onChange={set('notes')} placeholder={t('shiftDialog.visibleToTheEmployee')} /></Field>
      {!shift.id && <label className="check"><input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />{t('shiftDialog.publishImmediatelyNotifyTheEmployee')}</label>}
    </Modal>
  );
}

function ShiftDetail({ shift, onClose, events, startIn, onEdit }) {
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
      </> : onEdit ? <><button className="btn" onClick={onEdit}><Icon name="edit" />{t('shiftDialog.editShift')}</button><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('shiftDialog.close')}</button></> : null}>
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
