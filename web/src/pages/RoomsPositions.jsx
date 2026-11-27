import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, useAction, JobDot } from '../ui.jsx';
import { sameArea, textOn } from '../../../core/areas.js';
import { plural } from './ScheduleSheet.jsx';
import { useT } from '../i18n/index.js';

// Settings → Rooms & positions: the schedule's rooms (its colored banners: Restaurant, Moon Rabbit,
// Rabbit Hole…) in order, each with the positions worked there, in order. Managers add, rename,
// reorder and remove rooms; add positions (or make a new one), reorder them, hide or show them, set
// their name on the sheet, and remove them (moving their people and shifts, or keeping them).
// The schedule's banner opens the same editor for one room (RoomDialog). Every change saves at once
// (core/layout.js: layout.*).

/** The layout as layout.save takes it. */
const payload = (lay) => lay.rooms.map((r) => ({ room: r.room, positions: r.positions.map(({ jobCodeId, label, hidden }) => ({ jobCodeId, label, hidden })) }));

function useLayout() {
  const { call, toast } = useApp();
  const [lay, setLay] = useState(null);
  const load = () => call('layout.get').then(setLay).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [lay, setLay, load];
}

/** The Settings card. `focus` (from #/settings/rooms[/<room>]): scroll here, and open that room. */
export default function RoomsPositions({ focus }) {
  const t = useT();
  const [lay, setLay, reload] = useLayout();
  const ref = useRef(null);
  useEffect(() => { if (focus !== undefined && lay) ref.current?.scrollIntoView({ block: 'start' }); }, [lay != null]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card card-pad col rooms-card" style={{ gap: 12 }} ref={ref} id="rooms">
      <h2>{t('rooms.title')}</h2>
      <div className="small muted" style={{ marginTop: -6 }}>{t('rooms.sub')}</div>
      <div><a className="btn sm" href="#/who-works-where"><Icon name="users" />{t('whoWorks.open')}</a></div>
      {!lay ? <div className="empty small">{t('common.loading')}</div> : <RoomsEditor lay={lay} onChange={setLay} reload={reload} focus={focus || ''} />}
    </div>
  );
}

/** The schedule's banner opens this: the same editor, for one room. */
export function RoomDialog({ room, onClose }) {
  const t = useT();
  const [lay, setLay, reload] = useLayout();
  const [changed, setChanged] = useState(false);
  const [name, setName] = useState(room);
  const done = () => onClose(changed);
  return (
    <Modal title={name} sub={t('rooms.dialogSub')} onClose={done}
      footer={<><a className="btn ghost sm" href={`#/settings/rooms/${encodeURIComponent(name)}`} onClick={() => onClose(changed)}><Icon name="settings" />{t('rooms.allRooms')}</a>
        <span className="spacer" /><button className="btn primary" onClick={done}>{t('common.done')}</button></>}>
      {!lay ? <div className="empty small">{t('common.loading')}</div>
        : <RoomsEditor lay={lay} reload={reload} only={name} onRenamed={setName} onChange={(next) => { setLay(next); setChanged(true); }} />}
    </Modal>
  );
}

