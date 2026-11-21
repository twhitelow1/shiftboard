import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, Field, Empty, useAction, JobDot, money, shiftTime } from '../ui.jsx';
import { parseDate, addDays } from '../../../core/time.js';
import { SERVICE_STYLES, styleLabel } from '../../../core/beo.js';
import { IS_DEMO } from '../api.js';
import { EventPlans, useVenueRooms } from './Sections.jsx';
import { useT, dowShort, fmtTime, monthShort, prettyDate, stamp } from '../i18n/index.js';

const STATUS_BADGE = { tentative: 'warn', confirmed: 'ok', completed: '', cancelled: 'bad' };

export default function Events({ parts }) {
  const id = parts[1];
  if (id === 'new') return <EventEditor />;
  if (id && parts[2] === 'edit') return <EventEditor id={id} />;
  if (id) return <EventDetail id={id} />;
  return <EventList />;
}

function EventList() {
  const t = useT();
  const { call, version, isEvents, today } = useApp();
  const [list, setList] = useState(null);
  const [past, setPast] = useState(false);
  useEffect(() => { call('events.list', past ? { start: addDays(today, -120), end: addDays(today, -1) } : { start: today }).then(setList); }, [version, past]);

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="toolbar">
        <div className="seg">
          <button className={!past ? 'on' : ''} onClick={() => setPast(false)}>{t('events.upcoming')}</button>
          <button className={past ? 'on' : ''} onClick={() => setPast(true)}>{t('events.past')}</button>
        </div>
        <span className="spacer" />
        {isEvents && <a className="btn primary sm" href="#/events/new"><Icon name="plus" />{t('events.newEventBeo')}</a>}
      </div>
      <div className="card">
        {!list ? <div className="empty">{t('common.loading')}</div> : !list.length ? <Empty icon="glass" title={t('events.noEvents')}>{isEvents ? t('events.createABeoToShare') : ''}</Empty> : list.map((e) => {
          const d = parseDate(e.date);
          const pct = e.needed ? e.filled / e.needed : 1;
          return (
            <div key={e.id} className="evcard" onClick={() => (location.hash = `#/events/${e.id}`)}>
              <div className="scard" style={{ padding: 0, border: 0, background: 'none' }}>
                <div className="date"><div className="m">{dowShort(d.getUTCDay())}</div><div className="d">{d.getUTCDate()}</div><div className="m">{monthShort(d.getUTCMonth())}</div></div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}><b style={{ fontSize: 15 }}>{e.name}</b><span className={`badge ${STATUS_BADGE[e.status]}`}>{e.status}</span></div>
                <div className="small muted">{fmtTime(e.start)}{e.end ? `–${fmtTime(e.end)}` : ''} · {e.room || t('events.tbd')}{e.guestCount ? t('events.guestcountGuests', { guestCount: e.guestCount }) : ''}{e.type ? ` · ${e.type}` : ''}</div>
                {e.needed > 0 && (
                  <div className="row" style={{ marginTop: 6, maxWidth: 320 }}>
                    <div className={`progress ${pct < 1 ? 'low' : ''}`}><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>
                    <span className="tiny muted num" style={{ whiteSpace: 'nowrap' }}>{t('events.filledNeededStaffed', { filled: e.filled, needed: e.needed })}</span>
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
  const t = useT();
  const { call, version, isEvents, isMgr, jobs, people, me, refresh } = useApp();
  const [e, setE] = useState(null);
  const [err, setErr] = useState('');
  const [comment, setComment] = useState('');
  const [run, busy] = useAction();
  const load = () => call('events.get', { id }).then(setE).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, [id, version]);
  if (err) return <Empty title={err} />;
  if (!e) return <div className="empty">{t('common.loading')}</div>;

  const myShift = e.shifts.find((s) => s.userId === me.id);
  const missing = e.staffing.reduce((t, l) => t + Math.max(0, l.count - l.created), 0);
  const drafts = e.shifts.filter((s) => !s.published).length;
  const captain = people[e.captainId];

  const post = async () => {
    await run(() => call('events.comment', { eventId: id, text: comment }), t('events.posted'));
    setComment('');
    load();
  };

  return (
    <div className="beo-print" style={{ maxWidth: 1080 }}>
      <div className="toolbar no-print">
        <a className="btn sm ghost" href="#/events"><Icon name="left" />{t('common.events')}</a>
        <span className="spacer" />
        {!IS_DEMO && <button className="btn sm ghost" onClick={() => window.print()}><Icon name="print" />{t('events.printBeo')}</button>}
        {isEvents && <a className="btn sm" href={`#/events/${id}/edit`}><Icon name="edit" />{t('common.edit')}</a>}
      </div>

      <div className="card card-pad section">
        <div className="row wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="small faint" style={{ fontWeight: 700, letterSpacing: '.06em' }}>{t('events.banquetEventOrder')}</div>
            <h1 style={{ margin: '2px 0 4px' }}>{e.name}</h1>
            <div className="muted">{prettyDate(e.date)} · {fmtTime(e.start)}{e.end ? ` – ${fmtTime(e.end)}` : ''} · {e.room}</div>
          </div>
          <div className="row wrap">
            <span className={`badge ${STATUS_BADGE[e.status]}`}>{e.status}</span>
            {e.guestCount > 0 && <span className="badge brand">{t('events.guestcountGuests2', { guestCount: e.guestCount })}{e.guaranteed ? t('events.guaranteedGuaranteed', { guaranteed: e.guaranteed }) : ''}</span>}
          </div>
        </div>
        {myShift && <div className="alert info" style={{ marginTop: 12 }}><Icon name="user" size={16} />{t('events.youreWorkingThisNameTime', { name: jobs[myShift.jobCodeId]?.name, time: shiftTime(myShift) })}</div>}
      </div>

      <EventPlans event={e} />

      <div className="beo">
        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>{t('events.details')}</h2>
          <dl className="kv">
            <dt>{t('events.type')}</dt><dd>{e.type || '—'}</dd>
            <dt>{t('events.service')}</dt><dd>{styleLabel(SERVICE_STYLES[e.serviceStyle], t.lang) || '—'}</dd>
            <dt>{t('events.banquetCaptain')}</dt><dd>{captain ? <span className="row" style={{ gap: 6 }}><Avatar user={captain} size="sm" />{captain.name}</span> : t('events.none')}</dd>
            <dt>{t('events.client')}</dt><dd>{e.client || '—'}</dd>
            {e.contactName && <><dt>{t('events.contact')}</dt><dd>{e.contactName}{e.contactPhone ? ` · ${e.contactPhone}` : ''}{e.contactEmail ? ` · ${e.contactEmail}` : ''}</dd></>}
            {e.attire && <><dt>{t('events.attire')}</dt><dd>{e.attire}</dd></>}
            {isEvents && e.estRevenue > 0 && <><dt>{t('events.estRevenue')}</dt><dd>{money(e.estRevenue)}</dd></>}
          </dl>
        </div>

        <div className="card card-pad">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ flex: 1 }}>{t('events.staffing')}</h2>
            {e.needed > 0 && <span className={`badge ${e.filled >= e.needed ? 'ok' : 'warn'}`}>{t('events.filledNeededFilled', { filled: e.filled, needed: e.needed })}</span>}
          </div>
          {!e.staffing.length ? <div className="muted small">{t('events.noStaffingRequirementsListed')}</div> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{t('common.position')}</th><th>{t('events.need')}</th><th>{t('events.callTime')}</th><th>{t('events.filled')}</th></tr></thead>
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
                <span key={s.id} className={`badge ${s.userId ? '' : 'warn'}`}><JobDot job={jobs[s.jobCodeId]} />{s.userId ? people[s.userId]?.name : t('common.open')} · {fmtTime(s.start)}</span>
              ))}
            </div>
          )}
          {isMgr && (missing > 0 || drafts > 0) && (
            <div className="row wrap no-print" style={{ marginTop: 12 }}>
              {missing > 0 && <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('events.generateShifts', { id, publish: true }), (r) => t('events.postedCreatedOpenShiftsFor', { created: r.created })).then(load)}><Icon name="plus" />{t('events.createCountOpenShiftsPost', { count: missing })}</button>}
              {drafts > 0 && <button className="btn sm" disabled={busy} onClick={() => run(() => call('shifts.publish', { eventId: id }), t('events.eventShiftsPublished')).then(load)}><Icon name="send" />{t('events.publishCountDrafts', { count: drafts })}</button>}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>{t('events.menu')}</h2>
          {!e.menu?.length ? <div className="muted small">{t('events.noMenuItems')}</div> : (
            <div className="col" style={{ gap: 10 }}>
              {e.menu.map((m, i) => (
                <div key={i}><div className="tiny faint" style={{ fontWeight: 700, textTransform: 'uppercase' }}>{m.course}</div><div style={{ fontWeight: 600 }}>{m.item}</div>{m.notes && <div className="small muted">{m.notes}</div>}</div>
              ))}
            </div>
          )}
          {e.dietaryNotes && <div className="alert warn" style={{ marginTop: 12 }}><Icon name="alert" size={16} /><div>{t('events.bDietaryBDietarynotes', { dietaryNotes: e.dietaryNotes })}</div></div>}
        </div>

        <div className="card card-pad">
          <h2 style={{ marginBottom: 10 }}>{t('events.beverage')}</h2>
          <dl className="kv" style={{ marginBottom: 10 }}>
            <dt>{t('events.package')}</dt><dd>{e.beverage?.package || '—'}</dd>
            <dt>{t('events.bar')}</dt><dd>{e.beverage?.bar || '—'}</dd>
            {e.beverage?.notes && <><dt>{t('common.notes')}</dt><dd>{e.beverage.notes}</dd></>}
          </dl>
          {e.specialDrinks?.length > 0 && <>
            <h3 style={{ margin: '12px 0 8px' }}>{t('events.specialDrinks')}</h3>
            <div className="col">
              {e.specialDrinks.map((d, i) => (
                <div key={i} className="drink"><div style={{ fontWeight: 700 }}>🍸 {d.name}</div><div className="small">{d.recipe}</div>{d.batch && <div className="tiny faint">{d.batch}</div>}</div>
              ))}
            </div>
          </>}
        </div>

        {e.timeline?.length > 0 && (
          <div className="card card-pad">
            <h2 style={{ marginBottom: 10 }}>{t('events.timeline')}</h2>
            <table className="table"><tbody>{e.timeline.map((t, i) => <tr key={i}><td className="num" style={{ width: 80, fontWeight: 700 }}>{fmtTime(t.time)}</td><td>{t.item}</td></tr>)}</tbody></table>
          </div>
        )}

        {(e.setupNotes || e.avNotes || e.notes) && (
          <div className="card card-pad">
            <h2 style={{ marginBottom: 10 }}>{t('events.setupNotes')}</h2>
            {e.setupNotes && <p style={{ margin: '0 0 8px' }}>{t('events.bSetupBSetupnotes', { setupNotes: e.setupNotes })}</p>}
            {e.avNotes && <p style={{ margin: '0 0 8px' }}>{t('events.bAVBAvnotes', { avNotes: e.avNotes })}</p>}
            {e.notes && <p style={{ margin: 0 }}>{e.notes}</p>}
          </div>
        )}

        <div className="card card-pad full no-print">
          <h2 style={{ marginBottom: 6 }}>{t('events.teamThread')}</h2>
          <p className="small muted" style={{ margin: '0 0 8px' }}>{t('events.questionsAndUpdatesGoTo')}</p>
          {e.comments.map((c) => (
            <div key={c.id} className="comment">
              <Avatar user={people[c.userId]} size="sm" />
              <div><div className="small"><b>{c.userName}</b> <span className="faint">{stamp(c.at)}</span></div><div>{c.text}</div></div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" placeholder={t('events.askAQuestionOrPost')} value={comment} onChange={(x) => setComment(x.target.value)} onKeyDown={(x) => x.key === 'Enter' && comment.trim() && post()} />
            <button className="btn primary" disabled={!comment.trim() || busy} onClick={post}><Icon name="send" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

const blank = (today) => ({
  name: '', date: addDays(today, 7), start: '18:00', end: '22:00', room: '', roomId: '', guestCount: 50, guaranteed: '', type: '', serviceStyle: 'plated', status: 'tentative',
  client: '', contactName: '', contactPhone: '', contactEmail: '', estRevenue: '', captainId: '', attire: '',
  menu: [], beverage: { package: '', bar: '', notes: '' }, specialDrinks: [], staffing: [], timeline: [], setupNotes: '', dietaryNotes: '', avNotes: '', notes: '',
});

function EventEditor({ id }) {
  const t = useT();
  const { call, today, settings, jobCodes, employees, jobs, isMgr } = useApp();
  const [e, setE] = useState(id ? null : blank(today));
  const [run, busy] = useAction();
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { if (id) call('events.get', { id }).then((x) => setE({ ...blank(today), ...x })); }, [id]);
  if (!e) return <div className="empty">{t('common.loading')}</div>;

  const set = (k) => (x) => setE((c) => ({ ...c, [k]: x?.target ? x.target.value : x }));
  const captains = employees.filter((u) => u.jobCodes?.some((j) => /captain/i.test(jobs[j.jobCodeId]?.name || '')) || u.role === 'manager' || u.role === 'admin');

  const suggest = async () => {
    const lines = await run(() => call('events.suggestStaffing', e));
    if (lines) setE((c) => ({ ...c, staffing: lines }));
  };
  const save = async () => {
    const r = await run(() => call('events.save', { ...e, guaranteed: Number(e.guaranteed) || '', estRevenue: Number(e.estRevenue) || 0 }), t('events.beoSavedStaffOnThis'));
    if (r) location.hash = `#/events/${r.id}`;
  };
  const remove = async () => {
    if (!confirmDel) return setConfirmDel(true);
    const r = await run(() => call('events.delete', { id }), t('events.eventDeleted'));
    if (r) location.hash = '#/events';
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="toolbar">
        <a className="btn sm ghost" href={id ? `#/events/${id}` : '#/events'}><Icon name="left" />{t('events.back')}</a>
        <span className="spacer" />
        {id && <button className={`btn sm danger ${confirmDel ? 'solid' : ''}`} onClick={remove}>{confirmDel ? t('events.tapAgainToDelete') : t('common.delete')}</button>}
        <button className="btn sm primary" disabled={busy || !e.name} onClick={save}><Icon name="check" />{t('events.saveBeo')}</button>
      </div>

      <div className="col" style={{ gap: 14 }}>
        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.event')}</h2>
          <Field label={t('events.eventName')}><input className="input" value={e.name} onChange={set('name')} placeholder={t('events.eGSmithWeddingReception')} /></Field>
          <div className="grid3">
            <Field label={t('common.date')}><input className="input" type="date" value={e.date} onChange={set('date')} /></Field>
            <Field label={t('events.guestArrival')}><input className="input" type="time" value={e.start} onChange={set('start')} /></Field>
            <Field label={t('events.end')}><input className="input" type="time" value={e.end} onChange={set('end')} /></Field>
          </div>
          <div className="grid3">
            <RoomField e={e} setE={setE} settings={settings} />
            <Field label={t('events.guestCount')}><input className="input" type="number" min="0" value={e.guestCount} onChange={set('guestCount')} /></Field>
            <Field label={t('events.guaranteed')}><input className="input" type="number" min="0" value={e.guaranteed} onChange={set('guaranteed')} /></Field>
          </div>
          <div className="grid3">
            <Field label={t('events.status')}>
              <select className="input" value={e.status} onChange={set('status')}>
                <option value="tentative">{t('events.tentativeHiddenFromStaff')}</option><option value="confirmed">{t('events.confirmed')}</option><option value="completed">{t('events.completed')}</option><option value="cancelled">{t('events.cancelled')}</option>
              </select>
            </Field>
            <Field label={t('events.eventType')}><input className="input" list="types" value={e.type} onChange={set('type')} placeholder={t('events.weddingCorporate')} />
              <datalist id="types">{t('events.typeSuggestions').split('|').map((x) => <option key={x} value={x} />)}</datalist>
            </Field>
            <Field label={t('events.serviceStyle')}>
              <select className="input" value={e.serviceStyle} onChange={set('serviceStyle')}>{Object.entries(SERVICE_STYLES).map(([k, v]) => <option key={k} value={k}>{styleLabel(v, t.lang)}</option>)}</select>
            </Field>
          </div>
          <div className="grid3">
            <Field label={t('events.banquetCaptain')}>
              <select className="input" value={e.captainId || ''} onChange={set('captainId')}><option value="">{t('events.none')}</option>{captains.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            </Field>
            <Field label={t('events.staffAttire')}><input className="input" value={e.attire} onChange={set('attire')} placeholder={t('events.allBlack')} /></Field>
            <Field label={t('events.estRevenue2')} help={t('events.usedInLaborForecast')}><input className="input" type="number" value={e.estRevenue} onChange={set('estRevenue')} /></Field>
          </div>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.client')}</h2>
          <div className="grid2">
            <Field label={t('events.clientCompany')}><input className="input" value={e.client} onChange={set('client')} /></Field>
            <Field label={t('events.contactName')}><input className="input" value={e.contactName} onChange={set('contactName')} /></Field>
            <Field label={t('events.phone')}><input className="input" value={e.contactPhone} onChange={set('contactPhone')} /></Field>
            <Field label={t('common.email')}><input className="input" value={e.contactEmail} onChange={set('contactEmail')} /></Field>
          </div>
          <div className="help">{t('events.clientContactInfoIsOnly')}</div>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <div className="row"><h2 style={{ flex: 1 }}>{t('events.staffingNeeded')}</h2><button className="btn sm" onClick={suggest} disabled={busy}><Icon name="sparkle" />{t('events.suggestFromGuestCount')}</button></div>
          <div className="help">{t('events.howManyServersBartendersFood')}{' '}{isMgr ? t('events.afterSavingCreateOpenShifts') : t('events.managersTurnTheseIntoShifts')}</div>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="staffing" empty={t('events.addPosition')} row={() => ({ jobCodeId: jobCodes.find((j) => j.eventRole)?.id || jobCodes[0]?.id, count: 1, start: addHour(e.start, -1), notes: '' })}
            cols={[{ f: 'jobCodeId', type: 'job', w: '1.4fr' }, { f: 'count', type: 'number', label: '#', w: '70px' }, { f: 'start', type: 'time', label: t('events.call'), w: '120px' }, { f: 'notes', label: t('common.notes'), w: '1.4fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.menu')}</h2>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="menu" empty={t('events.addCourseItem')} row={() => ({ course: '', item: '', notes: '' })}
            cols={[{ f: 'course', label: t('events.courseEGEntrE'), w: '1fr' }, { f: 'item', label: t('events.item'), w: '1.6fr' }, { f: 'notes', label: t('common.notes'), w: '1.2fr' }]} />
          <Field label={t('events.dietaryRestrictionsAllergies')}><textarea className="input" rows="2" value={e.dietaryNotes} onChange={set('dietaryNotes')} /></Field>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.beverage')}</h2>
          <div className="grid2">
            <Field label={t('events.package')}><input className="input" value={e.beverage?.package || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, package: x.target.value } }))} placeholder={t('events.premiumOpenBar4Hrs')} /></Field>
            <Field label={t('events.barSetup')}><input className="input" value={e.beverage?.bar || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, bar: x.target.value } }))} placeholder={t('events.mainBarSatellite')} /></Field>
          </div>
          <Field label={t('events.beverageNotes')}><input className="input" value={e.beverage?.notes || ''} onChange={(x) => setE((c) => ({ ...c, beverage: { ...c.beverage, notes: x.target.value } }))} placeholder={t('events.champagneToastAt800')} /></Field>
          <h3>{t('events.specialDrinks')}</h3>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="specialDrinks" empty={t('events.addSpecialDrink')} row={() => ({ name: '', recipe: '', batch: '' })}
            cols={[{ f: 'name', label: t('common.name'), w: '1fr' }, { f: 'recipe', label: t('events.recipeBuild'), w: '2fr' }, { f: 'batch', label: t('events.batchQty'), w: '1fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.timeline')}</h2>
          <Repeater e={e} setE={setE} jobCodes={jobCodes} k="timeline" empty={t('events.addTimelineItem')} row={() => ({ time: e.start, item: '' })} cols={[{ f: 'time', type: 'time', w: '130px' }, { f: 'item', label: t('events.whatHappens'), w: '1fr' }]} />
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('events.setupNotes')}</h2>
          <Field label={t('events.roomSetup')}><textarea className="input" rows="2" value={e.setupNotes} onChange={set('setupNotes')} placeholder={t('events.roundsOf8HeadTable')} /></Field>
          <Field label={t('events.aV')}><input className="input" value={e.avNotes} onChange={set('avNotes')} /></Field>
          <Field label={t('events.otherNotes')}><textarea className="input" rows="2" value={e.notes} onChange={set('notes')} /></Field>
        </div>
        <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy || !e.name} onClick={save}><Icon name="check" />{t('events.saveBeo')}</button></div>
      </div>
    </div>
  );
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The event's room: one of the venue's rooms (stored by id), Full Buyout, or anything else typed in. */
function RoomField({ e, setE, settings }) {
  const t = useT();
  const rooms = useVenueRooms();
  const [typing, setTyping] = useState(false);
  if (!rooms?.length) { // no venue set up yet: the room list from Settings
    return (
      <Field label={t('events.roomArea')}>
        <input className="input" list="rooms" value={e.room} onChange={(x) => setE((c) => ({ ...c, room: x.target.value, roomId: '' }))} />
        <datalist id="rooms">{settings.rooms.map((r) => <option key={r} value={r} />)}</datalist>
      </Field>
    );
  }
  const linked = rooms.find((r) => r.id === e.roomId) || rooms.find((r) => norm(r.name) === norm(e.room));
  const bookings = (settings.rooms || []).filter((n) => !rooms.some((r) => norm(r.name) === norm(n)));
  const booking = !linked && bookings.find((n) => norm(n) === norm(e.room));
  const other = !linked && !booking && (typing || !!e.room);
  const value = linked ? linked.id : booking ? `name:${booking}` : other ? 'other' : '';
  const levels = [...new Set(rooms.map((r) => r.level || t('events.rooms')))];
  const pick = (v) => {
    setTyping(v === 'other');
    if (v === 'other') setE((c) => ({ ...c, roomId: '', room: '' }));
    else if (v.startsWith('name:')) setE((c) => ({ ...c, roomId: '', room: v.slice(5) }));
    else setE((c) => ({ ...c, roomId: v, room: rooms.find((r) => r.id === v)?.name || '' }));
  };
  return (
    <Field label={t('events.room')}>
      <select className="input" value={value} onChange={(x) => pick(x.target.value)}>
        <option value="">{t('events.notSet')}</option>
        {levels.map((l) => (
          <optgroup key={l} label={levels.length > 1 ? l : t('events.rooms')}>
            {rooms.filter((r) => (r.level || t('events.rooms')) === l).map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ''}</option>)}
          </optgroup>
        ))}
        <optgroup label={t('events.other')}>
          {bookings.map((n) => <option key={n} value={`name:${n}`}>{n}</option>)}
          <option value="other">{t('events.somewhereElse')}</option>
        </optgroup>
      </select>
      {other && <input className="input" style={{ marginTop: 6 }} value={e.room} autoFocus={typing} placeholder={t('events.eGPatioAndLibrary')} onChange={(x) => setE((c) => ({ ...c, roomId: '', room: x.target.value }))} />}
    </Field>
  );
}

function Repeater({ e, setE, jobCodes, k, cols, empty, row }) {
  const t = useT();
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
          <button className="btn sm icon ghost" onClick={() => del(i)} aria-label={t('common.remove')}><Icon name="x" /></button>
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
