// Floor plans: an SVG view (used on the Venue page and on BEOs) and a simple editor.
// Plan units are abstract (default room 1000 × 700); items are { id, type, x, y, w, h, r, label, seats }.
import React, { useEffect, useId, useRef, useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import '../venue.css';

export const ITEM_DEFS = {
  'table-round': { label: 'Round table', w: 80, h: 80, seats: 4, prefix: 'T' },
  'table-square': { label: 'Square table', w: 70, h: 70, seats: 4, prefix: 'T' },
  'table-rect': { label: 'Long table', w: 140, h: 60, seats: 6, prefix: 'T' },
  booth: { label: 'Booth', w: 140, h: 70, seats: 4, prefix: 'B' },
  bar: { label: 'Bar', w: 300, h: 50, seats: 8, name: 'Bar' },
  stage: { label: 'Stage', w: 260, h: 120, name: 'Stage' },
  dancefloor: { label: 'Dance floor', w: 220, h: 220, name: 'Dance floor' },
  dj: { label: 'DJ booth', w: 90, h: 60, name: 'DJ' },
  host: { label: 'Host stand', w: 80, h: 40, name: 'Host' },
  wall: { label: 'Wall', w: 200, h: 10 },
  door: { label: 'Door', w: 60, h: 60 },
  plant: { label: 'Plant', w: 40, h: 40 },
  label: { label: 'Text label', w: 160, h: 40, name: 'Label' },
};
const SEATED = new Set(['table-round', 'table-square', 'table-rect', 'booth', 'bar']);
const DARK = new Set(['bar', 'stage', 'dj']);
const SNAP = 10;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const newId = () => `itm_${Math.random().toString(36).slice(2, 10)}`;

export function planStats(plan) {
  const items = plan?.items || [];
  const tables = items.filter((i) => i.type.startsWith('table-') || i.type === 'booth').length;
  const seats = items.reduce((t, i) => t + (Number(i.seats) || 0), 0);
  const barSeats = items.filter((i) => i.type === 'bar').reduce((t, i) => t + (Number(i.seats) || 0), 0);
  return { tables, seats, barSeats, items: items.length };
}
export const statsText = (s) => `${s.tables} table${s.tables === 1 ? '' : 's'} · ${s.seats} seat${s.seats === 1 ? '' : 's'}${s.barSeats ? ` (${s.barSeats} at the bar)` : ''}`;

// ---------- drawing ----------
const spread = (n, len) => Array.from({ length: n }, (_, i) => -len / 2 + (len * (i + 0.5)) / n);

function seatPositions(it) {
  const n = Math.min(40, Number(it.seats) || 0);
  const { w, h } = it;
  const off = 13;
  if (!n || it.type === 'booth') return [];
  if (it.type === 'table-round') {
    return Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n - Math.PI / 2;
      return [Math.cos(a) * (w / 2 + off), Math.sin(a) * (h / 2 + off)];
    });
  }
  if (it.type === 'bar') { // stools along the long front side
    return w >= h ? spread(n, w * 0.92).map((x) => [x, h / 2 + off]) : spread(n, h * 0.92).map((y) => [w / 2 + off, y]);
  }
  // Square tables: seats go round all four sides. Long tables: long sides first, one at each end from 6 seats.
  const c = { top: 0, bottom: 0, left: 0, right: 0 };
  if (it.type === 'table-square') {
    ['top', 'bottom', 'left', 'right'].forEach((s, i) => { c[s] = Math.floor(n / 4) + (i < n % 4 ? 1 : 0); });
  } else {
    const ends = n >= 6 ? 1 : 0;
    const rest = n - 2 * ends;
    if (w >= h) { c.top = Math.ceil(rest / 2); c.bottom = Math.floor(rest / 2); c.left = c.right = ends; }
    else { c.left = Math.ceil(rest / 2); c.right = Math.floor(rest / 2); c.top = c.bottom = ends; }
  }
  return [
    ...spread(c.top, w).map((x) => [x, -h / 2 - off]),
    ...spread(c.bottom, w).map((x) => [x, h / 2 + off]),
    ...spread(c.left, h).map((y) => [-w / 2 - off, y]),
    ...spread(c.right, h).map((y) => [w / 2 + off, y]),
  ];
}

