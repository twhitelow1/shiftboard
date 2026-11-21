import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, Avatar, Warnings, shiftTime, startTimesOnly, useAction, JobDot } from '../ui.jsx';
import { prettyDate, addDays, fmtTime } from '../../../core/time.js';
import { scheduleAreas, findArea } from '../../../core/areas.js';

/** Opens the right dialog for the viewer: editor for managers, details + trade actions for staff. */
export default function ShiftDialog({ shift, onClose, warnings, events = [] }) {
  const { isMgr } = useApp();
  if (isMgr) return <ShiftEditor shift={shift} onClose={onClose} warnings={warnings} events={events} />;
  return <ShiftDetail shift={shift} onClose={onClose} events={events} />;
}

function ShiftEditor({ shift, onClose, warnings, events }) {
  const { jobCodes, employees, settings, jobs, call, toast } = useApp();
  const [f, setF] = useState(() => ({
    id: shift.id, date: shift.date, start: shift.start || '16:00', end: shift.end || '', jobCodeId: shift.jobCodeId || jobCodes.find((j) => !j.archived)?.id,
    userId: shift.userId || '', area: shift.area || '', tag: shift.tag || '', notes: shift.notes || '', breakMin: shift.breakMin || 0, eventId: shift.eventId || '', staffingLineId: shift.staffingLineId || null,
    untilClose: shift.id ? !shift.end : true,
  }));
  const [run, busy] = useAction();
  const [publishNow, setPublishNow] = useState(!!shift.published);
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
      if (r.warnings?.length) toast(`Saved — heads up: ${r.warnings[0]}`, 'bad');
      else toast(shift.id ? 'Shift updated' : 'Shift added');
      onClose(true);
    }
  };
  const del = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    const r = await run(() => call('shifts.delete', { id: shift.id }), 'Shift deleted');
    if (r) onClose(true);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Modal title={shift.id ? 'Edit shift' : 'Add shift'} sub={`${prettyDate(f.date)}${shift.id && !shift.published ? ' · Draft' : ''}`} onClose={() => onClose(false)}
      footer={<>
        {shift.id && <button className={`btn danger ${confirmDelete ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{confirmDelete ? 'Tap again to delete' : 'Delete'}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{shift.id ? 'Save' : 'Add shift'}</button>
      </>}>
      <Warnings items={warnings} />
      <div className="grid2">
        <Field label="Position (job code)">
          <select className="input" value={f.jobCodeId} onChange={set('jobCodeId')}>
            {jobCodes.filter((j) => !j.archived || j.id === f.jobCodeId).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </Field>
        <Field label="Employee">
          <select className="input" value={f.userId} onChange={pickUser}>
            <option value="">— Open shift (anyone can pick up) —</option>
            <optgroup label={`Trained as ${jobs[f.jobCodeId]?.name || ''}`}>
              {trained.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
            <optgroup label="Not trained for this job">
              {others.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </optgroup>
          </select>
        </Field>
      </div>
      <div className="grid3">
        <Field label="Date"><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Start"><input className="input" type="time" value={f.start} onChange={set('start')} step="900" /></Field>
        <Field label="End">
          {f.untilClose
            ? <button type="button" className="input" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setF((x) => ({ ...x, untilClose: false, end: x.end || '22:00' }))}>Until close <span className="faint small">(set time)</span></button>
            : <input className="input" type="time" value={f.end} onChange={set('end')} step="900" />}
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.untilClose} onChange={set('untilClose')} />Until close (no set end time)</label>
      <Field label="Area" help={areas.length ? 'Where this shift is worked. The schedule groups shifts by area, like the banners on your sheet.' : 'Add areas (Restaurant, Rabbit Hole…) in Settings, or import a schedule.'}>
        <select className="input" value={f.area} onChange={set('area')}>
          <option value="">No area</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </Field>
      <Field label="Tag / section" help="Shows on the schedule next to the time — e.g. LIB, RH, BC, PASSED">
        <input className="input" value={f.tag} onChange={set('tag')} placeholder="Optional" />
        <div className="row wrap" style={{ marginTop: 4 }}>
          {settings.tags.map((t) => <button type="button" key={t} className={`chip ${f.tag === t ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, tag: x.tag === t ? '' : t }))}>{t}</button>)}
        </div>
      </Field>
      <div className="grid2">
        <Field label="Linked event">
          <select className="input" value={f.eventId} onChange={set('eventId')}>
            <option value="">None</option>
            {dayEvents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="Unpaid break (min)"><input className="input" type="number" min="0" step="5" value={f.breakMin} onChange={set('breakMin')} /></Field>
      </div>
      <Field label="Notes"><textarea className="input" rows="2" value={f.notes} onChange={set('notes')} placeholder="Visible to the employee" /></Field>
      {!shift.id && <label className="check"><input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />Publish immediately (notify the employee)</label>}
    </Modal>
  );
}

