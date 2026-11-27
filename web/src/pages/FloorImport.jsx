// Venue → Edit layout → Import: make a floor plan from Toast, a picture or PDF, or a CSV.
// 1. Pick a source. Toast and the picture need the server (web/src/venue-import-api.js); a CSV is read here.
// 2. A picture: the AI's reading over the picture, which the manager can fix (move, renumber, seats, remove).
// 3. Preview (venue.importPreview): each room as it will be, with the new tables outlined, what's updated, and a
//    decision for anything ambiguous (skip by default: an import never makes a duplicate on its own).
// 4. Apply (venue.importApply), audited on the server.
// The rules are in core/floor-import.js; Toast's limits in docs/integrations/TOAST-FLOOR-PLAN.md.
// Ask ShiftBoard opens it with what it read (initial: { read, picture?, roomName } for a picture, { incoming } for a CSV).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, Field } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { FloorPlanView, ITEM_DEFS, SEATED, usePlanGestures, ZoomControls } from './FloorPlan.jsx';
import { importStatus, readToast, readPicture } from '../venue-import-api.js';
import { parseCsv } from '../../../core/adp-csv.js';
import { readPlanCsv, ITEM_TYPES } from '../../../core/floor-plan.js';
import { incomingFromCsv, incomingFromToast, incomingFromImage } from '../../../core/floor-import.js';

const MAX_SIDE = 1600;
const MAX_CHARS = 1_700_000;
const TEMPLATE = 'Room,Table,Seats,Shape,Section\r\nDining room,1,4,square,Section 1\r\nDining room,2,2,round,Section 1\r\nDining room,3,6,rectangle,Section 2\r\nPatio,P1,4,high-top,\r\nBar,Bar,8,bar,\r\n';

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** A picture or a PDF's first page, shrunk to a JPEG the server takes: { base64, dataUrl, mediaType, width, height }. */
export async function preparePicture(file) {
  let source;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const { pdfFirstPageCanvas } = await import('../pdf.js');
    source = await pdfFirstPageCanvas(file, MAX_SIDE);
  } else {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }
  const w0 = source.naturalWidth || source.width, h0 = source.naturalHeight || source.height;
  for (const side of [MAX_SIDE, 1200, 900]) {
    const k = Math.min(1, side / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * k));
    canvas.height = Math.max(1, Math.round(h0 * k));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (base64.length <= MAX_CHARS || side === 900) return { base64, dataUrl, mediaType: 'image/jpeg', width: canvas.width, height: canvas.height };
  }
  return null;
}

