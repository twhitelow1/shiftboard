// Floor plans: the SVG drawing, zoom & pan, a read-only viewer (sections, BEOs, shift details) and the editor.
// Plan units are abstract (default room 1000 × 700); the data model, its checks and the palette are in
// core/floor-plan.js: items are { id, type, x, y, w, h, r, label, seats, zone?, toastGuid? } and a plan can have
// server sections ({ zones: [{ id, name, color }] }) that color its tables.
//
// Gestures, the same everywhere: pinch to zoom and drag with two fingers to pan on phones; on a computer,
// Ctrl/⌘ + wheel (or a trackpad pinch) zooms and dragging pans once zoomed in; the +/− buttons work for both.
// In the editor, tap selects, long-press (or Select mode, or Shift-click) adds to the selection, dragging
// moves everything selected, and dragging on empty floor with a mouse (or in Select mode) box-selects.
// Keyboard (computers): see SHORTCUTS below; "?" shows them.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal } from '../ui.jsx';
import '../venue.css';
import { useT, t as tr } from '../i18n/index.js';
import {
  SEATED as CORE_SEATED, TYPE_DEFAULTS, PRESETS, PRESET_GROUPS, TABLE_TYPES, ZONE_COLORS, planWarnings, renumber, nextLabel, planCounts,
} from '../../../core/floor-plan.js';

// label: the catalog key (web/src/i18n) for the item's kind; name: the label a new one gets.
const KIND = {
  'table-round': { label: 'floorPlan.roundTable' },
  'table-square': { label: 'floorPlan.squareTable' },
  'table-rect': { label: 'floorPlan.longTable' },
  'table-hightop': { label: 'floor.type.hightop' },
  booth: { label: 'floorPlan.booth' },
  bar: { label: 'floorPlan.bar', name: 'floorPlan.nameBar' },
  stage: { label: 'floorPlan.stage', name: 'floorPlan.nameStage' },
  dancefloor: { label: 'floorPlan.danceFloor', name: 'floorPlan.nameDanceFloor' },
  dj: { label: 'floorPlan.djBooth', name: 'floorPlan.nameDj' },
  host: { label: 'floorPlan.hostStand', name: 'floorPlan.nameHost' },
  kitchen: { label: 'floor.type.kitchen', name: 'floor.default.kitchen' },
  restroom: { label: 'floor.type.restroom', name: 'floor.default.restroom' },
  wall: { label: 'floorPlan.wall' },
  divider: { label: 'floor.type.divider' },
  door: { label: 'floorPlan.door' },
  plant: { label: 'floorPlan.plant' },
  label: { label: 'floorPlan.textLabel', name: 'floorPlan.nameLabel' },
};
/** Each type's kind (a catalog key), default name, size, seats and number prefix. */
export const ITEM_DEFS = Object.fromEntries(Object.entries(KIND).map(([type, k]) => [type, { ...TYPE_DEFAULTS[type], ...k }]));
/** Items people sit at: tables, booths, high-tops and bars. These are what server sections are made of. */
export const SEATED = CORE_SEATED;
const DARK = new Set(['bar', 'stage', 'dj', 'kitchen']);
const GRID = 10;
const newId = () => `itm_${Math.random().toString(36).slice(2, 10)}`;
const presetKey = (p) => `floor.preset.${p.id.replace('-', '')}`;

export function planStats(plan) {
  const c = planCounts(plan);
  return { ...c, items: (plan?.items || []).length };
}
export const statsText = (s) => `${tr('floorPlan.tablesCount', { count: s.tables })} · ${tr('floorPlan.seatsCount', { count: s.seats })}${s.barSeats ? tr('floorPlan.atTheBar', { count: s.barSeats }) : ''}`;

// Icons the floor plan needs beyond the app's set.
const FP_ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  select: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  zoomIn: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35M8 11h6',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3M6 3h4v8a2 2 0 0 0 4 0V3h4M6 7h4M14 7h4',
  alignLeft: 'M4 3v18M8 7h10v4H8zM8 14h6v4H8z',
  alignCenter: 'M12 3v18M6 7h12v4H6zM9 14h6v4H9z',
  alignRight: 'M20 3v18M6 7h10v4H6zM10 14h6v4h-6z',
  alignTop: 'M3 4h18M7 8h4v10H7zM14 8h4v6h-4z',
  alignMiddle: 'M3 12h18M7 6h4v12H7zM14 9h4v6h-4z',
  alignBottom: 'M3 20h18M7 6h4v10H7zM14 10h4v6h-4z',
  distH: 'M4 3v18M20 3v18M9 8h6v8H9z',
  distV: 'M3 4h18M3 20h18M8 9h8v6H8z',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  alert: 'M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
};
export function FpIcon({ name, size = 16 }) {
  if (!FP_ICONS[name]) return <Icon name={name} size={size} />;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={size} height={size} aria-hidden="true">
      <path d={FP_ICONS[name]} />
    </svg>
  );
}

// ---------- drawing ----------
const spread = (n, len) => Array.from({ length: n }, (_, i) => -len / 2 + (len * (i + 0.5)) / n);
const ROUND = new Set(['table-round', 'table-hightop']);