function ShiftDetail({ shift, onClose, events }) {
  const { me, jobs, people, call, today, settings } = useApp();
  const [run, busy] = useAction();
  const [mode, setMode] = useState(null); // 'drop' | 'swap'
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
      setCoworkers(r.shifts.filter((s) => s.id !== shift.id && s.userId && (s.jobCodeId === shift.jobCodeId || (shift.eventId && s.eventId === shift.eventId))));
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

  const submit = async (type) => {
    const r = await run(() => call('swaps.create', { shiftId: shift.id, type, targetShiftId: target?.id, note }),
      type === 'drop' ? 'Shift posted — qualified coworkers were notified' : type === 'swap' ? 'Trade request sent' : 'Pickup requested — waiting on a manager');
    if (r) onClose(true);
  };

  return (
    <Modal title={`${job?.name || 'Shift'}${shift.tag ? ' · ' + shift.tag : ''}`} sub={`${prettyDate(shift.date)} · ${shiftTime(shift)}${!shift.end && !startTimesOnly() ? ' (until close)' : ''}${shift.area ? ` · ${shift.area}` : ''}`} onClose={() => onClose(false)}
      footer={mode ? <>
        <button className="btn" onClick={() => { setMode(null); setTarget(null); }}>Back</button>
        <span className="spacer" />
        {mode === 'drop' && <button className="btn primary" disabled={busy} onClick={() => submit('drop')}><Icon name="send" />Post for pickup</button>}
        {mode === 'swap' && <button className="btn primary" disabled={busy || !target} onClick={() => submit('swap')}><Icon name="swap" />Request trade</button>}
      </> : null}>
      {!mode && <>
        <div className="row">
          <Avatar user={people[shift.userId]} size="lg" />
          <div>
            <div style={{ fontWeight: 700 }}>{isOpen ? 'Open shift' : people[shift.userId]?.name}</div>
            <div className="small muted row" style={{ gap: 6 }}><JobDot job={job} />{job?.name}{job?.department ? ` · ${job.department}` : ''}</div>
          </div>
        </div>
        {shift.pending && <div className="alert warn"><Icon name="clock" size={16} />A {shift.pending === 'drop' ? 'giveaway' : shift.pending} request is in progress for this shift.</div>}
        {event && (
          <a className="card card-pad row" href={`#/events/${event.id}`} style={{ color: 'inherit', boxShadow: 'none' }}>
            <Icon name="glass" size={20} />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{event.name}</div><div className="small muted">{event.room} · {event.guestCount} guests · starts {fmtTime(event.start)}</div></div>
            <span className="badge brand">View BEO</span>
          </a>
        )}
        {shift.notes && <div><div className="small faint" style={{ fontWeight: 600 }}>Notes</div>{shift.notes}</div>}
        {!shift.end && <div className="help">"Until close" shifts end when a manager cuts you. Estimated at {settings.openEndHours} hrs for labor planning.</div>}
        {coworkers.length > 0 && (
          <div>
            <div className="small faint" style={{ fontWeight: 600, marginBottom: 6 }}>Working with you</div>
            <div className="row wrap">{coworkers.map((c) => <span key={c.id} className="badge"><JobDot job={jobs[c.jobCodeId]} />{people[c.userId]?.name} · {fmtTime(c.start)}</span>)}</div>
          </div>
        )}
        {future && mine && !shift.pending && (
          <div className="grid2">
            <button className="btn block" onClick={() => setMode('drop')}><Icon name="hand" />Give away</button>
            <button className="btn block primary" onClick={() => setMode('swap')}><Icon name="swap" />Trade shifts</button>
          </div>
        )}
        {future && isOpen && qualified && <button className="btn primary block" disabled={busy} onClick={() => submit('pickup')}><Icon name="plus" />Request to pick up</button>}
        {future && isOpen && !qualified && <div className="help">You're not set up as {job?.name}, so you can't pick this up.</div>}
      </>}

      {mode === 'drop' && <>
        <div className="alert info"><Icon name="hand" size={16} />Everyone trained as {job?.name} gets notified. You stay responsible for the shift until someone picks it up{settings.requireSwapApproval ? ' and a manager approves' : ''}.</div>
        <Field label="Note to coworkers (optional)"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family event, will owe you one!" /></Field>
      </>}

      {mode === 'swap' && <>
        <div className="small muted">Pick a coworker's shift to trade for your {job?.name} shift on {prettyDate(shift.date)}. Only people trained for both jobs are shown.</div>
        {!candidates && <div className="empty">Loading…</div>}
        {candidates?.length === 0 && <div className="empty">No tradeable shifts in the next 3 weeks.</div>}
        <div className="list card" style={{ boxShadow: 'none', maxHeight: 320, overflowY: 'auto' }}>
          {candidates?.map((s) => (
            <label key={s.id} className="list-item click" style={{ background: target?.id === s.id ? 'var(--brand-soft)' : undefined }}>
              <input type="radio" name="t" checked={target?.id === s.id} onChange={() => setTarget(s)} style={{ accentColor: 'var(--brand)' }} />
              <Avatar user={people[s.userId]} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{people[s.userId]?.name}</div>
                <div className="small muted">{prettyDate(s.date)} · {shiftTime(s)} · {jobs[s.jobCodeId]?.name}{s.area ? ' · ' + s.area : ''}{s.tag ? ' · ' + s.tag : ''}</div>
              </div>
            </label>
          ))}
        </div>
        <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </>}
    </Modal>
  );
}
