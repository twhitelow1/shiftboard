// Saved lists ("par lists", core/stock-saved.js): reusable lists of products with a par each, for me, a room or
// positions, shared with people, roles, positions or rooms. Run one down on a phone: count what's on hand (a big
// stepper, long-press to go fast, or type it), skip what you can't count, see what's needed as you go, then send it
// to support, work it yourself, and/or mark what's out with none in the storeroom (86). Progress is kept in this
// browser (a draft per list) if the phone locks or the tab goes away. On a desktop, the editor builds lists: search
// products, add with a par, drag to the shelf order.
// Routes: #/stock/saved · #/stock/saved/new · #/stock/saved/<id> · #/stock/saved/<id>/run · #/stock/saved/<id>/edit
// Who may do what is checked on the server; this page only hides buttons that wouldn't work.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty } from '../ui.jsx';
import { useT, stamp } from '../i18n/index.js';
import { productMatches } from '../../../core/products.js';
import { needFor } from '../../../core/stock-saved.js';
import { ProductPhoto, AddProduct } from './Stock.jsx';

const go = (path) => { location.hash = `#/stock/saved${path ? `/${path}` : ''}`; };
const catName = (cats, id, lang) => { const c = (cats || []).find((x) => x.id === id); return c ? (lang === 'es' ? c.nameEs || c.name : c.name) : ''; };
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

// ---------- the draft of a run, kept in this browser ----------
const DRAFT = (id) => `shiftboard.stockRun.${id}`;
function readDraft(id) {
  try { const d = JSON.parse(localStorage.getItem(DRAFT(id)) || 'null'); return d && typeof d === 'object' ? d : null; } catch { return null; }
}
function writeDraft(id, d) { try { if (d) localStorage.setItem(DRAFT(id), JSON.stringify(d)); else localStorage.removeItem(DRAFT(id)); } catch { /* private mode */ } }

export default function StockSaved({ parts = [] }) {
  const id = parts[2] || '';
  if (!id) return <SavedLists />;
  if (id === 'new') return <Editor />;
  if (parts[3] === 'run') return <RunDown id={id} />;
  if (parts[3] === 'edit') return <Editor id={id} />;
  return <SavedView id={id} />;
}

// ---------- the lists ----------
function SavedCard({ l }) {
  const t = useT();
  return (
    <div className="card stk-card sav-card">
      <button type="button" className="stk-card-main" onClick={() => go(l.id)}>
        <div className="stk-card-top">
          <span className="stk-card-name">{l.name}</span>
          {l.today && <span className="badge brand">{t('stockSaved.today')}</span>}
          {l.openRequests > 0 && <span className="badge warn">{t('stockSaved.nRequests', { count: l.openRequests })}</span>}
        </div>
        <div className="small muted">{[l.scopeLabel, !l.mine && l.owner && t('stockSaved.byOwner', { name: l.owner.name }), t('stockSaved.nLines', { count: l.lines })].filter(Boolean).join(' · ')}</div>
        {l.lastRun && <div className="tiny faint">{t('stockSaved.lastRun', { name: l.lastRun.by.name, when: stamp(l.lastRun.at), count: l.lastRun.needs })}</div>}
      </button>
      <div className="stk-card-foot sav-card-foot">
        <button type="button" className="btn primary sav-run-btn" onClick={() => go(`${l.id}/run`)}><Icon name="check" />{t('stockSaved.runIt')}</button>
        {l.shared > 0 && <span className="tiny faint"><Icon name="users" size={13} /> {t('stockSaved.sharedN', { count: l.shared })}</span>}
      </div>
    </div>
  );
}

