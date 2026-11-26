// Venue → Edit layout → Export: the layout as a PNG or PDF (table numbers, seats, sections) and every table as a CSV,
// with "Set this up in Toast": Toast doesn't let other apps create tables (docs/integrations/TOAST-FLOOR-PLAN.md),
// so this is the honest next best thing, a layout and a table list to build it in Toast Web, step by step.
// Plans are drawn by the same FloorPlanView as the app, in light colors, then copied onto a canvas.
import React, { useRef, useState } from 'react';
import { useApp, Icon, Modal } from '../ui.jsx';
import { useT, prettyDate } from '../i18n/index.js';
import { FloorPlanView, planStats, statsText, SEATED, ITEM_DEFS } from './FloorPlan.jsx';
import { downloadBlob } from './FloorImport.jsx';
import { planCsv, byLabel } from '../../../core/floor-plan.js';

// The light floor plan colors (web/src/venue.css), so an export looks the same in dark mode.
const LIGHT = {
  '--fp-floor': '#fbfaf7', '--fp-grid': '#ece9e2', '--fp-edge': '#d9d4c8', '--fp-table': '#ffffff', '--fp-table-line': '#8a7f6c', '--fp-seat': '#c9bfae',
  '--fp-bar': '#7a4f2a', '--fp-bar-top': '#a8743f', '--fp-stage': '#3b4256', '--fp-stage-2': '#4b5470', '--fp-dance-1': '#e9e4f7', '--fp-dance-2': '#d7cff0',
  '--fp-wall': '#374151', '--fp-plant': '#3f8f4f', '--fp-text': '#2b2b2b', '--fp-text-inv': '#ffffff', '--fp-select': '#4f46e5', '--fp-fixture': '#eef0f4', '--fp-kitchen': '#4b5563',
};
const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline'];
const safeName = (s) => String(s || 'floor-plan').replace(/[\\/:*?"<>|]+/g, '').trim() || 'floor-plan';

/** An SVG on the page → a standalone SVG string with its styles written in (so it draws the same as a picture). */
function standaloneSvg(svg, width, height) {
  const copy = svg.cloneNode(true);
  const from = [svg, ...svg.querySelectorAll('*')];
  const to = [copy, ...copy.querySelectorAll('*')];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    to[i].setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
  });
  copy.querySelectorAll('title').forEach((n) => n.remove());
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', width);
  copy.setAttribute('height', height);
  return new XMLSerializer().serializeToString(copy);
}

const loadImage = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });

/** A room's layout as a PNG canvas: its name, the plan, and its sections with their tables and seats. */
async function layoutCanvas(svg, { title, subtitle, plan, legend }) {
  const W = 2000, M = 48;
  const planW = W - 2 * M;
  const vb = svg.viewBox.baseVal;
  const planH = Math.round((planW * vb.height) / vb.width);
  const zones = plan.zones || [];
  const legendRows = zones.length ? Math.ceil(zones.length / 3) : 0;
  const H = M + 70 + 40 + planH + 30 + legendRows * 44 + 40 + M;
  const svgText = standaloneSvg(svg, planW, planH);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111827'; ctx.font = '700 44px system-ui, -apple-system, Segoe UI, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(title, M, M);
  ctx.fillStyle = '#4b5563'; ctx.font = '400 26px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(subtitle, M, M + 62);
  const top = M + 110;
  ctx.drawImage(img, M, top, planW, planH);
  let y = top + planH + 30;
  ctx.font = '600 26px system-ui, -apple-system, Segoe UI, sans-serif';
  zones.forEach((z, k) => {
    const col = k % 3, row = Math.floor(k / 3);
    const x = M + col * (planW / 3), yy = y + row * 44;
    ctx.fillStyle = z.color; ctx.fillRect(x, yy + 2, 26, 26);
    ctx.fillStyle = '#111827'; ctx.fillText(legend(z), x + 38, yy);
  });
  y += legendRows * 44 + 10;
  ctx.fillStyle = '#6b7280'; ctx.font = '400 20px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(legend(null), M, y);
  return canvas;
}

/** Only characters the PDF's standard font has (Latin-1); others become "?". */
const pdfText = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

