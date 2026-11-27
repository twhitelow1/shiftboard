// Copy & paste a shift on the schedule (managers): copy one shift (the chip's copy icon, the quick dialog's Copy, or
// Ctrl/Cmd+C on a selected cell), then paste it into person × day cells (a cell's Paste on hover, the quick dialog's
// "Paste copied shift", or Ctrl/Cmd+V on the selected cells). A paste is a new draft for that row's person on that
// day with the copied times, tag and notes (core/shift-paste.js, shifts.pasteMany). Over a shift it asks "Replace or
// add another?"; a day off, approved time off, an unavailable day or a position the person doesn't hold yet is asked
// first too. The last paste can be undone. The copied shift is kept in sessionStorage for this tab's session.
//
// Cells register as they render (sheet and grid each have a scope): their row and column make the selection a range
// in one row or one column (Shift+click, or drag).
import React, { useEffect, useRef, useState } from 'react';
import { useApp, Modal, Icon, useAction, shiftTime } from '../ui.jsx';
import { useT, fmtTime, prettyDate } from '../i18n/index.js';
import '../shift-paste.css';

const KEY = 'sb_shift_clip';
function readClip() { try { const v = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return v && v.start ? v : null; } catch { return null; } }
function writeClip(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch { /* private mode: kept for this page only */ } }

/** "4:00 PM – Close" */
export const clipTime = (c, t) => `${fmtTime(c.start)} – ${c.end ? fmtTime(c.end) : t('shiftPaste.close')}`;

const inRange = (sel, scope, row, col) => {
  if (!sel || sel.scope !== scope) return false;
  const { a, b } = sel;
  if (a.row === b.row) return row === a.row && col >= Math.min(a.col, b.col) && col <= Math.max(a.col, b.col);
  if (a.col === b.col) return col === a.col && row >= Math.min(a.row, b.row) && row <= Math.max(a.row, b.row);
  return row === b.row && col === b.col;
};
const isTyping = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '') || !!el?.isContentEditable;