function SavedLists() {
  const t = useT();
  const { call, version, toast, viewAs } = useApp();
  const [all, setAll] = useState(false);
  const [d, setD] = useState(null);
  useEffect(() => { call('stock.saved.list', { all }).then(setD).catch((e) => toast(e.message, 'bad')); }, [all, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="empty">{t('common.loading')}</div>;
  const groups = [['mine', t('stockSaved.mine')], ['forMe', t('stockSaved.forMe')], ['all', t('stockSaved.allOthers')]];
  return (
    <>
      <div className="stk-head">
        <div className="stk-head-text">
          <h2>{t('stockSaved.title')}</h2>
          <div className="small muted">{t('stockSaved.intro')}</div>
        </div>
        {d.canCreate && !viewAs && <div className="stk-head-btns"><button className="btn primary" onClick={() => go('new')}><Icon name="plus" />{t('stockSaved.newList')}</button></div>}
      </div>
      {d.canManage && (
        <div className="stk-chips">
          <button type="button" className={`chip ${!all ? 'on' : ''}`} aria-pressed={!all} onClick={() => setAll(false)}>{t('stockSaved.mySpaces')}</button>
          <button type="button" className={`chip ${all ? 'on' : ''}`} aria-pressed={all} onClick={() => setAll(true)}>{t('stockSaved.everyList')}</button>
        </div>
      )}
      {!d.lists.length ? <Empty icon="box" title={t('stockSaved.none')}>{d.canCreate && !viewAs ? <button className="btn sm primary" onClick={() => go('new')}>{t('stockSaved.newList')}</button> : null}</Empty> : groups.map(([k, label]) => {
        const ls = d.lists.filter((l) => l.section === k);
        if (!ls.length) return null;
        return (
          <section key={k} className="section">
            <h3 className="sav-h">{label}</h3>
            <div className="stk-grid">{ls.map((l) => <SavedCard key={l.id} l={l} />)}</div>
          </section>
        );
      })}
    </>
  );
}

// ---------- one list ----------
function SavedView({ id }) {
  const t = useT();
  const { call, version, toast, viewAs } = useApp();
  const [l, setL] = useState(null);
  const [err, setErr] = useState('');
  const [sharing, setSharing] = useState(false);
  useEffect(() => { call('stock.saved.get', { id }).then(setL).catch((e) => setErr(e.message)); }, [id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <Empty icon="alert" title={err}><a className="btn sm" href="#/stock/saved">{t('stockSaved.back')}</a></Empty>;
  if (!l) return <div className="empty">{t('common.loading')}</div>;
  const act = async (method, args, msg) => { try { const r = await call(method, { id: l.id, ...args }); if (r?.lines) setL(r); if (msg) toast(msg); return r; } catch (e) { toast(e.message, 'bad'); return null; } };
  const draft = readDraft(l.id);
  const ro = !!viewAs;
  return (
    <>
      <a className="stk-back small" href="#/stock/saved"><Icon name="left" size={14} />{t('stockSaved.back')}</a>
      <div className="card card-pad stk-top">
        <div className="stk-card-top"><h2 className="stk-title">{l.name}</h2></div>
        <div className="small muted">{[l.scopeLabel, l.owner && t('stockSaved.byOwner', { name: l.owner.name })].filter(Boolean).join(' · ')}</div>
        {l.notes && <div className="stk-notes">{l.notes}</div>}
        {l.runs[0] && <div className="tiny faint">{t('stockSaved.lastRun', { name: l.runs[0].by.name, when: stamp(l.runs[0].at), count: l.runs[0].needs })}</div>}
        <div className="stk-actions">
          <button className="btn primary sav-run-btn" onClick={() => go(`${l.id}/run`)}><Icon name="check" />{draft ? t('stockSaved.resume') : t('stockSaved.runIt')}</button>
          {l.canEdit && !ro && <button className="btn" onClick={() => go(`${l.id}/edit`)}><Icon name="edit" />{t('common.edit')}</button>}
          {l.canShare && !ro && <button className="btn" onClick={() => setSharing(true)}><Icon name="users" />{t('stockSaved.share')}</button>}
          {l.canShare && !ro && <button className="btn danger" onClick={async () => { if (window.confirm(t('stockSaved.deleteConfirm'))) { if (await act('stock.saved.delete', {})) go(''); } }}><Icon name="trash" />{t('stockSaved.delete')}</button>}
        </div>
      </div>
      {l.requests.length > 0 && (
        <div className="card section">
          <div className="card-head"><h2>{t('stockSaved.requests')}</h2></div>
          <div className="list">
            {l.requests.map((r) => (
              <div key={r.id} className="list-item sav-req">
                <span className="small sav-req-text">{t('stockSaved.requestLine', { name: r.byName, product: r.product, from: r.from, to: r.to })}{r.note ? ` · “${r.note}”` : ''}</span>
                {l.canEdit && !ro && (
                  <span className="sav-req-btns">
                    <button className="btn sm ok" onClick={() => act('stock.saved.answerRequest', { requestId: r.id, accept: true }, t('stockSaved.parChanged'))}>{t('stockSaved.accept')}</button>
                    <button className="btn sm ghost" onClick={() => act('stock.saved.answerRequest', { requestId: r.id, accept: false }, t('stockSaved.declined'))}>{t('stockSaved.decline')}</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card section">
        <div className="card-head"><h2>{t('stockSaved.products', { count: l.lines.length })}</h2></div>
        <div className="list">
          {l.lines.map((x) => (
            <div key={x.id} className={`list-item sav-line ${x.archived ? 'archived' : ''}`}>
              <ProductPhoto product={x} className="stk-thumb" />
              <span className="stk-result-text">
                <b>{x.name}</b>
                <span className="tiny faint">{[x.location, x.note].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="sav-par"><span className="tiny faint">{t('stockSaved.par')}</span><b className="num">{x.par}</b><span className="tiny faint">{x.unitName}</span></span>
              <span className="sav-usual small muted">{x.usually > 0 ? t('stockSaved.usually', { n: x.usually }) : ''}</span>
            </div>
          ))}
        </div>
      </div>
      {l.canShare && l.shares.length > 0 && (
        <div className="card card-pad section">
          <h3 className="sav-h">{t('stockSaved.sharedWith')}</h3>
          <div className="stk-chips tight">{l.shares.map((s) => <span key={s.id} className="chip on">{s.label} · {s.can === 'edit' ? t('stockSaved.canEdit') : t('stockSaved.canUse')}</span>)}</div>
        </div>
      )}
      {l.runs.length > 0 && <Runs runs={l.runs} />}
      {sharing && <ShareDialog l={l} onClose={() => setSharing(false)} onChanged={setL} />}
    </>
  );
}

function Runs({ runs }) {
  const t = useT();
  const [open, setOpen] = useState(null);
  return (
    <div className="card section">
      <div className="card-head"><h2>{t('stockSaved.history')}</h2></div>
      <div className="list">
        {runs.map((r) => (
          <div key={r.id} className="list-item sav-run">
            <button type="button" className="sav-run-head" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="small"><b>{r.by.name}</b> · {stamp(r.at)}</span>
              <span className="small muted">{[t('stockSaved.nNeeded', { count: r.needs }), r.skipped ? t('stockSaved.nSkipped', { count: r.skipped }) : '',
                r.send === 'support' ? t('stockSaved.sentTo', { to: r.to }) : r.send === 'self' ? t('stockSaved.workedSelf') : '', r.out.length ? t('stockSaved.out86', { names: r.out.join(', ') }) : ''].filter(Boolean).join(' · ')}</span>
            </button>
            {open === r.id && (
              <table className="sav-table small">
                <thead><tr><th>{t('stockSaved.product')}</th><th className="num">{t('stockSaved.par')}</th><th className="num">{t('stockSaved.onHand')}</th><th className="num">{t('stockSaved.need')}</th></tr></thead>
                <tbody>{r.counts.map((c, i) => <tr key={i}><td>{c.name}</td><td className="num">{c.par}</td><td className="num">{c.onHand === null ? '—' : c.onHand}</td><td className="num">{c.need ?? '—'}</td></tr>)}</tbody>
              </table>
            )}
            {open === r.id && r.listId && <a className="btn sm ghost" href={`#/stock/${r.listId}`}>{t('stockSaved.openList')}</a>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Share with a person, a role, a position or a room: to use it, or to edit it. Unshare. */
function ShareDialog({ l, onClose, onChanged }) {
  const t = useT();
  const { call, toast } = useApp();
  const [opts, setOpts] = useState(null);
  const [type, setType] = useState('position');
  const [val, setVal] = useState('');
  const [can, setCan] = useState('use');
  const [cur, setCur] = useState(l);
  useEffect(() => { call('stock.saved.options.get').then((o) => { setOpts(o); setVal(o.support.jobCodeId || ''); }).catch((e) => toast(e.message, 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const to = !val ? null : type === 'person' ? { type, userId: val } : type === 'role' ? { type, role: val } : type === 'position' ? { type, jobCodeId: val } : { type, room: val };
  const run = async (method, args, msg) => { try { const r = await call(method, { id: l.id, ...args }); setCur(r); onChanged(r); toast(msg); } catch (e) { toast(e.message, 'bad'); } };
  const choices = !opts ? [] : type === 'person' ? opts.people.map((p) => [p.id, p.name]) : type === 'role' ? opts.roles.map((r) => [r.id, r.name])
    : type === 'position' ? opts.positions.map((p) => [p.id, p.name]) : opts.rooms.map((r) => [r, r]);
  return (
    <Modal title={t('stockSaved.shareTitle', { name: l.name })} sub={t('stockSaved.shareSub')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.close')}</button><button className="btn primary" disabled={!to} onClick={() => run('stock.saved.share', { to, can }, t('stockSaved.sharedMsg'))}>{t('stockSaved.share')}</button></>}>
      {!opts ? <div className="empty">{t('common.loading')}</div> : (
        <>
          <div className="field">
            <span>{t('stockSaved.shareWith')}</span>
            <div className="stk-chips tight">
              {[['person', t('stockSaved.toPerson')], ['role', t('stockSaved.toRole')], ['position', t('stockSaved.toPosition')], ['room', t('stockSaved.toRoom')]].map(([k, label]) => (
                <button key={k} type="button" className={`chip ${type === k ? 'on' : ''}`} aria-pressed={type === k} onClick={() => { setType(k); setVal(''); }}>{label}</button>
              ))}
            </div>
          </div>
          <Field label={t('stockSaved.who')}>
            <select className="input" value={val} onChange={(e) => setVal(e.target.value)}>
              <option value="">{t('stockSaved.pick')}</option>
              {choices.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <div className="field">
            <span>{t('stockSaved.theyCan')}</span>
            <div className="stk-chips tight">
              <button type="button" className={`chip ${can === 'use' ? 'on' : ''}`} aria-pressed={can === 'use'} onClick={() => setCan('use')}>{t('stockSaved.canUse')}</button>
              <button type="button" className={`chip ${can === 'edit' ? 'on' : ''}`} aria-pressed={can === 'edit'} onClick={() => setCan('edit')}>{t('stockSaved.canEdit')}</button>
            </div>
            <div className="help">{t('stockSaved.canHelp')}</div>
          </div>
          {cur.shares.length > 0 && (
            <div className="field">
              <span>{t('stockSaved.sharedWith')}</span>
              {cur.shares.map((s) => (
                <div key={s.id} className="sav-share">
                  <span className="small"><b>{s.label}</b> · {s.can === 'edit' ? t('stockSaved.canEdit') : t('stockSaved.canUse')}</span>
                  <button type="button" className="btn sm ghost" onClick={() => run('stock.saved.unshare', { shareId: s.id }, t('stockSaved.unsharedMsg'))}>{t('stockSaved.unshare')}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------- the editor (desktop and phone) ----------
function Editor({ id = '' }) {
  const t = useT();
  const { call, toast } = useApp();
  const [cat, setCat] = useState(null);
  const [opts, setOpts] = useState(null);
  const [cur, setCur] = useState(id ? null : { name: '', notes: '', lines: [], scope: { type: 'personal' }, canScope: true });
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const [scope, setScope] = useState({ type: 'personal', room: '', jobCodeIds: [] });
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(null);
  useEffect(() => {
    call('products.list').then(setCat).catch((e) => toast(e.message, 'bad'));
    call('stock.saved.options.get').then(setOpts).catch(() => {});
    if (id) {
      call('stock.saved.get', { id }).then((l) => {
        setCur(l); setName(l.name); setNotes(l.notes);
        setLines(l.lines.filter((x) => !x.archived).map((x) => ({ id: x.id, productId: x.productId, par: x.par, unit: x.unit, note: x.note })));
        setScope({ type: l.scope.type, room: l.scope.room || '', jobCodeIds: l.scope.jobCodeIds || [] });
      }).catch((e) => toast(e.message, 'bad'));
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => Object.fromEntries((cat?.products || []).map((p) => [p.id, p])), [cat]);
  if (!cur || !cat || !opts) return <div className="empty">{t('common.loading')}</div>;
  const mgr = opts.canManage && (id ? cur.canScope : true);
  const results = q.trim() ? cat.products.filter((p) => productMatches(p, q, catName(cat.categories, p.category, t.lang))).slice(0, 12) : [];
  const add = (p) => {
    setLines((ls) => (ls.some((x) => x.productId === p.id) ? ls : [...ls, { productId: p.id, par: p.pars?.[scope.room] ?? p.pars?.[''] ?? 1, unit: '', note: '' }]));
    setQ('');
  };
  const setLine = (i, patch) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i, to) => setLines((ls) => { if (to < 0 || to >= ls.length) return ls; const n = [...ls]; const [x] = n.splice(i, 1); n.splice(to, 0, x); return n; });
  const scopeArg = scope.type === 'personal' ? { type: 'personal' } : scope.type === 'room' ? { type: 'room', room: scope.room } : { type: 'positions', jobCodeIds: scope.jobCodeIds, ...(scope.room ? { room: scope.room } : {}) };
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('stock.saved.save', { ...(id ? { id } : {}), name, notes, lines: lines.map((x) => ({ ...x, par: x.par === '' ? 0 : Number(x.par) })), ...(mgr || !id ? { scope: scopeArg } : {}) });
      toast(id ? t('stockSaved.saved') : t('stockSaved.created'));
      go(r.id);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <div className="sav-editor">
      <a className="stk-back small" href={id ? `#/stock/saved/${id}` : '#/stock/saved'}><Icon name="left" size={14} />{t('stockSaved.back')}</a>
      <h2 className="stk-title">{id ? t('stockSaved.editTitle') : t('stockSaved.newList')}</h2>
      <div className="sav-editor-cols">
        <div className="card card-pad stk-form">
          <Field label={t('stockSaved.name')}><input className="input" value={name} maxLength={60} placeholder={t('stockSaved.namePh')} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('stockSaved.notes')}><input className="input" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></Field>
          {(mgr || !id) && (
            <div className="field">
              <span>{t('stockSaved.forWho')}</span>
              <div className="stk-chips tight">
                <button type="button" className={`chip ${scope.type === 'personal' ? 'on' : ''}`} aria-pressed={scope.type === 'personal'} onClick={() => setScope({ ...scope, type: 'personal' })}>{t('stockSaved.personal')}</button>
                {opts.canManage && <button type="button" className={`chip ${scope.type === 'room' ? 'on' : ''}`} aria-pressed={scope.type === 'room'} onClick={() => setScope({ ...scope, type: 'room' })}>{t('stockSaved.aRoom')}</button>}
                {opts.canManage && <button type="button" className={`chip ${scope.type === 'positions' ? 'on' : ''}`} aria-pressed={scope.type === 'positions'} onClick={() => setScope({ ...scope, type: 'positions' })}>{t('stockSaved.positions')}</button>}
              </div>
              {!opts.canManage && <div className="help">{t('stockSaved.personalHelp')}</div>}
            </div>
          )}
          {scope.type === 'positions' && (
            <div className="field">
              <span>{t('stockSaved.positions')}</span>
              <div className="stk-chips tight">
                {opts.positions.map((p) => { const on = scope.jobCodeIds.includes(p.id); return <button key={p.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setScope({ ...scope, jobCodeIds: on ? scope.jobCodeIds.filter((x) => x !== p.id) : [...scope.jobCodeIds, p.id] })}>{p.name}</button>; })}
              </div>
            </div>
          )}
          {scope.type !== 'personal' && (
            <Field label={t('stockSaved.room')}>
              <select className="input" value={scope.room} onChange={(e) => setScope({ ...scope, room: e.target.value })}>
                <option value="">{scope.type === 'room' ? t('stockSaved.everyRoom') : t('stockSaved.anyRoom')}</option>
                {opts.rooms.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="card card-pad stk-form">
          <h3>{t('stockSaved.products', { count: lines.length })}</h3>
          <label className="stk-search">
            <Icon name="search" size={18} />
            <input className="input" type="search" value={q} placeholder={t('stock.searchProducts')} aria-label={t('stock.searchProducts')} onChange={(e) => setQ(e.target.value)} />
          </label>
          {q.trim() && (
            <div className="stk-results">
              {results.map((p) => (
                <button key={p.id} type="button" className="stk-result" onClick={() => add(p)} disabled={lines.some((x) => x.productId === p.id)}>
                  <ProductPhoto product={p} className="stk-thumb" />
                  <span className="stk-result-text"><b>{p.name}</b><span className="tiny faint">{[p.size, p.location].filter(Boolean).join(' · ')}</span></span>
                  <Icon name={lines.some((x) => x.productId === p.id) ? 'check' : 'plus'} size={18} />
                </button>
              ))}
              <button type="button" className="stk-result typed" onClick={() => setAdding(true)}><Icon name="plus" size={18} /><span className="stk-result-text">{t('stock.addNewProduct', { name: q.trim() })}</span></button>
            </div>
          )}
          <div className="help">{t('stockSaved.orderHelp')}</div>
          <div className="sav-lines">
            {lines.map((x, i) => {
              const p = byId[x.productId] || { name: '?', photos: [] };
              return (
                <div key={x.productId} className={`sav-edit-row ${drag === i ? 'dragging' : ''}`} draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }}>
                  <span className="sav-grip" aria-hidden="true">⋮⋮</span>
                  <ProductPhoto product={p} className="stk-thumb" />
                  <div className="stk-picked-text"><b>{p.name}</b>
                    <input className="input stk-note" value={x.note} maxLength={140} placeholder={t('stock.linePh')} aria-label={t('stock.lineNote', { name: p.name })} onChange={(e) => setLine(i, { note: e.target.value })} /></div>
                  <label className="sav-par-in"><span className="tiny faint">{t('stockSaved.par')}</span>
                    <input className="input num" type="number" inputMode="decimal" min="0" step="any" value={x.par} aria-label={t('stockSaved.parFor', { name: p.name })} onChange={(e) => setLine(i, { par: e.target.value })} /></label>
                  <span className="sav-move">
                    <button type="button" className="btn sm ghost icon" aria-label={t('stockSaved.moveUp', { name: p.name })} disabled={!i} onClick={() => move(i, i - 1)}><Icon name="up" /></button>
                    <button type="button" className="btn sm ghost icon" aria-label={t('stockSaved.moveDown', { name: p.name })} disabled={i === lines.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></button>
                    <button type="button" className="btn sm ghost icon" aria-label={t('stock.removeLine', { name: p.name })} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Icon name="x" /></button>
                  </span>
                </div>
              );
            })}
            {!lines.length && <div className="small faint">{t('stock.noLinesYet')}</div>}
          </div>
        </div>
      </div>
      <div className="stk-save">
        <button className="btn primary block" disabled={busy || !name.trim() || !lines.length || (scope.type === 'positions' && !scope.jobCodeIds.length)} onClick={save}>{id ? t('common.save') : t('stockSaved.create')}</button>
      </div>
      {adding && <AddProduct start={q.trim()} cat={cat} onClose={() => setAdding(false)}
        onPicked={(p) => { setCat((c) => (c.products.some((x) => x.id === p.id) ? c : { ...c, products: [...c.products, p] })); add(p); setAdding(false); }} />}
    </div>
  );
}

// ---------- running it down (phone first) ----------
/** A big − / + stepper: long-press repeats, and the number can be typed (the phone's keypad). */
function Stepper({ value, onChange, label, disabled }) {
  const timer = useRef(null);
  const val = useRef(value);
  val.current = value;
  const step = (d) => { const cur = Number(val.current === '' ? 0 : val.current) || 0; onChange(String(Math.max(0, Math.round((cur + d) * 100) / 100))); };
  const start = (d) => {
    step(d);
    let n = 0;
    timer.current = setTimeout(function again() { n++; step(d * (n > 10 ? 5 : 1)); timer.current = setTimeout(again, 90); }, 450);
  };
  const stop = () => { clearTimeout(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  const hold = (d) => ({
    onPointerDown: (e) => { if (disabled) return; e.preventDefault(); start(d); }, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop,
    onContextMenu: (e) => e.preventDefault(), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(d); } },
  });
  return (
    <div className="sav-stepper" role="group" aria-label={label}>
      <button type="button" className="sav-step" aria-label={`−1 ${label}`} disabled={disabled} {...hold(-1)}>−</button>
      <input className="input num sav-count" type="text" inputMode="decimal" value={value} placeholder="0" aria-label={label} disabled={disabled}
        onFocus={(e) => e.target.select()} onChange={(e) => onChange(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))} />
      <button type="button" className="sav-step" aria-label={`+1 ${label}`} disabled={disabled} {...hold(1)}>+</button>
    </div>
  );
}

function RunDown({ id }) {
  const t = useT();
  const { call, toast, viewAs } = useApp();
  const [l, setL] = useState(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState(() => readDraft(id) || { counts: {}, skip: {}, extra: [] });
  const [finish, setFinish] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState(null);
  const [par, setPar] = useState(null); // { line, value }
  useEffect(() => { call('stock.saved.get', { id }).then(setL).catch((e) => setErr(e.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kept in this browser as you go (the phone locks, the tab is closed): cleared when the run is saved.
  useEffect(() => { if (!viewAs && (Object.keys(draft.counts).length || Object.keys(draft.skip).length || draft.extra.length)) writeDraft(id, { ...draft, at: new Date().toISOString() }); }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <Empty icon="alert" title={err}><a className="btn sm" href="#/stock/saved">{t('stockSaved.back')}</a></Empty>;
  if (!l) return <div className="empty">{t('common.loading')}</div>;
  const lines = [...l.lines.filter((x) => !x.archived).map((x) => ({ ...x, key: x.id })), ...draft.extra.map((x) => ({ ...x, key: `p:${x.productId}`, extra: true }))];
  const countOf = (x) => (draft.skip[x.key] ? null : draft.counts[x.key] ?? '');
  const needOf = (x) => needFor(x.par, countOf(x), x.unit);
  const needs = lines.filter((x) => needOf(x) > 0);
  const counted = lines.filter((x) => countOf(x) !== '' && countOf(x) !== null).length;
  const setCount = (x, v) => setDraft((d) => ({ ...d, counts: { ...d.counts, [x.key]: v }, skip: { ...d.skip, [x.key]: false } }));
  const toggleSkip = (x) => setDraft((d) => ({ ...d, skip: { ...d.skip, [x.key]: !d.skip[x.key] } }));
  const reset = () => { if (window.confirm(t('stockSaved.startOverConfirm'))) { writeDraft(id, null); setDraft({ counts: {}, skip: {}, extra: [] }); } };
  const openAdd = async () => { if (!cat) { try { setCat(await call('products.list')); } catch (e) { toast(e.message, 'bad'); return; } } setAdding(true); };
  const picked = async (p) => {
    setAdding(false);
    if (lines.some((x) => x.productId === p.id)) { toast(t('stockSaved.alreadyOn', { name: p.name })); return; }
    if (l.canEdit && !viewAs) {
      try { setL(await call('stock.saved.addLine', { id: l.id, productId: p.id, par: 1 })); toast(t('stockSaved.addedTo', { name: p.name })); } catch (e) { toast(e.message, 'bad'); }
    } else setDraft((d) => ({ ...d, extra: [...d.extra, { productId: p.id, name: p.name, category: p.category, photos: p.photos, unit: p.unit, unitName: p.unit, location: p.location, par: 1 }] }));
  };
  return (
    <div className="sav-runpage">
      <a className="stk-back small" href={`#/stock/saved/${l.id}`}><Icon name="left" size={14} />{l.name}</a>
      <div className="sav-run-top">
        <h2 className="stk-title">{t('stockSaved.runTitle', { name: l.name })}</h2>
        <div className="small muted">{t('stockSaved.runHelp')}</div>
        {readDraft(l.id)?.at && <div className="tiny faint">{t('stockSaved.draftKept', { when: stamp(readDraft(l.id).at) })} · <button type="button" className="linkish" onClick={reset}>{t('stockSaved.startOver')}</button></div>}
      </div>
      <div className="sav-run-lines">
        {lines.map((x) => {
          const c = countOf(x);
          const need = needOf(x);
          return (
            <div key={x.key} className={`card sav-run-line ${draft.skip[x.key] ? 'skipped' : need > 0 ? 'needs' : c !== '' && c !== null ? 'ok' : ''}`}>
              <div className="sav-run-row">
                <ProductPhoto product={x} className="sav-run-photo" alt="" />
                <div className="stk-line-text">
                  <div className="stk-line-name">{x.name}</div>
                  <div className="small"><b>{x.unitName ? t('stockSaved.parIs', { n: x.par, unit: x.unitName }) : `${t('stockSaved.par')} ${x.par}`}</b>{x.usually > 0 ? <span className="muted"> · {t('stockSaved.usually', { n: x.usually })}</span> : null}</div>
                  {x.location && <div className="tiny muted stk-line-loc"><Icon name="pin" size={12} />{x.location}</div>}
                </div>
                <div className={`sav-need ${need > 0 ? 'on' : ''}`} aria-live="polite">{need === null ? '' : need > 0 ? t('stockSaved.needN', { n: need }) : '✓'}</div>
              </div>
              <div className="sav-run-ctl">
                <Stepper value={c === null ? '' : num(c)} label={t('stockSaved.onHandFor', { name: x.name })} disabled={!!draft.skip[x.key] || !!viewAs} onChange={(v) => setCount(x, v)} />
                <button type="button" className={`btn sav-skip ${draft.skip[x.key] ? 'on' : ''}`} aria-pressed={!!draft.skip[x.key]} onClick={() => toggleSkip(x)}>{draft.skip[x.key] ? t('stockSaved.skipped') : t('stockSaved.skip')}</button>
              </div>
              {!x.extra && !viewAs && <button type="button" className="linkish tiny sav-par-link" onClick={() => setPar({ line: x, value: String(x.par) })}>{l.canEdit ? t('stockSaved.changePar') : t('stockSaved.askPar')}</button>}
            </div>
          );
        })}
        {!viewAs && <button type="button" className="btn sav-add" onClick={openAdd}><Icon name="plus" />{t('stockSaved.addOnFly')}</button>}
      </div>
      <div className="sav-run-bar">
        <div className="sav-run-sum">
          <b>{t('stockSaved.needsSummary', { count: needs.length })}</b>
          <span className="tiny muted">{t('stockSaved.countedOf', { n: counted, total: lines.length })}</span>
        </div>
        <button className="btn primary sav-finish" disabled={!counted || !!viewAs} onClick={() => setFinish(true)}>{t('stockSaved.finish')}</button>
      </div>
      {finish && <Finish l={l} lines={lines} countOf={countOf} needOf={needOf} onClose={() => setFinish(false)} onDone={(r) => { writeDraft(id, null); setFinish(false); if (r.list) location.hash = `#/stock/${r.list.id}`; else go(l.id); }} />}
      {adding && cat && <AddProduct cat={cat} onClose={() => setAdding(false)} onPicked={picked} />}
      {par && <ParDialog l={l} line={par.line} start={par.value} onClose={() => setPar(null)} onSaved={(r) => { setL(r); setPar(null); }} />}
    </div>
  );
}

function ParDialog({ l, line, start, onClose, onSaved }) {
  const t = useT();
  const { call, toast } = useApp();
  const [v, setV] = useState(start);
  const [note, setNote] = useState('');
  const save = async () => {
    try {
      if (l.canEdit) { const r = await call('stock.saved.setPar', { id: l.id, lineId: line.id, par: v }); toast(t('stockSaved.parChanged')); onSaved(r); } else {
        const r = await call('stock.saved.requestPar', { id: l.id, lineId: line.id, par: v, note }); toast(t('stockSaved.parAsked')); onSaved(r);
      }
    } catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <Modal title={l.canEdit ? t('stockSaved.changeParFor', { name: line.name }) : t('stockSaved.askParFor', { name: line.name })} sub={l.canEdit ? null : t('stockSaved.askParSub')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{l.canEdit ? t('common.save') : t('stockSaved.send')}</button></>}>
      <Field label={t('stockSaved.par')}><Stepper value={v} label={t('stockSaved.par')} onChange={setV} /></Field>
      {!l.canEdit && <Field label={t('stockSaved.why')}><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>}
    </Modal>
  );
}

/** The end of a run: send it to support, work it myself, mark what's out (86), or only save the counts. */
function Finish({ l, lines, countOf, needOf, onClose, onDone }) {
  const t = useT();
  const { call, toast } = useApp();
  const [opts, setOpts] = useState(null);
  const [to, setTo] = useState('duty'); // duty · position · room · person
  const [job, setJob] = useState('');
  const [room, setRoom] = useState('');
  const [person, setPerson] = useState('');
  const [out, setOut] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('stock.saved.options.get').then((o) => { setOpts(o); setJob(o.support.jobCodeId); setRoom(o.support.room); }).catch((e) => toast(e.message, 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const zero = lines.filter((x) => countOf(x) !== null && countOf(x) !== '' && Number(countOf(x)) === 0);
  const needs = lines.filter((x) => needOf(x) > 0 && !out[x.key]);
  const counts = lines.map((x) => (x.extra ? { productId: x.productId, par: x.par, onHand: countOf(x) ?? null, skip: countOf(x) === null || countOf(x) === '' } : { lineId: x.id, onHand: countOf(x) ?? null, skip: countOf(x) === null || countOf(x) === '' }));
  const outIds = Object.keys(out).filter((k) => out[k]).map((k) => (k.startsWith('p:') ? k.slice(2) : k));
  const assign = !opts ? null : to === 'person' ? (person ? { type: 'person', userId: person } : null) : to === 'room' ? (room ? { type: 'room', room } : null)
    : (to === 'duty' ? opts.support.jobCodeId : job) ? { type: 'position', jobCodeId: to === 'duty' ? opts.support.jobCodeId : job, ...((to === 'duty' ? opts.support.room : room) ? { room: to === 'duty' ? opts.support.room : room } : {}) } : null;
  const run = async (send) => {
    setBusy(true);
    try {
      const r = await call('stock.saved.run', { id: l.id, counts, send, assign: send === 'support' ? assign : null, out: outIds });
      toast(send === 'support' ? (r.notified ? t('stockSaved.sentN', { count: r.notified }) : t('stockSaved.sentNobody')) : send === 'self' ? t('stockSaved.madeForMe') : t('stockSaved.countSaved'));
      if (r.eightySix.length) toast(t('stockSaved.reported86', { names: r.eightySix.map((x) => x.name).join(', ') }));
      onDone(r);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('stockSaved.finishTitle')} sub={t('stockSaved.needsSummary', { count: needs.length })} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('stockSaved.keepCounting')}</button><button className="btn ghost" disabled={busy} onClick={() => run('none')}>{t('stockSaved.justSave')}</button></>}>
      {needs.length > 0 && (
        <div className="sav-needs">
          {needs.map((x) => <div key={x.key} className="sav-needs-row small"><span>{x.name}</span><b className="num">{needOf(x)} {x.unitName}</b></div>)}
        </div>
      )}
      {zero.length > 0 && (
        <div className="field">
          <span>{t('stockSaved.outTitle')}</span>
          <div className="help">{t('stockSaved.outHelp')}</div>
          {zero.map((x) => (
            <label key={x.key} className="sav-out-row"><input type="checkbox" checked={!!out[x.key]} onChange={(e) => setOut({ ...out, [x.key]: e.target.checked })} /><span>{x.name}</span></label>
          ))}
        </div>
      )}
      {!opts ? <div className="empty">{t('common.loading')}</div> : (
        <>
          <div className="sav-choice">
            <h3 className="sav-h">{t('stockSaved.sendSupport')}</h3>
            <div className="stk-chips tight">
              {[['duty', opts.support.jobCodeId ? t('stockSaved.toDuty') : null], ['position', t('stockSaved.toPosition')], ['room', t('stockSaved.toRoom')], ['person', t('stockSaved.toPerson')]].filter(([, label]) => label).map(([k, label]) => (
                <button key={k} type="button" className={`chip ${to === k ? 'on' : ''}`} aria-pressed={to === k} onClick={() => setTo(k)}>{label}</button>
              ))}
            </div>
            {to === 'position' && <select className="input" value={job} aria-label={t('stockSaved.toPosition')} onChange={(e) => setJob(e.target.value)}><option value="">{t('stockSaved.pick')}</option>{opts.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
            {(to === 'position' || to === 'room') && <select className="input" value={room} aria-label={t('stockSaved.room')} onChange={(e) => setRoom(e.target.value)}><option value="">{t('stockSaved.anyRoom')}</option>{opts.rooms.map((r) => <option key={r} value={r}>{r}</option>)}</select>}
            {to === 'person' && <select className="input" value={person} aria-label={t('stockSaved.toPerson')} onChange={(e) => setPerson(e.target.value)}><option value="">{t('stockSaved.pick')}</option>{opts.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
            {to === 'duty' && <div className="help">{t('stockSaved.dutyHelp', { room: opts.support.room || t('stockSaved.anyRoom') })}</div>}
            <button className="btn primary block sav-big" disabled={busy || !needs.length || !assign} onClick={() => run('support')}><Icon name="send" />{to === 'duty' ? t('stockSaved.sendToBarbacks') : t('stockSaved.send')}</button>
          </div>
          <div className="sav-choice">
            <h3 className="sav-h">{t('stockSaved.workSelf')}</h3>
            <div className="help">{t('stockSaved.workSelfHelp')}</div>
            <button className="btn block sav-big" disabled={busy || !needs.length} onClick={() => run('self')}><Icon name="check" />{t('stockSaved.workSelfBtn')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
