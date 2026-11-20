// Venue & floor plans: locations → levels → rooms (dining / bar / event space), each with a floor plan.
// A one-room place can ignore locations and levels entirely; they only show up once there's more than one.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty } from '../ui.jsx';
import { FloorPlanEditor, FloorPlanView, planStats, statsText } from './FloorPlan.jsx';

const KIND_LABELS = { dining: 'Dining', bar: 'Bar', events: 'Event space', other: 'Other' };

export default function Venue() {
  const { call, toast, settings, isMgr, refresh } = useApp();
  const [v, setV] = useState(null);
  const [locId, setLocId] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [editRoom, setEditRoom] = useState(null);     // room form in a modal (new or existing)
  const [editLoc, setEditLoc] = useState(null);       // location form in a modal
  const [renameLevel, setRenameLevel] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => call('venue.get').then(setV).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => {
    setBusy(true);
    // refresh() reloads app settings too: room names feed event and import pickers.
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); await load(); refresh(); return r; }
    catch (e) { toast(e.message, 'bad'); return undefined; }
    finally { setBusy(false); }
  };

  const locations = v?.locations || [];
  const loc = locations.find((l) => l.id === locId) || locations[0] || null;
  const rooms = useMemo(() => (v?.rooms || []).filter((r) => !loc || r.locationId === loc.id), [v, loc]);
  const levels = useMemo(() => {
    const out = [];
    for (const r of rooms) {
      let g = out.find((x) => x.name === r.level);
      if (!g) out.push((g = { name: r.level, rooms: [] }));
      g.rooms.push(r);
    }
    return out;
  }, [rooms]);
  const room = rooms.find((r) => r.id === roomId) || rooms[0] || null;

  const pickRoom = (id) => {
    if (id === room?.id) return;
    if (planDirty && !window.confirm('Leave this floor plan without saving your changes?')) return;
    setPlanDirty(false);
    setRoomId(id);
  };
  const move = (r, dir) => {
    const ids = rooms.map((x) => x.id);
    const i = ids.indexOf(r.id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(() => call('venue.reorderRooms', { ids }));
  };

  if (!v) return <div className="empty">Loading…</div>;

  if (!locations.length && !v.rooms.length) {
    const starters = (settings.rooms || []).filter((r) => !/buyout/i.test(r));
    return (
      <div style={{ maxWidth: 760 }}>
        <div className="card card-pad col" style={{ gap: 12 }}>
          <div className="row"><Icon name="map" size={22} style={{ color: 'var(--brand)', flex: 'none' }} /><h2>Set up your venue</h2></div>
          <p className="muted" style={{ margin: 0 }}>Add the spaces you staff and book (dining rooms, bars, patios, event rooms), group them by level, and draw a floor plan with tables, bars and stages for each. Running one room? Just add that one room. Several locations? You can add more later.</p>
          {isMgr && <div className="row wrap">
            {starters.length > 0 && <button className="btn primary" disabled={busy} onClick={() => act(() => call('venue.setup'), 'Venue set up — now draw a floor plan')}><Icon name="sparkle" />Start from my rooms ({starters.join(', ')})</button>}
            <button className="btn" onClick={() => setEditRoom({ name: '', level: 'Main floor', kinds: ['dining'], capacity: '' })}><Icon name="plus" />Add a room</button>
          </div>}
        </div>
        {editRoom && <RoomDialog room={editRoom} levels={[]} locations={locations} onClose={() => setEditRoom(null)}
          onSave={(r) => act(() => call('venue.saveRoom', r), 'Room added').then((x) => { if (x) { setRoomId(x.id); setEditRoom(null); } })} />}
      </div>
    );
  }

  const stats = room ? planStats(room.plan) : null;

  return (
    <div className="col" style={{ gap: 14, maxWidth: 1400 }}>
      <div className="toolbar">
        <Icon name="pin" size={18} style={{ color: 'var(--text-3)', flex: 'none' }} />
        {locations.length > 1
          ? <select className="input sm" style={{ maxWidth: 260 }} value={loc?.id || ''} onChange={(e) => { if (planDirty && !window.confirm('Leave without saving the floor plan?')) return; setPlanDirty(false); setLocId(e.target.value); setRoomId(null); }}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          : <b>{loc?.name || 'Your venue'}</b>}
        {loc?.address && <span className="small muted">{loc.address}</span>}
        {isMgr && loc && <button className="btn sm ghost icon" title="Edit location" onClick={() => setEditLoc(loc)}><Icon name="edit" /></button>}
        <span className="spacer" />
        {isMgr && <button className="btn sm ghost" onClick={() => setEditLoc({ name: '', address: '' })}><Icon name="plus" />Add location</button>}
        {isMgr && <button className="btn sm primary" onClick={() => setEditRoom({ name: '', level: room?.level || levels[0]?.name || 'Main floor', kinds: ['dining'], capacity: '', locationId: loc?.id })}><Icon name="plus" />Add room</button>}
      </div>

      <div className="venue-grid">
        <div className="card venue-rooms" style={{ paddingBottom: 6 }}>
          {!rooms.length && <Empty icon="map" title="No rooms here yet">Add the first room for {loc?.name}.</Empty>}
          {levels.map((g) => (
            <div key={g.name}>
              <div className="level"><Icon name="layers" size={13} />{g.name}
                {isMgr && <button className="btn sm ghost icon" style={{ marginLeft: 'auto', height: 22, width: 22 }} title="Rename level" onClick={() => setRenameLevel({ from: g.name, to: g.name })}><Icon name="edit" size={12} /></button>}
              </div>
              {g.rooms.map((r) => {
                const s = planStats(r.plan);
                return (
                  <div key={r.id} className={`venue-room ${room?.id === r.id ? 'on' : ''}`} onClick={() => pickRoom(r.id)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="name">{r.name}</div>
                      <div className="tiny muted">{(r.kinds || []).map((k) => KIND_LABELS[k]).join(' · ') || '—'}{s.seats ? ` · ${s.seats} seats` : ''}{r.capacity ? ` · cap ${r.capacity}` : ''}</div>
                    </div>
                    {isMgr && <div className="moves">
                      <button className="btn sm ghost icon" style={{ height: 24, width: 24 }} title="Move up" onClick={(e) => { e.stopPropagation(); move(r, -1); }}><Icon name="up" size={14} /></button>
                      <button className="btn sm ghost icon" style={{ height: 24, width: 24 }} title="Move down" onClick={(e) => { e.stopPropagation(); move(r, 1); }}><Icon name="down" size={14} /></button>
                    </div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {room && (
          <div className="col" style={{ gap: 12, minWidth: 0 }}>
            <div className="card card-pad">
              <div className="row wrap">
                <div style={{ flex: 1, minWidth: 200 }}>
                  <h2 style={{ margin: 0 }}>{room.name}</h2>
                  <div className="small muted">{room.level}{locations.length > 1 ? ` · ${loc?.name}` : ''} · {statsText(stats)}{room.capacity ? ` · capacity ${room.capacity}` : ''}</div>
                </div>
                <div className="row wrap">{(room.kinds || []).map((k) => <span key={k} className="badge brand">{KIND_LABELS[k]}</span>)}</div>
                {isMgr && <button className="btn sm" onClick={() => setEditRoom(room)}><Icon name="edit" />Room details</button>}
              </div>
            </div>
            <div className="card card-pad">
              {isMgr
                ? <FloorPlanEditor key={room.id} room={room} onDirtyChange={setPlanDirty}
                    onSaved={(r) => setV((cur) => ({ ...cur, rooms: cur.rooms.map((x) => (x.id === r.id ? r : x)) }))} />
                : <FloorPlanView plan={room.plan} title={`${room.name} floor plan`} />}
            </div>
          </div>
        )}
      </div>

      {editRoom && <RoomDialog room={editRoom} levels={levels.map((g) => g.name)} locations={locations} busy={busy}
        onClose={() => setEditRoom(null)}
        onDelete={editRoom.id ? () => { if (window.confirm(`Delete ${editRoom.name} and its floor plan?`)) act(() => call('venue.deleteRoom', { id: editRoom.id }), 'Room deleted').then((x) => { if (x) { setEditRoom(null); setRoomId(null); setPlanDirty(false); } }); } : null}
        onSave={(r) => act(() => call('venue.saveRoom', r), editRoom.id ? 'Room saved' : 'Room added').then((x) => { if (x) { setEditRoom(null); setRoomId(x.id); setLocId(x.locationId); } })} />}
      {editLoc && <LocationDialog loc={editLoc} busy={busy} canDelete={editLoc.id && !(v.rooms || []).some((r) => r.locationId === editLoc.id)}
        onClose={() => setEditLoc(null)}
        onDelete={() => act(() => call('venue.deleteLocation', { id: editLoc.id }), 'Location removed').then((x) => { if (x) { setEditLoc(null); setLocId(null); } })}
        onSave={(l) => act(() => call('venue.saveLocation', l), editLoc.id ? 'Location saved' : 'Location added').then((x) => { if (x) { setEditLoc(null); setLocId(x.id); setRoomId(null); } })} />}
      {renameLevel && (
        <Modal title="Rename level" onClose={() => setRenameLevel(null)}
          footer={<><span className="spacer" /><button className="btn" onClick={() => setRenameLevel(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !renameLevel.to.trim()} onClick={() => act(() => call('venue.renameLevel', { locationId: loc.id, ...renameLevel }), 'Level renamed').then((x) => { if (x) setRenameLevel(null); })}>Save</button></>}>
          <Field label="Level name" help="e.g. Main floor, Lower level, Upstairs, Rooftop"><input className="input" autoFocus value={renameLevel.to} onChange={(e) => setRenameLevel({ ...renameLevel, to: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function RoomDialog({ room, levels, locations, busy, onClose, onSave, onDelete }) {
  const [f, setF] = useState({ ...room, kinds: room.kinds || [], capacity: room.capacity ?? '' });
  const toggle = (k) => setF({ ...f, kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
  return (
    <Modal title={room.id ? `Edit ${room.name}` : 'Add a room'} onClose={onClose}
      footer={<>{onDelete && <button className="btn danger" disabled={busy} onClick={onDelete}><Icon name="trash" />Delete</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.name?.trim()} onClick={() => onSave({ id: f.id, name: f.name, level: f.level, kinds: f.kinds, capacity: f.capacity, locationId: f.locationId })}>{room.id ? 'Save' : 'Add room'}</button></>}>
      <div className="grid2">
        <Field label="Room name"><input className="input" autoFocus value={f.name || ''} placeholder="Main dining room" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Level" help="Group rooms by floor">
          <input className="input" list="venue-levels" value={f.level || ''} placeholder="Main floor" onChange={(e) => setF({ ...f, level: e.target.value })} />
          <datalist id="venue-levels">{[...new Set([...levels, 'Main floor', 'Lower level', 'Upstairs', 'Rooftop'])].map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
      </div>
      <Field label="What happens here">
        <div className="row wrap">{Object.entries(KIND_LABELS).map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={f.kinds.includes(k)} onChange={() => toggle(k)} />{label}</label>
        ))}</div>
      </Field>
      <div className="grid2">
        <Field label="Capacity (guests)"><input className="input" type="number" min="0" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
        {locations.length > 1 && (
          <Field label="Location">
            <select className="input" value={f.locationId || ''} onChange={(e) => setF({ ...f, locationId: e.target.value })}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="help">Room names show up when you pick a room for an event and when importing the schedule.</div>
    </Modal>
  );
}

function LocationDialog({ loc, busy, canDelete, onClose, onSave, onDelete }) {
  const [f, setF] = useState({ ...loc });
  return (
    <Modal title={loc.id ? `Edit ${loc.name}` : 'Add a location'} onClose={onClose}
      footer={<>{loc.id && <button className="btn danger" disabled={busy || !canDelete} title={canDelete ? '' : 'Move or delete its rooms first'} onClick={onDelete}><Icon name="trash" />Delete</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.name?.trim()} onClick={() => onSave({ id: f.id, name: f.name, address: f.address, order: f.order })}>{loc.id ? 'Save' : 'Add location'}</button></>}>
      <Field label="Name"><input className="input" autoFocus value={f.name || ''} placeholder="Downtown" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Address (optional)"><input className="input" value={f.address || ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      {!loc.id && <div className="help">For a second venue or address. Each location has its own rooms and floor plans.</div>}
    </Modal>
  );
}
