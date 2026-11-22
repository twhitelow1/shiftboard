// A room's floor plan, read only, drawn with react-native-svg from the same plan data the website uses
// (venue.get rooms[].plan: { width, height, items: [{ id, type, x, y, w, h, r, label, seats }] }). Server sections
// are drawn on it as colored halos with first names (marks): yours strong, coworkers' faded. The drawing follows
// web/src/pages/FloorPlan.jsx (Shape, Halo, NameTag); keep the two in step. "My tables" frames your tables, like
// the website's focus view; "Whole room" shows everything.
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import type { PlanItem } from '@/lib/types';
import { Segmented, useColors } from './ui';

export const SEATED = new Set(['table-round', 'table-square', 'table-rect', 'booth', 'bar']);
const DARK = new Set(['bar', 'stage', 'dj']);
const PAD = 24;

export interface Mark { color: string; name: string; strong?: boolean; faded?: boolean }
type Plan = { width: number; height: number; items: PlanItem[] };
type Box = { x: number; y: number; w: number; h: number };

function fpColors(dark: boolean) {
  return dark
    ? { floor: '#141b2d', grid: '#1d263c', edge: '#2f3f63', table: '#1f2a44', line: '#8fa0c4', seat: '#3a4a6e', bar: '#6b4423', barTop: '#8c5a2e', stage: '#2a3147', stage2: '#3a4360', dance1: '#2a2650', dance2: '#36306a', wall: '#aab5cb', plant: '#4caf63', text: '#e6ebf5' }
    : { floor: '#fbfaf7', grid: '#ece9e2', edge: '#d9d4c8', table: '#ffffff', line: '#8a7f6c', seat: '#c9bfae', bar: '#7a4f2a', barTop: '#a8743f', stage: '#3b4256', stage2: '#4b5470', dance1: '#e9e4f7', dance2: '#d7cff0', wall: '#374151', plant: '#3f8f4f', text: '#2b2b2b' };
}
type FP = ReturnType<typeof fpColors>;

const spread = (n: number, len: number) => Array.from({ length: n }, (_, i) => -len / 2 + (len * (i + 0.5)) / n);
function seatPositions(it: PlanItem): [number, number][] {
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
  if (it.type === 'bar') return w >= h ? spread(n, w * 0.92).map((x) => [x, h / 2 + off]) : spread(n, h * 0.92).map((y) => [w / 2 + off, y]);
  const c = { top: 0, bottom: 0, left: 0, right: 0 };
  if (it.type === 'table-square') {
    (['top', 'bottom', 'left', 'right'] as const).forEach((s, i) => { c[s] = Math.floor(n / 4) + (i < n % 4 ? 1 : 0); });
  } else {
    const ends = n >= 6 ? 1 : 0;
    const rest = n - 2 * ends;
    if (w >= h) { c.top = Math.ceil(rest / 2); c.bottom = Math.floor(rest / 2); c.left = c.right = ends; } else { c.left = Math.ceil(rest / 2); c.right = Math.floor(rest / 2); c.top = c.bottom = ends; }
  }
  return [
    ...spread(c.top, w).map((x) => [x, -h / 2 - off] as [number, number]),
    ...spread(c.bottom, w).map((x) => [x, h / 2 + off] as [number, number]),
    ...spread(c.left, h).map((y) => [-w / 2 - off, y] as [number, number]),
    ...spread(c.right, h).map((y) => [w / 2 + off, y] as [number, number]),
  ];
}

