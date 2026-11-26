// Stock lists (core/stock.js) and the product catalog the 86 List shares (core/products.js).
// Routes: #/stock (my lists; managers: all open lists, templates, history) · #/stock/<id> (work a list, or watch it) ·
// #/stock/new · #/stock/new/template · #/stock/edit/<id> · #/stock/products · #/stock/products/review (managers).
// Who may do what is checked on the server; this page only hides buttons that wouldn't work. Photos are shrunk in the
// browser like the 86 List's (TrainingShared.jsx photoFromFile), uploaded one per request, served at /api/stock/photos/:id.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty } from '../ui.jsx';
import { IS_DEMO, call as rpc } from '../api.js';
import { photoFromFile } from './TrainingShared.jsx';
import { SmartImportButton } from './SmartImportButton.jsx';
import { useT, fmtTime, prettyDate, stamp } from '../i18n/index.js';
import '../stock.css';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const go = (path) => { location.hash = `#/stock${path ? `/${path}` : ''}`; };
const catName = (cats, id, lang) => { const c = (cats || []).find((x) => x.id === id); return c ? (lang === 'es' ? c.nameEs || c.name : c.name) : ''; };
const unitName = (units, id, lang) => { const u = (units || []).find((x) => x.id === id); return u ? u[lang === 'es' ? 'es' : 'en'] : id || ''; };
const listName86 = (l, lang) => (lang === 'es' && l?.nameEs ? l.nameEs : l?.name || '');

