import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Modal, Field, Icon, Avatar, Warnings, shiftTime, startTimesOnly, useAction, JobDot } from '../ui.jsx';
import { prettyDate, addDays, fmtTime } from '../../../core/time.js';
import { scheduleAreas, findArea } from '../../../core/areas.js';

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

function ShiftDetail({ shift, onClose, events, startIn, onEdit }) {
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
      ? [`${who} gets your request and accepts (or declines) it`, approval && 'A manager approves it', 'The schedule updates and you both get a notification']
      : sent.type === 'drop'
        ? [`Everyone trained as ${job?.name} was notified`, 'Someone picks it up', approval && 'A manager approves it', 'The schedule updates and you get a notification']
        : [approval ? 'A manager approves your pickup' : 'It’s yours', 'The schedule updates and you get a notification'];
    return (
      <Modal title={sent.type === 'swap' ? 'Trade request sent' : sent.type === 'drop' ? 'Your shift is up for grabs' : 'Pickup requested'} onClose={() => onClose(true)}
        footer={<><a className="btn" href="#/swaps" onClick={() => onClose(true)}>See my requests</a><span className="spacer" /><button className="btn primary" onClick={() => onClose(true)}>Done</button></>}>
        <div className="alert ok"><Icon name="check" size={16} /><span>{sent.type === 'pickup' ? 'Requested.' : `You’re still on ${prettyDate(shift.date)} until it’s ${approval ? 'approved' : 'taken'}.`}</span></div>
        <div className="small" style={{ fontWeight: 700 }}>What happens next</div>
        <ol className="trade-steps">{steps.filter(Boolean).map((t) => <li key={t}>{t}</li>)}</ol>
        <div className="help">Track it, or cancel it, in Swaps & Trades → My requests.</div>
      </Modal>
    );
  }

  return (
    <Modal title={`${job?.name || 'Shift'}${shift.tag ? ' · ' + shift.tag : ''}`} sub={`${prettyDate(shift.date)} · ${shiftTime(shift)}${!shift.end && !startTimesOnly() ? ' (until close)' : ''}${shift.area ? ` · ${shift.area}` : ''}`} onClose={() => onClose(false)}
      footer={mode ? <>
        <button className="btn" onClick={() => { setMode(null); setTarget(null); }}>Back</button>
        <span className="spacer" />
        {mode === 'drop' && <button className="btn primary" disabled={busy} onClick={() => submit('drop')}><Icon name="send" />Post for pickup</button>}
        {mode === 'swap' && <button className="btn primary" disabled={busy || !target} onClick={() => submit('swap')}><Icon name="swap" />{target ? `Send trade to ${people[target.userId]?.name?.split(' ')[0] || 'them'}` : 'Pick a shift first'}</button>}
      </> : onEdit ? <><button className="btn" onClick={onEdit}><Icon name="edit" />Edit shift</button><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>Close</button></> : null}>
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
        {future && mine && !shift.pending && !shift.published && (
          <div className="alert info"><Icon name="clock" size={16} />This shift is still a draft. Trading and giving it away open once the schedule is published.</div>
        )}
        {future && mine && !shift.pending && shift.published && (
          <div className="col" style={{ gap: 8 }}>
            <div style={{ fontWeight: 700 }}>Can’t make it?</div>
            <div className="trade-choices">
              <button type="button" className="trade-choice" onClick={() => setMode('swap')}>
                <Icon name="swap" size={22} /><b>Trade with a coworker</b>
                <span>Swap it for someone else’s shift. They accept{approval ? ', then a manager approves' : ''}.</span>
              </button>
              <button type="button" className="trade-choice" onClick={() => setMode('drop')}>
                <Icon name="hand" size={22} /><b>Give it away</b>
                <span>Anyone trained as {job?.name} can pick it up{approval ? ', then a manager approves' : ''}.</span>
              </button>
            </div>
            <div className="help">You keep the shift until the trade or giveaway goes through.{settings.minSwapNoticeHours ? ` Trades need ${settings.minSwapNoticeHours} hours’ notice; closer than that, call your manager.` : ''}</div>
          </div>
        )}
        {future && isOpen && qualified && <button className="btn primary block" disabled={busy} onClick={() => submit('pickup')}><Icon name="plus" />Request to pick up</button>}
        {future && isOpen && !qualified && <div className="help">You're not set up as {job?.name}, so you can't pick this up.</div>}
      </>}

      {mode === 'drop' && <>
        <div className="alert info"><Icon name="hand" size={16} />Everyone trained as {job?.name} gets notified. You stay responsible for the shift until someone picks it up{approval ? ' and a manager approves' : ''}.</div>
        <Field label="Note to coworkers (optional)"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family event, will owe you one!" /></Field>
      </>}

      {mode === 'swap' && <>
        <div className="small"><b>Which shift would you take instead?</b> You give {prettyDate(shift.date)} · {shiftTime(shift)} and take the shift you pick. Showing posted shifts in the next 3 weeks from people who can work your {job?.name} shift and that you’re trained for.</div>
        {!candidates && <div className="empty">Loading…</div>}
        {candidates?.length === 0 && (
          <div className="alert warn col" style={{ alignItems: 'stretch', gap: 8 }}>
            <span>No one has a shift you could trade for in the next 3 weeks.</span>
            <div><button type="button" className="btn sm primary" onClick={() => { setMode('drop'); setTarget(null); }}><Icon name="hand" />Give it away instead</button></div>
          </div>
        )}
        {(candidates?.length || 0) > 6 && <input className="input sm" placeholder="Find a coworker…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
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
        {target && <div className="alert info"><Icon name="swap" size={16} /><span>You’d work <b>{prettyDate(target.date)} · {shiftTime(target)}</b>; {people[target.userId]?.name} would work your <b>{prettyDate(shift.date)} · {shiftTime(shift)}</b>.</span></div>}
        <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Have a wedding that day" /></Field>
      </>}
    </Modal>
  );
}