export default function FloorImport({ room, rooms, onClose, onDone, initial = null }) {
  const t = useT();
  const { call, toast } = useApp();
  const [status, setStatus] = useState(null);
  const [source, setSource] = useState(null); // 'toast' | 'image' | 'csv'
  const [step, setStep] = useState('source'); // 'source' | 'adjust' | 'preview'
  const [busy, setBusy] = useState('');
  const [toastMode, setToastMode] = useState('rooms');
  const [toastData, setToastData] = useState(null);
  const [picture, setPicture] = useState(null); // prepared picture + file name
  const [read, setRead] = useState(null); // the AI's reading (adjustable)
  const [target, setTarget] = useState(room ? 'this' : 'new'); // the picture/CSV's room: 'this' | 'new' (no rooms yet: new)
  const [newName, setNewName] = useState('');
  const [csv, setCsv] = useState(null); // { name, rows, errors }
  const [incoming, setIncoming] = useState(null);
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [positions, setPositions] = useState('keep');
  const fileName = picture?.name || csv?.name || (source === 'toast' ? 'Toast' : '');

  useEffect(() => {
    if (!initial) return;
    if (initial.read?.items?.length && initial.picture) {
      setSource('image'); setTarget('new'); setNewName(initial.roomName || ''); setPicture(initial.picture);
      setRead({ ...initial.read, items: initial.read.items.map((i, k) => ({ ...i, id: `a${k}` })) }); setStep('adjust');
    } else if (initial.incoming) { setSource(initial.read ? 'image' : 'csv'); showPreview(initial.incoming); }
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { importStatus().then(setStatus).catch(() => setStatus({ toast: { available: false, reason: 'error' }, ai: { available: false, reason: 'error' } })); }, []);

  const roomOpt = () => (target === 'new' || !room ? { roomName: newName.trim() } : { roomId: room.id, roomName: room.name });
  const run = async (label, fn) => {
    setBusy(label);
    try { return await fn(); } catch (e) { toast(e.message, 'bad'); return undefined; } finally { setBusy(''); }
  };
  const showPreview = async (inc, dec = decisions, pos = positions) => {
    const p = await run('preview', () => call('venue.importPreview', { incoming: inc, decisions: dec, positions: pos }));
    if (!p) return;
    setIncoming(inc); setPreview(p); setStep('preview');
  };

  // ----- sources -----
  const startToast = async () => {
    const r = await run('toast', () => readToast());
    if (!r) return;
    setToastData(r.toast);
    if (!r.toast.tables.length) { toast(t('floor.import.toastEmpty'), 'bad'); return; }
    await showPreview(incomingFromToast(r.toast, { mode: room ? toastMode : 'rooms', roomId: room?.id, roomName: room?.name, otherName: t('floor.import.otherTables') }));
  };
  const pickPicture = async (file) => {
    if (!file) return;
    const p = await run('prepare', () => preparePicture(file));
    if (!p) { toast(t('floor.import.pictureUnreadable'), 'bad'); return; }
    setPicture({ ...p, name: file.name });
    setRead(null);
  };
  const readIt = async () => {
    const r = await run('read', () => readPicture({ image: picture.base64, mediaType: picture.mediaType, width: picture.width, height: picture.height }));
    if (!r) return;
    if (!r.available) { setStatus((s) => ({ ...s, ai: { available: false, reason: r.reason } })); toast(r.message || t(`floor.import.off.${r.reason}`), 'bad'); return; }
    if (!r.read.items.length) { toast(t('floor.import.nothingFound'), 'bad'); return; }
    setRead({ ...r.read, items: r.read.items.map((i, k) => ({ ...i, id: `a${k}` })), truncated: r.truncated });
    setStep('adjust');
  };
  const pickCsv = async (file) => {
    if (!file) return;
    const text = await file.text();
    const r = readPlanCsv(text, parseCsv);
    setCsv({ name: file.name, ...r });
  };
  const csvIncoming = () => incomingFromCsv(csv.rows, roomOpt());
  const imageIncoming = () => incomingFromImage(read, roomOpt());
  const redo = (dec, pos) => showPreview(incoming, dec, pos);

  const apply = async () => {
    const r = await run('apply', () => call('venue.importApply', { incoming, decisions, positions, fileName }));
    if (!r) return;
    const c = r.counts;
    toast(t('floor.import.done', { created: c.create, updated: c.update }));
    onDone(r);
  };

  const unavailable = (s) => (s?.available ? '' : s?.reason ? t(`floor.import.off.${s.reason}`) : '');
  const hasPositions = source === 'image' || (source === 'csv' && csv?.rows.some((r) => r.x != null));
  const targetPicker = (
    <div className="col" style={{ gap: 6 }}>
      {room && <label className="check"><input type="radio" checked={target === 'this'} onChange={() => setTarget('this')} />{t('floor.import.intoThisRoom', { name: room.name })}</label>}
      <label className="check"><input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />{t('floor.import.intoNewRoom')}</label>
      {target === 'new' && <input className="input" placeholder={t('floor.import.newRoomName')} value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />}
    </div>
  );
  const targetOk = (target === 'this' && room) || newName.trim();

  let body;
  let footer = <><span className="spacer" /><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button></>;
  if (step === 'source') {
    body = (
      <div className="col" style={{ gap: 12 }}>
        <div className="fp-sources" role="radiogroup" aria-label={t('floor.import.from')}>
          {[['toast', 'link', status?.toast], ['image', 'camera', status?.ai], ['csv', 'upload', { available: true }]].map(([key, icon, st]) => (
            <button key={key} type="button" role="radio" aria-checked={source === key} className={`fp-source ${source === key ? 'on' : ''}`} disabled={!status || !st?.available} onClick={() => setSource(key)}>
              <Icon name={icon} size={20} />
              <b>{t(`floor.import.source.${key}`)}</b>
              <span className="small muted">{status && !st?.available ? unavailable(st) : t(`floor.import.sourceHelp.${key}`)}</span>
            </button>
          ))}
        </div>
        {source === 'toast' && (
          <div className="fp-step col">
            <div className="small">{t('floor.import.toastHow')}</div>
            <label className="check"><input type="radio" checked={toastMode === 'rooms'} onChange={() => setToastMode('rooms')} />{t('floor.import.toastRooms')}</label>
            {room && <label className="check"><input type="radio" checked={toastMode === 'zones'} onChange={() => setToastMode('zones')} />{t('floor.import.toastZones', { name: room.name })}</label>}
            <div className="help">{t('floor.import.toastNote')}</div>
          </div>
        )}
        {source === 'image' && (
          <div className="fp-step col">
            <Field label={t('floor.import.pictureLabel')} help={t('floor.import.pictureHelp')}>
              <input className="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf" onChange={(e) => pickPicture(e.target.files?.[0])} />
            </Field>
            {picture && <img className="fp-thumb" src={picture.dataUrl} alt={t('floor.import.yourPicture')} />}
            {targetPicker}
          </div>
        )}
        {source === 'csv' && (
          <div className="fp-step col">
            <Field label={t('floor.import.csvLabel')} help={t('floor.import.csvHelp')}>
              <input className="input" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => pickCsv(e.target.files?.[0])} />
            </Field>
            <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => downloadBlob(new Blob([`﻿${TEMPLATE}`], { type: 'text/csv' }), 'floor-plan-template.csv')}><Icon name="download" />{t('floor.import.template')}</button>
            {csv && <div className="small">{t('floor.import.csvRows', { count: csv.rows.length })}</div>}
            {csv?.errors.length > 0 && (
              <ul className="fp-errors small">{csv.errors.slice(0, 8).map((e) => <li key={`${e.line}${e.error}`}>{t(`floor.import.csvError.${e.error}`, { line: e.line, value: e.value || '' })}</li>)}</ul>
            )}
            {csv?.rows.some((r) => !r.room) && <>
              <div className="small muted">{t('floor.import.csvNoRoom')}</div>
              {targetPicker}
            </>}
          </div>
        )}
      </div>
    );
    footer = <>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
      {source === 'toast' && <button type="button" className="btn primary" disabled={!!busy} onClick={startToast}>{busy === 'toast' || busy === 'preview' ? t('floor.import.reading') : t('floor.import.readToast')}</button>}
      {source === 'image' && <button type="button" className="btn primary" disabled={!!busy || !picture || !targetOk} onClick={readIt}><Icon name="sparkle" />{busy === 'read' ? t('floor.import.readingPicture') : t('floor.import.readPicture')}</button>}
      {source === 'csv' && <button type="button" className="btn primary" disabled={!!busy || !csv?.rows.length || (csv.rows.some((r) => !r.room) && !targetOk)} onClick={() => showPreview(csvIncoming())}>{t('floor.import.next')}</button>}
    </>;
  } else if (step === 'adjust') {
    body = <AdjustPicture read={read} setRead={setRead} picture={picture} />;
    footer = <>
      <button type="button" className="btn ghost" onClick={() => setStep('source')}>{t('floor.import.back')}</button>
      <span className="spacer" />
      <button type="button" className="btn primary" disabled={!!busy || !read.items.length} onClick={() => showPreview(imageIncoming())}>{t('floor.import.next')}</button>
    </>;
  } else {
    body = <PreviewImport preview={preview} decisions={decisions} positions={positions} hasPositions={hasPositions} busy={!!busy}
      onDecide={(key, v) => { const d = { ...decisions, [key]: v }; setDecisions(d); redo(d, positions); }}
      onPositions={(v) => { setPositions(v); redo(decisions, v); }} rooms={rooms} />;
    const c = preview.counts;
    footer = <>
      <button type="button" className="btn ghost" onClick={() => setStep(source === 'image' ? 'adjust' : 'source')}>{t('floor.import.back')}</button>
      <span className="spacer" />
      <button type="button" className="btn primary" disabled={!!busy || !(c.create + c.update) } onClick={apply}><Icon name="check" />{busy === 'apply' ? t('floor.import.applying') : t('floor.import.apply', { count: c.create + c.update })}</button>
    </>;
  }
  return (
    <Modal wide title={t('floor.import.title')} sub={step === 'preview' ? t('floor.import.previewSub') : t('floor.import.sub')} onClose={onClose} footer={footer}>
      {body}
    </Modal>
  );
}