function Shape({ it, ids }) {
  const { w, h } = it;
  const x0 = -w / 2, y0 = -h / 2;
  const seats = seatPositions(it).map(([x, y], i) => <circle key={i} className="fp-seat" cx={x} cy={y} r={8} />);
  switch (it.type) {
    case 'table-round':
      return <>{seats}<ellipse className="fp-table" rx={w / 2} ry={h / 2} /></>;
    case 'table-square':
    case 'table-rect':
      return <>{seats}<rect className="fp-table" x={x0} y={y0} width={w} height={h} rx={6} /></>;
    case 'booth': {
      const b = Math.min(16, w / 4, h / 3);
      return <>
        <rect className="fp-bench" x={x0} y={y0} width={w} height={b} rx={4} />
        <rect className="fp-bench" x={x0} y={y0} width={b} height={h} rx={4} />
        <rect className="fp-bench" x={x0 + w - b} y={y0} width={b} height={h} rx={4} />
        <rect className="fp-table" x={x0 + b + 6} y={y0 + b + 6} width={Math.max(4, w - 2 * b - 12)} height={Math.max(4, h - b - 10)} rx={4} />
      </>;
    }
    case 'bar': {
      const rx = Math.min(w, h) / 2;
      return <>{seats}<rect className="fp-bar" x={x0} y={y0} width={w} height={h} rx={rx} />
        <rect className="fp-bar-top" x={x0 + 5} y={y0 + 5} width={Math.max(2, w - 10)} height={Math.max(2, h - 10)} rx={Math.max(0, rx - 5)} /></>;
    }
    case 'stage':
      return <><rect x={x0} y={y0} width={w} height={h} rx={4} fill={`url(#${ids.stripes})`} /><rect className="fp-stage-edge" x={x0} y={y0} width={w} height={h} rx={4} /></>;
    case 'dancefloor':
      return <><rect x={x0} y={y0} width={w} height={h} fill={`url(#${ids.checker})`} /><rect className="fp-dance-edge" x={x0} y={y0} width={w} height={h} /></>;
    case 'dj': {
      const r = Math.max(3, Math.min(w / 4, h / 2) * 0.6);
      return <><rect className="fp-dj" x={x0} y={y0} width={w} height={h} rx={6} />
        <circle className="fp-dj-deck" cx={-w / 4} cy={0} r={r} /><circle className="fp-dj-deck" cx={w / 4} cy={0} r={r} /></>;
    }
    case 'host':
      return <rect className="fp-host" x={x0} y={y0} width={w} height={h} rx={4} />;
    case 'wall':
      return <rect className="fp-wall" x={x0} y={y0} width={w} height={h} />;
    case 'door':
      return <>
        <path className="fp-door" d={`M ${x0} ${y0} A ${w} ${h} 0 0 1 ${x0 + w} ${y0 + h}`} />
        <line className="fp-door-leaf" x1={x0} y1={y0 + h} x2={x0} y2={y0} />
      </>;
    case 'plant': {
      const r = Math.min(w, h) / 2;
      return <><circle className="fp-plant" r={r} opacity={0.35} /><circle className="fp-plant" r={r * 0.6} /></>;
    }
    default:
      return null; // 'label' is text only
  }
}

function Defs({ ids }) {
  return (
    <defs>
      <pattern id={ids.grid} width="50" height="50" patternUnits="userSpaceOnUse">
        <path d="M 50 0 L 0 0 0 50" fill="none" stroke="var(--fp-grid)" strokeWidth="1.5" />
      </pattern>
      <pattern id={ids.stripes} width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="16" height="16" fill="var(--fp-stage)" /><rect width="8" height="16" fill="var(--fp-stage-2)" />
      </pattern>
      <pattern id={ids.checker} width="40" height="40" patternUnits="userSpaceOnUse">
        <rect width="40" height="40" fill="var(--fp-dance-1)" /><rect width="20" height="20" fill="var(--fp-dance-2)" /><rect x="20" y="20" width="20" height="20" fill="var(--fp-dance-2)" />
      </pattern>
    </defs>
  );
}

function usePatternIds() {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return { grid: `fpg${base}`, stripes: `fps${base}`, checker: `fpc${base}` };
}

const PAD = 24;

