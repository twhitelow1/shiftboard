import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, useAction, JobDot } from '../ui.jsx';
import { useT, fmtTime, prettyDate, dowShort } from '../i18n/index.js';
import { dow } from '../../../core/time.js';
import '../programming.css';

// Regular programming on the calendar, the schedule, the publish dialog, an event and the forecast (core/programming.js).
// Everyone sees what's on; pars and coverage come only when the server sends them (the staffingPars role feature).
// Programming names, rooms and notes are the restaurant's and stay as typed.

/** programming.days.list for a range: { data, reload }. Silently empty if the server doesn't have it yet. */
export function useProgrammingDays(start, end, enabled = true) {
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  const reload = () => (enabled && start && end ? call('programming.days.list', { start, end }).then(setData).catch(() => setData(null)) : Promise.resolve());
  useEffect(() => { reload(); }, [start, end, version, enabled]);
  return { data, reload, byDate: Object.fromEntries((data?.days || []).map((d) => [d.date, d])) };
}

const timeOf = (x, t) => `${fmtTime(x.partStart || x.start)}–${x.partEnd ? fmtTime(x.partEnd) : x.end ? fmtTime(x.end) : t('programming.close')}`;
const roomsOf = (x, t) => (x.rooms?.length ? x.rooms.join(' · ') : t('programming.wholeVenue'));

/** The month grid's little colored lines: each item (crossed out when replaced or cancelled). */
export function ProgChips({ day, max = 3 }) {
  if (!day?.items?.length) return null;
  return (
    <div className="prog-chips">
      {day.items.slice(0, max).map((x) => (
        <div key={x.id} className={`prog-chip ${x.status === 'replaced' || x.status === 'cancelled' ? 'off' : ''}`} style={{ '--pc': x.color }} title={x.name}>{x.name}</div>
      ))}
    </div>
  );
}

/** "Bartender 2/3" chips, red when short. */
export function ParLines({ lines, jobs }) {
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {lines.map((l, i) => (
        <span key={i} className={`badge ${l.gap ? 'bad' : 'ok'}`} title={l.start ? fmtTime(l.start) : ''}>
          {jobs[l.jobCodeId]?.name || '—'} {l.have}/{l.need}{l.open ? ` (+${l.open})` : ''}
        </span>
      ))}
    </div>
  );
}