/** The AI's reading drawn over the picture: tap to pick, drag to move, fix a number or seats, remove what's wrong. */
function AdjustPicture({ read, setRead, picture }) {
  const t = useT();
  const [sel, setSel] = useState(null);
  const svgRef = useRef(null);
  const readRef = useRef(read);
  readRef.current = read;
  const plan = useMemo(() => ({ width: read.width, height: read.height, items: read.items.map((i) => ({ ...i, label: i.label || '', seats: i.seats ?? 0 })) }), [read]);
  const patch = (id, pt) => setRead({ ...readRef.current, items: readRef.current.items.map((i) => (i.id === id ? { ...i, ...pt } : i)) });
  const gz = usePlanGestures({
    plan, svgRef,
    onStart: (e, p) => {
      const id = e.target.closest?.('[data-id]')?.getAttribute('data-id');
      if (!id) return null;
      setSel(id);
      const it = readRef.current.items.find((i) => i.id === id);
      return {
        move(q) { patch(id, { x: Math.max(0, Math.round((it.x + q.x - p.x) / 5) * 5), y: Math.max(0, Math.round((it.y + q.y - p.y) / 5) * 5) }); },
        end() {}, cancel() { patch(id, { x: it.x, y: it.y }); },
      };
    },
    onTap: () => setSel(null),
  });
  const one = read.items.find((i) => i.id === sel);
  const seated = read.items.filter((i) => SEATED.has(i.type));
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="small">{t('floor.import.adjustHelp', { tables: seated.length, seats: seated.reduce((n, i) => n + (Number(i.seats) || 0), 0) })}</div>
      {read.notes && <div className="small muted">{t('floor.import.aiNotes', { notes: read.notes })}</div>}
      {read.truncated && <div className="small" style={{ color: 'var(--warn)' }}>{t('floor.import.truncated')}</div>}
      <div className="fp-adjust">
        <div className="fp-stage">
          <FloorPlanView plan={plan} editing svgRef={svgRef} view={gz.view} handlers={gz.handlers} touchAction="none" selected={new Set(sel ? [sel] : [])}
            backdrop={{ href: picture.dataUrl }} title={t('floor.import.yourPicture')} />
          <ZoomControls gz={gz} />
        </div>
        <div className="fp-panel col">
          {one ? <>
            <b>{t(ITEM_DEFS[one.type].label)}</b>
            <label className="field"><span>{t('floor.import.kind')}</span>
              <select className="input sm" value={one.type} onChange={(e) => patch(one.id, { type: e.target.value })}>
                {ITEM_TYPES.map((ty) => <option key={ty} value={ty}>{t(ITEM_DEFS[ty].label)}</option>)}
              </select>
            </label>
            <label className="field"><span>{SEATED.has(one.type) ? t('floor.tableNumber') : t('floorPlan.label')}</span>
              <input className="input sm" maxLength={40} value={one.label || ''} onChange={(e) => patch(one.id, { label: e.target.value })} /></label>
            {SEATED.has(one.type) && <label className="field"><span>{t('floorPlan.seats')}</span>
              <input className="input sm" type="number" min="0" max="40" value={one.seats ?? ''} placeholder="?" onChange={(e) => patch(one.id, { seats: e.target.value === '' ? null : Math.max(0, Math.min(40, Number(e.target.value) || 0)) })} /></label>}
            <button type="button" className="btn sm danger" style={{ alignSelf: 'flex-start' }} onClick={() => { setRead({ ...read, items: read.items.filter((i) => i.id !== one.id) }); setSel(null); }}><Icon name="trash" />{t('floor.import.remove')}</button>
          </> : <div className="small muted">{t('floor.import.adjustPick')}</div>}
        </div>
      </div>
    </div>
  );
}