function Shape({ it, fp }: { it: PlanItem; fp: FP }) {
  const { w, h } = it;
  const x0 = -w / 2, y0 = -h / 2;
  const seats = seatPositions(it).map(([x, y], i) => <Circle key={i} cx={x} cy={y} r={8} fill={fp.seat} stroke={fp.line} strokeWidth={1} />);
  const table = { fill: fp.table, stroke: fp.line, strokeWidth: 2 };
  switch (it.type) {
    case 'table-round':
      return <G>{seats}<Ellipse rx={w / 2} ry={h / 2} {...table} /></G>;
    case 'table-square':
    case 'table-rect':
      return <G>{seats}<Rect x={x0} y={y0} width={w} height={h} rx={6} {...table} /></G>;
    case 'booth': {
      const b = Math.min(16, w / 4, h / 3);
      const bench = { fill: fp.seat, stroke: fp.line, strokeWidth: 1.5, rx: 4 };
      return (
        <G>
          <Rect x={x0} y={y0} width={w} height={b} {...bench} />
          <Rect x={x0} y={y0} width={b} height={h} {...bench} />
          <Rect x={x0 + w - b} y={y0} width={b} height={h} {...bench} />
          <Rect x={x0 + b + 6} y={y0 + b + 6} width={Math.max(4, w - 2 * b - 12)} height={Math.max(4, h - b - 10)} rx={4} {...table} />
        </G>
      );
    }
    case 'bar': {
      const rx = Math.min(w, h) / 2;
      return <G>{seats}<Rect x={x0} y={y0} width={w} height={h} rx={rx} fill={fp.bar} /><Rect x={x0 + 5} y={y0 + 5} width={Math.max(2, w - 10)} height={Math.max(2, h - 10)} rx={Math.max(0, rx - 5)} fill="none" stroke={fp.barTop} strokeWidth={3} /></G>;
    }
    case 'stage':
      return <Rect x={x0} y={y0} width={w} height={h} rx={4} fill={fp.stage} stroke={fp.stage2} strokeWidth={3} />;
    case 'dancefloor':
      return <Rect x={x0} y={y0} width={w} height={h} fill={fp.dance1} stroke={fp.dance2} strokeWidth={2} />;
    case 'dj': {
      const r = Math.max(3, Math.min(w / 4, h / 2) * 0.6);
      return <G><Rect x={x0} y={y0} width={w} height={h} rx={6} fill={fp.stage} /><Circle cx={-w / 4} cy={0} r={r} fill="none" stroke={fp.stage2} strokeWidth={2.5} /><Circle cx={w / 4} cy={0} r={r} fill="none" stroke={fp.stage2} strokeWidth={2.5} /></G>;
    }
    case 'host':
      return <Rect x={x0} y={y0} width={w} height={h} rx={4} fill={fp.table} stroke={fp.wall} strokeWidth={2} />;
    case 'wall':
      return <Rect x={x0} y={y0} width={w} height={h} fill={fp.wall} />;
    case 'door':
      return <G><Path d={`M ${x0} ${y0} A ${w} ${h} 0 0 1 ${x0 + w} ${y0 + h}`} fill="none" stroke={fp.wall} strokeWidth={2} strokeDasharray="5 4" /><Line x1={x0} y1={y0 + h} x2={x0} y2={y0} stroke={fp.wall} strokeWidth={3} /></G>;
    case 'plant': {
      const r = Math.min(w, h) / 2;
      return <G><Circle r={r} fill={fp.plant} opacity={0.35} /><Circle r={r * 0.6} fill={fp.plant} /></G>;
    }
    default:
      return null;
  }
}

function Halo({ it, mark }: { it: PlanItem; mark: Mark }) {
  const grow = it.seats && it.type !== 'booth' ? 22 : 9;
  const fillOpacity = mark.faded ? 0.1 : mark.strong ? 0.45 : 0.3;
  const stroke = { stroke: mark.color, strokeWidth: mark.faded ? 2 : mark.strong ? 5 : 3, strokeOpacity: mark.faded ? 0.35 : 1, fill: mark.color, fillOpacity };
  if (it.type === 'table-round') return <Ellipse rx={it.w / 2 + grow} ry={it.h / 2 + grow} {...stroke} />;
  return <Rect x={-it.w / 2 - grow} y={-it.h / 2 - grow} width={it.w + 2 * grow} height={it.h + 2 * grow} rx={14} {...stroke} />;
}

function NameTag({ x, y, mark }: { x: number; y: number; mark: Mark }) {
  const text = String(mark.name || '').slice(0, 12);
  const w = Math.max(28, text.length * 8.4 + 14);
  return (
    <G opacity={mark.faded ? 0.55 : 1}>
      <Rect x={x - w / 2} y={y - 11} width={w} height={22} rx={11} fill={mark.color} stroke="#fff" strokeWidth={1.5} />
      <SvgText x={x} y={y + 4.5} fill="#fff" fontSize={13} fontWeight="700" textAnchor="middle">{text}</SvgText>
    </G>
  );
}

const fitBox = (plan: Plan): Box => ({ x: -PAD, y: -PAD, w: (plan.width || 1000) + PAD * 2, h: (plan.height || 700) + PAD * 2 });
/** Frames some items (zoomed in at most 2.5×), like the website's focus view. */
function focusBox(plan: Plan, ids: string[]): Box {
  const fit = fitBox(plan);
  const items = plan.items.filter((i) => ids.includes(i.id));
  if (!items.length) return fit;
  const m = 90;
  const x0 = Math.min(...items.map((i) => i.x)) - m, y0 = Math.min(...items.map((i) => i.y)) - m;
  const x1 = Math.max(...items.map((i) => i.x + i.w)) + m, y1 = Math.max(...items.map((i) => i.y + i.h)) + m;
  const w = Math.min(fit.w, Math.max(fit.w / 2.5, x1 - x0, ((y1 - y0) * fit.w) / fit.h));
  const h = (w * fit.h) / fit.w;
  return { w, h, x: Math.max(fit.x, Math.min(fit.x + fit.w - w, (x0 + x1) / 2 - w / 2)), y: Math.max(fit.y, Math.min(fit.y + fit.h - h, (y0 + y1) / 2 - h / 2)) };
}