/** The plan as SVG. With `editing`, items report pointer presses so the editor can move/resize them. */
export function FloorPlanView({ plan, editing, selectedId, svgRef, onItemDown, onHandleDown, onBackgroundDown, onPointerMove, onPointerUp, title }) {
  const ids = usePatternIds();
  const W = plan?.width || 1000, H = plan?.height || 700;
  const items = plan?.items || [];
  return (
    <svg ref={svgRef} className={`fp-svg ${editing ? 'editing' : ''}`} viewBox={`${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}`}
      role="img" aria-label={title || 'Floor plan'} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <Defs ids={ids} />
      <rect x={-PAD} y={-PAD} width={W + PAD * 2} height={H + PAD * 2} fill="var(--fp-floor)" onPointerDown={onBackgroundDown} />
      <rect x={0} y={0} width={W} height={H} fill={`url(#${ids.grid})`} stroke="var(--fp-edge)" strokeWidth="2" onPointerDown={onBackgroundDown} />
      {items.map((it) => {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const sel = editing && it.id === selectedId;
        return (
          <g key={it.id} className="fp-item" onPointerDown={editing ? (e) => onItemDown(e, it) : undefined}>
            <title>{[ITEM_DEFS[it.type]?.label, it.label, it.seats ? `${it.seats} seats` : ''].filter(Boolean).join(' · ')}</title>
            <g transform={`translate(${cx} ${cy}) rotate(${it.r || 0})`}>
              {it.type === 'label' && editing && <rect x={-it.w / 2} y={-it.h / 2} width={it.w} height={it.h} fill="transparent" stroke="var(--fp-edge)" strokeDasharray="4 4" />}
              {it.type === 'label' && !editing && <rect x={-it.w / 2} y={-it.h / 2} width={it.w} height={it.h} fill="transparent" />}
              <Shape it={it} ids={ids} />
              {sel && <rect className="fp-select" x={-it.w / 2 - 6} y={-it.h / 2 - 6} width={it.w + 12} height={it.h + 12} rx={6} />}
              {sel && <circle className="fp-handle" cx={it.w / 2 + 6} cy={it.h / 2 + 6} r={10} onPointerDown={(e) => onHandleDown(e, it)} />}
            </g>
            {it.label && it.type !== 'wall' && (
              <text className={`fp-text ${DARK.has(it.type) ? 'inv' : ''} ${it.type === 'label' || it.type === 'stage' || it.type === 'dancefloor' ? 'big' : ''}`}
                x={cx} y={it.type === 'door' ? cy + it.h / 2 + 14 : cy}>{it.label}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function MiniShape({ type }) {
  const ids = usePatternIds();
  const d = ITEM_DEFS[type];
  const it = { type, w: d.w, h: d.h, seats: Math.min(d.seats || 0, 6), r: 0 };
  const m = Math.max(d.w, d.h) / 2 + 26;
  return (
    <svg className="fp-mini" viewBox={`${-m} ${-m * 0.75} ${m * 2} ${m * 1.5}`} aria-hidden="true">
      <Defs ids={ids} />
      <Shape it={it} ids={ids} />
      {type === 'label' && <text className="fp-text big" x={0} y={0}>Aa</text>}
    </svg>
  );
}

// ---------- editor ----------
const fit = (it, plan) => {
  const w = Math.max(4, Math.min(plan.width, Math.round(it.w)));
  const h = Math.max(4, Math.min(plan.height, Math.round(it.h)));
  return { ...it, w, h, x: Math.max(0, Math.min(plan.width - w, Math.round(it.x))), y: Math.max(0, Math.min(plan.height - h, Math.round(it.y))) };
};
const normalize = (p) => ({ width: p?.width || 1000, height: p?.height || 700, items: (p?.items || []).map((i) => ({ ...i })) });
function nextLabel(items, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  const max = items.reduce((m, i) => Math.max(m, Number((i.label || '').match(re)?.[1] || 0)), 0);
  return `${prefix}${max + 1}`;
}

export function FloorPlanEditor({ room, onSaved, onDirtyChange }) {
  const { call, toast } = useApp();
  const [plan, setPlan] = useState(() => normalize(room.plan));
  const [sel, setSel] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef(null);
  const drag = useRef(null);
  const selected = plan.items.find((i) => i.id === sel) || null;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = (fn) => { setPlan(fn); setDirty(true); };
  const patch = (id, p) => change((pl) => ({ ...pl, items: pl.items.map((i) => (i.id === id ? fit({ ...i, ...p }, pl) : i)) }));
  const remove = (id) => { change((pl) => ({ ...pl, items: pl.items.filter((i) => i.id !== id) })); setSel(null); };
  const add = (type) => {
    const d = ITEM_DEFS[type];
    const n = plan.items.length % 8;
    const item = fit({
      id: newId(), type, w: d.w, h: d.h, r: 0, seats: d.seats || 0,
      x: snap(plan.width / 2 - d.w / 2 + n * 20), y: snap(plan.height / 2 - d.h / 2 + n * 20),
      label: d.prefix ? nextLabel(plan.items, d.prefix) : d.name || '',
    }, plan);
    change((pl) => ({ ...pl, items: [...pl.items, item] }));
    setSel(item.id);
  };
  const duplicate = (it) => {
    const d = ITEM_DEFS[it.type];
    const copy = fit({ ...it, id: newId(), x: it.x + 30, y: it.y + 30, label: d.prefix ? nextLabel(plan.items, d.prefix) : it.label }, plan);
    change((pl) => ({ ...pl, items: [...pl.items, copy] }));
    setSel(copy.id);
  };

  // Keyboard: Delete removes, arrows nudge, Esc deselects (ignored while typing in a field).
  useEffect(() => {
    const on = (e) => {
      if (!sel || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      const it = plan.items.find((i) => i.id === sel);
      if (!it) return;
      const step = e.shiftKey ? 1 : SNAP;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(sel); }
      else if (moves[e.key]) { e.preventDefault(); patch(sel, { x: it.x + moves[e.key][0], y: it.y + moves[e.key][1] }); }
      else if (e.key === 'Escape') setSel(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [sel, plan]);

  const toPlan = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svgRef.current.getScreenCTM().inverse());
  const capture = (e) => { try { svgRef.current.setPointerCapture(e.pointerId); } catch { /* not supported */ } };
  const onItemDown = (e, it) => {
    e.stopPropagation(); e.preventDefault();
    setSel(it.id);
    const p = toPlan(e);
    drag.current = { mode: 'move', id: it.id, dx: p.x - it.x, dy: p.y - it.y, x: it.x, y: it.y };
    capture(e);
  };
  const onHandleDown = (e, it) => {
    e.stopPropagation(); e.preventDefault();
    drag.current = { mode: 'resize', id: it.id, cx: it.x + it.w / 2, cy: it.y + it.h / 2, r: it.r || 0 };
    capture(e);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const p = toPlan(e);
    if (d.mode === 'move') {
      const x = snap(p.x - d.dx), y = snap(p.y - d.dy);
      if (x !== d.x || y !== d.y) { d.x = x; d.y = y; patch(d.id, { x, y }); }
    } else {
      const a = (-d.r * Math.PI) / 180;
      const vx = p.x - d.cx, vy = p.y - d.cy;
      const lx = vx * Math.cos(a) - vy * Math.sin(a), ly = vx * Math.sin(a) + vy * Math.cos(a);
      const w = Math.max(10, snap(2 * Math.abs(lx) - 12)), h = Math.max(10, snap(2 * Math.abs(ly) - 12));
      patch(d.id, { w, h, x: d.cx - w / 2, y: d.cy - h / 2 });
    }
  };
  const onPointerUp = () => { drag.current = null; };

  const save = async () => {
    setBusy(true);
    try {
      const r = await call('venue.savePlan', { roomId: room.id, plan });
      setPlan(normalize(r.plan));
      setDirty(false);
      toast('Floor plan saved');
      onSaved?.(r);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const discard = () => { setPlan(normalize(room.plan)); setDirty(false); setSel(null); };
  const stats = planStats(plan);
  const setSize = (k) => (e) => change((pl) => {
    const next = { ...pl, [k]: Math.max(200, Math.min(5000, Number(e.target.value) || 0)) };
    return { ...next, items: next.items.map((i) => fit(i, next)) };
  });

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="fp-toolbar">
        {Object.entries(ITEM_DEFS).map(([type, d]) => (
          <button key={type} className="btn sm fp-add" onClick={() => add(type)} title={`Add ${d.label.toLowerCase()}`}><MiniShape type={type} />{d.label}</button>
        ))}
      </div>
      <div className="fp-editor">
        <div className="col" style={{ gap: 6 }}>
          <FloorPlanView plan={plan} editing selectedId={sel} svgRef={svgRef} title={`${room.name} floor plan`}
            onItemDown={onItemDown} onHandleDown={onHandleDown} onBackgroundDown={() => setSel(null)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
          <div className="row wrap small muted">
            <span>{statsText(stats)}</span>
            <span className="spacer" />
            <span>Room size</span>
            <input className="input sm" type="number" step="50" style={{ width: 84 }} value={plan.width} onChange={setSize('width')} aria-label="Plan width" />
            <span>×</span>
            <input className="input sm" type="number" step="50" style={{ width: 84 }} value={plan.height} onChange={setSize('height')} aria-label="Plan height" />
          </div>
        </div>
        <div className="fp-panel col">
          {selected ? <>
            <div className="row"><b style={{ flex: 1 }}>{ITEM_DEFS[selected.type]?.label}</b>
              <button className="btn sm icon ghost" title="Duplicate" onClick={() => duplicate(selected)}><Icon name="copy" /></button>
              <button className="btn sm icon ghost danger" title="Delete (Del)" onClick={() => remove(selected.id)}><Icon name="trash" /></button>
            </div>
            <label className="field"><span>Label</span><input className="input sm" maxLength={40} value={selected.label || ''} onChange={(e) => patch(selected.id, { label: e.target.value })} /></label>
            {SEATED.has(selected.type) && (
              <label className="field"><span>{selected.type === 'bar' ? 'Bar stools' : 'Seats'}</span>
                <input className="input sm" type="number" min="0" max="40" value={selected.seats || 0} onChange={(e) => patch(selected.id, { seats: Math.max(0, Math.min(40, Number(e.target.value) || 0)) })} /></label>
            )}
            <div className="grid2">
              <label className="field"><span>Width</span><input className="input sm" type="number" step="10" value={selected.w} onChange={(e) => patch(selected.id, { w: Number(e.target.value) || 4 })} /></label>
              <label className="field"><span>Depth</span><input className="input sm" type="number" step="10" value={selected.h} onChange={(e) => patch(selected.id, { h: Number(e.target.value) || 4 })} /></label>
            </div>
            <div className="row">
              <span className="small muted" style={{ flex: 1 }}>Rotation {selected.r || 0}°</span>
              <button className="btn sm" title="Rotate left 15°" onClick={() => patch(selected.id, { r: ((selected.r || 0) + 345) % 360 })}><Icon name="rotateLeft" /></button>
              <button className="btn sm" title="Rotate right 15°" onClick={() => patch(selected.id, { r: ((selected.r || 0) + 15) % 360 })}><Icon name="rotateRight" /></button>
            </div>
            <div className="help">Drag to move · corner dot to resize · arrow keys nudge · Del removes</div>
          </> : <div className="small muted">Add tables, a bar, a stage and more from the buttons above, then drag them into place. Click an item to label it, set seats, resize or rotate it.</div>}
          <div className="row" style={{ marginTop: 6 }}>
            {dirty ? <span className="badge warn">Unsaved changes</span> : <span className="badge ok">Saved</span>}
            <span className="spacer" />
            {dirty && <button className="btn sm ghost" onClick={discard} disabled={busy}>Undo</button>}
            <button className="btn sm primary" onClick={save} disabled={busy || !dirty}><Icon name="check" />{busy ? 'Saving…' : 'Save plan'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Read-only plan for a room by name (used on the BEO page). Renders nothing if there's no plan. */
export function RoomPlanCard({ room }) {
  const { call, version } = useApp();
  const [r, setR] = useState(null);
  useEffect(() => {
    let live = true;
    if (!room) { setR(null); return undefined; }
    call('venue.get')
      .then((v) => { if (live) setR(v.rooms.find((x) => x.name.toLowerCase() === String(room).toLowerCase() && x.plan?.items?.length) || null); })
      .catch(() => { if (live) setR(null); });
    return () => { live = false; };
  }, [room, version]);
  if (!r) return null;
  return (
    <div className="card card-pad section">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ flex: 1 }}>Floor plan · {r.name}</h2>
        <span className="small muted">{statsText(planStats(r.plan))}</span>
      </div>
      <FloorPlanView plan={r.plan} title={`${r.name} floor plan`} />
    </div>
  );
}
