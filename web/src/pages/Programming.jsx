import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Field, useAction, Empty } from '../ui.jsx';
import { useT, fmtTime, dowShort, dowLong, prettyDate, stamp } from '../i18n/index.js';
import { addDays } from '../../../core/time.js';
import '../programming.css';
import { CalendarImportDialog } from './CalendarImport.jsx'; // Import from a calendar page
import { IS_DEMO } from '../api.js';

// Settings → Programming (#/settings/programming): what normally runs each weekday in each room, with staffing pars,
// one-off changes for a date, overlap warnings and recent changes (core/programming.js). Managers and up edit it
// (the programmingEdit role feature); pars show for whoever has staffingPars. Names stay as typed.

/** A labeled group of buttons (a <label> would name only its first button). */
function Group({ label, help, children }) {
  return <div className="field" role="group" aria-label={label}><span>{label}</span>{children}{help && <div className="help">{help}</div>}</div>;
}

const EMPTY = { name: '', rooms: [], days: [], start: '18:00', end: '', season: '', from: '', to: '', repeat: 'weekly', nth: 1, anchor: '', color: '', notes: '', dayNote: '', pars: [] };

/** The card in Settings that links here. */
export function ProgrammingCard() {
  const t = useT();
  return (
    <div className="card card-pad col" style={{ gap: 8 }}>
      <h2>{t('programming.title')}</h2>
      <div className="help" style={{ margin: 0 }}>{t('programming.cardHelp')}</div>
      <div><a className="btn sm" href="#/settings/programming"><Icon name="calendar" />{t('programming.open')}</a></div>
    </div>
  );
}