export function useShiftPaste({ enabled }) {
  const t = useT();
  const { call, toast } = useApp();
  const [run, busy] = useAction();
  const [clip, setClipState] = useState(() => (enabled ? readClip() : null));
  const [sel, setSel] = useState(null); // { scope, a: { row, col }, b: { row, col } }
  const [ask, setAsk] = useState(null); // { targets, opts, needs, skipped }
  const [undo, setUndo] = useState(null); // { items }
  const reg = useRef({}); // scope → { rows: Map(rowKey → index), cells: Map('row|col' → { row, col, target, shifts }) }
  const drag = useRef(null);
  const skipClick = useRef(false);
  const live = useRef({});

  const setClip = (v) => { setClipState(v); writeClip(v); };
  const copy = (s) => {
    setClip({ id: s.id, userId: s.userId || null, date: s.date, start: s.start, end: s.end || null, tag: s.tag || '', notes: s.notes || '', jobCodeId: s.jobCodeId, area: s.area || '', breakMin: s.breakMin || 0 });
    toast(t('shiftPaste.copiedToast'));
  };
  const begin = (scope) => { reg.current[scope] = { rows: new Map(), cells: new Map() }; };
  const selectedCells = (s = sel) => (s ? [...(reg.current[s.scope]?.cells.values() || [])].filter((c) => inRange(s, s.scope, c.row, c.col)) : []);
  const findShift = (id) => Object.values(reg.current).flatMap((r) => [...r.cells.values()].flatMap((c) => c.shifts || [])).find((s) => s.id === id);

  const finish = (r) => {
    if (r.skipped?.length) for (const x of r.skipped) toast(t('shiftPaste.skipped', { name: nameOf(x.userId), position: jobName(x.jobCodeId) }), 'bad');
    if (r.items?.length) setUndo({ items: r.items, created: r.created, replaced: r.replaced, at: Date.now() });
    setSel(null);
  };
  const pasteInto = async (targets, opts = {}) => {
    if (!clip || !targets.length) return;
    const r = await run(() => call('shifts.pasteMany', { fromId: clip.id, from: clip, targets, ...opts }));
    if (!r) return;
    if (!r.done) setAsk({ targets, opts, needs: r.needs, skipped: r.skipped || [] });
    else finish(r);
  };
  const doUndo = async () => {
    const items = undo?.items || [];
    setUndo(null);
    await run(async () => {
      for (const it of [...items].reverse()) {
        if (it.status === 'created') await call('shifts.delete', { id: it.shift.id });
        else if (it.before) await call('shifts.save', { ...it.before });
      }
    }, t('shiftPaste.undone'));
  };
  useEffect(() => { if (!undo) return undefined; const id = setTimeout(() => setUndo(null), 15000); return () => clearTimeout(id); }, [undo]);

  // Helpers the ask dialog and toasts need: names from bootstrap.
  const app = useApp();
  const nameOf = (id) => app.people?.[id]?.name || '';
  const jobName = (id) => app.jobs?.[id]?.name || '';

  live.current = { clip, sel, enabled, busy };
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      const { clip: c, sel: s, busy: b } = live.current;
      if (document.querySelector('.overlay')) return; // a dialog is open
      if (e.key === 'Escape' && s) { setSel(null); return; }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const k = String(e.key).toLowerCase();
      if (k === 'c') {
        if (String(window.getSelection?.() || '')) return; // copying text
        const chip = document.activeElement?.closest?.('[data-shift-id]');
        let shift = chip ? findShift(chip.getAttribute('data-shift-id')) : null;
        if (!shift) { const cells = selectedCells(s); if (cells.length === 1) shift = cells[0].shifts?.[0]; }
        if (!shift) return;
        e.preventDefault();
        copy(shift);
      } else if (k === 'v') {
        const cells = selectedCells(s).filter((x) => x.target);
        if (!c || !cells.length || b) return;
        e.preventDefault();
        pasteInto(cells.map((x) => x.target));
      }
    };
    const onUp = () => setTimeout(() => { drag.current = null; skipClick.current = false; }, 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onUp); };
  });

  /**
   * A cell: scope ('sheet' | 'grid'), rowKey (unique per row in that scope), col (day index), target ({ userId, date,
   * jobCodeId?, area? }, null when nobody's row), shifts (the cell's, for Ctrl+C). Returns { selected, props, pasteButton(empty) }.
   */
  const cell = (scope, rowKey, col, target, shifts = []) => {
    if (!enabled) return { selected: false, props: {}, pasteButton: () => null };
    const r = reg.current[scope] || (begin(scope), reg.current[scope]);
    if (!r.rows.has(rowKey)) r.rows.set(rowKey, r.rows.size);
    const row = r.rows.get(rowKey);
    r.cells.set(`${row}|${col}`, { row, col, target, shifts });
    const here = { row, col };
    const selected = inRange(sel, scope, row, col);
    const multi = selected && (sel.a.row !== sel.b.row || sel.a.col !== sel.b.col);
    const head = selected && sel.b.row === row && sel.b.col === col; // a range shows its Paste on the cell it ends on (and on hover)
    const span = multi ? (sel.a.row === sel.b.row ? Math.abs(sel.a.col - sel.b.col) : Math.abs(sel.a.row - sel.b.row)) + 1 : 1;
    const props = {
      'data-pcell': '',
      tabIndex: target ? 0 : undefined,
      onMouseDown: (e) => {
        if (e.button !== 0 || e.target.closest?.('.paste-btn, .copy-btn')) return;
        if (e.shiftKey && sel?.scope === scope) { e.preventDefault(); skipClick.current = true; setSel({ scope, a: sel.a, b: here }); return; }
        drag.current = { scope, a: here, moved: false };
        setSel({ scope, a: here, b: here });
      },
      onMouseEnter: (e) => {
        const d = drag.current;
        if (!d || d.scope !== scope || !(e.buttons & 1) || (d.a.row === row && d.a.col === col)) return;
        if (d.a.row !== row && d.a.col !== col) return; // one row or one column
        d.moved = true;
        setSel({ scope, a: d.a, b: here });
      },
      onClickCapture: (e) => { if (skipClick.current || drag.current?.moved) { e.stopPropagation(); e.preventDefault(); } },
      onFocus: (e) => { if (e.target === e.currentTarget && !selected) setSel({ scope, a: here, b: here }); },
    };
    const pasteButton = (empty) => (clip && target && empty ? (
      <button type="button" className={`paste-btn no-print ${multi && !head ? 'pm' : ''}`} title={t('shiftPaste.pasteTitle')} disabled={busy}
        onClick={(e) => { e.stopPropagation(); pasteInto(multi ? selectedCells().filter((x) => x.target).map((x) => x.target) : [target]); }}>
        <Icon name="copy" size={12} />{multi ? t('shiftPaste.pasteSelected', { count: span }) : t('shiftPaste.paste')}
      </button>
    ) : null);
    return { selected, props, pasteButton };
  };

  const copyButton = (s, i = 0) => (enabled && s?.id ? (
    <button type="button" className="copy-btn no-print" style={i ? { right: 2 + i * 20 } : undefined} title={t('shiftPaste.copyTitle')} aria-label={t('shiftPaste.copyShift')}
      onClick={(e) => { e.stopPropagation(); copy(s); }}><Icon name="copy" size={12} /></button>
  ) : null);

  const selCount = selectedCells().filter((x) => x.target).length;
  const pill = enabled && clip ? (
    <div className="paste-pill no-print" role="status">
      <Icon name="copy" size={14} />
      <span className="paste-pill-main"><b>{t('shiftPaste.copied')}</b> {clipTime(clip, t)}{clip.jobCodeId && jobName(clip.jobCodeId) ? ` · ${jobName(clip.jobCodeId)}` : ''}{clip.tag ? ` · ${clip.tag}` : ''}
        <span className="faint small"> {clip.userId ? t('shiftPaste.from', { name: nameOf(clip.userId), date: prettyDate(clip.date) }) : t('shiftPaste.fromOpen', { date: prettyDate(clip.date) })}</span></span>
      {selCount > 1 && <button type="button" className="btn sm primary" disabled={busy} onClick={() => pasteInto(selectedCells().filter((x) => x.target).map((x) => x.target))}>{t('shiftPaste.pasteSelected', { count: selCount })}</button>}
      <span className="paste-pill-hint small faint desktop-only">{t('shiftPaste.hint')}</span>
      <button type="button" className="btn icon sm ghost" onClick={() => { setClip(null); setSel(null); }} title={t('shiftPaste.clear')} aria-label={t('shiftPaste.clear')}><Icon name="x" size={14} /></button>
    </div>
  ) : null;

  const overlays = enabled ? (
    <>
      {undo && (
        <div className="paste-undo no-print" role="status">
          <span>{[undo.created ? t('shiftPaste.pasted', { count: undo.created }) : '', undo.replaced ? t('shiftPaste.replacedCount', { count: undo.replaced }) : ''].filter(Boolean).join(' · ')}</span>
          <button type="button" className="btn sm" onClick={doUndo} disabled={busy}>{t('shiftPaste.undo')}</button>
          <button type="button" className="btn icon sm ghost" onClick={() => setUndo(null)} aria-label={t('shiftPaste.dismiss')}><Icon name="x" size={14} /></button>
        </div>
      )}
      {ask && <PasteAsk ask={ask} busy={busy} nameOf={nameOf} jobName={jobName} onClose={() => setAsk(null)}
        onGo={(mode) => {
          const occ = new Map(ask.needs.occupied.map((o) => [`${o.userId}|${o.date}`, o]));
          const targets = ask.targets.map((tg) => {
            const o = occ.get(`${tg.userId}|${tg.date}`);
            if (!o) return tg;
            const first = [...o.shifts].sort((a, b) => a.start.localeCompare(b.start))[0];
            return mode === 'replace' ? { ...tg, replaceId: first.id } : { ...tg, add: true };
          });
          const opts = { ...ask.opts, givePosition: true, confirmOff: true };
          setAsk(null);
          pasteInto(targets, opts);
        }} />}
    </>
  ) : null;

  return { enabled, clip, copy, begin, cell, copyButton, pasteInto, pill, overlays, clear: () => setClip(null) };
}

