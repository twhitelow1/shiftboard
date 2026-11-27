// The schedule log (core/schedule-log.js): every change to the schedule, as sentences. Managers: #/schedule-log, with
// filters (dates, person, what, position, room, via), each row expanding to before → after, and a CSV export.
// Everyone: #/my-changes, only what affected them.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, Empty } from '../ui.jsx';
import { useT, stamp } from '../i18n/index.js';
import { addDays } from '../../../core/time.js';
import '../availability.css';

const GROUPS = ['shift', 'week', 'request', 'timeOff', 'availability', 'note', 'mod', 'event', 'layout', 'dayOff'];
const VIAS = ['web', 'phone', 'import', 'connector', 'assistant', 'sync', 'cron'];

function Rows({ rows, people, jobs }) {
  const t = useT();
  const [open, setOpen] = useState(null);
  if (!rows) return <div className="empty">{t('common.loading')}</div>;
  if (!rows.length) return <Empty icon="clock" title={t('scheduleLog.empty')} />;
  const val = (c, v) => (v === '' || v == null ? '—' : c.field === 'userId' ? people[v]?.name || v : c.field === 'jobCodeId' ? jobs[v]?.name || v : String(v));
  return (
    <div className="card list">
      {rows.map((r) => (
        <div key={r.id} className="list-item col" style={{ alignItems: 'stretch', gap: 4 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <a href={r.link} style={{ flex: '1 1 260px', minWidth: 0 }}>{r.text}</a>
            <span className="tiny muted">{stamp(r.at)}</span>
            <span className="badge">{t(`scheduleLog.via_${r.via}`)}</span>
            {r.changes?.length > 0 && <button type="button" className="btn ghost sm" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t('scheduleLog.hide') : t('scheduleLog.details')}</button>}
          </div>
          {open === r.id && (
            <ul className="av-changes">
              {r.changes.map((c, i) => <li key={i}><span className="av-dayname">{t(`scheduleLog.f_${c.field}`)}{c.position ? ` · ${jobs[c.position]?.name || ''}` : ''}</span><span className="si-before">{val(c, c.before)}</span><span aria-hidden="true"> → </span><b>{val(c, c.after)}</b></li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ScheduleLog() {
  const t = useT();
  const { call, employees, jobCodes, jobs, people, today, layout, toast } = useApp();
  const [f, setF] = useState({ from: addDays(today, -14), to: addDays(today, 14), person: '', group: '', jobCodeId: '', room: '', via: '' });
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); call('scheduleLog.list', f).then(setRows, (e) => { toast(e.message, 'bad'); setRows([]); }); }, [JSON.stringify(f)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const exportCsv = async () => {
    const { csv } = await call('scheduleLog.csv', f);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `schedule-log-${f.from}-${f.to}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  return (
    <div style={{ maxWidth: 980 }} className="col">
      <div className="help">{t('scheduleLog.help')}</div>
      <div className="card card-pad sl-filters">
        <Field label={t('scheduleLog.from')}><input className="input sm" type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label={t('scheduleLog.to')}><input className="input sm" type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label={t('scheduleLog.person')}><select className="input sm" value={f.person} onChange={set('person')}><option value="">{t('scheduleLog.anyone')}</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label={t('scheduleLog.what')}><select className="input sm" value={f.group} onChange={set('group')}><option value="">{t('scheduleLog.everything')}</option>{GROUPS.map((g) => <option key={g} value={g}>{t(`scheduleLog.g_${g}`)}</option>)}</select></Field>
        <Field label={t('scheduleLog.position')}><select className="input sm" value={f.jobCodeId} onChange={set('jobCodeId')}><option value="">{t('scheduleLog.any')}</option>{jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field>
        <Field label={t('scheduleLog.room')}><select className="input sm" value={f.room} onChange={set('room')}><option value="">{t('scheduleLog.any')}</option>{(layout?.rooms || []).map((r) => <option key={r.room} value={r.room}>{r.room}</option>)}</select></Field>
        <Field label={t('scheduleLog.via')}><select className="input sm" value={f.via} onChange={set('via')}><option value="">{t('scheduleLog.any')}</option>{VIAS.map((v) => <option key={v} value={v}>{t(`scheduleLog.via_${v}`)}</option>)}</select></Field>
        <div className="row" style={{ alignSelf: 'flex-end' }}><button className="btn sm" onClick={exportCsv}><Icon name="download" />{t('scheduleLog.csv')}</button></div>
      </div>
      <Rows rows={rows} people={people} jobs={jobs} />
    </div>
  );
}

/** My schedule changes: only what affected me, no one else's details. */
export function MyChanges() {
  const t = useT();
  const { call, people, jobs, today } = useApp();
  const [rows, setRows] = useState(null);
  useEffect(() => { call('scheduleLog.mine', { from: addDays(today, -60) }).then(setRows, () => setRows([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ maxWidth: 820 }} className="col">
      <div className="help">{t('scheduleLog.mineHelp')}</div>
      <Rows rows={rows} people={people} jobs={jobs} />
    </div>
  );
}
