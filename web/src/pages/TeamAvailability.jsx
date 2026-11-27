// Time Off → Availability → Team and Sheet: everyone's weekly availability side by side, for managers (and supervisors
// for employees when Roles & features turns on "Edit staff availability"). One read: availability.team.get
// (core/availability-team.js). Staff never get here (the server refuses them too).
//   Team   one row per person: name, positions and primary room, then each weekday: standing request off, unavailable,
//          some hours or open, with the day's note. Filters, a footer count of standing requests off per day, CSV.
//          Clicking a person opens their availability (AvailabilityDialog: edit when allowed, and history).
//   Sheet  like the house availability spreadsheet: room banners, position headers, names in capitals, Mon–Sun with the
//          week's dates. Green REQ OFF = standing request off; yellow REQ OFF = time off that week (REQ OFF? pending);
//          OFF = unavailable; the hours when partial; blank = open. Prints landscape; on a phone only the grid scrolls.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Icon, Field, Empty } from '../ui.jsx';
import { useT, prettyDate, dowShort, dowLong, fmtTime } from '../i18n/index.js';
import { addDays, parseDate } from '../../../core/time.js';
import { toCsv } from '../../../core/exports.js';
import { textOn } from '../../../core/areas.js';
import { AvailabilityDialog } from './AvailabilityEditor.jsx';
import { plural } from './ScheduleSheet.jsx';
import '../availability.css';