function seatPositions(it) {
  const n = Math.min(40, Number(it.seats) || 0);
  const { w, h } = it;
  const off = it.type === 'table-hightop' ? 11 : 13;
  if (!n || it.type === 'booth') return [];
  if (ROUND.has(it.type)) {
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
  const seatR = it.type === 'table-hightop' ? 6.5 : 8;
  const seats = seatPositions(it).map(([x, y], i) => <circle key={i} className="fp-seat" cx={x} cy={y} r={seatR} />);
  switch (it.type) {
    case 'table-round':
      return <>{seats}<ellipse className="fp-table" rx={w / 2} ry={h / 2} /></>;
    case 'table-hightop': // a high-top: a smaller top on a pedestal (the inner ring), with stools
      return <>{seats}<ellipse className="fp-table" rx={w / 2} ry={h / 2} /><ellipse className="fp-hightop-ring" rx={w / 4} ry={h / 4} /></>;
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
    case 'kitchen': // the kitchen door: a dark block with a pass line along its floor side
      return <><rect className="fp-kitchen" x={x0} y={y0} width={w} height={h} rx={3} />
        <line className="fp-kitchen-pass" x1={x0 + 8} y1={y0 + h - 5} x2={x0 + w - 8} y2={y0 + h - 5} /></>;
    case 'restroom':
      return <rect className="fp-fixture" x={x0} y={y0} width={w} height={h} rx={4} />;
    case 'wall':
      return <rect className="fp-wall" x={x0} y={y0} width={w} height={h} />;
    case 'divider':
      return <rect className="fp-divider" x={x0} y={y0} width={w} height={h} rx={Math.min(w, h) / 2} />;
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

/** A color behind a table (and its seats): a server's section for the day, or the table's usual section. */
function Halo({ it, mark, zone }) {
  const grow = it.seats && it.type !== 'booth' ? 22 : 9;
  const props = zone
    ? { className: 'fp-zone', style: { '--mark': zone.color } }
    : { className: `fp-halo ${mark.faded ? 'faded' : ''} ${mark.strong ? 'strong' : ''}`, style: { '--mark': mark.color } };
  if (ROUND.has(it.type)) return <ellipse {...props} rx={it.w / 2 + grow} ry={it.h / 2 + grow} />;
  return <rect {...props} x={-it.w / 2 - grow} y={-it.h / 2 - grow} width={it.w + 2 * grow} height={it.h + 2 * grow} rx={14} />;
}

function NameTag({ x, y, mark }) {
  const text = String(mark.name || '').slice(0, 12);
  const w = Math.max(28, text.length * 8.4 + 14);
  return (
    <g className={`fp-tag ${mark.faded ? 'faded' : ''}`} transform={`translate(${x} ${y})`} style={{ '--mark': mark.color }}>
      <rect x={-w / 2} y={-11} width={w} height={22} rx={11} />
      <text>{text}</text>
    </g>
  );
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
const MAX_ZOOM = 8;
/** The whole plan with a margin: the view when nothing is zoomed. */
export const fitBox = (plan) => ({ x: -PAD, y: -PAD, w: (plan?.width || 1000) + PAD * 2, h: (plan?.height || 700) + PAD * 2 });

/**
 * The plan as SVG.
 * - view: the visible part of the plan ({ x, y, w, h } in plan units); the whole plan when left out.
 * - selected: Set of item ids drawn as selected (editor); handleR: resize handle radius for a single selection.
 * - marks: Map of item id → { color, name, faded, strong } for server sections.
 * - picked: Set of item ids picked for assigning (or, in an import preview, the new ones).
 * - showZones: color tables by the plan's own sections (the editor, exports, previews).
 * - warnIds: Set of item ids drawn with a warning outline (overlaps).
 * - backdrop: { href } a picture drawn under the plan (the picture an import was read from).
 */
export function FloorPlanView({ plan, title, view, svgRef, handlers, editing, selected, handleR, marks, picked, marquee, touchAction, showZones, warnIds, backdrop, className = '' }) {
  const t = useT();
  const ids = usePatternIds();
  const W = plan?.width || 1000, H = plan?.height || 700;
  const items = plan?.items || [];
  const vb = view || fitBox(plan);
  const zones = useMemo(() => new Map((showZones ? plan?.zones || [] : []).map((z) => [z.id, z])), [showZones, plan?.zones]);
  return (
    <svg ref={svgRef} className={`fp-svg ${editing ? 'editing' : ''} ${className}`} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      style={touchAction ? { touchAction } : undefined} role="img" aria-label={title || t('floorPlan.floorPlan')}
      onContextMenu={handlers ? (e) => e.preventDefault() : undefined} {...handlers}>
      <Defs ids={ids} />
      <rect x={-PAD} y={-PAD} width={W + PAD * 2} height={H + PAD * 2} fill="var(--fp-floor)" />
      {backdrop?.href && <image href={backdrop.href} x={0} y={0} width={W} height={H} preserveAspectRatio="none" opacity={backdrop.opacity ?? 0.55} />}
      <rect x={0} y={0} width={W} height={H} fill={`url(#${ids.grid})`} stroke="var(--fp-edge)" strokeWidth="2" opacity={backdrop?.href ? 0.5 : 1} />
      {items.map((it) => {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const mark = marks?.get(it.id);
        const zone = !mark && it.zone ? zones.get(it.zone) : null;
        const sel = !!selected?.has(it.id);
        const pick = !!picked?.has(it.id);
        const seated = SEATED.has(it.type);
        const withTag = mark?.name && it.h >= 40;
        return (
          <g key={it.id} className={`fp-item ${seated ? 'seated' : ''} ${pick ? 'picked' : ''}`} data-id={it.id}>
            <title>{[ITEM_DEFS[it.type] && tr(ITEM_DEFS[it.type].label), it.label, it.seats ? tr('floorPlan.seatsCount', { count: it.seats }) : '', zone?.name, mark?.title || mark?.name].filter(Boolean).join(' · ')}</title>
            <g transform={`translate(${cx} ${cy}) rotate(${it.r || 0})`}>
              {(mark || zone) && <Halo it={it} mark={mark} zone={zone} />}
              {it.type === 'label' && <rect x={-it.w / 2} y={-it.h / 2} width={it.w} height={it.h} fill="transparent" stroke={editing ? 'var(--fp-edge)' : 'none'} strokeDasharray="4 4" />}
              <Shape it={it} ids={ids} />
              {warnIds?.has(it.id) && <rect className="fp-warn" x={-it.w / 2 - 4} y={-it.h / 2 - 4} width={it.w + 8} height={it.h + 8} rx={6} />}
              {pick && <rect className="fp-picked" x={-it.w / 2 - 10} y={-it.h / 2 - 10} width={it.w + 20} height={it.h + 20} rx={10} />}
              {sel && <rect className="fp-select" x={-it.w / 2 - 6} y={-it.h / 2 - 6} width={it.w + 12} height={it.h + 12} rx={6} />}
              {sel && handleR > 0 && (
                <g data-handle="" className="fp-handle-g">
                  <circle className="fp-handle-hit" cx={it.w / 2 + 6} cy={it.h / 2 + 6} r={handleR * 1.9} />
                  <circle className="fp-handle" cx={it.w / 2 + 6} cy={it.h / 2 + 6} r={handleR} />
                </g>
              )}
            </g>
            {it.label && it.type !== 'wall' && it.type !== 'divider' && (
              <text className={`fp-text ${DARK.has(it.type) ? 'inv' : ''} ${it.type === 'label' || it.type === 'stage' || it.type === 'dancefloor' ? 'big' : ''} ${it.type === 'table-hightop' || it.w < 50 ? 'small' : ''}`}
                x={cx} y={it.type === 'door' ? cy + it.h / 2 + 14 : withTag ? cy - 11 : cy}>{it.label}</text>
            )}
            {withTag && <NameTag x={cx} y={it.label ? cy + 12 : cy} mark={mark} />}
          </g>
        );
      })}
      {marquee && <rect className="fp-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
    </svg>
  );
}

/** A small drawing of a palette entry (a preset: type, size and seats). */
export function MiniShape({ preset }) {
  const t = useT();
  const ids = usePatternIds();
  const it = { type: preset.type, w: preset.w, h: preset.h, seats: Math.min(preset.seats || 0, 10), r: 0 };
  const m = Math.max(preset.w, preset.h) / 2 + 26;
  return (
    <svg className="fp-mini" viewBox={`${-m} ${-m * 0.75} ${m * 2} ${m * 1.5}`} aria-hidden="true">
      <Defs ids={ids} />
      <Shape it={it} ids={ids} />
      {preset.type === 'label' && <text className="fp-text big" x={0} y={0}>{t('floorPlan.aa')}</text>}
    </svg>
  );
}

// ---------- zoom, pan and gestures ----------
function clampView(v, fit) {
  const w = Math.max(fit.w / MAX_ZOOM, Math.min(fit.w, v.w));
  const h = (w * fit.h) / fit.w;
  return { w, h, x: Math.max(fit.x, Math.min(fit.x + fit.w - w, v.x)), y: Math.max(fit.y, Math.min(fit.y + fit.h - h, v.y)) };
}

/** A view that frames some items (e.g. someone's tables), zoomed in at most 2.5×; the whole plan without any. */
function focusView(plan, ids, fit) {
  const items = (plan?.items || []).filter((i) => ids?.includes(i.id));
  if (!items.length) return fit;
  const m = 90;
  const x0 = Math.min(...items.map((i) => i.x)) - m, y0 = Math.min(...items.map((i) => i.y)) - m;
  const x1 = Math.max(...items.map((i) => i.x + i.w)) + m, y1 = Math.max(...items.map((i) => i.y + i.h)) + m;
  const w = Math.max(fit.w / 2.5, x1 - x0, ((y1 - y0) * fit.w) / fit.h);
  const h = (w * fit.h) / fit.w;
  return clampView({ w, h, x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2 }, fit);
}

/** True on phones and tablets (a finger, not a mouse). */
export function useCoarsePointer() {
  const q = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(q);
    const on = () => setCoarse(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

/**
 * Zoom, pan and pointer gestures for a plan SVG.
 * Two pointers always pinch-zoom and pan. With one pointer, onStart(e, p) may return an action
 * { move(p, e), end(p, e, moved), cancel() }; with none, a drag pans (when zoomed in) and a press that
 * doesn't move is a tap: onTap(e, p, targetElement). p is the point in plan units.
 */
export function usePlanGestures({ plan, svgRef, onStart, onTap, focus }) {
  const W = plan?.width || 1000, H = plan?.height || 700;
  const fit = useMemo(() => fitBox({ width: W, height: H }), [W, H]);
  const focusKey = (focus || []).join();
  const first = () => focusView(plan, focus, fit);
  const [view, setViewState] = useState(first);
  const viewRef = useRef(view);
  const setView = (v) => { viewRef.current = v; setViewState(v); };
  useEffect(() => { setView(first()); }, [fit, focusKey]);
  const cb = useRef({});
  cb.current = { onStart, onTap, fit };
  const pts = useRef(new Map());
  const g = useRef(null);
  const [pxW, setPxW] = useState(0);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    setPxW(el.getBoundingClientRect().width);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => setPxW(el.getBoundingClientRect().width)) : null;
    ro?.observe(el);
    // Ctrl/⌘ + wheel and trackpad pinches zoom; a plain wheel still scrolls the page.
    const wheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const d = Math.max(-50, Math.min(50, e.deltaMode ? e.deltaY * 30 : e.deltaY)); // a mouse notch is ~100; trackpad pinches send small steps
      zoomAt(Math.exp(-d * 0.008), toPlan(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { ro?.disconnect(); el.removeEventListener('wheel', wheel); };
  }, []); // the svg is rendered with the component and stays for its life

  const rect = () => svgRef.current.getBoundingClientRect();
  function toPlan(cx, cy, v = viewRef.current) {
    const r = rect();
    return { x: v.x + ((cx - r.left) / r.width) * v.w, y: v.y + ((cy - r.top) / r.height) * v.h };
  }
  function zoomAt(f, p) {
    const v = viewRef.current;
    const z = clampView({ ...v, w: v.w / f }, cb.current.fit);
    setView(clampView({ ...z, x: p.x - (p.x - v.x) * (z.w / v.w), y: p.y - (p.y - v.y) * (z.h / v.h) }, cb.current.fit));
  }
  const zoomBy = (f) => { const v = viewRef.current; zoomAt(f, { x: v.x + v.w / 2, y: v.y + v.h / 2 }); };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { svgRef.current.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    if (pts.current.size === 2) {
      if (g.current?.kind === 'one') g.current.action?.cancel?.();
      const [a, b] = [...pts.current.values()];
      g.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, p0: toPlan((a.x + b.x) / 2, (a.y + b.y) / 2), v0: viewRef.current };
      return;
    }
    if (pts.current.size > 2) return;
    const action = cb.current.onStart?.(e, toPlan(e.clientX, e.clientY)) || null;
    g.current = { kind: 'one', id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, action, el: e.target, v0: viewRef.current, slop: e.pointerType === 'mouse' ? 3 : 8 };
  };
  const onPointerMove = (e) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    if (!s) return;
    if (s.kind === 'pinch') {
      if (pts.current.size < 2) return;
      const [a, b] = [...pts.current.values()];
      const f = Math.hypot(a.x - b.x, a.y - b.y) / s.d0;
      const r = rect();
      const z = clampView({ ...s.v0, w: s.v0.w / f }, cb.current.fit);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      setView(clampView({ ...z, x: s.p0.x - ((mx - r.left) / r.width) * z.w, y: s.p0.y - ((my - r.top) / r.height) * z.h }, cb.current.fit));
      return;
    }
    if (s.id !== e.pointerId) return;
    if (!s.moved && Math.hypot(e.clientX - s.x0, e.clientY - s.y0) > s.slop) s.moved = true;
    if (!s.moved) return;
    if (s.action) s.action.move?.(toPlan(e.clientX, e.clientY), e);
    else if (s.v0.w < cb.current.fit.w - 0.5) {
      const r = rect();
      setView(clampView({ ...s.v0, x: s.v0.x - ((e.clientX - s.x0) / r.width) * s.v0.w, y: s.v0.y - ((e.clientY - s.y0) / r.height) * s.v0.h }, cb.current.fit));
    }
  };
  const onPointerUp = (e) => {
    if (!pts.current.delete(e.pointerId)) return;
    const s = g.current;
    if (!s) return;
    if (s.kind === 'pinch') { if (!pts.current.size) g.current = null; return; } // the other finger does nothing until lifted
    if (s.id !== e.pointerId) return;
    g.current = null;
    if (e.type === 'pointercancel') { s.action?.cancel?.(); return; }
    const p = toPlan(e.clientX, e.clientY);
    if (s.action) s.action.end?.(p, e, s.moved);
    else if (!s.moved) cb.current.onTap?.(e, p, s.el);
  };

  return {
    view, fit, zoomBy, toPlan,
    reset: () => setView(cb.current.fit),
    zoomed: view.w < fit.w - 0.5,
    zoom: fit.w / view.w,
    unitsPerPx: pxW ? view.w / pxW : fit.w / 600,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}

export function ZoomControls({ gz }) {
  const t = useT();
  return (
    <div className="fp-zoom no-print" role="group" aria-label={t('floorPlan.zoom')}>
      <button type="button" className="btn sm icon" title={t('floorPlan.zoomIn')} aria-label={t('floorPlan.zoomIn')} onClick={() => gz.zoomBy(1.5)}><FpIcon name="zoomIn" /></button>
      <button type="button" className="btn sm icon" title={t('floorPlan.zoomOut')} aria-label={t('floorPlan.zoomOut')} disabled={!gz.zoomed} onClick={() => gz.zoomBy(1 / 1.5)}><FpIcon name="zoomOut" /></button>
      {gz.zoomed && <button type="button" className="btn sm icon" title={t('floorPlan.showTheWholeRoom')} aria-label={t('floorPlan.showTheWholeRoom')} onClick={gz.reset}><FpIcon name="fit" /></button>}
    </div>
  );
}

/**
 * A read-only plan you can zoom and pan, with server sections drawn on it (marks) and tables you can tap.
 * onTapItem(item | null) is called with the tapped item, or null for the floor.
 */
export function PlanViewer({ plan, title, marks, picked, onTapItem, focus, className = '' }) {
  const svgRef = useRef(null);
  const gz = usePlanGestures({
    plan, svgRef, focus,
    onTap: onTapItem ? (e, p, el) => {
      const id = el?.closest?.('[data-id]')?.getAttribute('data-id');
      onTapItem((id && plan.items.find((i) => i.id === id)) || null);
    } : undefined,
  });
  return (
    <div className={`fp-stage ${className}`}>
      <FloorPlanView plan={plan} title={title} view={gz.view} svgRef={svgRef} handlers={gz.handlers} marks={marks} picked={picked}
        touchAction={gz.zoomed ? 'none' : 'pan-y'} className={onTapItem ? 'tappable' : ''} />
      <ZoomControls gz={gz} />
    </div>
  );
}

// ---------- editor ----------
const fit = (it, plan) => {
  const w = Math.max(4, Math.min(plan.width, Math.round(it.w)));
  const h = Math.max(4, Math.min(plan.height, Math.round(it.h)));
  return { ...it, w, h, x: Math.max(0, Math.min(plan.width - w, Math.round(it.x))), y: Math.max(0, Math.min(plan.height - h, Math.round(it.y))) };
};
const normalize = (p) => ({
  width: p?.width || 1000, height: p?.height || 700, items: (p?.items || []).map((i) => ({ ...i })),
  ...(p?.zones?.length ? { zones: p.zones.map((z) => ({ ...z })) } : {}),
});
const boxOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const HISTORY = 100;
const TABLE_SHAPES = ['table-square', 'table-round', 'table-rect', 'table-hightop', 'booth'];
const ALIGNS = [
  ['left', 'alignLeft'], ['hcenter', 'alignCenter'], ['right', 'alignRight'],
  ['top', 'alignTop'], ['vcenter', 'alignMiddle'], ['bottom', 'alignBottom'],
];
/** Keyboard shortcuts (computers), shown with "?". */
const SHORTCUTS = [
  ['Ctrl/⌘ Z', 'floor.keys.undo'], ['Ctrl/⌘ Shift Z · Ctrl Y', 'floor.keys.redo'], ['Del · Backspace', 'floor.keys.delete'],
  ['Ctrl/⌘ D', 'floor.keys.duplicate'], ['Ctrl/⌘ C · V', 'floor.keys.copyPaste'], ['Ctrl/⌘ A', 'floor.keys.selectAll'],
  ['R · Shift R', 'floor.keys.rotate'], ['← ↑ → ↓', 'floor.keys.nudge'], ['Shift + ← ↑ → ↓', 'floor.keys.nudgeFine'],
  ['G', 'floor.keys.snap'], ['+ · −', 'floor.keys.zoom'], ['0', 'floor.keys.fit'], ['Esc', 'floor.keys.clear'], ['?', 'floor.keys.help'],
];

/** The next section color not used yet on this plan. */
const nextColor = (zones) => ZONE_COLORS.find((c) => !(zones || []).some((z) => z.color === c)) || ZONE_COLORS[(zones || []).length % ZONE_COLORS.length];

export function FloorPlanEditor({ room, onSaved, onDirtyChange, onImport, onExport }) {
  const t = useT();
  const { call, toast } = useApp();
  const coarse = useCoarsePointer();
  const [saved, setSaved] = useState(() => normalize(room.plan));
  const [plan, setPlanState] = useState(saved);
  const planRef = useRef(plan);
  const history = useRef({ past: [], future: [] });
  const coalesce = useRef(null);
  const clipboard = useRef([]);
  const [, bump] = useState(0);
  const [sel, setSelState] = useState([]);
  const selRef = useRef(sel);
  const [selectMode, setSelectModeState] = useState(false);
  const modeRef = useRef(false);
  const [snapOn, setSnapOnState] = useState(true);
  const snapRef = useRef(true);
  const [group, setGroup] = useState('tables');
  const [marquee, setMarquee] = useState(null);
  const [busy, setBusy] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [numbering, setNumbering] = useState(null); // { prefix, start } while renumbering a selection
  const svgRef = useRef(null);

  const setPlan = (p) => { planRef.current = p; setPlanState(p); };
  const setSel = (ids) => { selRef.current = ids; setSelState(ids); };
  const setSelectMode = (on) => { modeRef.current = on; setSelectModeState(on); };
  const setSnapOn = (on) => { snapRef.current = on; setSnapOnState(on); };
  const snap = (v) => (snapRef.current ? Math.round(v / GRID) * GRID : Math.round(v));
  const selected = useMemo(() => new Set(sel), [sel]);
  const dirty = useMemo(() => JSON.stringify(plan) !== JSON.stringify(saved), [plan, saved]);
  const single = sel.length === 1 ? plan.items.find((i) => i.id === sel[0]) || null : null;
  const chosen = plan.items.filter((i) => selected.has(i.id));
  const chosenSeated = chosen.filter((i) => SEATED.has(i.type));
  const zones = plan.zones || [];
  const warnings = useMemo(() => planWarnings(plan).filter((w) => w.kind === 'overlap'), [plan]);
  const warnIds = useMemo(() => new Set(warnings.flatMap((w) => w.ids)), [warnings]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ----- history: every change can be undone; typing in one field counts as one change -----
  const snapshot = (key) => {
    const now = Date.now();
    if (key && coalesce.current?.key === key && now - coalesce.current.at < 1500) { coalesce.current.at = now; return; }
    coalesce.current = key ? { key, at: now } : null;
    const h = history.current;
    h.past = [...h.past.slice(1 - HISTORY), planRef.current];
    h.future = [];
    bump((n) => n + 1);
  };
  const dropSnapshot = () => { history.current.past = history.current.past.slice(0, -1); bump((n) => n + 1); };
  const change = (fn, key) => { snapshot(key); setPlan(fn(planRef.current)); };
  const keepSel = (p) => setSel(selRef.current.filter((id) => p.items.some((i) => i.id === id)));
  const undo = () => {
    const h = history.current;
    if (!h.past.length) return;
    const prev = h.past[h.past.length - 1];
    history.current = { past: h.past.slice(0, -1), future: [planRef.current, ...h.future] };
    coalesce.current = null;
    setPlan(prev); keepSel(prev);
  };
  const redo = () => {
    const h = history.current;
    if (!h.future.length) return;
    const next = h.future[0];
    history.current = { past: [...h.past, planRef.current], future: h.future.slice(1) };
    coalesce.current = null;
    setPlan(next); keepSel(next);
  };

  // ----- changes to the selection -----
  const mapSel = (fn) => (p) => ({ ...p, items: p.items.map((i) => (selRef.current.includes(i.id) ? fit(fn(i), p) : i)) });
  const patch = (id, pt, key) => change((p) => ({ ...p, items: p.items.map((i) => (i.id === id ? fit({ ...i, ...pt }, p) : i)) }), key);
  const patchSel = (fn, key) => change(mapSel(fn), key);
  const removeSel = () => {
    if (!selRef.current.length) return;
    change((p) => ({ ...p, items: p.items.filter((i) => !selRef.current.includes(i.id)) }));
    setSel([]);
  };
  const rotateSel = (deg) => {
    if (!selRef.current.length) return;
    // 45° steps: an odd angle (from an older plan) goes to the next step first.
    patchSel((i) => {
      const r = i.r || 0;
      const next = r % 45 ? (deg > 0 ? Math.ceil(r / 45) : Math.floor(r / 45)) * 45 : r + deg;
      return { ...i, r: ((next % 360) + 360) % 360 };
    });
  };
  const nudge = (dx, dy) => {
    const items = planRef.current.items.filter((i) => selRef.current.includes(i.id));
    if (!items.length) return;
    const p = planRef.current;
    const mx = Math.max(-Math.min(...items.map((i) => i.x)), Math.min(p.width - Math.max(...items.map((i) => i.x + i.w)), dx));
    const my = Math.max(-Math.min(...items.map((i) => i.y)), Math.min(p.height - Math.max(...items.map((i) => i.y + i.h)), dy));
    change(mapSel((i) => ({ ...i, x: i.x + mx, y: i.y + my })), 'nudge');
  };
  /** Copies of items, numbered on from the plan's highest number, offset so they're visible. */
  const paste = (src, offset = 30) => {
    if (!src.length) return;
    const all = [...planRef.current.items];
    const copies = src.map((it) => {
      const d = ITEM_DEFS[it.type];
      const { toastGuid, ...rest } = it; // a copy is a new table: never the same Toast table
      const c = fit({ ...rest, id: newId(), x: it.x + offset, y: it.y + offset, label: d?.prefix ? nextLabel(all, d.prefix) : it.label }, planRef.current);
      all.push(c);
      return c;
    });
    change((p) => ({ ...p, items: [...p.items, ...copies] }));
    setSel(copies.map((c) => c.id));
  };
  const duplicateSel = () => paste(planRef.current.items.filter((i) => selRef.current.includes(i.id)));
  const add = (preset) => {
    const p = planRef.current;
    const v = gz.view;
    const cx = Math.max(0, Math.min(p.width, v.x + v.w / 2)), cy = Math.max(0, Math.min(p.height, v.y + v.h / 2));
    let x = snap(cx - preset.w / 2), y = snap(cy - preset.h / 2);
    for (let n = 0; n < 8 && p.items.some((i) => i.x === x && i.y === y); n++) { x += 20; y += 20; }
    const prefix = TYPE_DEFAULTS[preset.type]?.prefix;
    const label = prefix ? nextLabel(p.items, prefix) : preset.label ? tr(preset.label) : ITEM_DEFS[preset.type]?.name ? tr(ITEM_DEFS[preset.type].name) : '';
    const item = fit({ id: newId(), type: preset.type, w: preset.w, h: preset.h, r: 0, seats: preset.seats || 0, x, y, label }, p);
    change((pl) => ({ ...pl, items: [...pl.items, item] }));
    setSel([item.id]);
  };
  /** Line up the selection (by each item's box), or spread it out evenly. */
  const align = (how) => {
    const items = planRef.current.items.filter((i) => selRef.current.includes(i.id));
    if (items.length < 2) return;
    const x0 = Math.min(...items.map((i) => i.x)), x1 = Math.max(...items.map((i) => i.x + i.w));
    const y0 = Math.min(...items.map((i) => i.y)), y1 = Math.max(...items.map((i) => i.y + i.h));
    const pos = {};
    if (how === 'distH' || how === 'distV') {
      const horiz = how === 'distH';
      const c = (i) => (horiz ? i.x + i.w / 2 : i.y + i.h / 2);
      const sorted = [...items].sort((a, b) => c(a) - c(b));
      const first = c(sorted[0]), step = (c(sorted[sorted.length - 1]) - first) / (sorted.length - 1);
      sorted.forEach((i, k) => { pos[i.id] = horiz ? { x: Math.round(first + k * step - i.w / 2) } : { y: Math.round(first + k * step - i.h / 2) }; });
    } else {
      for (const i of items) {
        pos[i.id] = {
          left: { x: x0 }, right: { x: x1 - i.w }, hcenter: { x: Math.round((x0 + x1) / 2 - i.w / 2) },
          top: { y: y0 }, bottom: { y: y1 - i.h }, vcenter: { y: Math.round((y0 + y1) / 2 - i.h / 2) },
        }[how];
      }
    }
    patchSel((i) => ({ ...i, ...pos[i.id] }));
  };
  const renumberSel = ({ prefix, start }) => {
    const seated = planRef.current.items.filter((i) => selRef.current.includes(i.id) && SEATED.has(i.type));
    const labels = renumber(seated, seated.map((i) => i.id), { prefix: prefix.trim(), start: Number(start) || 1 });
    change((p) => ({ ...p, items: p.items.map((i) => (labels[i.id] ? { ...i, label: labels[i.id] } : i)) }));
    setNumbering(null);
  };
  const setShape = (type) => patchSel((i) => {
    if (!SEATED.has(i.type) || i.type === 'bar' || i.type === type) return i;
    const d = ITEM_DEFS[type];
    const round = type === 'table-round' || type === 'table-hightop';
    const size = round ? Math.max(d.w, Math.round(Math.max(i.w, i.h) * 0.9)) : null;
    const w = round ? size : type === 'table-rect' || type === 'booth' ? Math.max(d.w, i.w) : Math.max(d.w, Math.min(i.w, i.h));
    const h = round ? size : type === 'table-square' ? w : d.h;
    return { ...i, type, w, h, x: Math.round(i.x + i.w / 2 - w / 2), y: Math.round(i.y + i.h / 2 - h / 2) };
  });

  // ----- sections (zones): a table's usual server section, colored on the plan -----
  const addZone = () => {
    const z = { id: `zone_${Math.random().toString(36).slice(2, 8)}`, name: t('floor.zones.defaultName', { n: zones.length + 1 }), color: nextColor(zones) };
    // The tables picked, if any, go in it.
    change((p) => ({ ...p, zones: [...(p.zones || []), z], items: p.items.map((i) => (selRef.current.includes(i.id) && SEATED.has(i.type) ? { ...i, zone: z.id } : i)) }));
  };
  const patchZone = (id, pt, key) => change((p) => ({ ...p, zones: (p.zones || []).map((z) => (z.id === id ? { ...z, ...pt } : z)) }), key);
  const removeZone = (id) => change((p) => {
    const rest = (p.zones || []).filter((z) => z.id !== id);
    const items = p.items.map(({ zone, ...i }) => (zone && zone !== id ? { ...i, zone } : i));
    const { zones: _, ...base } = p;
    return { ...base, items, ...(rest.length ? { zones: rest } : {}) };
  });
  const setZoneSel = (zoneId) => change((p) => ({
    ...p,
    items: p.items.map((i) => {
      if (!selRef.current.includes(i.id) || !SEATED.has(i.type)) return i;
      const { zone, ...rest } = i;
      return zoneId ? { ...rest, zone: zoneId } : rest;
    }),
  }));

  // ----- pointer actions (see usePlanGestures) -----
  function itemAction(e, p, id) {
    const touch = e.pointerType !== 'mouse';
    const mods = e.shiftKey || e.metaKey || e.ctrlKey;
    const wasSelected = selRef.current.includes(id);
    const multi = modeRef.current;
    if (mods) {
      if (wasSelected) { setSel(selRef.current.filter((x) => x !== id)); return { end() {} }; }
      setSel([...selRef.current, id]);
    } else if (!wasSelected) {
      if (multi) setSel([...selRef.current, id]);
      else if (!touch) setSel([id]); // fingers: wait to see if it's a tap, a drag or a long press
    }
    let longPressed = false;
    const timer = touch && !multi && !mods ? setTimeout(() => {
      longPressed = true;
      if (!selRef.current.includes(id)) setSel([...selRef.current, id]);
      setSelectMode(true);
      navigator.vibrate?.(15);
    }, 450) : null;
    let drag = null;
    const begin = () => {
      if (!selRef.current.includes(id)) setSel(modeRef.current ? [...selRef.current, id] : [id]);
      const ids = new Set(selRef.current);
      const items = planRef.current.items.filter((i) => ids.has(i.id));
      const me = items.find((i) => i.id === id);
      snapshot();
      drag = {
        ids, me, p0: p, dx: 0, dy: 0,
        starts: new Map(items.map((i) => [i.id, { x: i.x, y: i.y }])),
        box: { x0: Math.min(...items.map((i) => i.x)), y0: Math.min(...items.map((i) => i.y)), x1: Math.max(...items.map((i) => i.x + i.w)), y1: Math.max(...items.map((i) => i.y + i.h)) },
      };
    };
    const place = (dx, dy) => {
      const cur = planRef.current;
      setPlan({ ...cur, items: cur.items.map((i) => (drag.ids.has(i.id) ? { ...i, x: drag.starts.get(i.id).x + dx, y: drag.starts.get(i.id).y + dy } : i)) });
    };
    return {
      move(q) {
        clearTimeout(timer);
        if (!drag) begin();
        const { width, height } = planRef.current;
        let dx = snap(drag.me.x + q.x - drag.p0.x) - drag.me.x;
        let dy = snap(drag.me.y + q.y - drag.p0.y) - drag.me.y;
        dx = Math.max(-drag.box.x0, Math.min(width - drag.box.x1, dx));
        dy = Math.max(-drag.box.y0, Math.min(height - drag.box.y1, dy));
        if (dx === drag.dx && dy === drag.dy) return;
        drag.dx = dx; drag.dy = dy;
        place(dx, dy);
      },
      end(q, ev, moved) {
        clearTimeout(timer);
        if (drag && !drag.dx && !drag.dy) dropSnapshot(); // picked up and put back: nothing to undo
        if (moved || longPressed || mods) return;
        if (modeRef.current) { if (wasSelected) setSel(selRef.current.filter((x) => x !== id)); return; }
        setSel([id]);
      },
      cancel() {
        clearTimeout(timer);
        if (drag) { place(0, 0); dropSnapshot(); }
      },
    };
  }
  function resizeAction() {
    const it = planRef.current.items.find((i) => i.id === selRef.current[0]);
    if (!it) return null;
    const c = { cx: it.x + it.w / 2, cy: it.y + it.h / 2, r: it.r || 0 };
    const round = it.type === 'table-round' || it.type === 'table-hightop' || it.type === 'plant';
    let started = false;
    return {
      move(q) {
        if (!started) { snapshot(); started = true; }
        const a = (-c.r * Math.PI) / 180;
        const vx = q.x - c.cx, vy = q.y - c.cy;
        const lx = vx * Math.cos(a) - vy * Math.sin(a), ly = vx * Math.sin(a) + vy * Math.cos(a);
        let w = Math.max(10, snap(2 * Math.abs(lx) - 12)), h = Math.max(10, snap(2 * Math.abs(ly) - 12));
        if (round && it.w === it.h) w = h = Math.max(w, h); // a round table stays round
        const cur = planRef.current;
        setPlan({ ...cur, items: cur.items.map((i) => (i.id === it.id ? fit({ ...i, w, h, x: c.cx - w / 2, y: c.cy - h / 2 }, cur) : i)) });
      },
      end() {},
      cancel() {
        if (!started) return;
        const cur = planRef.current;
        setPlan({ ...cur, items: cur.items.map((i) => (i.id === it.id ? it : i)) });
        dropSnapshot();
      },
    };
  }
  function floorAction(e, p) {
    const mouse = e.pointerType === 'mouse';
    const mods = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!mouse && !modeRef.current) return null; // a finger on the floor pans (when zoomed); a tap clears the selection
    const base = mods || modeRef.current ? selRef.current : [];
    return {
      move(q) { setMarquee(boxOf(p, q)); },
      end(q, ev, moved) {
        setMarquee(null);
        if (!moved) { if (!mods && !modeRef.current) setSel([]); return; }
        const r = boxOf(p, q);
        const hit = planRef.current.items.filter((i) => i.x < r.x + r.w && i.x + i.w > r.x && i.y < r.y + r.h && i.y + i.h > r.y).map((i) => i.id);
        setSel([...new Set([...base, ...hit])]);
      },
      cancel() { setMarquee(null); },
    };
  }
  const gz = usePlanGestures({
    plan, svgRef,
    onStart: (e, p) => {
      if (e.target.closest?.('[data-handle]')) return resizeAction();
      const el = e.target.closest?.('[data-id]');
      return el ? itemAction(e, p, el.getAttribute('data-id')) : floorAction(e, p);
    },
    onTap: () => { if (!modeRef.current) setSel([]); },
  });

  // Keyboard (see SHORTCUTS). Ignored while typing in a field or with a dialog open.
  useEffect(() => {
    const on = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (document.querySelector('.overlay')) return; // a dialog is open
      const k = e.key.toLowerCase();
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (cmd && k === 'y') { e.preventDefault(); redo(); return; }
      if (cmd && k === 'a') { e.preventDefault(); setSel(planRef.current.items.map((i) => i.id)); return; }
      if (cmd && k === 'v') { e.preventDefault(); paste(clipboard.current); return; }
      if (!cmd && !e.altKey) {
        if (e.key === '?') { e.preventDefault(); setKeysOpen(true); return; }
        if (k === 'g') { setSnapOn(!snapRef.current); return; }
        if (e.key === '+' || e.key === '=') { gz.zoomBy(1.5); return; }
        if (e.key === '-' || e.key === '_') { gz.zoomBy(1 / 1.5); return; }
        if (e.key === '0') { gz.reset(); return; }
      }
      if (!selRef.current.length) return;
      const step = e.shiftKey ? 1 : GRID;
      const moves = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
      if (cmd && k === 'd') { e.preventDefault(); duplicateSel(); }
      else if (cmd && k === 'c') { clipboard.current = planRef.current.items.filter((i) => selRef.current.includes(i.id)); }
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeSel(); }
      else if (moves[k]) { e.preventDefault(); nudge(...moves[k]); }
      else if (k === 'r' && !cmd) { e.preventDefault(); rotateSel(e.shiftKey ? -45 : 45); }
      else if (k === 'escape') { setSel([]); setSelectMode(false); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const save = async () => {
    setBusy(true);
    try {
      const r = await call('venue.savePlan', { roomId: room.id, plan: planRef.current });
      const next = normalize(r.plan);
      setSaved(next); setPlan(next); keepSel(next);
      toast(t('floorPlan.floorPlanSaved'));
      onSaved?.(r);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const discard = () => { change(() => saved); keepSel(saved); };
  const stats = planStats(plan);
  const setSize = (k) => (e) => change((pl) => {
    const next = { ...pl, [k]: Math.max(200, Math.min(5000, Number(e.target.value) || 0)) };
    return { ...next, items: next.items.map((i) => fit(i, next)) };
  }, `size:${k}`);
  const seatsSel = chosen.reduce((n, i) => n + (Number(i.seats) || 0), 0);
  const handleR = single ? (coarse ? 15 : 9) * gz.unitsPerPx : 0;
  const zoneOfSel = chosenSeated.length && chosenSeated.every((i) => i.zone === chosenSeated[0].zone) ? chosenSeated[0].zone || '' : null;
  const sameSeats = chosenSeated.length && chosenSeated.every((i) => i.seats === chosenSeated[0].seats) ? chosenSeated[0].seats : '';
  const seatField = (value, onSet, key, label) => (
    <label className="field"><span>{label}</span>
      <div className="fp-stepper">
        <button type="button" className="btn sm icon" aria-label={t('floor.fewerSeats')} onClick={() => onSet(Math.max(0, (Number(value) || 0) - 1))}>−</button>
        <input className="input sm" type="number" min="0" max="40" inputMode="numeric" value={value} onChange={(e) => onSet(Math.max(0, Math.min(40, Number(e.target.value) || 0)), key)} />
        <button type="button" className="btn sm icon" aria-label={t('floor.moreSeats')} onClick={() => onSet(Math.min(40, (Number(value) || 0) + 1))}>+</button>
      </div>
    </label>
  );
  const zonePicker = (value, onPick) => (
    <label className="field"><span>{t('floor.zones.section')}</span>
      <select className="input sm" value={value ?? ''} onChange={(e) => (e.target.value === '+' ? addZone() : onPick(e.target.value))}>
        {value === null && <option value="" disabled>{t('floor.zones.mixed')}</option>}
        <option value="">{t('floor.zones.none')}</option>
        {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        <option value="+">{t('floor.zones.addNew')}</option>
      </select>
    </label>
  );

  return (
    <div className="col fp-edit" style={{ gap: 10 }}>
      <div className="fp-actions" role="toolbar" aria-label={t('common.edit')}>
        <button type="button" className="btn sm icon" title={t('floorPlan.undoCtrlZ')} aria-label={t('common.undo')} disabled={!history.current.past.length} onClick={undo}><FpIcon name="undo" /></button>
        <button type="button" className="btn sm icon" title={t('floorPlan.redoCtrlShiftZ')} aria-label={t('floorPlan.redo')} disabled={!history.current.future.length} onClick={redo}><FpIcon name="redo" /></button>
        <button type="button" className={`btn sm ${selectMode ? 'primary' : ''}`} aria-pressed={selectMode} onClick={() => setSelectMode(!selectMode)} title={t('floorPlan.pickSeveralItemsTapEach')}>
          <FpIcon name="select" /><span className="fp-hide-narrow">{selectMode ? t('common.done') : t('floorPlan.select')}</span>
        </button>
        <button type="button" className={`btn sm ${snapOn ? 'on' : ''}`} aria-pressed={snapOn} onClick={() => setSnapOn(!snapOn)} title={t('floor.snapTitle')}>
          <FpIcon name="magnet" /><span className="fp-hide-narrow">{snapOn ? t('floor.snapOn') : t('floor.snapOff')}</span>
        </button>
        {!coarse && <button type="button" className="btn sm icon ghost fp-hide-narrow" title={t('floor.keys.title')} aria-label={t('floor.keys.title')} onClick={() => setKeysOpen(true)}><FpIcon name="keyboard" /></button>}
        <span className="spacer" />
        {onImport && <button type="button" className="btn sm" data-act="import" aria-label={t('floor.importButton')} onClick={() => (dirty ? toast(t('floor.saveFirst'), 'bad') : onImport())}><Icon name="upload" /><span className="fp-hide-narrow">{t('floor.importButton')}</span></button>}
        {onExport && <button type="button" className="btn sm" data-act="export" aria-label={t('floor.exportButton')} onClick={() => onExport(planRef.current)}><Icon name="download" /><span className="fp-hide-narrow">{t('floor.exportButton')}</span></button>}
        {dirty ? <span className="badge warn fp-state">{t('floorPlan.unsaved')}</span> : <span className="badge ok fp-state">{t('common.saved')}</span>}
        <button type="button" className="btn sm primary" onClick={save} disabled={busy || !dirty}><Icon name="check" />{busy ? t('floorPlan.saving') : t('common.save')}</button>
      </div>
      <div className="fp-palette-wrap">
        <div className="seg fp-groups" role="tablist" aria-label={t('floorPlan.addToThePlan')}>
          {PRESET_GROUPS.map((g) => <button key={g} type="button" role="tab" aria-selected={group === g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{t(`floor.group.${g}`)}</button>)}
        </div>
        <div className="fp-palette" role="toolbar" aria-label={t('floorPlan.addToThePlan')}>
          {PRESETS.filter((p) => p.group === group).map((p) => (
            <button key={p.id} type="button" className="btn sm fp-add" onClick={() => add(p)} title={t('floorPlan.addLabel', { label: t(presetKey(p)).toLowerCase() })}><MiniShape preset={p} />{t(presetKey(p))}</button>
          ))}
        </div>
      </div>
      <div className="fp-editor">
        <div className="col" style={{ gap: 8, minWidth: 0 }}>
          <div className={`fp-stage ${selectMode ? 'selecting' : ''}`}>
            <FloorPlanView plan={plan} editing selected={selected} handleR={handleR} svgRef={svgRef} view={gz.view} handlers={gz.handlers}
              marquee={marquee} touchAction="none" showZones warnIds={warnIds} title={t('floorPlan.nameFloorPlan', { name: room.name })} />
            <ZoomControls gz={gz} />
          </div>
          <div className="fp-selbar" aria-live="polite">
            {sel.length ? <>
              <span className="fp-selcount">{t('floorPlan.bSelcountBSelected', { selCount: sel.length })}{seatsSel ? t('floorPlan.seatsselSeats', { seatsSel }) : ''}</span>
              <span className="spacer" />
              <button type="button" className="btn sm icon" title={t('floor.rotateLeft45')} aria-label={t('floorPlan.rotateLeft')} onClick={() => rotateSel(-45)}><Icon name="rotateLeft" /></button>
              <button type="button" className="btn sm icon" title={t('floor.rotateRight45')} aria-label={t('floorPlan.rotateRight')} onClick={() => rotateSel(45)}><Icon name="rotateRight" /></button>
              <button type="button" className="btn sm icon" title={t('floorPlan.duplicateCtrlD')} aria-label={t('floorPlan.duplicate')} onClick={duplicateSel}><Icon name="copy" /></button>
              <button type="button" className="btn sm icon danger" title={t('floorPlan.deleteDel')} aria-label={t('common.delete')} onClick={removeSel}><Icon name="trash" /></button>
              <button type="button" className="btn sm icon ghost" title={t('floorPlan.clearSelectionEsc')} aria-label={t('floorPlan.clearSelection')} onClick={() => { setSel([]); setSelectMode(false); }}><Icon name="x" /></button>
            </> : <span className="small muted">{selectMode ? t('floorPlan.tapItemsToPickThem') : coarse ? t('floorPlan.tapToSelectLongPress') : t('floorPlan.clickToSelectShiftClick')}</span>}
          </div>
          <div className="row wrap small muted">
            <span>{statsText(stats)}</span>
            {warnings.length > 0 && (
              <button type="button" className="btn sm ghost fp-warnbtn" onClick={() => setSel([...warnIds])} title={t('floor.overlapsHelp')}>
                <FpIcon name="alert" size={14} />{t('floor.overlaps', { count: warnings.length })}
              </button>
            )}
            <span className="spacer" />
            <span className="fp-size">
              <span>{t('floorPlan.roomSize')}</span>
              <input className="input sm" type="number" step="50" style={{ width: 80 }} value={plan.width} onChange={setSize('width')} aria-label={t('floorPlan.planWidth')} />
              <span>×</span>
              <input className="input sm" type="number" step="50" style={{ width: 80 }} value={plan.height} onChange={setSize('height')} aria-label={t('floorPlan.planHeight')} />
            </span>
          </div>
        </div>
        <div className="fp-panel col">
          {single ? <>
            <b>{ITEM_DEFS[single.type] && t(ITEM_DEFS[single.type].label)}</b>
            <label className="field"><span>{SEATED.has(single.type) && single.type !== 'bar' ? t('floor.tableNumber') : t('floorPlan.label')}</span>
              <input className="input sm" maxLength={40} value={single.label || ''} onChange={(e) => patch(single.id, { label: e.target.value }, `label:${single.id}`)} /></label>
            {SEATED.has(single.type) && seatField(single.seats || 0, (n, key) => patch(single.id, { seats: n }, key || `seats:${single.id}`), `seats:${single.id}`, single.type === 'bar' ? t('floorPlan.barStools') : t('floorPlan.seats'))}
            {SEATED.has(single.type) && single.type !== 'bar' && (
              <label className="field"><span>{t('floor.shape')}</span>
                <select className="input sm" value={single.type} onChange={(e) => setShape(e.target.value)}>
                  {TABLE_SHAPES.map((ty) => <option key={ty} value={ty}>{t(ITEM_DEFS[ty].label)}</option>)}
                </select>
              </label>
            )}
            {SEATED.has(single.type) && zonePicker(single.zone || '', setZoneSel)}
            <div className="grid2">
              <label className="field"><span>{t('floorPlan.width')}</span><input className="input sm" type="number" step="10" inputMode="numeric" value={single.w} onChange={(e) => patch(single.id, { w: Number(e.target.value) || 4 }, `w:${single.id}`)} /></label>
              <label className="field"><span>{t('floorPlan.depth')}</span><input className="input sm" type="number" step="10" inputMode="numeric" value={single.h} onChange={(e) => patch(single.id, { h: Number(e.target.value) || 4 }, `h:${single.id}`)} /></label>
            </div>
            <div className="small muted">{t('floor.rotationIs', { deg: single.r || 0 })}</div>
            {single.toastGuid && <div className="tiny muted">{t('floor.linkedToToast')}</div>}
          </> : sel.length > 1 ? <>
            <div className="small muted">{t('floorPlan.selcountItemsSelectedDragAny', { selCount: sel.length })}</div>
            <div className="field"><span>{t('floor.align')}</span>
              <div className="fp-align" role="group" aria-label={t('floor.align')}>
                {ALIGNS.map(([how, icon]) => <button key={how} type="button" className="btn sm icon" title={t(`floor.alignTo.${how}`)} aria-label={t(`floor.alignTo.${how}`)} onClick={() => align(how)}><FpIcon name={icon} /></button>)}
                <button type="button" className="btn sm icon" disabled={sel.length < 3} title={t('floor.alignTo.distH')} aria-label={t('floor.alignTo.distH')} onClick={() => align('distH')}><FpIcon name="distH" /></button>
                <button type="button" className="btn sm icon" disabled={sel.length < 3} title={t('floor.alignTo.distV')} aria-label={t('floor.alignTo.distV')} onClick={() => align('distV')}><FpIcon name="distV" /></button>
              </div>
            </div>
            {chosenSeated.length > 0 && seatField(sameSeats, (n, key) => patchSel((i) => (SEATED.has(i.type) ? { ...i, seats: n } : i), key || 'seats:many'), 'seats:many', t('floor.seatsEach'))}
            {chosenSeated.length > 0 && zonePicker(zoneOfSel, setZoneSel)}
            {chosenSeated.length > 0 && (numbering
              ? <div className="fp-renumber">
                <label className="field"><span>{t('floor.prefix')}</span><input className="input sm" maxLength={6} value={numbering.prefix} onChange={(e) => setNumbering({ ...numbering, prefix: e.target.value })} /></label>
                <label className="field"><span>{t('floor.startAt')}</span><input className="input sm" type="number" min="0" value={numbering.start} onChange={(e) => setNumbering({ ...numbering, start: e.target.value })} /></label>
                <div className="row"><button type="button" className="btn sm primary" onClick={() => renumberSel(numbering)}>{t('floor.renumberApply', { count: chosenSeated.length })}</button>
                  <button type="button" className="btn sm ghost" onClick={() => setNumbering(null)}>{t('common.cancel')}</button></div>
                <div className="tiny muted">{t('floor.renumberHelp')}</div>
              </div>
              : <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setNumbering({ prefix: 'T', start: 1 })}><FpIcon name="hash" />{t('floor.renumber')}</button>)}
          </> : <>
            <div className="small muted">{t('floor.emptyHelp')}</div>
            <div className="fp-zones">
              <div className="row"><b className="small">{t('floor.zones.title')}</b><span className="spacer" /><button type="button" className="btn sm ghost" onClick={addZone}><Icon name="plus" />{t('floor.zones.add')}</button></div>
              {!zones.length && <div className="tiny muted">{t('floor.zones.help')}</div>}
              {zones.map((z) => {
                const n = plan.items.filter((i) => i.zone === z.id);
                return (
                  <div key={z.id} className="fp-zone-row" style={{ '--mark': z.color }}>
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="fp-swatch" title={t('floor.zones.color')} aria-label={t('floor.zones.color')}
                        onClick={() => patchZone(z.id, { color: ZONE_COLORS[(ZONE_COLORS.indexOf(z.color) + 1) % ZONE_COLORS.length] })} />
                      <input className="input sm" maxLength={30} value={z.name} aria-label={t('floor.zones.name')} onChange={(e) => patchZone(z.id, { name: e.target.value }, `zone:${z.id}`)} />
                      <button type="button" className="btn sm icon ghost" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => removeZone(z.id)}><Icon name="x" size={14} /></button>
                    </div>
                    <button type="button" className="fp-zone-count" title={t('floor.zones.selectTables')} onClick={() => setSel(n.map((i) => i.id))}>
                      {t('floor.zones.tables', { count: n.length, seats: n.reduce((s, i) => s + (Number(i.seats) || 0), 0) })}
                    </button>
                  </div>
                );
              })}
            </div>
          </>}
          <div className="help">{coarse ? t('floorPlan.pinchToZoomTwoFingers') : t('floor.keysHint')}</div>
          {dirty && <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={discard} disabled={busy}>{t('floorPlan.discardChanges')}</button>}
        </div>
      </div>
      {keysOpen && (
        <Modal title={t('floor.keys.title')} onClose={() => setKeysOpen(false)}>
          <table className="fp-keys"><tbody>
            {SHORTCUTS.map(([k, label]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{t(label)}</td></tr>)}
          </tbody></table>
        </Modal>
      )}
    </div>
  );
}