const OUTCOME_BADGE = { create: 'ok', update: 'brand', same: '', skip: 'warn' };

/** What the import will do, room by room. */
function PreviewImport({ preview, decisions, positions, hasPositions, onDecide, onPositions, busy }) {
  const t = useT();
  const c = preview.counts;
  const shape = (type) => (ITEM_DEFS[type] ? t(ITEM_DEFS[type].label) : type);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" aria-live="polite">
        <span className="badge ok">{t('floor.import.countNew', { count: c.create })}</span>
        <span className="badge brand">{t('floor.import.countUpdated', { count: c.update })}</span>
        <span className="badge">{t('floor.import.countSame', { count: c.same })}</span>
        {c.ambiguous > 0 && <span className="badge warn">{t('floor.import.countAsk', { count: c.ambiguous })}</span>}
        {c.newRooms > 0 && <span className="badge brand">{t('floor.import.countRooms', { count: c.newRooms })}</span>}
        {busy && <span className="small muted">{t('common.loading')}</span>}
      </div>
      {hasPositions && (
        <label className="check small"><input type="checkbox" checked={positions === 'replace'} onChange={(e) => onPositions(e.target.checked ? 'replace' : 'keep')} />{t('floor.import.movePositions')}</label>
      )}
      {preview.rooms.map((r) => {
        const fresh = new Set(r.create ? [] : r.items.filter((i) => i.outcome === 'create').map((i) => i.itemId)); // in a new room everything is new
        const warn = new Set(preview.warnings.filter((w) => w.roomId === r.roomId).flatMap((w) => w.ids));
        const shown = r.items.filter((i) => i.outcome !== 'same' || i.action === 'ambiguous');
        return (
          <div key={r.key} className="fp-preview-room col">
            <div className="row wrap"><b>{r.name || t('floor.import.noName')}</b>{r.create ? <span className="badge brand">{t('floor.import.newRoom')}</span> : <span className="badge">{t('floor.import.existingRoom')}</span>}
              {r.toast?.revenueCenterName && <span className="small muted">{t('floor.import.revenueCenter', { name: r.toast.revenueCenterName })}</span>}</div>
            {r.error && <div className="small" style={{ color: 'var(--bad)' }}>{t('floor.import.needRoomName')}</div>}
            {r.plan && <FloorPlanView plan={r.plan} picked={fresh} showZones warnIds={warn} title={r.name} />}
            {warn.size > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{t('floor.import.overlapNote')}</div>}
            {shown.length > 0 && (
              <div className="fp-table-wrap"><table className="fp-rows">
                <thead><tr><th>{t('floor.tableNumber')}</th><th>{t('floorPlan.seats')}</th><th>{t('floor.shape')}</th><th>{t('floor.import.result')}</th></tr></thead>
                <tbody>{shown.map((i) => {
                  const key = `${r.key}|${i.key}`;
                  return (
                    <tr key={i.key}>
                      <td><b>{i.label || '—'}</b></td>
                      <td>{SEATED.has(i.type) ? i.seats ?? '—' : '—'}</td>
                      <td>{shape(i.type)}</td>
                      <td>
                        {i.action === 'ambiguous'
                          ? <div className="col" style={{ gap: 4 }}>
                            <span className="small">{t(`floor.import.why.${i.reason}`, { label: i.label })}</span>
                            <select className="input sm" value={decisions[key] || 'skip'} onChange={(e) => onDecide(key, e.target.value)} aria-label={t('floor.import.decide')}>
                              <option value="skip">{t('floor.import.decision.skip')}</option>
                              {i.candidates.map((cand) => <option key={cand.id} value={`update:${cand.id}`}>{t('floor.import.decision.update', { label: cand.label || '—', seats: cand.seats })}</option>)}
                              <option value="create">{t('floor.import.decision.create')}</option>
                            </select>
                          </div>
                          : <span className={`badge ${OUTCOME_BADGE[i.outcome]}`}>{t(`floor.import.outcome.${i.outcome}`)}</span>}
                        {i.outcome === 'update' && Object.keys(i.changes || {}).length > 0 && (
                          <div className="tiny muted">{Object.keys(i.changes).filter((k) => k !== 'w' && k !== 'h').map((k) => t(`floor.import.field.${k}`)).join(', ')}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
            {!shown.length && <div className="small muted">{t('floor.import.nothingNew')}</div>}
            {r.missing.length > 0 && <div className="small muted">{t('floor.import.missing', { count: r.missing.length, tables: r.missing.map((m) => m.label).join(', ') })}</div>}
          </div>
        );
      })}
    </div>
  );
}