export function FloorPlan({ plan, marks, focus = [], title, labels }: {
  plan: Plan; marks: Map<string, Mark>; focus?: string[]; title: string; labels: { mine: string; room: string };
}) {
  const c = useColors();
  const fp = fpColors(c.dark);
  const [mode, setMode] = useState<'mine' | 'room'>(focus.length ? 'mine' : 'room');
  const vb = mode === 'mine' && focus.length ? focusBox(plan, focus) : fitBox(plan);
  const W = plan.width || 1000, H = plan.height || 700;
  const grid: number[] = [];
  for (let x = 50; x < W; x += 50) grid.push(x);
  const gridY: number[] = [];
  for (let y = 50; y < H; y += 50) gridY.push(y);
  return (
    <View style={{ gap: 8 }}>
      {focus.length ? <Segmented value={mode} onChange={setMode} options={[{ value: 'mine', label: labels.mine }, { value: 'room', label: labels.room }]} /> : null}
      <View style={{ borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: fp.edge, backgroundColor: fp.floor }} accessible accessibilityRole="image" accessibilityLabel={title}>
        <Svg width="100%" style={{ aspectRatio: vb.w / vb.h }} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}>
          <Rect x={-PAD} y={-PAD} width={W + PAD * 2} height={H + PAD * 2} fill={fp.floor} />
          {grid.map((x) => <Line key={`x${x}`} x1={x} y1={0} x2={x} y2={H} stroke={fp.grid} strokeWidth={1.5} />)}
          {gridY.map((y) => <Line key={`y${y}`} x1={0} y1={y} x2={W} y2={y} stroke={fp.grid} strokeWidth={1.5} />)}
          <Rect x={0} y={0} width={W} height={H} fill="none" stroke={fp.edge} strokeWidth={2} />
          {plan.items.map((it) => {
            const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
            const mark = marks.get(it.id);
            const withTag = !!mark?.name && it.h >= 40;
            const big = it.type === 'label' || it.type === 'stage' || it.type === 'dancefloor';
            return (
              <G key={it.id}>
                <G transform={`translate(${cx} ${cy}) rotate(${it.r || 0})`}>
                  {mark ? <Halo it={it} mark={mark} /> : null}
                  <Shape it={it} fp={fp} />
                </G>
                {it.label && it.type !== 'wall' ? (
                  <SvgText x={cx} y={(it.type === 'door' ? cy + it.h / 2 + 14 : withTag ? cy - 11 : cy) + (big ? 7 : 5)} textAnchor="middle"
                    fill={DARK.has(it.type) ? '#ffffff' : fp.text} fontSize={big ? 20 : 15} fontWeight={big ? '700' : '600'}>{it.label}</SvgText>
                ) : null}
                {withTag ? <NameTag x={cx} y={it.label ? cy + 12 : cy} mark={mark!} /> : null}
              </G>
            );
          })}
        </Svg>
      </View>
    </View>
  );
}

// ---------- server sections → marks ----------
const COLORS = ['#6366f1', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0f766e', '#db2777', '#2563eb', '#65a30d', '#f59e0b', '#84cc16', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444', '#0ea5e9', '#f97316'];
const OPEN = '#64748b';
/** The same color the website gives someone without one (web/src/ui.jsx colorFor). */
export function colorFor(id = '') {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLORS.slice(0, 10)[Math.abs(h) % 10];
}

/** Marks for a room's sections: each person's color (or a free one if someone else in the room has it). */
export function sectionMarks(
  entries: { shiftId: string; userId: string | null; tableIds: string[] }[],
  people: Record<string, { name: string; color?: string } | undefined>,
  { mine, you, open }: { mine: (e: { shiftId: string; userId: string | null }) => boolean; you: string; open: string },
): Map<string, Mark> {
  const used = new Set<string>();
  const colors = new Map<string, string>();
  for (const e of entries) {
    let col = e.userId ? people[e.userId]?.color || colorFor(e.userId) : OPEN;
    if (e.userId && used.has(col)) col = COLORS.find((x) => !used.has(x)) || col;
    used.add(col);
    colors.set(e.shiftId, col);
  }
  const marks = new Map<string, Mark>();
  for (const e of entries) {
    const me = mine(e);
    const name = me ? you : e.userId ? (people[e.userId]?.name || '').trim().split(/\s+/)[0] : open;
    for (const t of e.tableIds) marks.set(t, { color: colors.get(e.shiftId)!, name, strong: me, faded: !me });
  }
  return marks;
}
