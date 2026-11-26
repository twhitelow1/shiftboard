// Venue & floor plans: locations → levels → rooms (dining / bar / event space), each with a floor plan.
// A one-room place can ignore locations and levels entirely; they only show up once there's more than one.
// Each room has two views: Sections (who works which tables on a day) and, for managers, Edit layout.
// Route: #/venue/<roomId>/<date> opens a room's sections for that day (BEOs link here).
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty } from '../ui.jsx';
import { FloorPlanEditor, planStats, statsText, SEATED } from './FloorPlan.jsx';
import { SectionsBoard } from './Sections.jsx';
import FloorImport from './FloorImport.jsx';
import FloorExport from './FloorExport.jsx';
import { useT } from '../i18n/index.js';

// Catalog keys (web/src/i18n).
const KIND_LABELS = { dining: 'venue.kindDining', bar: 'venue.kindBar', events: 'venue.kindEvents', other: 'venue.kindOther' };

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

export default function Venue({ parts = [] }) {
  const t = useT();
  const { call, toast, settings, isMgr, refresh, today } = useApp();
  const [v, setV] = useState(null);
  const [locId, setLocId] = useState(null);
  const [roomId, setRoomId] = useState(parts[1] || null);
  const [date, setDate] = useState(isDate(parts[2]) ? parts[2] : today);
  const [tab, setTab] = useState('sections'); // 'sections' | 'layout' (managers)
  const [planDirty, setPlanDirty] = useState(false);
  const [editRoom, setEditRoom] = useState(null);     // room form in a modal (new or existing)
  const [editLoc, setEditLoc] = useState(null);       // location form in a modal
  const [renameLevel, setRenameLevel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false); // the Import dialog (Toast, a picture, a CSV)
  const [exporting, setExporting] = useState(null);  // the Export dialog: the room with the editor's current plan
  const [stamp, setStamp] = useState(0);             // bumped after an import, so the editor starts from the new plan

  const load = () => call('venue.get').then(setV).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []);
  useEffect(() => { // opened from a link: #/venue/<room>/<date>
    if (parts[1]) { setRoomId(parts[1]); setLocId(null); }
    if (isDate(parts[2])) { setDate(parts[2]); setTab('sections'); }
  }, [parts[1], parts[2]]);

  const act = async (fn, ok) => {
    setBusy(true);
    // refresh() reloads app settings too: room names feed event and import pickers.
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); await load(); refresh(); return r; }
    catch (e) { toast(e.message, 'bad'); return undefined; }
    finally { setBusy(false); }
  };

  const locations = v?.locations || [];
  const linked = v?.rooms.find((r) => r.id === roomId);
  const loc = locations.find((l) => l.id === (locId || linked?.locationId)) || locations[0] || null;
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
  // A room with no tables yet opens on its layout for managers: there's nothing to assign.
  useEffect(() => {
    if (isMgr && room && !(room.plan?.items || []).some((i) => SEATED.has(i.type))) setTab('layout');
  }, [room?.id]);

  const leavePlan = () => {
    if (planDirty && !window.confirm(t('venue.leaveThisFloorPlanWithout'))) return false;
    setPlanDirty(false);
    return true;
  };
  const pickRoom = (id) => {
    if (id === room?.id || !leavePlan()) return;
    setRoomId(id);
  };
  const pickTab = (t) => { if (t !== tab && (t === 'layout' || leavePlan())) setTab(t); };
  const view = isMgr && tab === 'layout' ? 'layout' : 'sections';
  const move = (r, dir) => {
    const ids = rooms.map((x) => x.id);
    const i = ids.indexOf(r.id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act(() => call('venue.reorderRooms', { ids }));
  };

  if (!v) return <div className="empty">{t('common.loading')}</div>;

  if (!locations.length && !v.rooms.length) {
    const starters = (settings.rooms || []).filter((r) => !/buyout/i.test(r));
    return (
      <div style={{ maxWidth: 760 }}>
        <div className="card card-pad col" style={{ gap: 12 }}>
          <div className="row"><Icon name="map" size={22} style={{ color: 'var(--brand)', flex: 'none' }} /><h2>{t('venue.setUpYourVenue')}</h2></div>
          <p className="muted" style={{ margin: 0 }}>{t('venue.addTheSpacesYouStaff')}</p>
          {isMgr && <div className="row wrap">
            {starters.length > 0 && <button className="btn primary" disabled={busy} onClick={() => act(() => call('venue.setup'), t('venue.venueSetUpNowDraw'))}><Icon name="sparkle" />{t('venue.startFromMyRooms')}{starters.join(', ')})</button>}
            <button className="btn" onClick={() => setEditRoom({ name: '', level: t('venue.levelMainFloor'), kinds: ['dining'], capacity: '' })}><Icon name="plus" />{t('venue.addARoom')}</button>
            <button className="btn" onClick={() => setImporting(true)}><Icon name="upload" />{t('floor.import.startFromImport')}</button>
          </div>}
          {isMgr && <div className="help">{t('floor.import.startHelp')}</div>}
        </div>
        {importing && <FloorImport room={null} rooms={[]} onClose={() => setImporting(false)}
          onDone={(r) => { setImporting(false); setV(r); refresh(); if (r.roomIds?.[0]) setRoomId(r.roomIds[0]); }} />}
        {editRoom && <RoomDialog room={editRoom} levels={[]} locations={locations} onClose={() => setEditRoom(null)}
          onSave={(r) => act(() => call('venue.saveRoom', r), t('venue.roomAdded')).then((x) => { if (x) { setRoomId(x.id); setEditRoom(null); } })} />}
      </div>
    );
  }

  const stats = room ? planStats(room.plan) : null;

  return (
    <div className="col" style={{ gap: 14, maxWidth: 1400 }}>
      <div className="toolbar">
        <Icon name="pin" size={18} style={{ color: 'var(--text-3)', flex: 'none' }} />
        {locations.length > 1
          ? <select className="input sm" style={{ maxWidth: 260 }} value={loc?.id || ''} onChange={(e) => { if (planDirty && !window.confirm(t('venue.leaveWithoutSavingTheFloor'))) return; setPlanDirty(false); setLocId(e.target.value); setRoomId(null); }}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          : <b>{loc?.name || t('venue.yourVenue')}</b>}
        {loc?.address && <span className="small muted">{loc.address}</span>}
        {isMgr && loc && <button className="btn sm ghost icon" title={t('venue.editLocation')} onClick={() => setEditLoc(loc)}><Icon name="edit" /></button>}
        <span className="spacer" />
        {isMgr && <button className="btn sm ghost" onClick={() => setEditLoc({ name: '', address: '' })}><Icon name="plus" />{t('venue.addLocation')}</button>}
        {isMgr && <button className="btn sm primary" onClick={() => setEditRoom({ name: '', level: room?.level || levels[0]?.name || t('venue.levelMainFloor'), kinds: ['dining'], capacity: '', locationId: loc?.id })}><Icon name="plus" />{t('venue.addRoom')}</button>}
      </div>

      <div className={`venue-grid ${view === 'layout' ? 'editing' : ''}`}>
        <div className="card venue-rooms" style={{ paddingBottom: 6 }}>
          {!rooms.length && <Empty icon="map" title={t('venue.noRoomsHereYet')}>{t('venue.addTheFirstRoomFor', { name: loc?.name })}</Empty>}
          {levels.map((g) => (
            <div key={g.name}>
              <div className="level"><Icon name="layers" size={13} />{g.name}
                {isMgr && <button className="btn sm ghost icon" style={{ marginLeft: 'auto', height: 22, width: 22 }} title={t('venue.renameLevel')} onClick={() => setRenameLevel({ from: g.name, to: g.name })}><Icon name="edit" size={12} /></button>}
              </div>
              {g.rooms.map((r) => {
                const s = planStats(r.plan);
                return (
                  <div key={r.id} className={`venue-room ${room?.id === r.id ? 'on' : ''}`} onClick={() => pickRoom(r.id)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="name">{r.name}</div>
                      <div className="tiny muted">{(r.kinds || []).map((k) => t(KIND_LABELS[k])).join(' · ') || '—'}{s.seats ? t('venue.seatsSeats', { seats: s.seats }) : ''}{r.capacity ? t('venue.capCapacity', { capacity: r.capacity }) : ''}</div>
                    </div>
                    {isMgr && <div className="moves">
                      <button className="btn sm ghost icon" style={{ height: 24, width: 24 }} title={t('venue.moveUp')} onClick={(e) => { e.stopPropagation(); move(r, -1); }}><Icon name="up" size={14} /></button>
                      <button className="btn sm ghost icon" style={{ height: 24, width: 24 }} title={t('venue.moveDown')} onClick={(e) => { e.stopPropagation(); move(r, 1); }}><Icon name="down" size={14} /></button>
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
              {rooms.length > 1 && (
                <select className="input mobile-only venue-room-pick" value={room.id} onChange={(e) => pickRoom(e.target.value)} aria-label={t('venue.room')}>
                  {levels.map((g) => <optgroup key={g.name} label={g.name}>{g.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>)}
                </select>
              )}
              <div className="row wrap">
                <div style={{ flex: 1, minWidth: 200 }}>
                  <h2 className={rooms.length > 1 ? 'desktop-only' : ''} style={{ margin: 0 }}>{room.name}</h2>
                  <div className="small muted">{room.level}{locations.length > 1 ? ` · ${loc?.name}` : ''} · {statsText(stats)}{room.capacity ? t('venue.capacityCapacity', { capacity: room.capacity }) : ''}</div>
                </div>
                <div className="row wrap">{(room.kinds || []).map((k) => <span key={k} className="badge brand">{t(KIND_LABELS[k])}</span>)}</div>
                {isMgr && <button className="btn sm" onClick={() => setEditRoom(room)}><Icon name="edit" />{t('venue.roomDetails')}</button>}
              </div>
            </div>
            <div className="card card-pad col" style={{ gap: 12 }}>
              {isMgr && (
                <div className="seg venue-tabs" role="tablist">
                  <button role="tab" aria-selected={view === 'sections'} className={view === 'sections' ? 'on' : ''} onClick={() => pickTab('sections')}>{t('venue.sections')}</button>
                  <button role="tab" aria-selected={view === 'layout'} className={view === 'layout' ? 'on' : ''} onClick={() => pickTab('layout')}>{t('venue.editLayout')}</button>
                </div>
              )}
              {view === 'layout'
                ? <FloorPlanEditor key={`${room.id}:${stamp}`} room={room} onDirtyChange={setPlanDirty}
                    onImport={() => setImporting(true)} onExport={(plan) => setExporting({ ...room, plan })}
                    onSaved={(r) => { setV((cur) => ({ ...cur, rooms: cur.rooms.map((x) => (x.id === r.id ? r : x)) })); refresh(); }} />
                : <SectionsBoard key={room.id} room={room} date={date} setDate={setDate} onEditLayout={() => pickTab('layout')} />}
            </div>
          </div>
        )}
      </div>

      {importing && room && <FloorImport room={room} rooms={v.rooms} onClose={() => setImporting(false)}
        onDone={(r) => { setImporting(false); setV(r); setStamp((n) => n + 1); refresh(); if (r.roomIds?.[0] && !r.roomIds.includes(room.id)) { setLocId(null); setRoomId(r.roomIds[0]); } }} />}
      {exporting && <FloorExport room={exporting} rooms={v.rooms} onClose={() => setExporting(null)} />}
      {editRoom && <RoomDialog room={editRoom} levels={levels.map((g) => g.name)} locations={locations} busy={busy}
        onClose={() => setEditRoom(null)}
        onDelete={editRoom.id ? () => { if (window.confirm(t('venue.deleteNameAndItsFloor', { name: editRoom.name }))) act(() => call('venue.deleteRoom', { id: editRoom.id }), t('venue.roomDeleted')).then((x) => { if (x) { setEditRoom(null); setRoomId(null); setPlanDirty(false); } }); } : null}
        onSave={(r) => act(() => call('venue.saveRoom', r), editRoom.id ? t('venue.roomSaved') : t('venue.roomAdded')).then((x) => { if (x) { setEditRoom(null); setRoomId(x.id); setLocId(x.locationId); } })} />}
      {editLoc && <LocationDialog loc={editLoc} busy={busy} canDelete={editLoc.id && !(v.rooms || []).some((r) => r.locationId === editLoc.id)}
        onClose={() => setEditLoc(null)}
        onDelete={() => act(() => call('venue.deleteLocation', { id: editLoc.id }), t('venue.locationRemoved')).then((x) => { if (x) { setEditLoc(null); setLocId(null); } })}
        onSave={(l) => act(() => call('venue.saveLocation', l), editLoc.id ? t('venue.locationSaved') : t('venue.locationAdded')).then((x) => { if (x) { setEditLoc(null); setLocId(x.id); setRoomId(null); } })} />}
      {renameLevel && (
        <Modal title={t('venue.renameLevel')} onClose={() => setRenameLevel(null)}
          footer={<><span className="spacer" /><button className="btn" onClick={() => setRenameLevel(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy || !renameLevel.to.trim()} onClick={() => act(() => call('venue.renameLevel', { locationId: loc.id, ...renameLevel }), t('venue.levelRenamed')).then((x) => { if (x) setRenameLevel(null); })}>{t('common.save')}</button></>}>
          <Field label={t('venue.levelName')} help={t('venue.eGMainFloorLower')}><input className="input" autoFocus value={renameLevel.to} onChange={(e) => setRenameLevel({ ...renameLevel, to: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function RoomDialog({ room, levels, locations, busy, onClose, onSave, onDelete }) {
  const t = useT();
  const [f, setF] = useState({ ...room, kinds: room.kinds || [], capacity: room.capacity ?? '' });
  const toggle = (k) => setF({ ...f, kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
  return (
    <Modal title={room.id ? t('common.editName', { name: room.name }) : t('venue.addARoom')} onClose={onClose}
      footer={<>{onDelete && <button className="btn danger" disabled={busy} onClick={onDelete}><Icon name="trash" />{t('common.delete')}</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !f.name?.trim()} onClick={() => onSave({ id: f.id, name: f.name, level: f.level, kinds: f.kinds, capacity: f.capacity, locationId: f.locationId })}>{room.id ? t('common.save') : t('venue.addRoom')}</button></>}>
      <div className="grid2">
        <Field label={t('venue.roomName')}><input className="input" autoFocus value={f.name || ''} placeholder={t('venue.mainDiningRoom')} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('venue.level')} help={t('venue.groupRoomsByFloor')}>
          <input className="input" list="venue-levels" value={f.level || ''} placeholder={t('venue.mainFloor')} onChange={(e) => setF({ ...f, level: e.target.value })} />
          <datalist id="venue-levels">{[...new Set([...levels, ...t('venue.levelSuggestions').split('|')])].map((l) => <option key={l} value={l} />)}</datalist>
        </Field>
      </div>
      <Field label={t('venue.whatHappensHere')}>
        <div className="row wrap">{Object.entries(KIND_LABELS).map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={f.kinds.includes(k)} onChange={() => toggle(k)} />{t(label)}</label>
        ))}</div>
      </Field>
      <div className="grid2">
        <Field label={t('venue.capacityGuests')}><input className="input" type="number" min="0" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
        {locations.length > 1 && (
          <Field label={t('venue.location')}>
            <select className="input" value={f.locationId || ''} onChange={(e) => setF({ ...f, locationId: e.target.value })}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="help">{t('venue.roomNamesShowUpWhen')}</div>
    </Modal>
  );
}

function LocationDialog({ loc, busy, canDelete, onClose, onSave, onDelete }) {
  const t = useT();
  const [f, setF] = useState({ ...loc });
  return (
    <Modal title={loc.id ? t('common.editName', { name: loc.name }) : t('venue.addALocation')} onClose={onClose}
      footer={<>{loc.id && <button className="btn danger" disabled={busy || !canDelete} title={canDelete ? '' : t('venue.moveOrDeleteItsRooms')} onClick={onDelete}><Icon name="trash" />{t('common.delete')}</button>}<span className="spacer" />
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !f.name?.trim()} onClick={() => onSave({ id: f.id, name: f.name, address: f.address, order: f.order })}>{loc.id ? t('common.save') : t('venue.addLocation')}</button></>}>
      <Field label={t('common.name')}><input className="input" autoFocus value={f.name || ''} placeholder={t('venue.downtown')} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t('venue.addressOptional')}><input className="input" value={f.address || ''} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      {!loc.id && <div className="help">{t('venue.forASecondVenueOr')}</div>}
    </Modal>
  );
}