export default function Programming() {
  const t = useT();
  const { call, version, settings, today } = useApp();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [override, setOverride] = useState(null);
  const [calendar, setCalendar] = useState(false);
  const load = () => call('programming.list').then(setData);
  useEffect(() => { load(); }, [version]);
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + Number(settings.weekStartDow)) % 7);
  const rows = [...data.rooms.map((r) => ({ key: r, label: r, match: (x) => x.rooms.includes(r) })), { key: '*', label: t('programming.wholeVenue'), match: (x) => !x.rooms.length }]
    .filter((r) => r.key !== '*' || data.items.some(r.match));
  const usedRooms = rows.filter((r) => data.items.some(r.match));
  const byId = Object.fromEntries(data.items.map((x) => [x.id, x]));
  const upcoming = data.items.flatMap((x) => Object.entries(x.exceptions || {}).filter(([d]) => d >= today).map(([date, ex]) => ({ date, ex, item: x }))).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="col prog-page" style={{ maxWidth: 1100 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <a className="btn sm ghost" href="#/settings"><Icon name="left" />{t('main.settings')}</a>
        <span className="spacer" />
        {data.canEdit && !IS_DEMO && <button className="btn sm" onClick={() => setCalendar(true)}><Icon name="download" />{t('calImport.button')}</button>}
        {data.canEdit && <button className="btn sm" onClick={() => setOverride({ date: addDays(today, 1), id: data.items[0]?.id || 'all', action: 'cancel', reason: '', start: '', end: '', pars: [] })}><Icon name="edit" />{t('programming.oneOff')}</button>}
        {data.canEdit && <button className="btn sm primary" onClick={() => setEdit({ ...EMPTY, color: data.colors[data.items.length % data.colors.length] })}><Icon name="plus" />{t('programming.add')}</button>}
      </div>
      <div className="card card-pad col" style={{ gap: 6 }}>
        <h2>{t('programming.title')}</h2>
        <div className="help" style={{ margin: 0 }}>{t('programming.help')}</div>
      </div>

      {data.warnings.length > 0 && (
        <div className="alert warn"><Icon name="alert" size={16} />
          <ul>{data.warnings.map((w, i) => <li key={i}>{t('programming.overlap', { a: w.aName, b: w.bName, room: w.room || t('programming.wholeVenue'), days: w.days.map((d) => dowShort(d)).join(', ') })}</li>)}</ul>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.weekByRoom')}</h2></div>
        {!data.items.length ? <Empty icon="calendar" title={t('programming.none')}>{data.canEdit ? t('programming.noneHelp') : null}</Empty> : (
          <div className="prog-grid-wrap">
            <table className="prog-grid">
              <thead><tr><th>{t('programming.room')}</th>{order.map((d) => <th key={d} className={data.closedDays.includes(d) ? 'closed' : ''}>{dowShort(d)}{data.closedDays.includes(d) && <div className="tiny">{t('common.closed')}</div>}</th>)}</tr></thead>
              <tbody>
                {(usedRooms.length ? usedRooms : rows).map((r) => (
                  <tr key={r.key}>
                    <th>{r.label}</th>
                    {order.map((d) => (
                      <td key={d} className={data.closedDays.includes(d) ? 'closed' : ''}>
                        {data.items.filter((x) => r.match(x) && x.days.includes(d)).map((x) => (
                          <button key={x.id} className={`prog-cell ${x.active === false ? 'inactive' : ''}`} style={{ '--pc': x.color }} onClick={() => data.canEdit && setEdit({ ...EMPTY, ...x })} disabled={!data.canEdit}
                            title={[x.name, x.notes].filter(Boolean).join('\n')}>
                            <b>{x.name}</b><span>{fmtTime(x.start)}{x.end ? `–${fmtTime(x.end)}` : ''}</span>
                            {x.pars?.length > 0 && <span className="tiny">{x.pars.map((p) => `${p.count}`).reduce((a, b) => a + Number(b), 0)} {t('programming.staff')}</span>}
                            {(x.season || x.from || x.to || x.repeat !== 'weekly') && <span className="tiny">{whenText(x, t, data)}</span>}
                          </button>
                        ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.items.length > 0 && data.canPars && (
        <div className="card">
          <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.pars')}</h2></div>
          <div className="list">
            {data.items.map((x) => <ParsSummary key={x.id} item={x} onEdit={data.canEdit ? () => setEdit({ ...EMPTY, ...x }) : null} />)}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.oneOffTitle')}</h2></div>
        {!upcoming.length ? <div className="card-pad small muted">{t('programming.noOneOff')}</div> : (
          <div className="list">{upcoming.map(({ date, ex, item }) => <ExceptionRow key={`${item.id}${date}`} date={date} ex={ex} item={item} canEdit={data.canEdit} onDone={load} />)}</div>
        )}
      </div>

      {data.log?.length > 0 && (
        <div className="card">
          <div className="card-head"><h2 style={{ flex: 1 }}>{t('programming.recent')}</h2></div>
          <div className="list">
            {data.log.slice(0, 12).map((l, i) => (
              <div key={i} className="list-item small"><span className="muted" style={{ whiteSpace: 'nowrap' }}>{stamp(l.at)}</span>
                <span style={{ flex: 1 }}>{t(`programming.log_${l.action.split('.')[1]}`, { by: l.by, name: l.details.name || byId[l.targetId]?.name || '', date: l.details.date ? prettyDate(l.details.date) : '', count: l.details.created || 0 })}{l.details.reason ? ` · ${l.details.reason}` : ''}</span></div>
            ))}
          </div>
        </div>
      )}

      {edit && <ItemDialog item={edit} data={data} onClose={(c) => { setEdit(null); if (c) load(); }} />}
      {calendar && <CalendarImportDialog onClose={(c) => { setCalendar(false); if (c) load(); }} />}
      {override && <OverrideDialog init={override} data={data} onClose={(c) => { setOverride(null); if (c) load(); }} />}
    </div>
  );
}

function whenText(x, t, data) {
  const parts = [];
  if (x.season) parts.push(data.seasons.find((s) => s.key === x.season)?.label || t(`programming.season_${x.season}`, {}) || x.season);
  if (x.from || x.to) parts.push(`${x.from ? prettyDate(x.from) : '…'} – ${x.to ? prettyDate(x.to) : '…'}`);
  if (x.repeat === 'biweekly') parts.push(t('programming.everyOther'));
  if (x.repeat === 'monthly') parts.push(t(`programming.nth_${x.nth === -1 ? 'last' : x.nth}`));
  return parts.join(' · ');
}

function ParsSummary({ item, onEdit }) {
  const t = useT();
  const { jobs } = useApp();
  return (
    <div className={`list-item ${onEdit ? 'click' : ''} prog-item`} style={{ '--pc': item.color }} onClick={onEdit || undefined}>
      <span className="prog-bar" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{item.name}</b> <span className="small muted">· {item.rooms.length ? item.rooms.join(' · ') : t('programming.wholeVenue')} · {item.days.map((d) => dowShort(d)).join(' ')}</span>
        <div className="small">{item.pars.length ? item.pars.map((p) => `${jobs[p.jobCodeId]?.name || '—'} ${p.count}${p.start ? ` (${t('programming.inAt', { time: fmtTime(p.start) })})` : ''}${p.room ? ` · ${p.room}` : ''}`).join(' · ') : <span className="muted">{t('programming.noPars')}</span>}</div>
      </div>
    </div>
  );
}

function ExceptionRow({ date, ex, item, canEdit, onDone }) {
  const t = useT();
  const { call, jobs } = useApp();
  const [run, busy] = useAction();
  const what = ex.cancel ? t('programming.cancelledDay') : ex.start ? `${t('programming.newTimes')}: ${fmtTime(ex.start)}–${ex.end ? fmtTime(ex.end) : t('programming.close')}`
    : ex.pars ? `${t('programming.newPars')}: ${ex.pars.map((p) => `${jobs[p.jobCodeId]?.name} ${p.count}`).join(', ')}` : '';
  return (
    <div className="list-item prog-item" style={{ '--pc': item.color }}>
      <span className="prog-bar" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{prettyDate(date)}</b> · {item.name}
        <div className="small muted">{what}{ex.reason ? ` · ${ex.reason}` : ''}</div>
      </div>
      {canEdit && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('programming.override', { id: item.id, date, action: 'clear' }), t('programming.backToNormal')).then(onDone)}><Icon name="x" />{t('programming.undoChange')}</button>}
    </div>
  );
}

/** Pars editor rows: position, how many, in at, counted in another room. */
function ParsEditor({ pars, setPars, rooms }) {
  const t = useT();
  const { jobCodes } = useApp();
  const active = jobCodes.filter((j) => !j.archived);
  const set = (i, k, v) => setPars(pars.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <div className="col" style={{ gap: 6 }}>
      {pars.map((p, i) => (
        <div key={i} className="prog-par-row">
          <select className="input sm" value={p.jobCodeId} onChange={(e) => set(i, 'jobCodeId', e.target.value)} aria-label={t('common.position')}>
            {active.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <input className="input sm num" type="number" min="0" max="99" value={p.count} onChange={(e) => set(i, 'count', e.target.value)} aria-label={t('programming.howMany')} />
          <input className="input sm" type="time" value={p.start || ''} onChange={(e) => set(i, 'start', e.target.value)} aria-label={t('programming.inAtLabel')} title={t('programming.inAtLabel')} />
          <select className="input sm" value={p.room || ''} onChange={(e) => set(i, 'room', e.target.value)} aria-label={t('programming.countedIn')} title={t('programming.countedIn')}>
            <option value="">{t('programming.itsRoom')}</option>
            {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn ghost icon sm" onClick={() => setPars(pars.filter((_, j) => j !== i))} aria-label={t('common.remove')}><Icon name="x" /></button>
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setPars([...pars, { jobCodeId: active[0]?.id, count: 1, start: '', room: '' }])}><Icon name="plus" />{t('programming.addPosition')}</button></div>
      <div className="help" style={{ margin: 0 }}>{t('programming.parsHelp')}</div>
    </div>
  );
}

const cleanPars = (pars) => pars.filter((p) => p.jobCodeId).map((p) => ({ jobCodeId: p.jobCodeId, count: Number(p.count) || 0, ...(p.start ? { start: p.start } : {}), ...(p.room ? { room: p.room } : {}) }));

function ItemDialog({ item, data, onClose }) {
  const t = useT();
  const { call, toast } = useApp();
  const [x, setX] = useState(() => ({ ...item, when: item.season ? 'season' : 'always' })); // start and end dates are always shown; a season narrows it further
  const [run, busy] = useAction();
  const set = (k) => (e) => setX({ ...x, [k]: e.target.value });
  const toggle = (k, v) => setX({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] });
  const save = async () => {
    const body = { ...(x.id ? { id: x.id } : {}), name: x.name, rooms: x.rooms, days: x.days, start: x.start, end: x.end, color: x.color, notes: x.notes, dayNote: x.dayNote,
      season: x.when === 'season' ? x.season : '', from: x.from || '', to: x.to || '',
      repeat: x.repeat, nth: Number(x.nth), anchor: x.repeat === 'biweekly' ? x.anchor || x.from : '', active: x.active !== false,
      ...(data.canPars ? { pars: cleanPars(x.pars) } : {}) };
    const r = await run(() => call('programming.save', body), t('programming.saved'));
    if (r) {
      for (const w of r.warnings) toast(t('programming.overlap', { a: w.aName, b: w.bName, room: w.room || t('programming.wholeVenue'), days: w.days.map((d) => dowShort(d)).join(', ') }), 'bad');
      onClose(true);
    }
  };
  const remove = async () => { if (await run(() => call('programming.delete', { id: x.id }), t('programming.deleted'))) onClose(true); };
  return (
    <Modal wide title={x.id ? t('programming.editTitle', { name: item.name }) : t('programming.add')} onClose={() => onClose(false)}
      footer={<>{x.id && <button className="btn danger" disabled={busy} onClick={remove}><Icon name="trash" />{t('common.delete')}</button>}<span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !x.name.trim() || !x.days.length || !x.start} onClick={save}>{t('common.save')}</button></>}>
      <div className="col" style={{ gap: 14 }}>
        <div className="grid2">
          <Field label={t('common.name')}><input className="input" value={x.name} onChange={set('name')} placeholder={t('programming.namePlaceholder')} maxLength={60} /></Field>
          <Group label={t('programming.color')}>
            <div className="row wrap" style={{ gap: 6 }}>{data.colors.map((c) => <button key={c} type="button" className={`prog-swatch ${x.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setX({ ...x, color: c })} aria-label={c} aria-pressed={x.color === c} />)}</div>
          </Group>
        </div>
        <Group label={t('programming.rooms')} help={t('programming.roomsHelp')}>
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className={`chip ${!x.rooms.length ? 'on' : ''}`} onClick={() => setX({ ...x, rooms: [] })}>{t('programming.wholeVenue')}</button>
            {data.rooms.map((r) => <button key={r} type="button" className={`chip ${x.rooms.includes(r) ? 'on' : ''}`} aria-pressed={x.rooms.includes(r)} onClick={() => toggle('rooms', r)}>{r}</button>)}
          </div>
        </Group>
        <Group label={t('programming.days')}>
          <div className="row wrap" style={{ gap: 6 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => <button key={d} type="button" className={`chip ${x.days.includes(d) ? 'on' : ''}`} aria-pressed={x.days.includes(d)} onClick={() => toggle('days', d)} title={dowLong(d)}>
              {dowShort(d)}{data.closedDays.includes(d) ? ` (${t('common.closed')})` : ''}</button>)}
          </div>
        </Group>
        <div className="grid2">
          <Field label={t('programming.starts')}><input className="input" type="time" value={x.start} onChange={set('start')} /></Field>
          <Field label={t('programming.ends')} help={t('programming.endsHelp')}><input className="input" type="time" value={x.end} onChange={set('end')} /></Field>
        </div>
        <div className="grid2">
          <Field label={t('programming.when')}>
            <select className="input" value={x.when} onChange={set('when')}>
              <option value="always">{t('programming.allYear')}</option>
              <option value="season">{t('programming.aSeason')}</option>
            </select>
          </Field>
          {x.when === 'season' && <Field label={t('programming.season')}>
            <select className="input" value={x.season} onChange={set('season')}><option value="">—</option>{data.seasons.map((s) => <option key={s.key} value={s.key}>{s.label || t(`programming.season_${s.key}`)}</option>)}</select>
          </Field>}
        </div>
        <div className="grid2">
          <Field label={t('programming.startDate')}><input className="input" type="date" value={x.from || ''} onChange={set('from')} /></Field>
          <Field label={t('programming.endDate')} help={t('programming.endDateHelp')}><input className="input" type="date" value={x.to || ''} min={x.from || undefined} onChange={set('to')} /></Field>
        </div>
        <div className="grid2">
          <Field label={t('programming.repeat')}>
            <select className="input" value={x.repeat} onChange={set('repeat')}>
              <option value="weekly">{t('programming.everyWeek')}</option>
              <option value="biweekly">{t('programming.everyOther')}</option>
              <option value="monthly">{t('programming.monthly')}</option>
            </select>
          </Field>
          {x.repeat === 'biweekly' && <Field label={t('programming.anchor')} help={t('programming.anchorHelp')}><input className="input" type="date" value={x.anchor || ''} onChange={set('anchor')} /></Field>}
          {x.repeat === 'monthly' && <Field label={t('programming.whichWeek')}>
            <select className="input" value={x.nth} onChange={set('nth')}>{[1, 2, 3, 4, -1].map((n) => <option key={n} value={n}>{t(`programming.nth_${n === -1 ? 'last' : n}`)}</option>)}</select>
          </Field>}
        </div>
        <Field label={t('programming.notesForStaff')}><textarea className="input" rows={2} value={x.notes} onChange={set('notes')} maxLength={500} /></Field>
        <Field label={t('programming.dayNoteLabel')} help={t('programming.dayNoteHelp')}><input className="input" value={x.dayNote} onChange={set('dayNote')} maxLength={80} placeholder={`${x.name || t('programming.namePlaceholder')} ${x.start ? fmtTime(x.start) : ''}`.toUpperCase()} /></Field>
        {data.canPars && <Group label={t('programming.pars')}><ParsEditor pars={x.pars} setPars={(pars) => setX({ ...x, pars })} rooms={data.rooms} /></Group>}
        {x.id && <label className="check"><input type="checkbox" checked={x.active !== false} onChange={(e) => setX({ ...x, active: e.target.checked })} />{t('programming.active')}</label>}
      </div>
    </Modal>
  );
}

function OverrideDialog({ init, data, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [o, setO] = useState(init);
  const [run, busy] = useAction();
  const set = (k) => (e) => setO({ ...o, [k]: e.target.value });
  const item = data.items.find((x) => x.id === o.id);
  const apply = async () => {
    const r = await run(() => call('programming.override', { id: o.id, date: o.date, action: o.action, reason: o.reason,
      ...(o.action === 'retime' ? { start: o.start, end: o.end } : {}), ...(o.action === 'repar' ? { pars: cleanPars(o.pars) } : {}) }), t('programming.changeSaved'));
    if (r) onClose(true);
  };
  return (
    <Modal title={t('programming.oneOff')} sub={t('programming.oneOffSub')} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !o.date || (o.action === 'retime' && !o.start)} onClick={apply}>{t('common.save')}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="grid2">
          <Field label={t('common.date')}><input className="input" type="date" value={o.date} onChange={set('date')} /></Field>
          <Field label={t('programming.which')}>
            <select className="input" value={o.id} onChange={(e) => { const it = data.items.find((x) => x.id === e.target.value); setO({ ...o, id: e.target.value, pars: it?.pars ? it.pars.map((p) => ({ ...p })) : [] }); }}>
              <option value="all">{t('programming.everything')}</option>
              {data.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
        </div>
        <Group label={t('programming.change')}>
          <div className="row wrap" style={{ gap: 6 }}>
            {['cancel', 'retime', ...(data.canPars && o.id !== 'all' ? ['repar'] : [])].map((a) => <button key={a} type="button" className={`chip ${o.action === a ? 'on' : ''}`}
              onClick={() => setO({ ...o, action: a, pars: a === 'repar' && !o.pars.length ? (item?.pars || []).map((p) => ({ ...p })) : o.pars, start: o.start || item?.start || '', end: o.end || item?.end || '' })}>{t(`programming.action_${a}`)}</button>)}
          </div>
        </Group>
        {o.action === 'retime' && <div className="grid2">
          <Field label={t('programming.starts')}><input className="input" type="time" value={o.start} onChange={set('start')} /></Field>
          <Field label={t('programming.ends')} help={t('programming.endsHelp')}><input className="input" type="time" value={o.end} onChange={set('end')} /></Field>
        </div>}
        {o.action === 'repar' && <ParsEditor pars={o.pars} setPars={(pars) => setO({ ...o, pars })} rooms={data.rooms} />}
        <Field label={t('programming.reason')} help={t('programming.reasonHelp')}><input className="input" value={o.reason} onChange={set('reason')} maxLength={120} placeholder={t('programming.reasonPlaceholder')} /></Field>
      </div>
    </Modal>
  );
}
