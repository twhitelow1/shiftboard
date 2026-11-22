// The 86 List: what's out ("86'd") or running low, list by list, with the bar's lists apart from the rest.
// Routes: #/86 (the lists) | #/86/history (managers: the log and what was 86'd most).
// Also used elsewhere: the banner on the Schedule's day view and My Shifts (EightySixBanner), and the summary
// Training reads for its "86'd today" badge (useEightySix). Who may see, report and clear is checked on the server
// (core/eighty-six.js); this page only hides buttons that wouldn't work.
import React, { useEffect, useRef, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty } from '../ui.jsx';
import { nowDate } from '../api.js';
import { sameArea } from '../../../core/areas.js';
import { categoryLabel } from '../../../core/training.js';
import { useT, fmtTime, stamp } from '../i18n/index.js';
import '../eightysix.css';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** A list's or an item's name in the reader's language (the Spanish one where there is one). */
export const listName = (l, lang) => (lang === 'es' && l?.nameEs ? l.nameEs : l?.name || '');
const itemName = (it, lang) => (lang === 'es' && it?.nameEs ? it.nameEs : it?.name || '');
const barFirst = (a, b) => (a.kind === 'bar' ? 0 : 1) - (b.kind === 'bar' ? 0 : 1);

/** '12 min ago' · 'hace 12 min'. */
export function ago(t, iso, now = nowDate()) {
  const min = Math.floor((now - new Date(iso)) / 60000);
  if (!(min >= 1)) return t('eightySix.justNow');
  if (min < 60) return t('eightySix.minAgo', { count: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('eightySix.hoursAgo', { count: h });
  return t('eightySix.daysAgo', { count: Math.floor(h / 24) });
}
/** How long something was out: '45 min', '3 h', '2 days'. */
function duration(t, from, to) {
  const min = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
  if (min < 60) return t('eightySix.durMin', { count: min });
  if (min < 48 * 60) return t('eightySix.durHours', { count: Math.round(min / 60) });
  return t('eightySix.durDays', { count: Math.round(min / 1440) });
}

/** What's out and low on the lists this person can see (null while loading). */
export function useEightySix() {
  const { call, version } = useApp();
  const [s, setS] = useState(null);
  useEffect(() => {
    let live = true;
    call('eightySix.summary').then((r) => { if (live) setS(r); }).catch(() => {});
    return () => { live = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

/** "Bar: 3 out · Kitchen: 1 out", linking to the 86 List. Nothing when nothing's out or low. */
export function EightySixBanner({ className = '' }) {
  const t = useT();
  const s = useEightySix();
  const lists = (s?.lists || []).filter((l) => l.out || l.low).sort(barFirst);
  if (!lists.length) return null;
  return (
    <a className={`e86-banner ${className}`} href="#/86">
      <span className="e86-tag">86</span>
      <span className="e86-banner-text">
        {lists.map((l, i) => (
          <span key={l.id}>{i > 0 && <span className="faint"> · </span>}<b>{listName(l, t.lang)}:</b>{' '}
            {[l.out && t('eightySix.nOut', { count: l.out }), l.low && t('eightySix.nLow', { count: l.low })].filter(Boolean).join(', ')}</span>
        ))}
      </span>
      <Icon name="right" size={16} />
    </a>
  );
}

export default function EightySix({ parts = [] }) {
  const t = useT();
  const { call, version, toast, isMgr, refresh } = useApp();
  const [board, setBoard] = useState(null);
  const [focus, setFocus] = useState('');
  const [dialog, setDialog] = useState(null); // { listId } or { item }
  const [undo, setUndo] = useState([]); // just cleared: [{ id, name, listId }]
  const tab = isMgr && parts[1] === 'history' ? 'history' : 'lists';
  useEffect(() => { call('eightySix.board.get').then(setBoard).catch((e) => toast(e.message, 'bad')); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async (it) => {
    try {
      await call('eightySix.clear', { id: it.id });
      setUndo((u) => [...u, { id: it.id, name: itemName(it, t.lang), listId: it.listId }]);
      setTimeout(() => setUndo((u) => u.filter((x) => x.id !== it.id)), 10000);
    } catch (e) { toast(e.message, 'bad'); }
    refresh();
  };
  const restore = async (u) => {
    setUndo((x) => x.filter((y) => y.id !== u.id));
    try { await call('eightySix.restore', { id: u.id }); } catch (e) { toast(e.message, 'bad'); }
    refresh();
  };

  return (
    <div className="e86">
      {isMgr && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'lists'} className={tab === 'lists' ? 'on' : ''} onClick={() => { location.hash = '#/86'; }}><Icon name="ban" size={16} />{t('eightySix.tabLists')}</button>
          <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => { location.hash = '#/86/history'; }}><Icon name="clock" size={16} />{t('eightySix.tabHistory')}</button>
        </div>
      )}
      {tab === 'history' ? <History /> : !board ? <div className="empty">{t('common.loading')}</div> : (
        <Board board={board} focus={focus} setFocus={setFocus} undo={undo}
          onReport={(listId) => setDialog({ listId })} onEdit={(item) => setDialog({ item })} onClear={clear} onUndo={restore} />
      )}
      {dialog && board && <ReportDialog board={board} start={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
    </div>
  );
}

function Board({ board, focus, setFocus, undo, onReport, onEdit, onClear, onUndo }) {
  const t = useT();
  const all = [...board.lists].sort(barFirst);
  const shown = focus ? all.filter((l) => l.id === focus) : all;
  const bar = shown.filter((l) => l.kind === 'bar');
  const floor = shown.filter((l) => l.kind !== 'bar');
  const card = (l) => <ListCard key={l.id} list={l} undo={undo.filter((u) => u.listId === l.id)} onReport={onReport} onEdit={onEdit} onClear={onClear} onUndo={onUndo} />;
  return (
    <>
      <div className="e86-head">
        <div className="e86-head-text">
          <h2>{t('eightySix.whatsOut')}</h2>
          <div className="small muted">{t('eightySix.intro')}</div>
        </div>
        {board.canReport && (
          <button className="btn primary e86-report" onClick={() => onReport(all.find((l) => l.id === focus && l.canReport)?.id || '')}>
            <Icon name="plus" />{t('eightySix.report')}
          </button>
        )}
      </div>
      {all.length > 2 && (
        <div className="e86-chips">
          <button type="button" className={`chip ${!focus ? 'on' : ''}`} onClick={() => setFocus('')}>{t('eightySix.all')}</button>
          {all.map((l) => (
            <button key={l.id} type="button" className={`chip ${focus === l.id ? 'on' : ''}`} onClick={() => setFocus(focus === l.id ? '' : l.id)}>
              {l.kind === 'bar' && <Icon name="glass" size={13} />}{listName(l, t.lang)}{l.items.length > 0 && <span className="e86-chip-n">{l.items.length}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={`e86-cols ${bar.length && floor.length ? 'two' : ''}`}>
        {bar.length > 0 && <section className="e86-col bar"><div className="e86-col-h"><Icon name="glass" size={15} />{t('eightySix.barColumn')}</div>{bar.map(card)}</section>}
        {floor.length > 0 && <section className="e86-col floor"><div className="e86-col-h"><Icon name="ban" size={15} />{t('eightySix.floorColumn')}</div>{floor.map(card)}</section>}
      </div>
    </>
  );
}

function ListCard({ list, undo, onReport, onEdit, onClear, onUndo }) {
  const t = useT();
  const out = list.items.filter((i) => i.status === 'out').length;
  const low = list.items.length - out;
  const name = listName(list, t.lang);
  return (
    <div className={`card e86-list ${list.kind}`}>
      <div className="e86-list-h">
        <div className="e86-list-title">
          <div className="e86-list-name">{name}{list.area && <span className="badge">{list.area}</span>}</div>
          <div className="small muted">{out || low ? [out && t('eightySix.nOut', { count: out }), low && t('eightySix.nLow', { count: low })].filter(Boolean).join(' · ') : t('eightySix.allGood')}</div>
        </div>
        {list.canReport && <button className="btn sm" onClick={() => onReport(list.id)} aria-label={`${t('eightySix.report')}: ${name}`}><Icon name="plus" />{t('eightySix.report')}</button>}
      </div>
      {undo.map((u) => (
        <div key={u.id} className="e86-undo" role="status">
          <Icon name="check" size={16} /><span className="e86-undo-text">{t('eightySix.backName', { name: u.name })}</span>
          <button className="btn sm ghost" onClick={() => onUndo(u)}>{t('common.undo')}</button>
        </div>
      ))}
      {list.items.map((it) => <ItemRow key={it.id} it={it} list={list} onEdit={onEdit} onClear={onClear} />)}
      {list.resetAt && <div className="e86-foot tiny faint"><Icon name="clock" size={12} />{t('eightySix.clearsAt', { time: fmtTime(list.resetAt) })}</div>}
    </div>
  );
}

function ItemRow({ it, list, onEdit, onClear }) {
  const t = useT();
  const meta = [it.status === 'low' && it.count != null && t('eightySix.countLeft', { count: it.count }), it.area && !sameArea(it.area, list.area) && it.area].filter(Boolean);
  const body = (
    <>
      <span className={`e86-pill ${it.status}`}>{it.status === 'out' ? t('eightySix.pillOut') : t('eightySix.pillLow')}</span>
      <span className="e86-item-text">
        <span className="e86-item-name">{itemName(it, t.lang)}</span>
        {(meta.length > 0 || it.note) && <span className="e86-item-meta">{meta.join(' · ')}{meta.length > 0 && it.note ? ' · ' : ''}{it.note && <i>{it.note}</i>}</span>}
        <span className="e86-item-who">{it.updatedBy.name} · {ago(t, it.updatedAt)}</span>
      </span>
    </>
  );
  return (
    <div className={`e86-item ${it.status}`}>
      {list.canReport ? <button type="button" className="e86-item-main" onClick={() => onEdit(it)}>{body}</button> : <div className="e86-item-main">{body}</div>}
      {list.canReport && <button type="button" className="btn sm e86-back" onClick={() => onClear(it)}><Icon name="check" />{t('eightySix.backInStock')}</button>}
    </div>
  );
}

/** Pick the list, search the menu (or type), then one tap: 86'd or running low. Also updates an item already on a list. */
function ReportDialog({ board, start, onClose, onDone }) {
  const t = useT();
  const { call, toast } = useApp();
  const editing = start.item || null;
  const reportable = board.lists.filter((l) => l.canReport).sort(barFirst);
  const [listId, setListId] = useState(editing?.listId || (reportable.some((l) => l.id === start.listId) ? start.listId : reportable[0]?.id));
  const list = board.lists.find((l) => l.id === listId);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(editing ? { name: editing.name, nameEs: editing.nameEs, menuItemId: editing.menuItemId } : null);
  const [count, setCount] = useState(editing?.count ?? '');
  const [note, setNote] = useState(editing?.note || '');
  const [area, setArea] = useState(editing?.area || '');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  const words = norm(q).split(' ').filter(Boolean);
  const options = (list?.suggest || []).map((id) => ({ id, ...board.menu[id] }))
    .filter((m) => m.name && words.every((w) => norm(`${m.name} ${m.nameEs} ${m.category}`).includes(w)));
  const exact = q.trim() ? options.find((m) => norm(m.name) === norm(q) || (m.nameEs && norm(m.nameEs) === norm(q))) : null;
  const current = picked || (q.trim() ? { name: q.trim(), menuItemId: exact?.id || null } : null);
  const existing = !editing && current && list?.items.find((i) => (current.menuItemId ? i.menuItemId === current.menuItemId : norm(i.name) === norm(current.name)));
  const pickMenu = (m) => { setPicked({ name: m.name, nameEs: m.nameEs, menuItemId: m.id }); setQ(''); };
  const pickTyped = () => { if (q.trim()) { setPicked({ name: q.trim(), nameEs: '', menuItemId: null }); setQ(''); } };

  const send = async (status) => {
    if (!current) { toast(t('eightySix.pickFirst'), 'bad'); input.current?.focus(); return; }
    setBusy(true);
    try {
      const r = await call('eightySix.report', { listId, name: current.name, menuItemId: current.menuItemId || null, status, count: status === 'low' ? count : '', note, area });
      const nm = itemName(r.item, t.lang);
      toast(`${status === 'out' ? t('eightySix.reportedOut', { name: nm }) : t('eightySix.reportedLow', { name: nm })}${r.notified ? ` · ${t('eightySix.told', { count: r.notified })}` : ''}`);
      onDone();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? t('eightySix.updateItem', { name: itemName(editing, t.lang) }) : t('eightySix.reportItem')} sub={editing ? listName(list, t.lang) : null} onClose={onClose}
      footer={(
        <div className="e86-foot-btns">
          <button className="btn e86-low" disabled={busy} onClick={() => send('low')}>{t('eightySix.markLow')}</button>
          <button className="btn danger solid" disabled={busy} onClick={() => send('out')}><Icon name="ban" />{t('eightySix.markOut')}</button>
        </div>
      )}>
      {!editing && reportable.length > 1 && (
        <div className="field">
          <span>{t('eightySix.list')}</span>
          <div className="e86-chips tight">
            {reportable.map((l) => (
              <button key={l.id} type="button" className={`chip ${l.id === listId ? 'on' : ''}`} aria-pressed={l.id === listId} onClick={() => { setListId(l.id); setPicked(null); }}>
                {l.kind === 'bar' && <Icon name="glass" size={13} />}{listName(l, t.lang)}
              </button>
            ))}
          </div>
        </div>
      )}
      {picked ? (
        <div className="e86-picked">
          <span className="e86-picked-name">{itemName(picked, t.lang)}</span>
          {!editing && <button type="button" className="btn sm ghost" onClick={() => { setPicked(null); setTimeout(() => input.current?.focus(), 0); }}>{t('eightySix.change')}</button>}
        </div>
      ) : (
        <div className="e86-search">
          <label className="e86-search-box">
            <Icon name="search" size={18} />
            <input ref={input} className="input" type="search" value={q} autoFocus enterKeyHint="done" placeholder={t('eightySix.search')} aria-label={t('eightySix.search')}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (exact) pickMenu(exact); else pickTyped(); } }} />
          </label>
          {(options.length > 0 || q.trim()) && (
            <div className="e86-results">
              {!q.trim() && <div className="tiny faint e86-results-h">{t('eightySix.fromMenu')}</div>}
              {q.trim() && !exact && <button type="button" className="e86-result typed" onClick={pickTyped}><Icon name="plus" size={16} /><span className="e86-result-name">{t('eightySix.useTyped', { text: q.trim() })}</span></button>}
              {options.slice(0, q.trim() ? 8 : 6).map((m) => (
                <button key={m.id} type="button" className="e86-result" onClick={() => pickMenu(m)}>
                  <span className="e86-result-name">{t.lang === 'es' && m.nameEs ? m.nameEs : m.name}</span>
                  <span className="tiny faint">{categoryLabel(m.category, t.lang)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {existing && <div className="alert info"><Icon name="alert" size={16} />{existing.status === 'out' ? t('eightySix.alreadyOut') : t('eightySix.alreadyLow')}</div>}
      <div className="e86-fields">
        <Field label={t('eightySix.howMany')}>
          <input className="input" type="number" inputMode="numeric" min="0" step="1" value={count} onChange={(e) => setCount(e.target.value)} placeholder={t('eightySix.countPlaceholder')} />
        </Field>
        <Field label={t('eightySix.note')}>
          <input className="input" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder={t('eightySix.notePlaceholder')} />
        </Field>
      </div>
      {board.areas.length > 0 && (
        <Field label={t('eightySix.area')}>
          <select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">{t('eightySix.anyArea')}</option>
            {board.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}

/** Managers: what was 86'd most (for ordering) and the log, newest first. */
function History() {
  const t = useT();
  const { call, version, toast } = useApp();
  const [days, setDays] = useState(30);
  const [h, setH] = useState(null);
  useEffect(() => { call('eightySix.history.get', { days }).then(setH).catch((e) => toast(e.message, 'bad')); }, [version, days]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!h) return <div className="empty">{t('common.loading')}</div>;
  const max = Math.max(1, ...h.top.map((x) => x.times));
  const now = nowDate();
  const status = (e) => {
    if (e.active) return e.status === 'out' ? t('eightySix.stillOut') : t('eightySix.stillLow');
    const when = stamp(e.clearedAt);
    if (e.clearedHow === 'reset') return t('eightySix.resetAt', { when });
    if (e.clearedHow === 'removed') return t('eightySix.removedAt', { when });
    return t('eightySix.backAt', { when, name: e.clearedBy?.name || '' });
  };
  return (
    <>
      <div className="e86-hist-bar">
        <div className="seg">{[30, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{t('eightySix.lastDays', { days: d })}</button>)}</div>
      </div>
      <div className="card card-pad section">
        <h2>{t('eightySix.mostTitle', { days: h.days })}</h2>
        <div className="small muted">{t('eightySix.mostHelp')}</div>
        {!h.top.length ? <div className="small faint" style={{ marginTop: 10 }}>{t('eightySix.nothingYet', { days: h.days })}</div> : (
          <div className="e86-top">
            {h.top.map((x) => (
              <div key={x.key} className="e86-top-row">
                <div className="e86-top-name"><b>{itemName(x, t.lang)}</b><span className="tiny faint">{x.lists.join(', ')}</span></div>
                <div className="e86-top-bar" aria-hidden="true"><span style={{ width: `${Math.round((x.times / max) * 100)}%` }} /></div>
                <div className="e86-top-n num">{t('eightySix.times', { count: x.times })}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card section">
        <div className="card-head"><h2>{t('eightySix.logTitle')}</h2></div>
        {!h.entries.length && <Empty icon="ban" title={t('eightySix.nothingYet', { days: h.days })} />}
        <div className="list">
          {h.entries.map((e) => {
            const from = e.outAt || e.reportedAt;
            const until = e.active ? (e.status === 'out' ? now : null) : e.clearedAt;
            return (
              <div key={e.id} className="list-item e86-log">
                <span className={`e86-pill ${e.outAt ? 'out' : 'low'}`}>{e.outAt ? t('eightySix.pillOut') : t('eightySix.pillLow')}</span>
                <div className="e86-log-text">
                  <div><b>{itemName(e, t.lang)}</b> <span className="small muted">· {t.lang === 'es' && e.listNameEs ? e.listNameEs : e.listName}{e.area ? ` · ${e.area}` : ''}</span></div>
                  <div className="small muted">{stamp(from)} · {e.reportedBy.name}{e.note ? ` · “${e.note}”` : ''}</div>
                  <div className={`small ${e.active ? 'e86-still' : ''}`}>{status(e)}{e.outAt && until ? ` (${t('eightySix.outFor', { time: duration(t, e.outAt, until) })})` : ''}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