/** One day's programming, by room: time, notes, what replaced it, and (with pars) scheduled vs par. Calendar, phone layout. */
export function DayProgramming({ day, onChanged }) {
  const t = useT();
  const { jobs } = useApp();
  const [open, setOpen] = useState(null);
  if (!day) return null;
  const cov = (kind, id) => day.coverage?.find((c) => c.kind === kind && c.id === id);
  if (!day.items.length && !day.events.length) {
    return day.closed ? <div className="card card-pad prog-day small muted">{t('programming.closedDay')}</div> : null;
  }
  return (
    <div className="card prog-day" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.whatsOn')}</h2>
        {day.coverage && day.short > 0 && <span className="badge bad">{t('programming.shortCount', { count: day.short })}</span>}</div>
      <div className="list">
        {day.items.map((x) => {
          const off = x.status === 'replaced' || x.status === 'cancelled';
          const c = cov('item', x.id);
          return (
            <div key={x.id} className="list-item click prog-item" onClick={() => setOpen(open === x.id ? null : x.id)} style={{ '--pc': x.color }}>
              <span className="prog-bar" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={off ? 'prog-off' : ''}><b>{x.name}</b> <span className="muted small">· {roomsOf(x, t)} · {timeOf(x, t)}</span></div>
                {x.status === 'replaced' && <div className="small prog-note">{t('programming.replacedBy', { name: x.replacedBy.map((r) => r.name || t('programming.anEvent')).join(', ') })}</div>}
                {x.status === 'partial' && <div className="small prog-note">{x.roomsLeft ? t('programming.partlyRooms', { name: x.replacedBy.map((r) => r.name || t('programming.anEvent')).join(', '), rooms: x.roomsLeft.join(' · ') }) : t('programming.partlyTime', { name: x.replacedBy.map((r) => r.name || t('programming.anEvent')).join(', ') })}</div>}
                {x.status === 'cancelled' && <div className="small prog-note">{t('programming.cancelledDay')}{x.exception?.reason ? ` · ${x.exception.reason}` : ''}</div>}
                {x.status !== 'cancelled' && x.exception?.start && <div className="small prog-note">{t('programming.newTimes')}{x.exception.reason ? ` · ${x.exception.reason}` : ''}</div>}
                {x.status !== 'cancelled' && x.exception?.pars && <div className="small prog-note">{t('programming.newPars')}{x.exception.reason ? ` · ${x.exception.reason}` : ''}</div>}
                {open === x.id && (
                  <div className="col" style={{ gap: 6, marginTop: 6 }}>
                    {x.notes && <div className="small">{x.notes}</div>}
                    {c && !off ? <ParLines lines={c.lines} jobs={jobs} /> : x.pars?.length && !off ? <div className="small muted">{x.pars.map((p) => `${jobs[p.jobCodeId]?.name} ${p.count}`).join(' · ')}</div> : null}
                  </div>
                )}
                {open !== x.id && c && !off && c.lines.some((l) => l.gap) && <div className="small" style={{ color: 'var(--bad)', marginTop: 2 }}>{t('programming.shortHere', { count: c.lines.reduce((s, l) => s + l.gap, 0) })}</div>}
              </div>
              <Icon name={open === x.id ? 'up' : 'down'} size={14} />
            </div>
          );
        })}
        {day.events.map((e) => {
          const c = cov('event', e.id);
          return (
            <div key={e.id} className="list-item prog-item prog-event">
              <span className="prog-bar" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div><a href={`#/events/${e.id}`}><b>{e.name}</b></a> <span className="muted small">· {e.all ? t('programming.fullBuyout') : e.rooms.join(' · ') || e.room} · {fmtTime(e.start)}{e.end ? `–${fmtTime(e.end)}` : ''}{e.guestCount ? ` · ${t('programming.guests', { count: e.guestCount })}` : ''}</span></div>
                {c && <div style={{ marginTop: 4 }}><ParLines lines={c.lines} jobs={jobs} /></div>}
                {e.needsPars && <EventParsButtons event={e} onChanged={onChanged} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "Use the regular pars" / "Set pars for this event": for an event with no staffing that replaces programming with pars. */
function EventParsButtons({ event, onChanged }) {
  const t = useT();
  const { call, isEvents, isMgr } = useApp();
  const [run, busy] = useAction();
  if (!isEvents && !isMgr) return null;
  const go = (mode, ok) => run(() => call('programming.eventPars', { eventId: event.id, mode }), ok).then((r) => r && onChanged?.());
  return (
    <div className="col" style={{ gap: 6, marginTop: 6 }}>
      <div className="small muted">{t('programming.eventNoPars')}</div>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" disabled={busy} onClick={() => go('regular', t('programming.usingRegular'))}>{t('programming.useRegularPars')}</button>
        <button className="btn sm" disabled={busy} onClick={() => go('copy', t('programming.parsCopied'))}>{t('programming.setEventPars')}</button>
      </div>
    </div>
  );
}

/** On an event's page with no staffing lines: the same choice, or what was chosen. */
export function EventParsChoice({ event, onChanged }) {
  const t = useT();
  const { call } = useApp();
  const { data, reload } = useProgrammingDays(event.date, event.date);
  const [run, busy] = useAction();
  const day = data?.days?.[0];
  const ev = day?.events.find((x) => x.id === event.id);
  const replaced = day?.items.filter((x) => x.replacedBy.some((r) => r.id === event.id)) || [];
  if (!ev || !replaced.length || !data.canPars) return null;
  const done = () => { reload(); onChanged?.(); };
  if (ev.programmingPars === 'regular') {
    return (
      <div className="alert info" style={{ marginTop: 8 }}><Icon name="check" size={16} />
        <span style={{ flex: 1 }}>{t('programming.eventUsesRegular', { names: replaced.map((x) => x.name).join(', ') })}</span>
        <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('programming.eventPars', { eventId: event.id, mode: '' })).then(done)}>{t('common.undo')}</button>
      </div>
    );
  }
  return <div style={{ marginTop: 8 }}><div className="small">{t('programming.replaces', { names: replaced.map((x) => x.name).join(', ') })}</div><EventParsButtons event={ev} onChanged={done} /></div>;
}

/** The schedule grid's par row under a section (a position in a room): "2/3" per day, red when short. */
export function ParRow({ banner, jobCodeId, days, byDate, className = '' }) {
  const t = useT();
  const cells = days.map((d) => {
    const lines = (byDate[d]?.coverage || []).flatMap((c) => c.lines.filter((l) => l.jobCodeId === jobCodeId && (l.room ? l.room === banner : (c.room || '').split(' & ').includes(banner))));
    if (!lines.length) return null;
    return lines.reduce((a, l) => ({ need: a.need + l.need, have: a.have + l.have, gap: a.gap + l.gap }), { need: 0, have: 0, gap: 0 });
  });
  if (!cells.some(Boolean)) return null;
  return (
    <tr className={`par-row ${className}`}>
      <td className="namecol"><span className="small muted">{t('programming.par')}</span></td>
      {cells.map((c, i) => <td key={days[i]}>{c && <div className={`gapcell ${c.gap ? 'under' : 'okay'}`} title={t('programming.parTitle', { have: c.have, need: c.need })}>{c.have}/{c.need}</div>}</td>)}
    </tr>
  );
}

/** Managers' coverage panel on the schedule: each day's rooms and positions vs par, and open shifts for the gaps. */
export function CoveragePanel({ days, byDate, onChanged }) {
  const t = useT();
  const { call, jobs } = useApp();
  const [run, busy] = useAction();
  const [ask, setAsk] = useState(null);
  const list = days.map((d) => byDate[d]).filter(Boolean);
  if (!list.some((d) => d.coverage?.length)) return null;
  const short = list.reduce((s, d) => s + (d.short || 0), 0);
  const plan = () => call('programming.fillGaps', { start: days[0], end: days[days.length - 1], dryRun: true }).then((r) => setAsk(r));
  const make = async () => {
    const r = await run(() => call('programming.fillGaps', { start: days[0], end: days[days.length - 1] }), (x) => t('programming.openShiftsMade', { count: x.created }));
    setAsk(null);
    if (r) onChanged?.();
  };
  return (
    <div className="card section prog-coverage no-print" style={{ marginTop: 16 }}>
      <div className="card-head row wrap">
        <h2 style={{ flex: 1 }}>{t('programming.coverage')}</h2>
        {short > 0 ? <span className="badge bad">{t('programming.shortCount', { count: short })}</span> : <span className="badge ok">{t('programming.allCovered')}</span>}
        {short > 0 && <button className="btn sm primary" disabled={busy} onClick={plan}><Icon name="plus" />{t('programming.fillGaps')}</button>}
      </div>
      <div className="prog-cov-days">
        {list.filter((d) => d.coverage?.length).map((d) => (
          <div key={d.date} className="prog-cov-day">
            <div className="row" style={{ gap: 6 }}><b>{dowShort(dow(d.date))} {prettyDate(d.date).replace(/^[^,]*, /, '')}</b>{d.short ? <span className="badge bad">{t('programming.shortCount', { count: d.short })}</span> : null}</div>
            {d.coverage.map((c) => (
              <div key={c.key} className="prog-cov-row" style={{ '--pc': c.color || 'var(--warn)' }}>
                <div className="small"><span className="prog-dot" /> <b>{c.name}</b> <span className="muted">· {c.all ? t('programming.wholeVenue') : c.room}{c.start ? ` · ${fmtTime(c.start)}` : ''}</span></div>
                <ParLines lines={c.lines} jobs={jobs} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="card-pad help" style={{ paddingTop: 0 }}>{t('programming.coverageHelp')}</div>
      {ask && (
        <Modal title={t('programming.fillGapsTitle')} sub={t('programming.fillGapsSub')} onClose={() => setAsk(null)}
          footer={<><span className="spacer" /><button className="btn" onClick={() => setAsk(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy || !ask.wouldCreate} onClick={make}><Icon name="plus" />{t('programming.createCount', { count: ask.wouldCreate })}</button></>}>
          {!ask.wouldCreate ? <div className="muted">{t('programming.nothingToCreate')}</div> : (
            <div className="list">
              {ask.shifts.map((s, i) => (
                <div key={i} className="list-item small"><JobDot job={jobs[s.jobCodeId]} /><span style={{ flex: 1 }}>{prettyDate(s.date)} · {jobs[s.jobCodeId]?.name} · {fmtTime(s.start)}{s.area ? ` · ${s.area}` : ''}</span><span className="muted">{s.notes}</span></div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** In the Publish dialog: understaffed days and rooms, as a warning (never blocks publishing). */
export function StaffingCheck({ start, end }) {
  const t = useT();
  const { call, jobs, has } = useApp();
  const [gaps, setGaps] = useState(null);
  useEffect(() => { if (has('staffingPars')) call('programming.gaps.list', { start, end }).then(setGaps).catch(() => setGaps(null)); }, [start, end]);
  if (!gaps?.short) return null;
  return (
    <div className="alert warn prog-publish">
      <Icon name="alert" size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{t('programming.publishWarn', { count: gaps.short })}</b>
        <ul className="small">
          {gaps.days.slice(0, 7).map((d) => (
            <li key={d.date}>{prettyDate(d.date)}: {d.rooms.map((c) => `${c.name}${c.room ? ` (${c.room})` : ''} ${c.lines.map((l) => `${jobs[l.jobCodeId]?.name} ${l.have}/${l.need}`).join(', ')}`).join('; ')}</li>
          ))}
        </ul>
        <div className="small">{t('programming.publishWarnHelp')}</div>
      </div>
    </div>
  );
}

/** Forecast & Labor: the regular programming's pars next to the forecast's suggestion, per position and day. */
export function ForecastPars({ f, dp }) {
  const t = useT();
  const { jobs } = useApp();
  const days = (f?.days || []).map((d) => d.date);
  const { data } = useProgrammingDays(days[0], days[days.length - 1], days.length > 0);
  if (!data?.canPars) return null;
  const byDate = Object.fromEntries(data.days.map((d) => [d.date, d]));
  const parOf = (date, jid) => (byDate[date]?.coverage || []).reduce((s, c) => s + c.lines.filter((l) => l.jobCodeId === jid).reduce((u, l) => u + l.need, 0), 0);
  const ids = [...new Set(data.days.flatMap((d) => (d.coverage || []).flatMap((c) => c.lines.map((l) => l.jobCodeId))))];
  if (!ids.length) return null;
  const rec = (d, jid) => d.dayparts.find((p) => p.name === dp)?.rows.find((r) => r.jobCodeId === jid)?.recommended;
  return (
    <div className="card section">
      <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.forecastTitle')}</h2><a className="small" href="#/settings/programming">{t('programming.edit')}</a></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('common.position')}</th>{f.days.map((d) => <th key={d.date} style={{ textAlign: 'center' }}>{dowShort(d.dow)}</th>)}</tr></thead>
          <tbody>
            {ids.map((jid) => (
              <tr key={jid}>
                <td style={{ whiteSpace: 'nowrap' }}><span className="row" style={{ gap: 6 }}><JobDot job={jobs[jid]} />{jobs[jid]?.name}</span></td>
                {f.days.map((d) => {
                  const p = parOf(d.date, jid);
                  const r = rec(d, jid);
                  return <td key={d.date} className="num small" style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{p ? <b>{p}</b> : '—'}{r != null ? <span className="muted"> · {r}</span> : ''}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-pad help" style={{ paddingTop: 8 }}>{t('programming.forecastHelp', { daypart: dp })}</div>
    </div>
  );
}