/** "Before pasting": the shifts already there (Replace or add another?), positions they'd get, days off and time off. */
function PasteAsk({ ask, busy, nameOf, jobName, onClose, onGo }) {
  const t = useT();
  const { occupied = [], position = [], off = [] } = ask.needs;
  const day = (d) => prettyDate(d);
  return (
    <Modal title={t('shiftPaste.askTitle')} onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        {occupied.length > 0 ? <>
          <button className="btn" disabled={busy} onClick={() => onGo('add')}><Icon name="plus" />{t('shiftPaste.addAnother')}</button>
          <button className="btn primary" disabled={busy} onClick={() => onGo('replace')} autoFocus><Icon name="swap" />{t('shiftPaste.replace')}</button>
        </> : <button className="btn primary" disabled={busy} onClick={() => onGo('add')} autoFocus>{t('shiftPaste.pasteAnyway')}</button>}
      </>}>
      {occupied.length > 0 && (
        <div className="paste-ask-group">
          <div style={{ fontWeight: 700 }}>{t('shiftPaste.replaceOrAdd')}</div>
          {occupied.map((o) => <div key={`${o.userId}|${o.date}`} className="small">{t('shiftPaste.occupied', { name: nameOf(o.userId), date: day(o.date), time: o.shifts.map((s) => `${shiftTime(s)}${s.tag ? ` ${s.tag}` : ''}`).join(', ') })}</div>)}
          <div className="help">{t('shiftPaste.replaceHelp')}</div>
        </div>
      )}
      {position.map((p) => <div key={`p${p.userId}|${p.date}`} className="alert warn"><Icon name="alert" size={16} /><span>{t('shiftPaste.position', { name: nameOf(p.userId), position: jobName(p.jobCodeId), room: p.room || '—' })}</span></div>)}
      {off.map((o) => <div key={`o${o.userId}|${o.date}`} className="alert warn"><Icon name="sun" size={16} /><span>{o.codes.map((c) => t(`shiftPaste.${c}`, { name: nameOf(o.userId), date: day(o.date) })).join(' ')}</span></div>)}
      {ask.skipped.map((x) => <div key={`s${x.userId}|${x.date}`} className="small faint">{t('shiftPaste.skipped', { name: nameOf(x.userId), position: jobName(x.jobCodeId) })}</div>)}
    </Modal>
  );
}