// ---------- photos ----------
const TILE_COLORS = { spirits: '#0e7490', beer: '#ca8a04', wine: '#be185d', mixers: '#0369a1', garnish: '#65a30d', glassware: '#475569', smallwares: '#57534e', paper: '#0f766e', cleaning: '#0891b2', dry: '#c2410c' };
/** A placeholder tile for a product without a photo: its initials on its category's color (an SVG data URL). */
export function productTile(name, category) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase().replace(/[<&>"]/g, '');
  const bg = TILE_COLORS[category] || '#64748b';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${bg}"/><text x="48" y="60" text-anchor="middle" font-family="sans-serif" font-size="36" font-weight="700" fill="#fff">${ini}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const demoPhotos = new Map();
/** One product photo (behind sign-in on a server; from the in-browser store in the demo), or its tile. */
export function ProductPhoto({ product, className = 'stk-photo', alt = '' }) {
  const id = product?.photos?.[0]?.id || null;
  const [src, setSrc] = useState(!id ? '' : IS_DEMO ? demoPhotos.get(id) || '' : `/api/stock/photos/${encodeURIComponent(id)}`);
  useEffect(() => {
    if (!id) { setSrc(''); return undefined; }
    if (!IS_DEMO) { setSrc(`/api/stock/photos/${encodeURIComponent(id)}`); return undefined; }
    if (demoPhotos.has(id)) { setSrc(demoPhotos.get(id)); return undefined; }
    let live = true;
    rpc('products.photo.get', { id }).then((r) => { demoPhotos.set(id, r.dataUrl); if (live) setSrc(r.dataUrl); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return <img className={className} src={src || productTile(product?.name, product?.category)} alt={alt} loading="lazy" decoding="async" draggable={false} />;
}
const rememberPhoto = (id, dataUrl) => { if (IS_DEMO && id) demoPhotos.set(id, dataUrl); };

// ---------- the page ----------
export default function Stock({ parts = [] }) {
  const t = useT();
  const { has } = useApp();
  const sub = parts[1] || '';
  const [cat, setCat] = useState(null); // products.list: who may do what, the review queue's size
  const { call, version } = useApp();
  useEffect(() => { call('products.list').then(setCat).catch(() => {}); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const inProducts = sub === 'products';
  return (
    <div className="stk">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={!inProducts} className={!inProducts ? 'on' : ''} onClick={() => go('')}><Icon name="check" size={16} />{t('stock.tabLists')}</button>
        <button role="tab" aria-selected={inProducts} className={inProducts ? 'on' : ''} onClick={() => go('products')}><Icon name="box" size={16} />{t('stock.tabProducts')}
          {cat?.newCount > 0 && <span className="count">{cat.newCount}</span>}</button>
      </div>
      {inProducts ? (parts[2] === 'review' && cat?.canManage ? <ReviewQueue /> : <Products cat={cat} />)
        : sub === 'new' ? <Builder template={parts[2] === 'template'} />
          : sub === 'edit' ? <Builder id={parts[2]} />
            : sub ? <ListView id={sub} has86={!has || has('eightySix')} /> : <Lists />}
    </div>
  );
}

// ---------- the lists ----------
function Progress({ counts }) {
  const t = useT();
  const pct = counts.lines ? Math.round((counts.done / counts.lines) * 100) : 0;
  return (
    <div className="stk-progress">
      <div className="stk-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('stock.progress', { done: counts.done, total: counts.lines })}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted num">{t('stock.progress', { done: counts.done, total: counts.lines })}</span>
      {counts.short > 0 && <span className="stk-pill short">{t('stock.nShort', { count: counts.short })}</span>}
      {counts.out > 0 && <span className="stk-pill out">{t('stock.nOut', { count: counts.out })}</span>}
    </div>
  );
}
function when(t, l) {
  const parts = [];
  if (l.date) parts.push(prettyDate(l.date));
  if (l.due) parts.push(t('stock.dueAt', { time: fmtTime(l.due) }));
  return parts.join(' · ');
}
function ListCard({ l, onUse }) {
  const t = useT();
  const open = () => go(l.id);
  return (
    <div className={`card stk-card ${l.status}`} >
      <button type="button" className="stk-card-main" onClick={l.kind === 'template' ? () => go(`edit/${l.id}`) : open}>
        <div className="stk-card-top">
          <span className="stk-card-name">{l.name}</span>
          {l.status === 'done' && <span className="badge ok">{t('stock.done')}</span>}
          {l.overdue && <span className="badge bad">{t('stock.overdue')}</span>}
          {l.personal && <span className="badge">{t('stock.personal')}</span>}
        </div>
        {l.kind === 'list' && <div className="small muted">{[l.assignLabel && t('stock.forWho', { who: l.assignLabel }), when(t, l)].filter(Boolean).join(' · ')}</div>}
        {l.kind === 'template' ? <div className="small muted">{t('stock.nProducts', { count: l.counts.lines })}</div> : <Progress counts={l.counts} />}
        {l.status === 'done' && l.doneBy && <div className="tiny faint">{t('stock.doneBy', { name: l.doneBy.name, when: stamp(l.doneAt) })}</div>}
      </button>
      {l.kind === 'template' && <div className="stk-card-foot"><button className="btn sm primary" onClick={() => onUse(l)}><Icon name="plus" />{t('stock.useTemplate')}</button></div>}
    </div>
  );
}

function Lists() {
  const t = useT();
  const { call, version, toast } = useApp();
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState(null);
  const [using, setUsing] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => call('stock.lists.list', { scope }).then((r) => { if (live) setData(r); }).catch((e) => toast(e.message, 'bad'));
    load();
    const timer = scope === 'all' ? setInterval(load, 10000) : null; // live progress for managers
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [scope, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const mgr = data?.canManage;
  const scopes = [['mine', t('stock.scopeMine')], ...(mgr ? [['all', t('stock.scopeAll')], ['templates', t('stock.scopeTemplates')]] : []), ['history', t('stock.scopeHistory')]];
  return (
    <>
      <div className="stk-head">
        <div className="stk-head-text">
          <h2>{t('stock.title')}</h2>
          <div className="small muted">{mgr ? t('stock.introMgr') : t('stock.intro')}</div>
        </div>
        {(mgr || data?.canOwn) && (
          <div className="stk-head-btns">
            {mgr && scope === 'templates'
              ? <button className="btn primary" onClick={() => go('new/template')}><Icon name="plus" />{t('stock.newTemplate')}</button>
              : <button className="btn primary" onClick={() => go('new')}><Icon name="plus" />{t('stock.newList')}</button>}
          </div>
        )}
      </div>
      <div className="stk-chips">
        {scopes.map(([k, label]) => <button key={k} type="button" className={`chip ${scope === k ? 'on' : ''}`} aria-pressed={scope === k} onClick={() => setScope(k)}>{label}</button>)}
      </div>
      {!data ? <div className="empty">{t('common.loading')}</div> : !data.lists.length ? (
        <Empty icon="box" title={scope === 'mine' ? t('stock.noneMine') : scope === 'templates' ? t('stock.noneTemplates') : scope === 'history' ? t('stock.noneHistory') : t('stock.noneAll')} />
      ) : <div className="stk-grid">{data.lists.map((l) => <ListCard key={l.id} l={l} onUse={setUsing} />)}</div>}
      {using && <AssignDialog title={t('stock.useTemplateTitle', { name: using.name })} start={{ date: data.today }} onClose={() => setUsing(null)}
        onSave={async (a) => { const r = await call('stock.fromTemplate', { templateId: using.id, ...a }); toast(r.notified ? t('stock.createdTold', { count: r.notified }) : t('stock.created')); go(r.id); }} />}
    </>
  );
}

/** Who a list is for (a person, a position that day, a room's shift that day, or nobody yet), the date and the due time. */
function AssignDialog({ title, start = {}, onClose, onSave }) {
  const t = useT();
  const { call, toast } = useApp();
  const [opts, setOpts] = useState(null);
  const [a, setA] = useState({ type: start.assign?.type || 'person', userId: start.assign?.userId || '', jobCodeId: start.assign?.jobCodeId || '', room: start.assign?.room || '' });
  const [date, setDate] = useState(start.date || '');
  const [due, setDue] = useState(start.due || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('stock.options.get').then((o) => { setOpts(o); if (!date) setDate(o.today); }).catch((e) => toast(e.message, 'bad')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const assign = a.type === 'person' ? (a.userId ? { type: 'person', userId: a.userId } : null) : a.type === 'position' ? (a.jobCodeId ? { type: 'position', jobCodeId: a.jobCodeId } : null)
    : a.type === 'room' ? (a.room ? { type: 'room', room: a.room } : null) : null;
  const save = async () => {
    setBusy(true);
    try { await onSave({ assign, date, due }); onClose(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy} onClick={save}>{t('stock.assignSave')}</button></>}>
      {!opts ? <div className="empty">{t('common.loading')}</div> : <AssignFields opts={opts} a={a} setA={setA} date={date} setDate={setDate} due={due} setDue={setDue} />}
    </Modal>
  );
}
function AssignFields({ opts, a, setA, date, setDate, due, setDue }) {
  const t = useT();
  const types = [['person', t('stock.toPerson')], ['position', t('stock.toPosition')], ['room', t('stock.toRoom')], ['none', t('stock.toNobody')]].filter(([k]) => k !== 'room' || opts.rooms.length);
  return (
    <>
      <div className="field">
        <span>{t('stock.assignTo')}</span>
        <div className="stk-chips tight">
          {types.map(([k, label]) => <button key={k} type="button" className={`chip ${a.type === k ? 'on' : ''}`} aria-pressed={a.type === k} onClick={() => setA({ ...a, type: k })}>{label}</button>)}
        </div>
      </div>
      {a.type === 'person' && (
        <Field label={t('stock.person')}>
          <select className="input" value={a.userId} onChange={(e) => setA({ ...a, userId: e.target.value })}>
            <option value="">{t('stock.pickPerson')}</option>
            {opts.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      {a.type === 'position' && (
        <Field label={t('stock.position')} help={t('stock.positionHelp')}>
          <select className="input" value={a.jobCodeId} onChange={(e) => setA({ ...a, jobCodeId: e.target.value })}>
            <option value="">{t('stock.pickPosition')}</option>
            {opts.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      {a.type === 'room' && (
        <Field label={t('stock.room')} help={t('stock.roomHelp')}>
          <select className="input" value={a.room} onChange={(e) => setA({ ...a, room: e.target.value })}>
            <option value="">{t('stock.pickRoom')}</option>
            {opts.rooms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
      )}
      <div className="stk-two">
        <Field label={t('stock.date')}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={t('stock.due')}><input className="input" type="time" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
    </>
  );
}

// ---------- one list: work it, or watch it ----------
function ListView({ id, has86 }) {
  const t = useT();
  const { call, toast, version, viewAs } = useApp();
  const [l, setL] = useState(null);
  const [err, setErr] = useState('');
  const [reassign, setReassign] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    call('stock.list.get', { id }).then((r) => { if (live) setL(r); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id, version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live: someone else may be working it (a position's barbacks, or the manager watching).
  useEffect(() => {
    if (!l || l.status === 'done' || l.kind !== 'list') return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 8000);
    return () => clearInterval(timer);
  }, [l?.status, l?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <Empty icon="alert" title={err}><a className="btn sm" href="#/stock">{t('stock.backToLists')}</a></Empty>;
  if (!l) return <div className="empty">{t('common.loading')}</div>;
  const act = async (method, args, done) => {
    try { const r = await call(method, { id: l.id, ...args }); setL(r.lines ? r : l); if (done) toast(typeof done === 'function' ? done(r) : done); return r; } catch (e) { toast(e.message, 'bad'); return null; }
  };
  const working = l.canWork && !viewAs;
  return (
    <>
      <a className="stk-back small" href="#/stock"><Icon name="left" size={14} />{t('stock.backToLists')}</a>
      <div className="card card-pad stk-top">
        <div className="stk-card-top">
          <h2 className="stk-title">{l.name}</h2>
          {l.status === 'done' && <span className="badge ok">{t('stock.done')}</span>}
          {l.overdue && <span className="badge bad">{t('stock.overdue')}</span>}
        </div>
        {l.kind === 'list' && <div className="small muted">{[l.assignLabel && t('stock.forWho', { who: l.assignLabel }), when(t, l)].filter(Boolean).join(' · ')}</div>}
        {l.kind === 'list' && l.assign?.type !== 'person' && l.assignees.length > 0 && <div className="tiny faint">{t('stock.whoToday', { names: l.assignees.map((x) => x.name).join(', ') })}</div>}
        {l.notes && <div className="stk-notes">{l.notes}</div>}
        {l.kind === 'list' && <Progress counts={l.counts} />}
        {l.canManage && !viewAs && (
          <div className="stk-actions">
            {l.kind === 'list' && <button className="btn sm" onClick={() => setReassign(true)}><Icon name="users" />{t('stock.reassign')}</button>}
            <button className="btn sm" onClick={() => go(`edit/${l.id}`)}><Icon name="edit" />{t('common.edit')}</button>
            {l.kind === 'list' && <button className="btn sm" onClick={() => act('stock.saveAsTemplate', { name: l.name }, t('stock.templateSaved'))}><Icon name="copy" />{t('stock.saveAsTemplate')}</button>}
            <button className="btn sm danger" onClick={async () => { if (window.confirm(t('stock.deleteConfirm'))) { try { await call('stock.delete', { id: l.id }); go(''); } catch (e) { toast(e.message, 'bad'); } } }}><Icon name="trash" />{t('stock.delete')}</button>
          </div>
        )}
      </div>
      {l.status === 'done' && <div className="alert ok stk-done-msg"><Icon name="check" size={16} />{t('stock.allDone', { name: l.doneBy?.name || '', when: stamp(l.doneAt) })}</div>}
      <div className="stk-lines">
        {l.lines.map((x) => <LineCard key={x.id} x={x} working={working && l.kind === 'list'} has86={has86} onAct={act} />)}
      </div>
      {l.kind === 'list' && l.log?.length > 0 && <HistoryLog log={l.log} />}
      {reassign && <AssignDialog title={t('stock.reassignTitle', { name: l.name })} start={{ assign: l.assign, date: l.date, due: l.due }} onClose={() => setReassign(false)}
        onSave={async (a) => { const r = await call('stock.assign', { id: l.id, ...a }); setL(r); toast(r.notified ? t('stock.reassignedTold', { count: r.notified }) : t('stock.reassigned')); }} />}
    </>
  );
}

function LineCard({ x, working, has86, onAct }) {
  const t = useT();
  const [short, setShort] = useState(false);
  const [brought, setBrought] = useState('');
  const [big, setBig] = useState(false);
  const qty = `${x.qty}${x.unitName ? ` ${x.unitName}` : ''}`;
  const mark = (state, extra = {}) => onAct('stock.mark', { lineId: x.id, state, ...extra });
  const report = (status) => onAct('stock.reportEightySix', { lineId: x.id, status }, (r) => (status === 'out' ? t('stock.reportedOut', { name: x.name, list: r.eightySix.listName }) : t('stock.reportedLow', { name: x.name, list: r.eightySix.listName })));
  return (
    <div className={`card stk-line ${x.state || 'todo'}`}>
      <div className="stk-line-row">
        <button type="button" className="stk-line-photo" onClick={() => setBig(true)} aria-label={t('stock.seePhoto', { name: x.name })}>
          <ProductPhoto product={{ name: x.name, category: x.category, photos: x.photos }} alt={x.name} />
        </button>
        <div className="stk-line-text">
          <div className="stk-line-name">{x.name}{x.size && <span className="faint"> · {x.size}</span>}</div>
          <div className="stk-line-qty">{t('stock.bring', { qty })}</div>
          {x.location && <div className="small muted stk-line-loc"><Icon name="pin" size={13} />{x.location}</div>}
          {x.note && <div className="small"><i>{x.note}</i></div>}
          {x.review === 'new' && <div className="tiny faint">{t('stock.newProduct')}</div>}
        </div>
        {x.state && <span className={`stk-pill ${x.state}`}>{x.state === 'got' ? t('stock.got') : x.state === 'short' ? t('stock.shortN', { n: x.brought }) : t('stock.out')}</span>}
      </div>
      {x.state && x.by && <div className="tiny faint stk-line-who">{x.by.name} · {stamp(x.at)}</div>}
      {working && !x.state && !short && (
        <div className="stk-btns">
          <button className="btn stk-got" onClick={() => mark('got')}><Icon name="check" />{t('stock.gotIt')}</button>
          <button className="btn stk-short" onClick={() => setShort(true)}>{t('stock.short')}</button>
          <button className="btn stk-out" onClick={() => mark('out')}><Icon name="ban" />{t('stock.out')}</button>
        </div>
      )}
      {working && short && !x.state && (
        <div className="stk-short-row">
          <label className="field stk-short-field"><span>{t('stock.howManyBrought', { qty })}</span>
            <input className="input" type="number" inputMode="decimal" min="0" step="any" value={brought} autoFocus onChange={(e) => setBrought(e.target.value)} /></label>
          <button className="btn primary" onClick={async () => { const r = await mark('short', { brought }); if (r) setShort(false); }}>{t('common.save')}</button>
          <button className="btn ghost" onClick={() => setShort(false)}>{t('common.cancel')}</button>
        </div>
      )}
      {working && x.state && (
        <div className="stk-after">
          {has86 && x.state === 'out' && x.eightySix && !x.reported86 && (
            <button className="btn danger solid stk-86" onClick={() => report('out')}><Icon name="ban" />{t('stock.reportOut', { list: listName86(x.eightySix, t.lang) })}</button>
          )}
          {has86 && x.state === 'short' && x.eightySix && !x.reported86 && (
            <button className="btn stk-86 low" onClick={() => report('low')}>{t('stock.reportLow', { list: listName86(x.eightySix, t.lang) })}</button>
          )}
          {x.reported86 && <span className="small stk-on86"><span className="e86-tag">86</span>{x.reported86.status === 'out' ? t('stock.on86Out', { list: x.reported86.listName }) : t('stock.on86Low', { list: x.reported86.listName })}</span>}
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => mark(null)}>{t('common.undo')}</button>
        </div>
      )}
      {!working && x.reported86 && <div className="small stk-on86"><span className="e86-tag">86</span>{x.reported86.status === 'out' ? t('stock.on86Out', { list: x.reported86.listName }) : t('stock.on86Low', { list: x.reported86.listName })}</div>}
      {big && (
        <div className="e86-viewer" role="dialog" aria-modal="true" aria-label={x.name} onClick={() => setBig(false)}>
          <div className="e86-viewer-top"><span className="e86-viewer-title">{x.name}</span><button type="button" className="btn ghost icon" aria-label={t('common.close')}><Icon name="x" /></button></div>
          <div className="e86-viewer-img"><ProductPhoto product={{ name: x.name, category: x.category, photos: x.photos }} className="" alt={x.name} /></div>
        </div>
      )}
    </div>
  );
}

function HistoryLog({ log }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const what = (e) => {
    if (e.what === 'created') return t('stock.logCreated', { name: e.byName });
    if (e.what === 'edited') return t('stock.logEdited', { name: e.byName });
    if (e.what === 'reassigned') return t('stock.logReassigned', { name: e.byName, to: e.to || '—' });
    if (e.what === 'reported86') return t(e.state === 'out' ? 'stock.logReportedOut' : 'stock.logReportedLow', { name: e.byName, product: e.product, list: e.to });
    if (!e.state) return t('stock.logUndo', { name: e.byName, product: e.product });
    if (e.state === 'short') return t('stock.logShort', { name: e.byName, product: e.product, n: e.brought });
    return t(e.state === 'got' ? 'stock.logGot' : 'stock.logOut', { name: e.byName, product: e.product });
  };
  const shown = open ? [...log].reverse() : [...log].reverse().slice(0, 4);
  return (
    <div className="card section">
      <div className="card-head"><h2>{t('stock.historyTitle')}</h2></div>
      <div className="list">
        {shown.map((e, i) => <div key={i} className="list-item stk-log"><span className="tiny faint stk-log-at">{stamp(e.at)}</span><span className="small">{what(e)}</span></div>)}
      </div>
      {log.length > 4 && <div className="card-pad"><button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? t('stock.showLess') : t('stock.showAll', { count: log.length })}</button></div>}
    </div>
  );
}

// ---------- making a list or a template ----------
function Builder({ id = '', template = false }) {
  const t = useT();
  const { call, toast } = useApp();
  const [cat, setCat] = useState(null);
  const [opts, setOpts] = useState(null);
  const [cur, setCur] = useState(id ? null : { kind: template ? 'template' : 'list', name: '', notes: '', lines: [], date: '', due: '', assign: null });
  const [lines, setLines] = useState([]);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [a, setA] = useState({ type: 'person', userId: '', jobCodeId: '', room: '' });
  const [date, setDate] = useState('');
  const [due, setDue] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('products.list').then(setCat).catch((e) => toast(e.message, 'bad'));
    call('stock.options.get').then((o) => { setOpts(o); if (!id) setDate(o.today); }).catch(() => {});
    if (id) {
      call('stock.list.get', { id }).then((l) => {
        setCur(l); setName(l.name); setNotes(l.notes); setDate(l.date); setDue(l.due);
        setLines(l.lines.map((x) => ({ id: x.id, productId: x.productId, qty: x.qty, note: x.note })));
        if (l.assign) setA({ type: l.assign.type, userId: l.assign.userId || '', jobCodeId: l.assign.jobCodeId || '', room: l.assign.room || '' });
        else setA({ type: 'none', userId: '', jobCodeId: '', room: '' });
      }).catch((e) => toast(e.message, 'bad'));
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => Object.fromEntries((cat?.products || []).map((p) => [p.id, p])), [cat]);
  if (!cur || !cat || !opts) return <div className="empty">{t('common.loading')}</div>;
  const isTemplate = cur.kind === 'template';
  const mgr = opts.canManage;
  const words = norm(q).split(' ').filter(Boolean);
  const results = words.length ? cat.products.filter((p) => words.every((w) => norm(`${p.name} ${p.size} ${p.location} ${catName(cat.categories, p.category, t.lang)}`).includes(w))).slice(0, 12) : [];
  const add = (p) => {
    setLines((ls) => (ls.some((x) => x.productId === p.id) ? ls.map((x) => (x.productId === p.id ? { ...x, qty: x.qty + 1 } : x)) : [...ls, { productId: p.id, qty: 1, note: '' }]));
    setQ('');
  };
  const setLine = (i, patch) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const assign = a.type === 'person' ? (a.userId ? { type: 'person', userId: a.userId } : null) : a.type === 'position' ? (a.jobCodeId ? { type: 'position', jobCodeId: a.jobCodeId } : null)
    : a.type === 'room' ? (a.room ? { type: 'room', room: a.room } : null) : null;
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('stock.save', { ...(id ? { id } : { kind: isTemplate ? 'template' : 'list' }), name, notes, lines,
        ...(isTemplate ? {} : { date, due, ...(mgr ? { assign } : {}) }) });
      toast(r.notified ? t('stock.createdTold', { count: r.notified }) : id ? t('stock.saved') : t('stock.created'));
      go(r.id);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <>
      <a className="stk-back small" href={id ? `#/stock/${id}` : '#/stock'}><Icon name="left" size={14} />{t('stock.back')}</a>
      <h2 className="stk-title">{id ? (isTemplate ? t('stock.editTemplate') : t('stock.editList')) : isTemplate ? t('stock.newTemplate') : t('stock.newList')}</h2>
      <div className="card card-pad stk-form">
        <Field label={t('stock.listName')}><input className="input" value={name} maxLength={60} placeholder={isTemplate ? t('stock.templateNamePh') : t('stock.listNamePh')} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('stock.notes')}><input className="input" value={notes} maxLength={300} placeholder={t('stock.notesPh')} onChange={(e) => setNotes(e.target.value)} /></Field>
        {!isTemplate && mgr && <AssignFields opts={opts} a={a} setA={setA} date={date} setDate={setDate} due={due} setDue={setDue} />}
        {!isTemplate && !mgr && (
          <div className="stk-two">
            <Field label={t('stock.date')}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t('stock.due')}><input className="input" type="time" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
        )}
      </div>
      <div className="card card-pad stk-form">
        <h3>{t('stock.productsOnList', { count: lines.length })}</h3>
        <label className="stk-search">
          <Icon name="search" size={18} />
          <input className="input" type="search" value={q} placeholder={t('stock.searchProducts')} aria-label={t('stock.searchProducts')} onChange={(e) => setQ(e.target.value)} />
        </label>
        {words.length > 0 && (
          <div className="stk-results">
            {results.map((p) => (
              <button key={p.id} type="button" className="stk-result" onClick={() => add(p)}>
                <ProductPhoto product={p} className="stk-thumb" />
                <span className="stk-result-text"><b>{p.name}</b>{p.size ? ` · ${p.size}` : ''}<span className="tiny faint">{[catName(cat.categories, p.category, t.lang), p.location].filter(Boolean).join(' · ')}</span></span>
                <Icon name="plus" size={18} />
              </button>
            ))}
            <button type="button" className="stk-result typed" onClick={() => setAdding(true)}><Icon name="plus" size={18} /><span className="stk-result-text">{t('stock.addNewProduct', { name: q.trim() })}</span></button>
          </div>
        )}
        {!words.length && <button type="button" className="btn sm" onClick={() => setAdding(true)}><Icon name="camera" />{t('stock.addProductOnFly')}</button>}
        <div className="stk-picked">
          {lines.map((x, i) => {
            const p = byId[x.productId] || { name: '?', photos: [] };
            return (
              <div key={x.productId} className="stk-picked-row">
                <ProductPhoto product={p} className="stk-thumb" />
                <div className="stk-picked-text"><b>{p.name}</b>{p.unit && <span className="tiny faint">{unitName(cat.units, p.unit, t.lang)}</span>}
                  <input className="input stk-note" value={x.note} maxLength={140} placeholder={t('stock.linePh')} aria-label={t('stock.lineNote', { name: p.name })} onChange={(e) => setLine(i, { note: e.target.value })} /></div>
                <div className="stk-qty">
                  <button type="button" className="btn sm icon" aria-label={t('stock.less')} onClick={() => setLine(i, { qty: Math.max(1, x.qty - 1) })}>−</button>
                  <input className="input num" type="number" inputMode="decimal" min="1" value={x.qty} aria-label={t('stock.howMany', { name: p.name })} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 1 })} />
                  <button type="button" className="btn sm icon" aria-label={t('stock.more')} onClick={() => setLine(i, { qty: x.qty + 1 })}>+</button>
                </div>
                <button type="button" className="btn sm ghost icon" aria-label={t('stock.removeLine', { name: p.name })} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Icon name="x" /></button>
              </div>
            );
          })}
          {!lines.length && <div className="small faint">{t('stock.noLinesYet')}</div>}
        </div>
      </div>
      <div className="stk-save">
        <button className="btn primary block" disabled={busy || !name.trim() || !lines.length} onClick={save}>{isTemplate ? t('stock.saveTemplate') : id ? t('stock.saveList') : t('stock.createList')}</button>
      </div>
      {adding && <AddProduct start={q.trim()} cat={cat} onClose={() => setAdding(false)}
        onPicked={(p) => { setCat((c) => (c.products.some((x) => x.id === p.id) ? c : { ...c, products: [...c.products, p] })); add(p); setAdding(false); }} />}
    </>
  );
}

// ---------- adding a product (anyone) ----------
/**
 * A name (and maybe a photo from the camera or the library) is enough. As the name is typed, likely duplicates show
 * with their photos and "Use this one". onPicked(product): the new one, or the existing one they chose.
 */
export function AddProduct({ start = '', cat, onClose, onPicked }) {
  const t = useT();
  const { call, toast } = useApp();
  const [name, setName] = useState(start);
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('');
  const [size, setSize] = useState('');
  const [location, setLocation] = useState('');
  const [matches, setMatches] = useState([]);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const cam = useRef(null);
  const lib = useRef(null);
  useEffect(() => {
    if (!name.trim()) { setMatches([]); return undefined; }
    const timer = setTimeout(() => { call('products.matches.get', { name }).then((r) => setMatches(r.matches)).catch(() => {}); }, 250);
    return () => clearTimeout(timer);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (files) => {
    const f = files?.[0];
    if (!f) return;
    try { setPhoto(await photoFromFile(f)); } catch (e) { toast(e.message === 'big' ? t('stock.photoBig') : t('stock.photoBad'), 'bad'); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('products.add', { name, ...(category ? { category } : {}), unit, size, location, force: true });
      let p = r.product;
      if (photo) {
        try { const up = await call('products.addPhoto', { id: p.id, dataUrl: photo.dataUrl, w: photo.w, h: photo.h }); rememberPhoto(up.photo.id, photo.dataUrl); p = up.product; } catch (e) { toast(t('stock.photoFailed', { error: e.message }), 'bad'); }
      }
      toast(t('stock.productAdded', { name: p.name }));
      onPicked(p);
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('stock.addProduct')} sub={t('stock.addProductSub')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !name.trim()} onClick={save}>{matches.length ? t('stock.addAnyway') : t('stock.addIt')}</button></>}>
      <Field label={t('stock.productName')}><input className="input" value={name} maxLength={80} autoFocus placeholder={t('stock.productNamePh')} onChange={(e) => setName(e.target.value)} /></Field>
      {matches.length > 0 && (
        <div className="stk-dups" role="status">
          <div className="small"><b>{t('stock.alreadyHave')}</b></div>
          {matches.map((m) => (
            <div key={m.id} className="stk-dup">
              <ProductPhoto product={m} className="stk-thumb" />
              <span className="stk-result-text"><b>{m.name}</b><span className="tiny faint">{[m.size, m.location, m.review === 'new' && m.addedBy && t('stock.addedBy', { name: m.addedBy.name })].filter(Boolean).join(' · ')}</span></span>
              <button type="button" className="btn sm primary" onClick={() => onPicked(m)}>{t('stock.useThis')}</button>
            </div>
          ))}
        </div>
      )}
      <div className="field">
        <span>{t('stock.photo')}</span>
        <div className="stk-photo-pick">
          {photo ? (
            <div className="e86-pick-thumb"><img src={photo.dataUrl} alt="" /><button type="button" className="e86-pick-x" onClick={() => setPhoto(null)} aria-label={t('stock.removePhoto')}><Icon name="x" size={14} /></button></div>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => cam.current?.click()}><Icon name="camera" />{t('stock.takePhoto')}</button>
              <button type="button" className="btn" onClick={() => lib.current?.click()}><Icon name="upload" />{t('stock.choosePhoto')}</button>
            </>
          )}
          <input ref={cam} type="file" accept="image/*" capture="environment" hidden data-testid="stock-camera" onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
          <input ref={lib} type="file" accept="image/*" hidden data-testid="stock-library" onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
        </div>
      </div>
      <div className="stk-two">
        <Field label={t('stock.category')}>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('stock.pickCategory')}</option>
            {(cat?.categories || []).map((c) => <option key={c.id} value={c.id}>{catName(cat.categories, c.id, t.lang)}</option>)}
          </select>
        </Field>
        <Field label={t('stock.unit')}>
          <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">—</option>
            {(cat?.units || []).map((u) => <option key={u.id} value={u.id}>{u[t.lang === 'es' ? 'es' : 'en']}</option>)}
          </select>
        </Field>
      </div>
      <div className="stk-two">
        <Field label={t('stock.size')}><input className="input" value={size} maxLength={30} placeholder={t('stock.sizePh')} onChange={(e) => setSize(e.target.value)} /></Field>
        <Field label={t('stock.location')}><input className="input" value={location} maxLength={80} placeholder={t('stock.locationPh')} onChange={(e) => setLocation(e.target.value)} /></Field>
      </div>
      <div className="help">{t('stock.addHelp')}</div>
    </Modal>
  );
}

// ---------- the catalog ----------
function Products({ cat: first }) {
  const t = useT();
  const { call, version, toast, viewAs } = useApp();
  const [cat, setCat] = useState(first);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const [cats, setCats] = useState(false);
  const [archived, setArchived] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { call('products.list', { archived }).then(setCat).catch((e) => toast(e.message, 'bad')); }, [version, tick, archived]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cat) return <div className="empty">{t('common.loading')}</div>;
  const words = norm(q).split(' ').filter(Boolean);
  const shown = cat.products.filter((p) => (!filter || p.category === filter) && words.every((w) => norm(`${p.name} ${p.size} ${p.location} ${p.supplier}`).includes(w)));
  const used = new Set(cat.products.map((p) => p.category));
  return (
    <>
      <div className="stk-head">
        <div className="stk-head-text">
          <h2>{t('stock.productsTitle')}</h2>
          <div className="small muted">{cat.canManage ? t('stock.productsIntroMgr') : t('stock.productsIntro')}</div>
        </div>
        {!viewAs && (
          <div className="stk-head-btns">
            {cat.canManage && cat.newCount > 0 && <a className="btn" href="#/stock/products/review"><Icon name="inbox" />{t('stock.reviewN', { count: cat.newCount })}</a>}
            <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('stock.addProduct')}</button>
          </div>
        )}
      </div>
      <label className="stk-search">
        <Icon name="search" size={18} />
        <input className="input" type="search" value={q} placeholder={t('stock.searchProducts')} aria-label={t('stock.searchProducts')} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="stk-chips">
        <button type="button" className={`chip ${!filter ? 'on' : ''}`} onClick={() => setFilter('')}>{t('stock.allCategories')}</button>
        {cat.categories.filter((c) => used.has(c.id)).map((c) => (
          <button key={c.id} type="button" className={`chip ${filter === c.id ? 'on' : ''}`} aria-pressed={filter === c.id} onClick={() => setFilter(filter === c.id ? '' : c.id)}>{catName(cat.categories, c.id, t.lang)}</button>
        ))}
      </div>
      {!shown.length ? <Empty icon="box" title={t('stock.noProducts')} /> : (
        <div className="card stk-catalog">
          {shown.map((p) => (
            <button key={p.id} type="button" className={`stk-prod ${p.status}`} onClick={() => setOpen(p)}>
              <ProductPhoto product={p} className="stk-thumb lg" alt="" />
              <span className="stk-result-text">
                <b>{p.name}</b>
                <span className="small muted">{[p.size, p.unit && unitName(cat.units, p.unit, t.lang), catName(cat.categories, p.category, t.lang)].filter(Boolean).join(' · ')}</span>
                {p.location && <span className="tiny faint stk-line-loc"><Icon name="pin" size={12} />{p.location}</span>}
                {p.review === 'new' && p.addedBy && <span className="badge brand stk-added">{t('stock.addedBy', { name: p.addedBy.name })}</span>}
                {p.status === 'archived' && <span className="badge">{t('stock.archived')}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {cat.canManage && !viewAs && (
        <div className="stk-mgr-links">
          <button className="btn sm ghost" onClick={() => setCats(true)}><Icon name="settings" />{t('stock.categories')}</button>
          <button className="btn sm ghost" onClick={() => setArchived(!archived)}>{archived ? t('stock.hideArchived') : t('stock.showArchived')}</button>
          <SmartImportButton target="products" className="btn sm ghost" />
        </div>
      )}
      {adding && <AddProduct cat={cat} onClose={() => setAdding(false)} onPicked={(p) => { setAdding(false); setTick((n) => n + 1); setOpen(p); }} />}
      {open && <ProductDialog id={open.id} cat={cat} onClose={() => setOpen(null)} onChanged={() => setTick((n) => n + 1)} />}
      {cats && <CategoriesDialog cats={cat.categories} onClose={() => setCats(false)} onSaved={() => { setCats(false); setTick((n) => n + 1); }} />}
    </>
  );
}

function ProductDialog({ id, cat, onClose, onChanged }) {
  const t = useT();
  const { call, toast, viewAs } = useApp();
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [merging, setMerging] = useState(false);
  const file = useRef(null);
  const load = () => call('products.get', { id }).then((r) => { setD(r); setF({ ...r.product, pars: { ...r.product.pars } }); }).catch((e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d || !f) return <Modal title={t('common.loading')} onClose={onClose}><div className="empty">{t('common.loading')}</div></Modal>;
  const p = d.product;
  const edit = p.canEdit && !viewAs;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      await call('products.save', { id: p.id, name: f.name, category: f.category, unit: f.unit, size: f.size, location: f.location, supplier: f.supplier, notes: f.notes,
        ...(cat.canManage ? { pars: f.pars } : {}) });
      toast(t('stock.saved')); onChanged(); onClose();
    } catch (e) { toast(e.message, 'bad'); }
  };
  const run = async (method, args, msg) => { try { await call(method, args); toast(msg); onChanged(); load(); } catch (e) { toast(e.message, 'bad'); } };
  const addPhoto = async (files) => {
    const fl = files?.[0];
    if (!fl) return;
    try {
      const ph = await photoFromFile(fl);
      const up = await call('products.addPhoto', { id: p.id, dataUrl: ph.dataUrl, w: ph.w, h: ph.h });
      rememberPhoto(up.photo.id, ph.dataUrl); onChanged(); load();
    } catch (e) { toast(e.message === 'big' ? t('stock.photoBig') : e.message === 'bad' ? t('stock.photoBad') : e.message, 'bad'); }
  };
  const canAddPhoto = !viewAs && (p.canEdit || !p.photos.length) && p.photos.length < 3 && p.status !== 'archived';
  return (
    <Modal title={p.name} sub={p.addedBy ? t('stock.addedByWhen', { name: p.addedBy.name, when: stamp(p.addedAt) }) : p.source === 'migration' ? t('stock.fromThe86') : null} onClose={onClose}
      footer={edit ? <><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></> : null}>
      <div className="stk-photos">
        {p.photos.map((ph) => (
          <div key={ph.id} className="e86-pick-thumb stk-photo-lg">
            <ProductPhoto product={{ ...p, photos: [ph] }} className="" />
            {ph.canRemove && !viewAs && <button type="button" className="e86-pick-x" onClick={() => run('products.removePhoto', { id: p.id, photoId: ph.id }, t('stock.photoRemoved'))} aria-label={t('stock.removePhoto')}><Icon name="x" size={14} /></button>}
          </div>
        ))}
        {!p.photos.length && <ProductPhoto product={p} className="stk-photo-lg" />}
        {canAddPhoto && <button type="button" className="e86-pick-add" onClick={() => file.current?.click()} aria-label={t('stock.addPhoto')}><Icon name="camera" size={20} /><span>{t('stock.photo')}</span></button>}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { addPhoto(e.target.files); e.target.value = ''; }} />
      </div>
      {edit ? (
        <>
          <Field label={t('stock.productName')}><input className="input" value={f.name} maxLength={80} onChange={set('name')} /></Field>
          <div className="stk-two">
            <Field label={t('stock.category')}><select className="input" value={f.category} onChange={set('category')}>{cat.categories.map((c) => <option key={c.id} value={c.id}>{catName(cat.categories, c.id, t.lang)}</option>)}</select></Field>
            <Field label={t('stock.unit')}><select className="input" value={f.unit} onChange={set('unit')}><option value="">—</option>{cat.units.map((u) => <option key={u.id} value={u.id}>{u[t.lang === 'es' ? 'es' : 'en']}</option>)}{f.unit && !cat.units.some((u) => u.id === f.unit) && <option value={f.unit}>{f.unit}</option>}</select></Field>
          </div>
          <div className="stk-two">
            <Field label={t('stock.size')}><input className="input" value={f.size} maxLength={30} onChange={set('size')} /></Field>
            <Field label={t('stock.location')}><input className="input" value={f.location} maxLength={80} placeholder={t('stock.locationPh')} onChange={set('location')} /></Field>
          </div>
          <Field label={t('stock.supplier')}><input className="input" value={f.supplier} maxLength={80} onChange={set('supplier')} /></Field>
          <Field label={t('stock.productNotes')}><input className="input" value={f.notes} maxLength={300} onChange={set('notes')} /></Field>
          {cat.canManage && (
            <div className="field">
              <span>{t('stock.pars')}</span>
              <div className="help">{t('stock.parsHelp')}</div>
              <div className="stk-pars">
                {['', ...cat.areas].map((area) => (
                  <label key={area || '_'} className="stk-par"><span className="small">{area || t('stock.parDefault')}</span>
                    <input className="input num" type="number" inputMode="decimal" min="0" value={f.pars[area] ?? ''} onChange={(e) => setF({ ...f, pars: { ...f.pars, [area]: e.target.value } })} /></label>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="stk-facts small">
          {[[t('stock.category'), catName(cat.categories, p.category, t.lang)], [t('stock.unit'), unitName(cat.units, p.unit, t.lang)], [t('stock.size'), p.size], [t('stock.location'), p.location], [t('stock.supplier'), p.supplier], [t('stock.productNotes'), p.notes]]
            .filter(([, v]) => v).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {v}</div>)}
        </div>
      )}
      <div className="tiny faint">{t('stock.usage', { lists: d.usage.lists, reports: d.usage.eightySix })}</div>
      {cat.canManage && !viewAs && (
        <div className="stk-actions">
          {p.review === 'new' && <button className="btn sm ok" onClick={() => run('products.approve', { id: p.id }, t('stock.approved'))}><Icon name="check" />{t('stock.approve')}</button>}
          {p.status !== 'archived' && <button className="btn sm" onClick={() => setMerging(true)}><Icon name="layers" />{t('stock.merge')}</button>}
          {p.status !== 'archived' ? <button className="btn sm danger" onClick={() => run('products.archive', { id: p.id, archived: true }, t('stock.archivedMsg'))}><Icon name="trash" />{t('stock.archive')}</button>
            : !p.mergedInto && <button className="btn sm" onClick={() => run('products.archive', { id: p.id, archived: false }, t('stock.restored'))}>{t('stock.restore')}</button>}
        </div>
      )}
      {merging && <MergeDialog product={p} suggestions={d.matches} cat={cat} onClose={() => setMerging(false)} onDone={() => { setMerging(false); onChanged(); onClose(); }} />}
    </Modal>
  );
}

/** Merge a product into another: its list lines, 86 reports and photos move to the one kept. */
function MergeDialog({ product, suggestions = [], cat, onClose, onDone }) {
  const t = useT();
  const { call, toast } = useApp();
  const [q, setQ] = useState('');
  const [into, setInto] = useState(suggestions[0] || null);
  const words = norm(q).split(' ').filter(Boolean);
  const results = (words.length ? cat.products.filter((p) => p.id !== product.id && words.every((w) => norm(p.name).includes(w))) : suggestions).slice(0, 8);
  const go2 = async () => {
    try {
      const r = await call('products.merge', { keepId: into.id, mergeId: product.id });
      toast(t('stock.merged', { name: product.name, into: r.product.name, lines: r.moved.lines, reports: r.moved.eightySix }));
      onDone();
    } catch (e) { toast(e.message, 'bad'); }
  };
  return (
    <Modal title={t('stock.mergeTitle', { name: product.name })} sub={t('stock.mergeSub')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={!into} onClick={go2}>{into ? t('stock.mergeInto', { name: into.name }) : t('stock.merge')}</button></>}>
      <label className="stk-search"><Icon name="search" size={18} /><input className="input" type="search" value={q} placeholder={t('stock.mergeSearch')} aria-label={t('stock.mergeSearch')} onChange={(e) => setQ(e.target.value)} /></label>
      {!words.length && suggestions.length > 0 && <div className="tiny faint">{t('stock.likelySame')}</div>}
      <div className="stk-results">
        {results.map((p) => (
          <button key={p.id} type="button" className={`stk-result ${into?.id === p.id ? 'on' : ''}`} aria-pressed={into?.id === p.id} onClick={() => setInto(p)}>
            <ProductPhoto product={p} className="stk-thumb" />
            <span className="stk-result-text"><b>{p.name}</b><span className="tiny faint">{[p.size, p.location].filter(Boolean).join(' · ')}</span></span>
            {into?.id === p.id && <Icon name="check" size={18} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Managers: what staff (and 86 reports) added. Approve, edit, merge into a likely duplicate, or archive. */
function ReviewQueue() {
  const t = useT();
  const { call, toast, version } = useApp();
  const [r, setR] = useState(null);
  const [cat, setCat] = useState(null);
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    call('products.review.list').then(setR).catch((e) => toast(e.message, 'bad'));
    call('products.list').then(setCat).catch(() => {});
  }, [version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r || !cat) return <div className="empty">{t('common.loading')}</div>;
  const run = async (method, args, msg) => { try { await call(method, args); toast(msg); setTick((n) => n + 1); } catch (e) { toast(e.message, 'bad'); } };
  return (
    <>
      <a className="stk-back small" href="#/stock/products"><Icon name="left" size={14} />{t('stock.backToProducts')}</a>
      <h2 className="stk-title">{t('stock.reviewTitle')}</h2>
      <div className="small muted section">{t('stock.reviewIntro')}</div>
      {!r.products.length ? <Empty icon="check" title={t('stock.reviewEmpty')} /> : r.products.map((p) => (
        <div key={p.id} className="card card-pad stk-review">
          <div className="stk-review-row">
            <ProductPhoto product={p} className="stk-thumb lg" />
            <div className="stk-result-text">
              <b>{p.name}</b>
              <span className="small muted">{[catName(cat.categories, p.category, t.lang), p.size, p.location].filter(Boolean).join(' · ')}</span>
              <span className="tiny faint">{p.addedBy ? t('stock.addedByWhen', { name: p.addedBy.name, when: stamp(p.addedAt) }) : t('stock.fromThe86')}{p.source === 'eightySix' ? ` · ${t('stock.via86')}` : ''}</span>
            </div>
          </div>
          {p.matches.length > 0 && (
            <div className="stk-dups">
              <div className="small"><b>{t('stock.maybeSame')}</b></div>
              {p.matches.map((m) => (
                <div key={m.id} className="stk-dup">
                  <ProductPhoto product={m} className="stk-thumb" />
                  <span className="stk-result-text"><b>{m.name}</b><span className="tiny faint">{[m.size, m.location].filter(Boolean).join(' · ')}</span></span>
                  <button type="button" className="btn sm primary" onClick={() => run('products.merge', { keepId: m.id, mergeId: p.id }, t('stock.mergedShort', { name: p.name, into: m.name }))}>{t('stock.mergeIntoThis')}</button>
                </div>
              ))}
            </div>
          )}
          <div className="stk-actions">
            <button className="btn sm ok" onClick={() => run('products.approve', { id: p.id }, t('stock.approved'))}><Icon name="check" />{t('stock.approve')}</button>
            <button className="btn sm" onClick={() => setOpen(p)}><Icon name="edit" />{t('common.edit')}</button>
            <button className="btn sm danger" onClick={() => run('products.archive', { id: p.id, archived: true }, t('stock.archivedMsg'))}><Icon name="trash" />{t('stock.archive')}</button>
          </div>
        </div>
      ))}
      {open && <ProductDialog id={open.id} cat={cat} onClose={() => setOpen(null)} onChanged={() => setTick((n) => n + 1)} />}
    </>
  );
}

function CategoriesDialog({ cats, onClose, onSaved }) {
  const t = useT();
  const { call, toast } = useApp();
  const [list, setList] = useState(cats.map((c) => ({ ...c })));
  const save = async () => { try { await call('products.saveCategories', { categories: list }); toast(t('stock.saved')); onSaved(); } catch (e) { toast(e.message, 'bad'); } };
  return (
    <Modal title={t('stock.categories')} sub={t('stock.categoriesHelp')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
      {list.map((c, i) => (
        <div key={c.id || i} className="stk-cat-row">
          <input className="input" value={c.name} aria-label={t('stock.catEn')} placeholder={t('stock.catEn')} onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input" value={c.nameEs} aria-label={t('stock.catEs')} placeholder={t('stock.catEs')} onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, nameEs: e.target.value } : x)))} />
          {c.id !== 'other' ? <button className="btn sm ghost icon" aria-label={t('stock.removeCat')} onClick={() => setList(list.filter((_, k) => k !== i))}><Icon name="x" /></button> : <span className="stk-cat-x" />}
        </div>
      ))}
      <button className="btn sm" onClick={() => setList([...list, { id: '', name: '', nameEs: '' }])}><Icon name="plus" />{t('stock.addCat')}</button>
    </Modal>
  );
}

// ---------- My Shifts: my lists for today ----------
/** "Stock lists for you today": shown on My Shifts when someone has one. */
export function StockCard({ className = '' }) {
  const t = useT();
  const { call, version, has } = useApp();
  const [lists, setLists] = useState([]);
  useEffect(() => {
    let live = true;
    if (has && !has('stock')) return undefined;
    call('stock.mine.list').then((r) => { if (live) setLists(r.lists); }).catch(() => {});
    return () => { live = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!lists.length) return null;
  return (
    <div className={`card stk-mine ${className}`}>
      <div className="stk-mine-h"><Icon name="box" size={16} /><b>{t('stock.forYouToday')}</b></div>
      {lists.map((l) => (
        <a key={l.id} className="stk-mine-row" href={`#/stock/${l.id}`}>
          <span className="stk-result-text"><b>{l.name}</b><span className="small muted">{[l.due && t('stock.dueAt', { time: fmtTime(l.due) }), t('stock.progress', { done: l.counts.done, total: l.counts.lines })].filter(Boolean).join(' · ')}</span></span>
          {l.overdue && <span className="badge bad">{t('stock.overdue')}</span>}
          <Icon name="right" size={16} />
        </a>
      ))}
    </div>
  );
}

// ---------- Settings → Products ----------
/** Settings → Products: the same catalog page as Stock → Products, for managers who look for it in Settings. */
export function ProductsAdmin() {
  const t = useT();
  const { call, version } = useApp();
  const [cat, setCat] = useState(null);
  useEffect(() => { call('products.list').then(setCat).catch(() => {}); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stk">
      <a className="stk-back small" href="#/settings"><Icon name="left" size={14} />{t('stock.backToSettings')}</a>
      {cat ? <Products cat={cat} /> : <div className="empty">{t('common.loading')}</div>}
    </div>
  );
}
/** The card in Settings that opens it. */
export function ProductsCard() {
  const t = useT();
  const { has } = useApp();
  if (has && !has('stock')) return null;
  return (
    <div className="card card-pad col" style={{ gap: 8 }}>
      <h2>{t('stock.productsTitle')}</h2>
      <div className="help">{t('stock.settingsHelp')}</div>
      <div className="row wrap" style={{ gap: 8 }}><a className="btn sm" href="#/settings/products"><Icon name="box" />{t('stock.settingsOpen')}</a></div>
    </div>
  );
}