const key = (s) => String(s || '').trim().toLowerCase();
const usDate = (d) => { const x = parseDate(d); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
/** "4PM", "3:30PM": the sheet's way of writing a time. */
const sheetClock = (t) => { const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'PM' : 'AM'}`; };

/** A day's short text for the Team list: "Req off" · "Off" · "after 4:00 PM" · "Open". */
export function dayLabel(t, d) {
  if (d.status === 'standing') return t('teamAv.standingOff');
  if (d.status === 'off') return t('teamAv.unavailable');
  if (d.status === 'partial') return d.from && d.to ? t('teamAv.range', { from: fmtTime(d.from), to: fmtTime(d.to) }) : d.from ? t('teamAv.after', { time: fmtTime(d.from) }) : t('teamAv.until', { time: fmtTime(d.to) });
  return t('teamAv.available');
}
/** The sheet's cell: { cls, text, title }. */
function sheetCell(t, d) {
  const title = [d.timeOff ? (d.timeOff.status === 'approved' ? t('teamAv.timeOffApproved') : t('teamAv.timeOffPending')) + (d.timeOff.reason ? ` · ${d.timeOff.reason}` : '') : '',
    d.status === 'standing' ? (d.requestedAt ? t('teamAv.standingSince', { date: prettyDate(d.requestedAt.slice(0, 10)) }) : t('teamAv.standingTitle')) : '', d.note].filter(Boolean).join('\n');
  if (d.timeOff) return { cls: `av-dated ${d.timeOff.status === 'pending' ? 'pending' : ''}`, text: d.timeOff.status === 'pending' ? t('teamAv.sheetPending') : t('teamAv.sheetReqOff'), title };
  if (d.status === 'standing') return { cls: 'av-standing-cell', text: t('teamAv.sheetReqOff'), title };
  if (d.status === 'off') return { cls: 'av-off-cell', text: t('teamAv.sheetOff'), title };
  if (d.status === 'partial') return { cls: 'av-partial-cell', text: d.from && d.to ? `${sheetClock(d.from)}-${sheetClock(d.to)}` : d.from ? t('teamAv.sheetAfter', { time: sheetClock(d.from) }) : t('teamAv.sheetUntil', { time: sheetClock(d.to) }), title };
  return { cls: '', text: d.note ? d.note.replace(/^Sheet note:\s*/i, '') : '', title };
}

/** Load the week: { data, week, setWeek }. weekStart null → the server's default (next week). */
function useTeamWeek() {
  const { call, version } = useApp();
  const [week, setWeek] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call('availability.team.get', week ? { weekStart: week } : {}).then((d) => { if (live) { setData(d); setError(''); } }, (e) => live && setError(e.message || String(e)));
    return () => { live = false; };
  }, [week, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, week: data?.weekStart || week, setWeek };
}

function WeekPicker({ week, setWeek }) {
  const t = useT();
  if (!week) return null;
  return (
    <div className="row av-weekpick no-print" role="group" aria-label={t('teamAv.week')}>
      <button type="button" className="btn sm icon" onClick={() => setWeek(addDays(week, -7))} aria-label={t('teamAv.prevWeek')} title={t('teamAv.prevWeek')}><Icon name="left" /></button>
      <input className="input sm" type="date" value={week} onChange={(e) => e.target.value && setWeek(e.target.value)} aria-label={t('teamAv.week')} />
      <button type="button" className="btn sm icon" onClick={() => setWeek(addDays(week, 7))} aria-label={t('teamAv.nextWeek')} title={t('teamAv.nextWeek')}><Icon name="right" /></button>
    </div>
  );
}

/** The filters both views share. */
function useFilters(people) {
  const [f, setF] = useState({ room: '', position: '', q: '', standing: false });
  const rows = useMemo(() => (people || []).filter((p) => (!f.room || (f.room === '-' ? !p.room : key(p.room) === key(f.room)))
    && (!f.position || p.positions.some((x) => x.jobCodeId === f.position))
    && (!f.q || [p.name, p.sheetName, p.legalName].some((n) => key(n).includes(key(f.q))))
    && (!f.standing || p.days.some((d) => d.status === 'standing'))), [people, f]);
  return [f, setF, rows];
}

function Filters({ data, f, setF }) {
  const t = useT();
  const positions = useMemo(() => {
    const m = new Map();
    for (const p of data.people) for (const x of p.positions) m.set(x.jobCodeId, x.name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const noRoom = data.people.some((p) => !p.room);
  return (
    <div className="sl-filters av-team-filters no-print">
      <Field label={t('teamAv.room')}>
        <select className="input" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}>
          <option value="">{t('teamAv.allRooms')}</option>
          {data.rooms.map((r) => <option key={r.room} value={r.room}>{r.room}</option>)}
          {noRoom && <option value="-">{t('teamAv.noRoom')}</option>}
        </select>
      </Field>
      <Field label={t('teamAv.position')}>
        <select className="input" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })}>
          <option value="">{t('teamAv.allPositions')}</option>
          {positions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>
      <Field label={t('teamAv.search')}>
        <input className="input" type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={t('teamAv.search')} />
      </Field>
      <label className="row av-check"><input type="checkbox" checked={f.standing} onChange={(e) => setF({ ...f, standing: e.target.checked })} />{t('teamAv.onlyStanding')}</label>
    </div>
  );
}

/** Time Off → Availability → Team. */
export function TeamAvailabilityList() {
  const t = useT();
  const { data, error } = useTeamWeek();
  const [f, setF, rows] = useFilters(data?.people);
  const [open, setOpen] = useState(null);
  if (error) return <div className="alert bad"><Icon name="alert" size={16} /><div>{error}</div></div>;
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const dows = data.dates.map((d) => parseDate(d).getUTCDay());
  const standing = dows.map((_, i) => rows.filter((p) => p.days[i].status === 'standing').length);
  const exportCsv = () => {
    const legal = rows.some((p) => p.legalName);
    const head = [t('teamAv.csvName'), ...(legal ? [t('teamAv.csvLegalName')] : []), t('teamAv.csvPositions'), t('teamAv.csvRoom'), ...dows.map((d) => dowLong(d)), t('teamAv.csvNotes')];
    const body = rows.map((p) => [p.name, ...(legal ? [p.legalName || ''] : []), p.positions.map((x) => x.name).join('; '), p.room,
      ...p.days.map((d) => [dayLabel(t, d), d.note].filter(Boolean).join(' · ')), p.notes]);
    const foot = [t('teamAv.footerStanding'), ...(legal ? [''] : []), '', '', ...standing.map(String), ''];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${toCsv([head, ...body, foot])}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `availability-${data.weekStart}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted">{t('teamAv.teamHelp')}</div>
      <Filters data={data} f={f} setF={setF} />
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="small muted">{t('teamAv.showing', { count: rows.length })}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />{t('teamAv.exportCsv')}</button>
      </div>
      {!rows.length ? <Empty icon="users" title={t('teamAv.noneMatch')} /> : (
        <div className="card av-team-wrap">
          <table className="av-team">
            <thead>
              <tr><th className="av-team-who">{t('teamAv.person')}</th>{dows.map((d, i) => <th key={i}>{dowShort(d)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="av-team-who">
                    <button type="button" className="av-who-btn" onClick={() => setOpen(p)}>{p.name}</button>
                    {p.legalName && <span className="tiny faint"> ({p.legalName})</span>}
                    <div className="tiny muted">{[p.positions.map((x) => x.name).join(', '), p.room].filter(Boolean).join(' · ')}</div>
                    {(p.effectiveFrom || !p.canEdit) && <div className="tiny faint">{[p.effectiveFrom && t('teamAv.effectiveFrom', { date: prettyDate(p.effectiveFrom) }), !p.canEdit && t('teamAv.readOnly')].filter(Boolean).join(' · ')}</div>}
                    {p.notes && <div className="tiny faint av-team-notes" title={p.notes}>{p.notes}</div>}
                  </td>
                  {p.days.map((d, i) => (
                    <td key={i} className={`av-team-day ${d.status}`} data-day={dowShort(dows[i])}
                      title={[dowLong(dows[i]), dayLabel(t, d), d.status === 'standing' && d.requestedAt ? t('teamAv.standingSince', { date: prettyDate(d.requestedAt.slice(0, 10)) }) : '', d.note].filter(Boolean).join(' · ')}>
                      <span className="av-chip">{dayLabel(t, d)}</span>
                      {d.note && <span className="av-daynote">{d.note}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td className="av-team-who">{t('teamAv.footerStanding')}</td>{standing.map((n, i) => <td key={i} className="av-team-day" data-day={dowShort(dows[i])}><b>{n}</b></td>)}</tr>
            </tfoot>
          </table>
        </div>
      )}
      {open && createPortal(<AvailabilityDialog person={open} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}

/** Rooms → positions → people, like the house sheet. People sit under their primary room and position. */
export function sheetGroups(data, rows, otherBanner) {
  const order = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name);
  const used = new Set();
  const groups = [];
  const take = (list) => { list.forEach((p) => used.add(p.id)); return list.sort(order); };
  data.rooms.forEach((r, ri) => {
    const inRoom = rows.filter((p) => key(p.room) === key(r.room));
    const secs = [];
    for (const pos of r.positions) {
      const people = take(inRoom.filter((p) => !used.has(p.id) && p.jobCodeId === pos.jobCodeId));
      if (people.length) secs.push({ key: pos.jobCodeId, label: pos.label || plural(pos.name), people });
    }
    const rest = inRoom.filter((p) => !used.has(p.id));
    const byJob = new Map();
    for (const p of rest) { const name = p.positions.find((x) => x.jobCodeId === p.jobCodeId)?.name || ''; byJob.set(name, [...(byJob.get(name) || []), p]); }
    for (const [name, list] of byJob) secs.push({ key: `x-${name}`, label: name ? plural(name) : '', people: take(list) });
    if (secs.length) groups.push({ banner: r.room, color: r.color, index: ri, secs });
  });
  const left = rows.filter((p) => !used.has(p.id));
  if (left.length) {
    const byJob = new Map();
    for (const p of left) { const name = p.positions.find((x) => x.jobCodeId === p.jobCodeId)?.name || ''; byJob.set(name, [...(byJob.get(name) || []), p]); }
    groups.push({ banner: otherBanner, color: '#d9d9d9', index: data.rooms.length, secs: [...byJob].map(([name, list]) => ({ key: `o-${name}`, label: name ? plural(name) : '', people: take(list) })) });
  }
  return groups;
}

/** Time Off → Availability → Sheet. */
export function AvailabilitySheet() {
  const t = useT();
  const { data, error, week, setWeek } = useTeamWeek();
  const [f, setF, rows] = useFilters(data?.people);
  const [open, setOpen] = useState(null);
  if (error) return <div className="alert bad"><Icon name="alert" size={16} /><div>{error}</div></div>;
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const dows = data.dates.map((d) => parseDate(d).getUTCDay());
  const groups = sheetGroups(data, rows, t('teamAv.otherBanner'));
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small muted no-print">{t('teamAv.sheetHelp')}</div>
      <div className="row wrap no-print" style={{ gap: 8 }}>
        <WeekPicker week={week} setWeek={setWeek} />
        <b className="small">{t('teamAv.weekOf', { date: prettyDate(data.weekStart) })}</b>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => window.print()}><Icon name="print" />{t('teamAv.print')}</button>
      </div>
      <Filters data={data} f={f} setF={setF} />
      <div className="print-only av-print-title">{t('teamAv.weekOf', { date: prettyDate(data.weekStart) })}</div>
      {!rows.length ? <Empty icon="users" title={t('teamAv.noneMatch')} /> : (
        <div className="sheet-wrap av-sheet-wrap av-sheet-print">
          <table className="sheet av-sheet">
            <colgroup><col className="sh-namecol" />{dows.map((d, i) => <col key={i} />)}</colgroup>
            <tbody>
              {groups.map((g, gi) => {
                const fill = { background: g.color, color: textOn(g.color) };
                return (
                  <React.Fragment key={g.banner + gi}>
                    <tr className="sh-banner"><td colSpan={8} style={fill}><span className="sh-banner-t">{g.banner}</span></td></tr>
                    {gi === 0 && <tr className="sh-dates"><td />{data.dates.map((d) => <td key={d}>{usDate(d)}</td>)}</tr>}
                    {g.secs.map((sec) => (
                      <React.Fragment key={sec.key}>
                        <tr className="sh-head"><td style={fill}>{sec.label}</td>{dows.map((d, i) => <td key={i}>{dowLong(d).toUpperCase()}</td>)}</tr>
                        {sec.people.map((p) => (
                          <tr key={p.id}>
                            <td className="sh-name av-sheet-name" title={p.name} onClick={() => setOpen(p)}>{p.sheetName || p.name}</td>
                            {p.days.map((d, i) => { const c = sheetCell(t, d); return <td key={i} className={c.cls} title={c.title || undefined}>{c.text}</td>; })}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="av-sheet-legend" aria-label={t('teamAv.legend')}>
        <b className="small">{t('teamAv.legend')}</b>
        <span><i className="av-key av-standing-cell">{t('teamAv.sheetReqOff')}</i>{t('teamAv.legendStanding')}</span>
        <span><i className="av-key av-dated">{t('teamAv.sheetReqOff')}</i>{t('teamAv.legendDated')}</span>
        <span><i className="av-key">{t('teamAv.sheetOff')}</i>{t('teamAv.legendOff')}</span>
        <span><i className="av-key">{t('teamAv.sheetAfter', { time: '4PM' })}</i>{t('teamAv.legendPartial')}</span>
        <span><i className="av-key" />{t('teamAv.legendOpen')}</span>
      </div>
      {open && createPortal(<AvailabilityDialog person={open} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}
