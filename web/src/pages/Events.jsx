import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, Field, Empty, useAction, JobDot, money, shiftTime } from '../ui.jsx';
import { prettyDate, fmtTime, parseDate, MONTHS, DOW_SHORT, addDays } from '../../../core/time.js';
import { SERVICE_STYLES } from '../../../core/beo.js';
import { IS_DEMO } from '../api.js';
import { RoomPlanCard } from './FloorPlan.jsx';

const STATUS_BADGE = { tentative: 'warn', confirmed: 'ok', completed: '', cancelled: 'bad' };

export default function Events({ parts }) {
  const id = parts[1];
  if (id === 'new') return <EventEditor />;
  if (id && parts[2] === 'edit') return <EventEditor id={id} />;
  if (id) return <EventDetail id={id} />;
  return <EventList />;
}

function EventList() {
  const { call, version, isEvents, today } = useApp();
  const [list, setList] = useState(null);
  const [past, setPast] = useState(false);
  useEffect(() => { call('events.list', past ? { start: addDays(today, -120), end: addDays(today, -1) } : { start: today }).then(setList); }, [version, past]);

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="toolbar">
        <div className="seg">
          <button className={!past ? 'on' : ''} onClick={() => setPast(false)}>Upcoming</button>
          <button className={past ? 'on' : ''} onClick={() => setPast(true)}>Past</button>
        </div>
        <span className="spacer" />
        {isEvents && <a className="btn primary sm" href="#/events/new"><Icon name="plus" />New event / BEO</a>}
      </div>
      <div className="card">
        {!list ? <div className="empty">Loading…</div> : !list.length ? <Empty icon="glass" title="No events">{isEvents ? 'Create a BEO to share menus, drinks and staffing needs with the team.' : ''}</Empty> : list.map((e) => {
          const d = parseDate(e.date);
          const pct = e.needed ? e.filled / e.needed : 1;
          return (
            <div key={e.id} className="evcard" onClick={() => (location.hash = `#/events/${e.id}`)}>
              <div className="scard" style={{ padding: 0, border: 0, background: 'none' }}>
                <div className="date"><div className="m">{DOW_SHORT[d.getUTCDay()]}</div><div className="d">{d.getUTCDate()}</div><div className="m">{MONTHS[d.getUTCMonth()].slice(0, 3)}</div></div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}><b style={{ fontSize: 15 }}>{e.name}</b><span className={`badge ${STATUS_BADGE[e.status]}`}>{e.status}</span></div>
                <div className="small muted">{fmtTime(e.start)}{e.end ? `–${fmtTime(e.end)}` : ''} · {e.room || 'TBD'}{e.guestCount ? ` · ${e.guestCount} guests` : ''}{e.type ? ` · ${e.type}` : ''}</div>
                {e.needed > 0 && (
                  <div className="row" style={{ marginTop: 6, maxWidth: 320 }}>
                    <div className={`progress ${pct < 1 ? 'low' : ''}`}><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>
                    <span className="tiny muted num" style={{ whiteSpace: 'nowrap' }}>{e.filled}/{e.needed} staffed</span>
                  </div>
                )}
              </div>
              <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventDetail({ id }) {
  const { call, version, isEvents, isMgr, jobs, people, me, refresh } = useApp();
  const [e, setE] = useState(null);
  const [err, setErr] = useState('');
  const [comment, setComment] = useState('');
  const [run, busy] = useAction();
  const load = () => call('events.get', { id }).then(setE).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, [id, version]);
  if (err) return <Empty title={err} />;
  if (!e) return <div className="empty">Loading…</div>;

  const myShift = e.shifts.find((s) => s.userId === me.id);
  const missing = e.staffing.reduce((t, l) => t + Math.max(0, l.count - l.created), 0);
  const drafts = e.shifts.filter((s) => !s.published).length;
  const captain = people[e.captainId];

  const post = async () => {
    await run(() => call('events.comment', { eventId: id, text: comment }), 'Posted');
    setComment('');
    load();
  };

  return (
    <div className="beo-print" style={{ maxWidth: 1080 }}>
      <div className="toolbar no-print">
        <a className="btn sm ghost" href="#/events"><Icon name="left" />Events</a>
        <span className="spacer" />
        {!IS_DEMO && <button className="btn sm ghost" onClick={() => window.print()}><Icon name="print" />Print BEO</button>}
        {isEvents && <a className="btn sm" href={`#/events/${id}/edit`}><Icon name="edit" />Edit</a>}
      </div>

      <div className="card card-pad section">
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="small faint" style={{ fontWeight: 700, letterSpacing: '.06em' }}>BANQUET EVENT ORDER</div>
            <h1 style={{ margin: '2px 0 4px' }}>{e.name}</h1>
            <div className="muted">{prettyDate(e.date)} · {fmtTime(e.start)}{e.end ? ` – ${fmtTime(e.end)}` : ''} · {e.room}</div>
          </div>
          <div className="row wrap">
            <span className={`badge ${STATUS_BADGE[e.status]}`}>{e.status}</span>
            {e.guestCount > 0 && <span className="badge brand">{e.guestCount} guests{e.guaranteed ? ` (${e.guaranteed} guaranteed)` : ''}</span>}
          </div>
        </div>
        {myShift && <div className="alert info" style={{ marginTop: 12 }}><Icon name="user" size={16} />You're working this: {jobs[myShift.jobCodeId]?.name} · {shiftTime(myShift)}</div>}
      </div>

      <RoomPlanCard room={e.room} />

      <div className="beo">
        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>Details</h2>
          <dl className="kv">
            <dt>Type</dt><dd>{e.type || '—'}</dd>
            <dt>Service</dt><dd>{SERVICE_STYLES[e.serviceStyle]?.label || '—'}</dd>
            <dt>Banquet captain</dt><dd>{captain ? <span className="row" style={{ gap: 6 }}><Avatar user={captain} size="sm" />{captain.name}</span> : 'None'}</dd>
            <dt>Client</dt><dd>{e.client || '—'}</dd>
            {e.contactName && <><dt>Contact</dt><dd>{e.contactName}{e.contactPhone ? ` · ${e.contactPhone}` : ''}{e.contactEmail ? ` · ${e.contactEmail}` : ''}</dd></>}
            {e.attire && <><dt>Attire</dt><dd>{e.attire}</dd></>}
            {isEvents && e.estRevenue > 0 && <><dt>Est. revenue</dt><dd>{money(e.estRevenue)}</dd></>}
          </dl>
        </div>

        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ flex: 1 }}>Staffing</h2>
            {e.needed > 0 && <span className={`badge ${e.filled >= e.needed ? 'ok' : 'warn'}`}>{e.filled}/{e.needed} filled</span>}
          </div>
          {!e.staffing.length ? <div className="muted small">No staffing requirements listed.</div> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Position</th><th>Need</th><th>Call time</th><th>Filled</th></tr></thead>
              <tbody>
                {e.staffing.map((l) => (
                  <tr key={l.id}>
                    <td><span className="row" style={{ gap: 6 }}><JobDot job={jobs[l.jobCodeId]} />{jobs[l.jobCodeId]?.name}</span>{l.notes && <div className="tiny faint">{l.notes}</div>}</td>
                    <td className="num"><b>{l.count}</b></td>
                    <td className="num">{fmtTime(l.start)}</td>
                    <td><span className={`badge ${l.filled >= l.count ? 'ok' : 'warn'}`}>{l.filled}/{l.count}</span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {e.shifts.length > 0 && (
            <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
              {e.shifts.sort((a, b) => a.jobCodeId.localeCompare(b.jobCodeId)).map((s) => (
                <span key={s.id} className={`badge ${s.userId ? '' : 'warn'}`}><JobDot job={jobs[s.jobCodeId]} />{s.userId ? people[s.userId]?.name : 'Open'} · {fmtTime(s.start)}</span>
              ))}
            </div>
          )}
          {isMgr && (missing > 0 || drafts > 0) && (
            <div className="row wrap no-print" style={{ marginTop: 12 }}>
              {missing > 0 && <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('events.generateShifts', { id, publish: true }), (r) => `Posted ${r.created} open shifts for staff to pick up`).then(load)}><Icon name="plus" />Create {missing} open shift{missing > 1 ? 's' : ''} & post</button>}
              {drafts > 0 && <button className="btn sm" disabled={busy} onClick={() => run(() => call('shifts.publish', { eventId: id }), 'Event shifts published').then(load)}><Icon name="send" />Publish {drafts} draft{drafts > 1 ? 's' : ''}</button>}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>Menu</h2>
          {!e.menu?.length ? <div className="muted small">No menu items.</div> : (
            <div className="col" style={{ gap: 10 }}>
              {e.menu.map((m, i) => (
                <div key={i}><div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase' }}>{m.course}</div><div style={{ fontWeight: 600 }}>{m.item}</div>{m.notes && <div className="small muted">{m.notes}</div>}</div>
              ))}
            </div>
          )}
          {e.dietaryNotes && <div className="alert warn" style={{ marginTop: 12 }}><Icon name="alert" size={16} /><div><b>Dietary:</b> {e.dietaryNotes}</div></div>}
        </div>

        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>Beverage</h2>
          <dl className="kv" style={{ marginBottom: 10 }}>
            <dt>Package</dt><dd>{e.beverage?.package || '—'}</dd>
            <dt>Bar</dt><dd>{e.beverage?.bar || '—'}</dd>
            {e.beverage?.notes && <><dt>Notes</dt><dd>{e.beverage.notes}</dd></>}
          </dl>
          {e.specialDrinks?.length > 0 && <>
            <h3 style={{ margin: '12px 0 8px' }}>Special drinks</h3>
            <div className="col">
              {e.specialDrinks.map((d, i) => (
                <div key={i} className="drink"><div style={{ fontWeight: 700 }}>🍸 {d.name}</div><div className="small">{d.recipe}</div>{d.batch && <div className="tiny faint">{d.batch}</div>}</div>
              ))}
            </div>
          </>}
        </div>

        {e.timeline?.length > 0 && (
          <div className="card card-pad">
            <h2 style={{ marginBottom: 10 }}>Timeline</h2>
            <table className="table"><tbody>{e.timeline.map((t, i) => <tr key={i}><td className="num" style={{ width: 80, fontWeight: 700 }}>{fmtTime(t.time)}</td><td>{t.item}</td></tr>)}</tbody></table>
          </div>
        )}

        {(e.setupNotes || e.avNotes || e.notes) && (
          <div className="card card-pad">
            <h2 style={{ marginBottom: 10 }}>Setup & notes</h2>
            {e.setupNotes && <p style={{ margin: '0 0 8px' }}><b>Setup:</b> {e.setupNotes}</p>}
            {e.avNotes && <p style={{ margin: '0 0 8px' }}><b>A/V:</b> {e.avNotes}</p>}
            {e.notes && <p style={{ margin: 0 }}>{e.notes}</p>}
          </div>
        )}

        <div className="card card-pad full no-print">
          <h2 style={{ marginBottom: 6 }}>Team thread</h2>
          <p className="small muted" style={{ margin: '0 0 8px' }}>Questions and updates go to the events team, managers and everyone scheduled on this event.</p>
          {e.comments.map((c) => (
            <div key={c.id} className="comment">
              <Avatar user={people[c.userId]} size="sm" />
              <div><div className="small"><b>{c.userName}</b> <span className="faint">{new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div><div>{c.text}</div></div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" placeholder="Ask a question or post an update…" value={comment} onChange={(x) => setComment(x.target.value)} onKeyDown={(x) => x.key === 'Enter' && comment.trim() && post()} />
            <button className="btn primary" disabled={!comment.trim() || busy} onClick={post}><Icon name="send" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

const blank = (today) => ({
  name: '', date: addDays(today, 7), start: '18:00', end: '22:00', room: '', guestCount: 50, guaranteed: '', type: '', serviceStyle: 'plated', status: 'tentative',
  client: '', contactName: '', contactPhone: '', contactEmail: '', estRevenue: '', captainId: '', attire: '',
  menu: [], beverage: { package: '', bar: '', notes: '' }, specialDrinks: [], staffing: [], timeline: [], setupNotes: '', dietaryNotes: '', avNotes: '', notes: '',
});

function EventEditor({ id }) {
  const { call, today, settings, jobCodes, employees, jobs, isMgr } = useApp();
  const [e, setE] = useState(id ? null : blank(today));
  const [run, busy] = useAction();
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { if (id) call('events.get', { id }).then((x) => setE({ ...blank(today), ...x })); }, [id]);
  if (!e) return <div className="empty">Loading…</div>;

  const set = (k) => (x) => setE((c) => ({ ...c, [k]: x?.target ? x.target.value : x }));
  const captains = employees.filter((u) => u.jobCodes?.some((j) => /captain/i.test(jobs[j.jobCodeId]?.name || '')) || u.role === 'manager' || u.role === 'admin');

  const suggest = async () => {
    const lines = await run(() => call('events.suggestStaffing', e));
    if (lines) setE((c) => ({ ...c, staffing: lines }));
  };
  const save = async () => {
    const r = await run(() => call('events.save', { ...e, guaranteed: Number(e.guaranteed) || '', estRevenue: Number(e.estRevenue) || 0 }), 'BEO saved — staff on this event were notified');
    if (r) location.hash = `#/events/${r.id}`;
  };
  const remove = async () => {
    if (!confirmDel) return setConfirmDel(true);
    const r = await run(() => call('events.delete', { id }), 'Event deleted');
    if (r) location.hash = '#/events';
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="toolbar">
        <a className="btn sm ghost" href={id ? `#/events/${id}` : '#/events'}><Icon name="left" />Back</a>
        <span className="spacer" />
        {id && <button className={`btn sm danger ${confirmDel ? 'solid' : ''}`} onClick={remove}>{confirmDel ? 'Tap again to delete' : 'Delete'}</button>}
        <button className="btn sm primary" disabled={busy || !e.name} onClick={save}><Icon name="check" />Save BEO</button>
      </div>

      <div className="col" style={{ gap: 14 }}>
        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Event</h2>
          <Field label="Event name"><input className="input" value={e.name} onChange={set('name')} placeholder="e.g. Smith Wedding Reception" /></Field>
          <div className="grid3">
            <Field label="Date"><input className="input" type="date" value={e.date} onChange={set('date')} /></Field>
            <Field label="Guest arrival"><input className="input" type="time" value={e.start} onChange={set('start')} /></Field>
            <Field label="End"><input className="input" type="time" value={e.end} onChange={set('end')} /></Field>
          </div>
          <div className="grid3">
            <Field label="Room / area">
              <input className="input" list="rooms" value={e.room} onChange={set('room')} />
              <datalist id="rooms">{settings.rooms.map((r) => <option key={r} value={r} />)}</datalist>
            </Field>
            <Field label="Guest count"><input className="input" type="number" min="0" value={e.guestCount} onChange={set('guestCount')} /></Field>
            <Field label="Guaranteed"><input className="input" type="number" min="0" value={e.guaranteed} onChange={set('guaranteed')} /></Field>
          </div>
          <div className="grid3">
            <Field label="Status">
              <select className="input" value={e.status} onChange={set('status')}>
                <option value="tentative">Tentative (hidden from staff)</option><option value="confirmed">Confirmed</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Event type"><input className="input" list="types" value={e.type} onChange={set('type')} placeholder="Wedding, Corporate…" />
              <datalist id="types">{['Wedding', 'Corporate', 'Private dinner', 'Party', 'Rehearsal dinner', 'Happy hour', 'Fundraiser', 'Buyout'].map((t) => <option key={t} value={t} />)}</datalist>
            </Field>
            <Field label="Service style">
              <select className="input" value={e.serviceStyle} onChange={set('serviceStyle')}>{Object.entries(SERVICE_STYLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
            </Field>
          </div>
          <div className="grid3">
            <Field label="Banquet captain">
              <select className="input" value={e.captainId || ''} onChange={set('captainId')}><option value="">None</option>{captains.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            </Field>
            <Field label="Staff attire"><input className="input" value={e.attire} onChange={set('attire')} placeholder="All black" /></Field>
            <Field label="Est. revenue ($)" help="Used in labor % forecast"><input className="input" type="number" value={e.estRevenue} onChange={set('estRevenue')} /></Field>
          </div>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Client</h2>
          <div className="grid2">
            <Field label="Client / company"><input className="input" value={e.client} onChange={set('client')} /></Field>
            <Field label="Contact name"><input className="input" value={e.contactName} onChange={set('contactName')} /></Field>
            <Field label="Phone"><input className="input" value={e.contactPhone} onChange={set('contactPhone')} /></Field>
            <Field label="Email"><input className="input" value={e.contactEmail} onChange={set('contactEmail')} /></Field>
          </div>
          <div className="help">Client contact info is only visible to managers and the events team.</div>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <div className="row"><h2 style={{ flex: 1 }}>Staffing needed</h2><button className="btn sm" onClick={suggest} disabled={busy}><Icon name="sparkle" />Suggest from guest count</button></div>
          <div className="help">How many servers, bartenders, food runners, banquet captains, etc. {isMgr ? 'After saving, create open shifts from these lines so staff can pick them up.' : 'Managers turn these into shifts.'}</div>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="staffing" empty="Add position" row={() => ({ jobCodeId: jobCodes.find((j) => j.eventRole)?.id || jobCodes[0]?.id, count: 1, start: addHour(e.start, -1), notes: '' })}
            cols={[{ f: 'jobCodeId', type: 'job', w: '1.4fr' }, { f: 'count', type: 'number', label: '#', w: '70px' }, { f: 'start', type: 'time', label: 'Call', w: '120px' }, { f: 'notes', label: 'Notes', w: '1.4fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Menu</h2>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="menu" empty="Add course / item" row={() => ({ course: '', item: '', notes: '' })}
            cols={[{ f: 'course', label: 'Course (e.g. Entrée)', w: '1fr' }, { f: 'item', label: 'Item', w: '1.6fr' }, { f: 'notes', label: 'Notes', w: '1.2fr' }]} />
          <Field label="Dietary restrictions / allergies"><textarea className="input" rows="2" value={e.dietaryNotes} onChange={set('dietaryNotes')} /></Field>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Beverage</h2>
          <div className="grid2">
            <Field label="Package"><input className="input" value={e.beverage?.package || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, package: x.target.value } }))} placeholder="Premium open bar, 4 hrs" /></Field>
            <Field label="Bar setup"><input className="input" value={e.beverage?.bar || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, bar: x.target.value } }))} placeholder="Main bar + satellite" /></Field>
          </div>
          <Field label="Beverage notes"><input className="input" value={e.beverage?.notes || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, notes: x.target.value } }))} placeholder="Champagne toast at 8:00" /></Field>
          <h3>Special drinks</h3>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="specialDrinks" empty="Add special drink" row={() => ({ name: '', recipe: '', batch: '' })}
            cols={[{ f: 'name', label: 'Name', w: '1fr' }, { f: 'recipe', label: 'Recipe / build', w: '2fr' }, { f: 'batch', label: 'Batch / qty', w: '1fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Timeline</h2>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="timeline" empty="Add timeline item" row={() => ({ time: e.start, item: '' })} cols={[{ f: 'time', type: 'time', w: '130px' }, { f: 'item', label: 'What happens', w: '1fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>Setup & notes</h2>
          <Field label="Room setup"><textarea className="input" rows="2" value={e.setupNotes} onChange={set('setupNotes')} placeholder="Rounds of 8, head table, gift table…" /></Field>
          <Field label="A/V"><input className="input" value={e.avNotes} onChange={set('avNotes')} /></Field>
          <Field label="Other notes"><textarea className="input" rows="2" value={e.notes} onChange={set('notes')} /></Field>
        </div>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy || !e.name} onClick={save}><Icon name="check" />Save BEO</button></div>
      </div>
    </div>
  );
}

function Repeater({ e, setE, jobCodes, k, cols, empty, row }) {
  const setIn = (i, f) => (x) => setE((c) => ({ ...c, [k]: c[k].map((r, j) => (j === i ? { ...r, [f]: x.target.value } : r)) }));
  const add = () => setE((c) => ({ ...c, [k]: [...(c[k] || []), row()] }));
  const del = (i) => setE((c) => ({ ...c, [k]: c[k].filter((_, j) => j !== i) }));
  return (
    <div className="col">
      {(e[k] || []).map((r, i) => (
        <div key={i} className="repeat-row" style={{ gridTemplateColumns: `${cols.map((c) => c.w || '1fr').join(' ')} 36px` }}>
          {cols.map((c) => c.type === 'job'
            ? <select key={c.f} className="input sm" value={r[c.f]} onChange={setIn(i, c.f)}>{jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select>
            : <input key={c.f} className="input sm" type={c.type || 'text'} placeholder={c.label} value={r[c.f] ?? ''} onChange={setIn(i, c.f)} />)}
          <button className="btn sm icon ghost" onClick={() => del(i)} aria-label="Remove"><Icon name="x" /></button>
        </div>
      ))}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="plus" />{empty}</button>
    </div>
  );
}

function addHour(t, n) {
  const [h, m] = (t || '17:00').split(':').map(Number);
  return `${String((h + n + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