export default function FloorExport({ room, rooms, onClose }) {
  const t = useT();
  const { settings, toast } = useApp();
  const [scope, setScope] = useState('room'); // 'room' | 'all'
  const [busy, setBusy] = useState('');
  const refs = useRef(new Map());
  const list = scope === 'all' ? rooms.map((r) => (r.id === room.id ? room : r)).filter((r) => r.plan?.items?.length) : [room];
  const today = prettyDate(new Date().toISOString().slice(0, 10));
  const subtitleOf = (r) => [settings.restaurantName, statsText(planStats(r.plan)), today].filter(Boolean).join(' · ');
  const legendOf = (r) => (z) => {
    if (!z) return t('floor.export.legendNote');
    const items = r.plan.items.filter((i) => i.zone === z.id);
    return t('floor.export.legendZone', { name: z.name, tables: items.map((i) => i.label).filter(Boolean).join(', ') || '—', seats: items.reduce((n, i) => n + (Number(i.seats) || 0), 0) });
  };
  const canvasOf = (r) => layoutCanvas(refs.current.get(r.id), { title: r.name, subtitle: subtitleOf(r), plan: r.plan, legend: legendOf(r) });
  const go = async (label, fn) => { setBusy(label); try { await fn(); } catch (e) { console.error(e); toast(t('floor.export.failed'), 'bad'); } finally { setBusy(''); } };

  const png = () => go('png', async () => {
    const canvas = await canvasOf(room);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    downloadBlob(blob, `${safeName(room.name)} floor plan.png`);
  });
  const csv = () => downloadBlob(new Blob([planCsv(list.map((r) => ({ name: r.name, plan: r.plan })))], { type: 'text/csv' }), `${safeName(scope === 'all' ? settings.restaurantName || 'tables' : room.name)} tables.csv`);
  const pdf = () => go('pdf', async () => {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const r of list) {
      const canvas = await canvasOf(r);
      const image = await doc.embedPng(canvas.toDataURL('image/png'));
      const page = doc.addPage([792, 612]);
      const k = Math.min((792 - 48) / image.width, (612 - 48) / image.height);
      page.drawImage(image, { x: (792 - image.width * k) / 2, y: (612 - image.height * k) / 2, width: image.width * k, height: image.height * k });
    }
    // The table list: what to set up in Toast, room by room.
    const cols = [[36, 'floor.export.colRoom'], [190, 'floor.export.colTable'], [290, 'floor.export.colSeats'], [350, 'floor.export.colShape'], [450, 'floor.export.colSection']];
    let page = null, y = 0;
    const newPage = () => {
      page = doc.addPage([612, 792]);
      y = 750;
      page.drawText(pdfText(t('floor.export.tableList')), { x: 36, y, size: 16, font: bold });
      y -= 26;
      cols.forEach(([x, key]) => page.drawText(pdfText(t(key)), { x, y, size: 10, font: bold, color: rgb(0.3, 0.3, 0.3) }));
      y -= 16;
    };
    newPage();
    for (const r of list) {
      const zones = new Map((r.plan.zones || []).map((z) => [z.id, z.name]));
      const seated = r.plan.items.filter((i) => SEATED.has(i.type)).sort(byLabel);
      for (const i of seated) {
        if (y < 40) newPage();
        const cells = [r.name, i.label || '—', String(i.seats || 0), t(ITEM_DEFS[i.type].label), zones.get(i.zone) || ''];
        cells.forEach((v, c) => page.drawText(pdfText(v).slice(0, c === 0 ? 26 : 22), { x: cols[c][0], y, size: 10, font }));
        y -= 15;
      }
      y -= 8;
    }
    const bytes = await doc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${safeName(scope === 'all' ? settings.restaurantName || 'floor plans' : room.name)} floor plan.pdf`);
  });

  const steps = ['1', '2', '3', '4', '5', '6', '7'];
  return (
    <Modal wide title={t('floor.export.title')} sub={t('floor.export.sub')} onClose={onClose}
      footer={<><span className="spacer" /><button type="button" className="btn" onClick={onClose}>{t('common.close')}</button></>}>
      <div className="col" style={{ gap: 14 }}>
        {rooms.length > 1 && (
          <div className="seg" role="tablist" aria-label={t('floor.export.which')}>
            <button type="button" role="tab" aria-selected={scope === 'room'} className={scope === 'room' ? 'on' : ''} onClick={() => setScope('room')}>{t('floor.export.thisRoom', { name: room.name })}</button>
            <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{t('floor.export.allRooms')}</button>
          </div>
        )}
        <div className="row wrap">
          {scope === 'room' && <button type="button" className="btn" disabled={!!busy} onClick={png}><Icon name="download" />{busy === 'png' ? t('floor.export.making') : t('floor.export.png')}</button>}
          <button type="button" className="btn" disabled={!!busy || !list.length} onClick={pdf}><Icon name="print" />{busy === 'pdf' ? t('floor.export.making') : t('floor.export.pdf')}</button>
          <button type="button" className="btn" disabled={!list.length} onClick={csv}><Icon name="download" />{t('floor.export.csv')}</button>
        </div>
        <div className="fp-toast-help col">
          <div className="row"><Icon name="alert" size={18} style={{ color: 'var(--warn)', flex: 'none' }} /><b>{t('floor.toastHelp.title')}</b></div>
          <p className="small" style={{ margin: 0 }}>{t('floor.toastHelp.honest')}</p>
          <ol className="small fp-steps">{steps.map((n) => <li key={n}>{t(`floor.toastHelp.step${n}`)}</li>)}</ol>
          <p className="tiny muted" style={{ margin: 0 }}>{t('floor.toastHelp.after')}</p>
        </div>
      </div>
      {/* The plans to draw from: off screen, in light colors. */}
      <div className="fp-export-src" aria-hidden="true" style={LIGHT}>
        {list.map((r) => <FloorPlanView key={r.id} plan={r.plan} showZones title={r.name} svgRef={(el) => { if (el) refs.current.set(r.id, el); else refs.current.delete(r.id); }} />)}
      </div>
    </Modal>
  );
}