function RoomsEditor({ lay, onChange, reload, only = null, focus = '', onRenamed }) {
  const t = useT();
  const { call, jobCodes } = useApp();
  const [run, busy] = useAction();
  const [open, setOpen] = useState(() => new Set(lay.rooms.filter((r) => focus && sameArea(r.room, focus)).map((r) => r.room)));
  const [newRoom, setNewRoom] = useState('');
  const jobs = useMemo(() => Object.fromEntries(jobCodes.map((j) => [j.id, j])), [jobCodes]);
  // Every change returns the fresh layout; a failed one (someone else changed it) reloads.
  const apply = async (fn, ok) => {
    const r = await run(fn, ok);
    if (r?.rooms) onChange(r); else if (!r) reload();
    return r;
  };
  const save = (rooms, ok, colors = {}) => apply(() => call('layout.save', { rev: lay.rev, rooms: rooms.map((r) => ({ ...r, ...(colors[r.room] ? { color: colors[r.room] } : {}) })) }), ok);
  const rooms = payload(lay);
  const moveRoom = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rooms.length) return;
    const next = [...rooms];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const addRoom = async () => {
    const name = newRoom.trim();
    if (!name) return;
    const r = await save([...rooms, { room: name, positions: [] }], t('rooms.roomAdded', { room: name }));
    if (r) { setNewRoom(''); setOpen(new Set([...open, r.rooms.at(-1).room])); }
  };
  const toggle = (room) => { const next = new Set(open); if (next.has(room)) next.delete(room); else next.add(room); setOpen(next); };
  const unplaced = jobCodes.filter((j) => !j.archived && !lay.rooms.some((r) => r.positions.some((p) => p.jobCodeId === j.id)));

  if (only) {
    const i = lay.rooms.findIndex((r) => sameArea(r.room, only));
    if (i < 0) return <div className="empty small">{t('rooms.roomGone')}</div>;
    return <RoomBody lay={lay} index={i} jobs={jobs} busy={busy} apply={apply} save={save} rooms={rooms} onRenamed={onRenamed} />;
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      {!lay.rooms.length && <div className="empty small">{t('rooms.empty')}</div>}
      {lay.rooms.map((r, i) => {
        const hidden = r.positions.filter((p) => p.hidden).length;
        const isOpen = open.has(r.room);
        return (
          <div key={r.room} className={`room-card ${isOpen ? 'open' : ''}`}>
            <div className="room-head">
              <button type="button" className="room-toggle" onClick={() => toggle(r.room)} aria-expanded={isOpen} aria-label={t('rooms.open', { room: r.room })}>
                <Icon name={isOpen ? 'down' : 'right'} size={16} />
                <span className="room-swatch" style={{ background: r.color, color: textOn(r.color) }}>{r.room}</span>
                <span className="small muted room-count">{t('rooms.positionsCount', { count: r.positions.length })}{hidden ? ` · ${t('rooms.hiddenCount', { count: hidden })}` : ''}</span>
              </button>
              <button type="button" className="btn ghost icon sm" disabled={busy || i === 0} onClick={() => moveRoom(i, -1)} aria-label={t('rooms.moveRoomUp', { room: r.room })}><Icon name="up" /></button>
              <button type="button" className="btn ghost icon sm" disabled={busy || i === lay.rooms.length - 1} onClick={() => moveRoom(i, 1)} aria-label={t('rooms.moveRoomDown', { room: r.room })}><Icon name="down" /></button>
            </div>
            {isOpen && <RoomBody lay={lay} index={i} jobs={jobs} busy={busy} apply={apply} save={save} rooms={rooms} canRemove onRenamed={(name) => setOpen(new Set([...open].map((x) => (x === r.room ? name : x))))} />}
          </div>
        );
      })}
      <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
        <input className="input" style={{ flex: '1 1 180px' }} value={newRoom} onChange={(e) => setNewRoom(e.target.value)} placeholder={t('rooms.addRoomPlaceholder')} aria-label={t('rooms.addRoom')}
          onKeyDown={(e) => { if (e.key === 'Enter') addRoom(); }} maxLength={60} />
        <button type="button" className="btn" disabled={busy || !newRoom.trim()} onClick={addRoom}><Icon name="plus" />{t('rooms.addRoom')}</button>
      </div>
      {unplaced.length > 0 && <div className="help">{t('rooms.notInAnyRoom', { positions: unplaced.map((j) => j.name).join(', ') })}</div>}
    </div>
  );
}

/** One room: its name and color, its positions (order, name on the sheet, hide, remove), adding a position, removing the room. */
function RoomBody({ lay, index, jobs, busy, apply, save, rooms, canRemove = false, onRenamed }) {
  const t = useT();
  const { call, jobCodes } = useApp();
  const r = lay.rooms[index];
  const [name, setName] = useState(r.room);
  const [color, setColor] = useState(r.color);
  const [adding, setAdding] = useState('');
  const [newName, setNewName] = useState('');
  const [removing, setRemoving] = useState(null); // jobCodeId being removed
  const [removeRoom, setRemoveRoom] = useState(false);
  const NEW = '__new__';
  useEffect(() => setName(r.room), [r.room]);
  useEffect(() => setColor(r.color), [r.color]);
  // A banner color saves a moment after the picker settles.
  useEffect(() => {
    if (color === r.color) return undefined;
    const id = setTimeout(() => save(rooms, null, { [r.room]: color }), 500);
    return () => clearTimeout(id);
  }, [color]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = async () => {
    const res = await apply(() => call('layout.renameRoom', { from: r.room, to: name }), t('rooms.renamed', { room: name.trim() }));
    if (res) onRenamed?.(res.rooms[index]?.room || name.trim());
  };
  const movePos = (pi, d) => {
    const j = pi + d;
    if (j < 0 || j >= r.positions.length) return;
    const next = rooms.map((x, k) => (k !== index ? x : { ...x, positions: (() => { const p = [...x.positions]; [p[pi], p[j]] = [p[j], p[pi]]; return p; })() }));
    save(next);
  };
  const setLabel = (pi, label) => {
    if ((label || '').trim() === (r.positions[pi].label || '')) return;
    save(rooms.map((x, k) => (k !== index ? x : { ...x, positions: x.positions.map((p, q) => (q === pi ? { ...p, label } : p)) })), t('rooms.sheetNameSaved'));
  };
  const toggleHidden = (p) => {
    const position = jobs[p.jobCodeId]?.name || '';
    apply(() => call(p.hidden ? 'layout.unhide' : 'layout.hide', { room: r.room, jobCodeId: p.jobCodeId }),
      t(p.hidden ? 'rooms.shownDone' : 'rooms.hiddenDone', { position, room: r.room }));
  };
  const add = async () => {
    const args = adding === NEW ? { room: r.room, newPosition: { name: newName.trim() } } : { room: r.room, jobCodeId: adding };
    const res = await apply(() => call('layout.addPosition', args), (x) => t('rooms.added', { position: jobs[x.jobCodeId]?.name || newName.trim(), room: r.room }));
    if (res) { setAdding(''); setNewName(''); }
  };
  const choices = jobCodes.filter((j) => !j.archived && !r.positions.some((p) => p.jobCodeId === j.id));

  return (
    <div className="room-body col" style={{ gap: 12 }}>
      <div className="room-fields">
        <label className="field" style={{ flex: '1 1 200px' }}><span>{t('rooms.name')}</span>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && name !== r.room) rename(); }} />
            {name.trim() && name !== r.room && <button type="button" className="btn primary sm" disabled={busy} onClick={rename}>{t('rooms.rename')}</button>}
          </div>
          {name !== r.room && <span className="help">{t('rooms.renameHelp')}</span>}
        </label>
        <label className="field"><span>{t('rooms.color')}</span>
          <input type="color" className="color-input" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t('rooms.color')} />
        </label>
      </div>

      <div className="col" style={{ gap: 0 }}>
        <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>{t('rooms.positions')}</div>
        {!r.positions.length && <div className="empty small" style={{ padding: 12 }}>{t('rooms.noPositions')}</div>}
        <div className="pos-list">
          {r.positions.map((p, pi) => {
            const job = jobs[p.jobCodeId];
            return (
              <div key={p.jobCodeId} className={`pos-row ${p.hidden ? 'is-hidden' : ''}`}>
                <div className="pos-top">
                  <div className="pos-name">
                    <div className="row wrap" style={{ gap: 6, minWidth: 0 }}>
                      <JobDot job={job} /><b className="pos-title">{job?.name || '?'}</b>
                      {p.hidden && <span className="badge">{t('rooms.hidden')}</span>}
                      {job?.archived && <span className="badge">{t('team.archived')}</span>}
                    </div>
                    <div className="tiny muted">{t('rooms.people', { count: p.people })} · {t('rooms.shifts', { count: p.shifts })}</div>
                  </div>
                  <div className="pos-actions">
                    <button type="button" className="btn ghost icon sm" disabled={busy || pi === 0} onClick={() => movePos(pi, -1)} aria-label={t('sectionPeople.moveUp')}><Icon name="up" /></button>
                    <button type="button" className="btn ghost icon sm" disabled={busy || pi === r.positions.length - 1} onClick={() => movePos(pi, 1)} aria-label={t('sectionPeople.moveDown')}><Icon name="down" /></button>
                    <button type="button" className="btn ghost icon sm" disabled={busy} onClick={() => toggleHidden(p)} aria-label={p.hidden ? t('rooms.show') : t('rooms.hide')} title={p.hidden ? t('rooms.show') : t('rooms.hide')}><Icon name={p.hidden ? 'eyeOff' : 'eye'} /></button>
                    <button type="button" className="btn ghost icon sm danger" disabled={busy} onClick={() => setRemoving(removing === p.jobCodeId ? null : p.jobCodeId)} aria-label={t('rooms.removePosition')} title={t('rooms.removePosition')}><Icon name="trash" /></button>
                  </div>
                </div>
                <label className="pos-label"><span className="tiny muted">{t('rooms.sheetName')}</span>
                  <SheetName value={p.label} placeholder={plural(job?.name || '')} onSave={(v) => setLabel(pi, v)} disabled={busy} />
                </label>
                {removing === p.jobCodeId && (
                  <RemovePosition lay={lay} room={r.room} pos={p} jobs={jobs} busy={busy} apply={apply} onCancel={() => setRemoving(null)} onDone={() => setRemoving(null)} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <select className="input" style={{ flex: '1 1 180px' }} value={adding} onChange={(e) => setAdding(e.target.value)} aria-label={t('rooms.addPosition')}>
          <option value="">{t('rooms.addPosition')}</option>
          {choices.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          <option value={NEW}>{t('rooms.newPosition')}</option>
        </select>
        {adding === NEW && <input className="input" style={{ flex: '1 1 160px' }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('rooms.newPositionPlaceholder')} aria-label={t('rooms.newPositionName')} maxLength={60} autoFocus />}
        <button type="button" className="btn" disabled={busy || !adding || (adding === NEW && !newName.trim())} onClick={add}><Icon name="plus" />{t('rooms.add')}</button>
      </div>

      {canRemove && (removeRoom ? (
        <div className="alert warn col" style={{ alignItems: 'stretch' }}>
          <span>{t('rooms.removeRoomSure', { room: r.room })}</span>
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn danger solid sm" disabled={busy} onClick={() => save(rooms.filter((_, k) => k !== index), t('rooms.roomRemoved', { room: r.room }))}>{t('rooms.removeRoom')}</button>
            <button type="button" className="btn sm" onClick={() => setRemoveRoom(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <div><button type="button" className="btn ghost sm danger" onClick={() => setRemoveRoom(true)}><Icon name="trash" />{t('rooms.removeRoom')}</button></div>
      ))}
    </div>
  );
}

/** A section's name on the sheet: saves when you leave the field (or press Enter). */
function SheetName({ value = '', placeholder, onSave, disabled }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="input sm" value={v} placeholder={placeholder} disabled={disabled} maxLength={60} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

/** Take a position off a room: move its people and shifts to another position, or keep them (off the schedule). */
function RemovePosition({ lay, room, pos, jobs, busy, apply, onCancel, onDone }) {
  const t = useT();
  const { call } = useApp();
  const NEW = '__new__';
  const position = jobs[pos.jobCodeId]?.name || '';
  const anyone = pos.people > 0 || pos.shifts > 0;
  const [mode, setMode] = useState(anyone ? 'move' : 'keep');
  const [toRoom, setToRoom] = useState(room);
  const targets = (name) => (lay.rooms.find((x) => sameArea(x.room, name))?.positions || [])
    .filter((p) => !p.hidden && jobs[p.jobCodeId] && !jobs[p.jobCodeId].archived && !(sameArea(name, room) && p.jobCodeId === pos.jobCodeId));
  const [toJob, setToJob] = useState(() => targets(room)[0]?.jobCodeId || NEW);
  const [newName, setNewName] = useState('');
  const pickRoom = (name) => { setToRoom(name); setToJob(targets(name)[0]?.jobCodeId || NEW); };
  const ready = mode === 'keep' || (toJob === NEW ? !!newName.trim() : !!toJob);
  const remove = async () => {
    const to = toJob === NEW ? { room: toRoom, newPosition: { name: newName.trim() } } : { room: toRoom, jobCodeId: toJob };
    const res = await apply(() => call('layout.removePosition', { room, jobCodeId: pos.jobCodeId, mode, ...(mode === 'move' ? { to } : {}) }),
      (x) => (mode === 'move' ? t('rooms.movedCounts', { people: x.moved.people, shifts: x.moved.shifts }) : t('rooms.removed', { position, room })));
    if (res) onDone();
  };
  return (
    <div className="remove-panel col" style={{ gap: 8 }}>
      <b>{t('rooms.removeTitle', { position, room })}</b>
      {anyone && <div className="small">{t('rooms.removeCounts', { people: t('rooms.people', { count: pos.people }), shifts: t('rooms.shifts', { count: pos.shifts }) })}</div>}
      {anyone ? (
        <>
          <label className="check"><input type="radio" checked={mode === 'move'} onChange={() => setMode('move')} />{t('rooms.moveThem')}</label>
          {mode === 'move' && (
            <div className="col" style={{ gap: 6, paddingLeft: 24 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <select className="input" style={{ flex: '1 1 130px' }} value={toRoom} onChange={(e) => pickRoom(e.target.value)} aria-label={t('rooms.moveRoom')}>
                  {lay.rooms.map((x) => <option key={x.room} value={x.room}>{x.room}</option>)}
                </select>
                <select className="input" style={{ flex: '1 1 150px' }} value={toJob} onChange={(e) => setToJob(e.target.value)} aria-label={t('rooms.movePosition')}>
                  {targets(toRoom).map((p) => <option key={p.jobCodeId} value={p.jobCodeId}>{jobs[p.jobCodeId]?.name}</option>)}
                  <option value={NEW}>{t('rooms.newPosition')}</option>
                </select>
              </div>
              {toJob === NEW && <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('rooms.newPositionPlaceholder')} aria-label={t('rooms.newPositionName')} maxLength={60} />}
              <span className="help">{t('rooms.moveHelp')}</span>
            </div>
          )}
          <label className="check"><input type="radio" checked={mode === 'keep'} onChange={() => setMode('keep')} />{t('rooms.keepThem')}</label>
          {mode === 'keep' && <span className="help" style={{ paddingLeft: 24 }}>{t('rooms.keepHelp')}</span>}
        </>
      ) : <div className="small muted">{t('rooms.removeEmpty')}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn danger solid sm" disabled={busy || !ready} onClick={remove}>{t('common.remove')}</button>
        <button type="button" className="btn sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
