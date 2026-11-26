// Reports → 86 List (#/reports/86), managers and up. Three tabs, each one RPC that does the work on the server
// (core/reports-86.js):
//   Missing now (#/reports/86)          everything out or low on every list (hidden ones too), grouped by category or
//                                        list, with how long, who, notes and photos; the shopping list; CSV.
//   History (#/reports/86/history)      a season, the last 7/30/90 days or two dates: most often 86'd, time out,
//                                        repeat offenders, by list, category and day of the week, who reports; CSV.
//   Trends (#/reports/86/trends)        a season against the same season last year.
// The shopping list and the CSV files are built here, in the reader's language, by core/reports-86.js.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Icon, Modal, Empty } from '../../ui.jsx';
import { useT, prettyDate, stamp, dowShort, dowLong } from '../../i18n/index.js';
import { nowDate } from '../../api.js';
import { Thumbs, PhotoViewer, listName, ago, duration } from '../EightySix.jsx';
import { ProductPhoto } from '../Stock.jsx'; // the catalog's photo on the purchase list
import { groupMissing, shoppingList, missingCsv, historyCsv, REPEAT_MIN } from '../../../../core/reports-86.js';
import { seasonById } from '../../../../core/seasons.js';
import { todayStr } from '../../../../core/time.js';
import '../../eightysix.css';

const TABS = [['missing', 'reports.e86.tabMissing', 'ban', ''], ['history', 'reports.e86.tabHistory', 'clock', '/history'], ['trends', 'reports.e86.tabTrends', 'chart', '/trends']];
/** '45 min', '3 h', '2 days'. */
const dur = (t, min) => duration(t, 0, Math.max(0, min || 0) * 60000);
const catLabel = (t, cats, id) => {
  const c = id ? cats.find((x) => x.id === id) : null;
  return c ? (t.lang === 'es' ? c.nameEs || c.name : c.name) : t('reports.e86.noCategory');
};
const day = (iso) => prettyDate(iso, { dow: false });
const seasonLabel = (id, settings, lang) => seasonById(id, settings, lang)?.label || id;

/** Save text as a file (CSV). */
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export default function EightySixReport({ parts = [] }) {
  const t = useT();
  const tab = parts[2] === 'history' ? 'history' : parts[2] === 'trends' ? 'trends' : 'missing';
  return (
    <div className="rp rp86">
      <a className="rp-back" href="#/reports"><Icon name="left" size={16} />{t('reports.back')}</a>
      <h2 className="rp-title">{t('reports.e86.title')}</h2>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label, icon, path]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { location.hash = `#/reports/86${path}`; }}>
            <Icon name={icon} size={16} />{t(label)}
          </button>
        ))}
      </div>
      {tab === 'missing' ? <Missing /> : tab === 'history' ? <History /> : <Trends />}
    </div>
  );
}

// ---------- Missing now ----------
function Missing() {
  const t = useT();
  const { call, version, toast } = useApp();
  const [data, setData] = useState(null);
  const [by, setBy] = useState('category');
  const [listId, setListId] = useState('');
  const [shop, setShop] = useState(false);
  const [viewer, setViewer] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { call('reports.eightySix.missing.get').then(setData).catch((e) => toast(e.message, 'bad')); }, [version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const items = data.items.filter((i) => !listId || i.listId === listId);
  const groups = groupMissing(items, { by, categories: data.categories, lists: data.lists, lang: t.lang });
  const out = items.filter((i) => i.status === 'out').length;
  const onLists = new Set(items.map((i) => i.listId)).size;
  const csv = () => download(`86-list-missing-${todayStr(nowDate())}.csv`,
    missingCsv(items, { categories: data.categories, lists: data.lists, lang: t.lang, now: data.now, stampOf: (iso) => stamp(iso) }));
  return (
    <>
      <div className="rp-bar">
        <div className="rp-bar-text">
          <div className="rp-sum">{items.length ? t('reports.e86.summary', { out, low: items.length - out, count: onLists }) : t('reports.e86.nothingMissing')}</div>
          <div className="small muted">{t('reports.e86.missingIntro')}</div>
        </div>
        <button className="btn primary rp-shop-btn" disabled={!items.length} onClick={() => setShop(true)}><Icon name="copy" />{t('reports.e86.shoppingList')}</button>
      </div>
      <div className="rp-controls">
        <div className="rp-ctl">
          <span className="rp-ctl-l">{t('reports.e86.groupBy')}</span>
          <div className="seg" role="group" aria-label={t('reports.e86.groupBy')}>
            <button type="button" className={by === 'category' ? 'on' : ''} aria-pressed={by === 'category'} onClick={() => setBy('category')}>{t('reports.e86.byCategory')}</button>
            <button type="button" className={by === 'list' ? 'on' : ''} aria-pressed={by === 'list'} onClick={() => setBy('list')}>{t('reports.e86.byList')}</button>
          </div>
        </div>
        <select className="input rp-select" value={listId} onChange={(e) => setListId(e.target.value)} aria-label={t('reports.e86.list')}>
          <option value="">{t('reports.e86.allLists')}</option>
          {data.lists.map((l) => <option key={l.id} value={l.id}>{listName(l, t.lang)}{l.hidden ? ` (${t('reports.e86.hidden')})` : ''} · {l.out + l.low}</option>)}
        </select>
        <button type="button" className="btn sm" onClick={csv} disabled={!items.length}><Icon name="download" />{t('reports.e86.csv')}</button>
      </div>
      {!items.length && <Empty icon="check" title={t('reports.e86.nothingMissing')} />}
      {groups.map((g) => (
        <section key={g.id || 'none'} className="card rp-group">
          <div className="rp-group-h">
            <h3>{g.label}</h3>
            {by === 'list' && data.lists.find((l) => l.id === g.id)?.hidden && <span className="badge">{t('reports.e86.hidden')}</span>}
            <span className="small muted rp-group-n">{[g.out && t('eightySix.nOut', { count: g.out }), g.low && t('eightySix.nLow', { count: g.low })].filter(Boolean).join(' · ')}</span>
          </div>
          {g.items.map((it) => <MissingItem key={it.id} it={it} by={by} data={data} onPhoto={(start) => setViewer({ item: it, start })} />)}
        </section>
      ))}
      {shop && <ShoppingList items={items} categories={data.categories} onClose={() => setShop(false)} onChanged={() => setTick((n) => n + 1)} />}
      {viewer && <PhotoViewer item={viewer.item} start={viewer.start} onClose={() => setViewer(null)} onRemoved={() => { setViewer(null); setTick((n) => n + 1); }} />}
    </>
  );
}

function MissingItem({ it, by, data, onPhoto }) {
  const t = useT();
  const list = data.lists.find((l) => l.id === it.listId);
  const where = [by === 'category' ? listName(list, t.lang) : catLabel(t, data.categories, it.category), it.area && it.area !== list?.area ? it.area : ''].filter(Boolean);
  const name = t.lang === 'es' && it.nameEs ? it.nameEs : it.name;
  const changed = it.updatedBy?.id && it.updatedBy.id !== it.reportedBy?.id;
  return (
    <div className={`rp-item ${it.status}`}>
      <span className={`e86-pill ${it.status}`}>{it.status === 'out' ? t('eightySix.pillOut') : t('eightySix.pillLow')}</span>
      <div className="rp-item-text">
        <div className="rp-item-name">{name}{it.status === 'low' && it.count != null && <span className="rp-left"> · {t('reports.e86.left', { count: it.count })}</span>}</div>
        <div className="rp-item-meta">
          <b className={it.status === 'out' ? 'rp-bad' : 'rp-warn'}>{t(it.status === 'out' ? 'reports.e86.outFor' : 'reports.e86.lowFor', { time: dur(t, it.minutes) })}</b>
          {where.length > 0 && <> · {where.join(' · ')}</>}
          {by === 'category' && list?.hidden && <span className="badge rp-hidden">{t('reports.e86.hidden')}</span>}
        </div>
        <div className="rp-item-who">
          {t('reports.e86.reportedBy', { name: it.reportedBy?.name || '—' })} · {ago(t, it.reportedAt)}
          {changed && <> · {t('reports.e86.updatedBy', { name: it.updatedBy.name })} {ago(t, it.updatedAt)}</>}
        </div>
        {it.note && <div className="rp-item-note">“{it.note}”</div>}
        <Thumbs small photos={it.photos} name={name} onOpen={onPhoto} />
      </div>
    </div>
  );
}

/** The shopping list: what to order, by category. Copy it, share it (phones), print it. */
function ShoppingList({ items, categories, onClose, onChanged }) {
  const t = useT();
  const { toast, settings, call, viewAs } = useApp();
  const [withLow, setWithLow] = useState(true);
  const [busy, setBusy] = useState('');
  // Ordered (the buyer placed the order) and Received (back in stock: off the 86 List).
  const act = async (method, args, msg) => {
    setBusy(args.id);
    try { await call(method, args); toast(msg); onChanged?.(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(''); }
  };
  const chosen = withLow ? items : items.filter((i) => i.status === 'out');
  const text = shoppingList(chosen, { categories, lang: t.lang, date: prettyDate(todayStr(nowDate())), place: settings?.restaurantName || '' });
  useEffect(() => () => document.body.classList.remove('print-shop'), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('reports.e86.copied'));
    } catch {
      // Older browsers (and http pages): a hidden text box and the copy command.
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy');
      ta.remove();
      toast(ok ? t('reports.e86.copied') : t('reports.e86.copyFailed'), ok ? '' : 'bad');
    }
  };
  const share = () => navigator.share({ title: t('reports.e86.shoppingTitle'), text }).catch(() => {});
  // Print only the list: the copy below sits at the end of <body>, hidden except while printing (reports.css).
  const print = () => {
    const done = () => { document.body.classList.remove('print-shop'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    document.body.classList.add('print-shop');
    window.print();
  };
  return (
    <Modal title={t('reports.e86.shoppingTitle')} onClose={onClose}
      footer={(
        <div className="rp-shop-foot">
          {typeof navigator !== 'undefined' && navigator.share && <button type="button" className="btn" onClick={share}><Icon name="send" />{t('reports.e86.share')}</button>}
          <button type="button" className="btn" onClick={print}><Icon name="print" />{t('reports.e86.print')}</button>
          <button type="button" className="btn primary" onClick={copy}><Icon name="copy" />{t('reports.e86.copy')}</button>
        </div>
      )}>
      <div className="help">{t('reports.e86.shoppingHelp')}</div>
      <label className="check"><input type="checkbox" checked={withLow} onChange={(e) => setWithLow(e.target.checked)} />{t('reports.e86.includeLow')}</label>
      <div className="rp-buy" role="list" aria-label={t('stock.buyListTitle')}>
        {chosen.map((i) => (
          <div key={i.id} className="rp-buy-row" role="listitem">
            {i.product ? <ProductPhoto product={i.product} className="rp-buy-photo" alt="" /> : <span className={`e86-pill ${i.status}`}>{i.status === 'out' ? t('eightySix.pillOut') : t('eightySix.pillLow')}</span>}
            <div className="rp-buy-text">
              <b>{i.name}</b>
              <span className="small muted">{[i.status === 'out' ? t('eightySix.pillOut') : t('eightySix.pillLow'), i.product?.supplier, listName({ name: i.listName, nameEs: i.listNameEs }, t.lang)].filter(Boolean).join(' · ')}</span>
              {i.shortOut > 0 && <span className="tiny faint">{t('stock.shortOutTimes', { count: i.shortOut })}</span>}
              {i.orderedAt && <span className="badge ok rp-buy-badge">{t('stock.orderedBy', { name: i.orderedBy?.name || '', when: stamp(i.orderedAt) })}</span>}
            </div>
            {!viewAs && (
              <div className="rp-buy-btns">
                <button type="button" className="btn sm" disabled={busy === i.id} onClick={() => act('eightySix.markOrdered', { id: i.id, ordered: !i.orderedAt }, i.orderedAt ? t('stock.notOrdered') : t('stock.markedOrdered', { name: i.name }))}>
                  {i.orderedAt ? t('stock.undoOrdered') : t('stock.ordered')}</button>
                <button type="button" className="btn sm ok" disabled={busy === i.id} onClick={() => act('eightySix.clear', { id: i.id }, t('stock.received', { name: i.name }))}><Icon name="check" />{t('stock.receivedBtn')}</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <pre className="rp-shop-text" tabIndex={0} aria-label={t('reports.e86.shoppingTitle')}>{text}</pre>
      {createPortal(<div className="rp-print-sheet"><pre>{text}</pre></div>, document.body)}
    </Modal>
  );
}

// ---------- History ----------
const PRESETS = [7, 30, 90];

function History() {
  const t = useT();
  const { call, version, toast, settings } = useApp();
  const [period, setPeriod] = useState(''); // '' this season · 'season:<id>' · 'days:<n>' · 'dates'
  const [dates, setDates] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState(null); // the dates asked for
  const [listId, setListId] = useState('');
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const args = period.startsWith('season:') ? { season: period.slice(7) } : period.startsWith('days:') ? { days: Number(period.slice(5)) }
    : period === 'dates' && applied ? applied : {};
  const key = JSON.stringify([args, listId]);
  useEffect(() => {
    let live = true;
    call('reports.eightySix.history.get', { ...args, listId }).then((r) => { if (live) setData(r); }).catch((e) => toast(e.message, 'bad'));
    return () => { live = false; };
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const cats = data.categories;
  const current = data.seasons[0]?.id;
  const r = data.range;
  const rangeText = r.kind === 'season' ? t('reports.e86.rangeSeason', { season: seasonLabel(r.seasonId, settings, t.lang), from: day(r.from), to: day(r.to) })
    : r.kind === 'days' ? t('reports.e86.rangeDays', { days: r.days, from: day(r.from), to: day(r.to) }) : t('reports.e86.rangeDates', { from: day(r.from), to: day(r.to) });
  const top = showAll ? data.items : data.items.slice(0, 10);
  const csv = () => download(`86-list-history-${r.from}-${r.to}.csv`, historyCsv(data, { categories: cats, lists: data.lists, lang: t.lang, stampOf: (iso) => stamp(iso) }));
  const tot = data.totals;
  return (
    <>
      <div className="rp-controls">
        <select className="input rp-select" value={period} aria-label={t('reports.e86.period')} onChange={(e) => { setPeriod(e.target.value); setShowAll(false); }}>
          <option value="">{t('reports.e86.thisSeason', { season: seasonLabel(current, settings, t.lang) })}</option>
          {PRESETS.map((d) => <option key={d} value={`days:${d}`}>{t('reports.e86.lastDays', { days: d })}</option>)}
          {data.seasons.slice(1).map((s) => <option key={s.id} value={`season:${s.id}`}>{seasonLabel(s.id, settings, t.lang)}</option>)}
          <option value="dates">{t('reports.e86.customDates')}</option>
        </select>
        <select className="input rp-select" value={listId} aria-label={t('reports.e86.list')} onChange={(e) => setListId(e.target.value)}>
          <option value="">{t('reports.e86.allLists')}</option>
          {data.lists.map((l) => <option key={l.id} value={l.id}>{listName(l, t.lang)}{l.hidden ? ` (${t('reports.e86.hidden')})` : ''}</option>)}
        </select>
        <button type="button" className="btn sm" onClick={csv} disabled={!data.items.length}><Icon name="download" />{t('reports.e86.csv')}</button>
      </div>
      {period === 'dates' && (
        <form className="rp-dates" onSubmit={(e) => { e.preventDefault(); if (dates.from && dates.to) setApplied({ from: dates.from, to: dates.to }); }}>
          <label className="field"><span>{t('reports.e86.from')}</span><input className="input" type="date" value={dates.from} max={data.today} onChange={(e) => setDates({ ...dates, from: e.target.value })} /></label>
          <label className="field"><span>{t('reports.e86.to')}</span><input className="input" type="date" value={dates.to} max={data.today} onChange={(e) => setDates({ ...dates, to: e.target.value })} /></label>
          <button className="btn primary" disabled={!dates.from || !dates.to}>{t('reports.e86.show')}</button>
        </form>
      )}
      <div className="rp-range small muted">{rangeText}</div>
      <div className="kpis rp-kpis">
        <div className="card kpi"><div className="l">{t('reports.e86.kpiOut')}</div><div className="v rp-bad">{tot.outs}</div>
          <div className="s">{t('reports.e86.kpiNowOut', { count: tot.stillOut })}</div></div>
        <div className="card kpi"><div className="l">{t('reports.e86.kpiLow')}</div><div className="v rp-warn">{tot.lows}</div></div>
        <div className="card kpi"><div className="l">{t('reports.e86.kpiAvgOut')}</div><div className="v">{tot.avgOutMinutes != null ? dur(t, tot.avgOutMinutes) : '—'}</div>
          {tot.backs > 0 && <div className="s">{t('reports.e86.kpiTotalOut', { time: dur(t, tot.outMinutes) })}</div>}</div>
        <div className="card kpi"><div className="l">{t('reports.e86.kpiItems')}</div><div className="v">{tot.items}</div></div>
      </div>
      {!tot.reports ? <Empty icon="ban" title={t('reports.e86.nothingInRange')} /> : (
        <>
          <section className="card card-pad section">
            <h3>{t('reports.e86.repeatTitle')}</h3>
            <div className="help">{t('reports.e86.repeatHelp', { min: REPEAT_MIN })}</div>
            {!data.repeat.length ? <div className="small faint rp-gap">{t('reports.e86.noRepeats', { min: REPEAT_MIN })}</div> : (
              <ul className="rp-repeat">
                {data.repeat.map((x) => (
                  <li key={x.key}><b>{x.name}</b> <span className="rp-bad">{t(r.kind === 'season' ? 'reports.e86.repeatSeason' : 'reports.e86.repeatLine', { count: x.outs })}</span>
                    <span className="tiny faint"> · {catLabel(t, cats, x.category)}</span></li>
                ))}
              </ul>
            )}
          </section>
          <section className="card section">
            <div className="card-head"><h3>{t('reports.e86.mostTitle')}</h3></div>
            <div className="table-wrap">
              <table className="table rp-table">
                <thead><tr><th>{t('reports.e86.colItem')}</th><th className="num">{t('reports.e86.colOut')}</th><th className="num">{t('reports.e86.colLow')}</th><th>{t('reports.e86.colAvgOut')}</th><th className="rp-wide">{t('reports.e86.colTotalOut')}</th></tr></thead>
                <tbody>
                  {top.map((x) => (
                    <tr key={x.key}>
                      <td><b>{x.name}</b><div className="tiny faint">{catLabel(t, cats, x.category)}</div></td>
                      <td className="num">{x.outs}</td>
                      <td className="num">{x.lows}</td>
                      <td>{x.backs ? dur(t, x.avgOutMinutes) : '—'}</td>
                      <td className="rp-wide">{x.backs ? dur(t, x.outMinutes) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.items.length > 10 && <div className="rp-more"><button type="button" className="btn sm ghost" onClick={() => setShowAll(!showAll)}>{showAll ? t('reports.e86.showFewer') : t('reports.e86.showAll', { count: data.items.length })}</button></div>}
            <div className="help rp-pad">{t('reports.e86.lowHelp')}</div>
          </section>
          <section className="card card-pad section">
            <h3>{t('reports.e86.byDayTitle')}</h3>
            <div className="help">{t('reports.e86.byDayHelp')}</div>
            <Weekdays days={data.byWeekday} start={settings?.weekStartDow ?? 1} />
          </section>
          <div className="rp-two">
            <section className="card card-pad section">
              <h3>{t('reports.e86.byListTitle')}</h3>
              <Bars rows={data.byList.map((l) => ({ key: l.listId, label: t.lang === 'es' && l.nameEs ? l.nameEs : l.name, outs: l.outs, lows: l.lows }))} />
            </section>
            <section className="card card-pad section">
              <h3>{t('reports.e86.byCategoryTitle')}</h3>
              <Bars rows={data.byCategory.map((c) => ({ key: c.category || 'none', label: catLabel(t, cats, c.category), outs: c.outs, lows: c.lows }))} />
            </section>
          </div>
          <section className="card section">
            <div className="card-head"><h3>{t('reports.e86.reportersTitle')}</h3></div>
            <div className="list">
              {data.reporters.map((p) => (
                <div key={p.id} className="list-item rp-person">
                  <span className="rp-person-name">{p.name || '—'}</span>
                  <span className="small muted">{t('reports.e86.reportCount', { count: p.reports })}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

/** Seven small stacked bars (out, then low), Monday first (or the restaurant's first day). Each one reads out its numbers. */
function Weekdays({ days, start = 1 }) {
  const t = useT();
  const order = Array.from({ length: 7 }, (_, i) => days[(start + i) % 7]);
  const max = Math.max(1, ...order.map((d) => d.outs + d.lows));
  return (
    <>
      <ul className="rp-days" aria-label={t('reports.e86.byDayTitle')}>
        {order.map((d) => (
          <li key={d.dow} aria-label={t('reports.e86.dayBar', { day: dowLong(d.dow), out: d.outs, low: d.lows })}>
            <span className="rp-day-n" aria-hidden="true">{d.outs + d.lows || ''}</span>
            <span className="rp-day-bar" aria-hidden="true">
              <span className="rp-day-low" style={{ height: `${(d.lows / max) * 100}%` }} />
              <span className="rp-day-out" style={{ height: `${(d.outs / max) * 100}%` }} />
            </span>
            <span className="rp-day-l" aria-hidden="true">{dowShort(d.dow)}</span>
          </li>
        ))}
      </ul>
      <div className="rp-legend" aria-hidden="true"><span><i className="rp-sw out" />{t('reports.e86.legendOut')}</span><span><i className="rp-sw low" />{t('reports.e86.legendLow')}</span></div>
    </>
  );
}

/** Horizontal bars: out and low side by side, longest first. */
function Bars({ rows }) {
  const t = useT();
  const max = Math.max(1, ...rows.map((r) => r.outs + r.lows));
  return (
    <div className="rp-hbars">
      {rows.map((r) => (
        <div key={r.key} className="rp-hbar">
          <span className="rp-hbar-name">{r.label}</span>
          <span className="rp-hbar-track" aria-hidden="true">
            <span className="rp-hbar-out" style={{ width: `${(r.outs / max) * 100}%` }} />
            <span className="rp-hbar-low" style={{ width: `${(r.lows / max) * 100}%` }} />
          </span>
          <span className="rp-hbar-n num" aria-label={`${t('reports.e86.legendOut')} ${r.outs}, ${t('reports.e86.legendLow')} ${r.lows}`}>
            <span className="rp-bad">{r.outs}</span> · <span className="rp-warn">{r.lows}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------- Trends ----------
function Trends() {
  const t = useT();
  const { call, version, toast, settings } = useApp();
  const [season, setSeason] = useState('');
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    call('reports.eightySix.trends.get', season ? { season } : {}).then((r) => { if (live) setData(r); }).catch((e) => toast(e.message, 'bad'));
    return () => { live = false; };
  }, [season, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const label = (id) => seasonLabel(id, settings, t.lang);
  const now = data.totals.now, then = data.totals.then, whole = data.totals.lastWhole;
  const thisName = `${label(data.season.id)}${data.partial ? ` (${t('reports.e86.soFar', { date: day(data.season.to) })})` : ''}`;
  const maxCat = Math.max(1, ...data.byCategory.map((c) => Math.max(c.now, c.then)));
  return (
    <>
      <div className="rp-controls">
        <select className="input rp-select" value={season || data.season.id} aria-label={t('reports.e86.season')} onChange={(e) => setSeason(e.target.value)}>
          {data.seasons.map((s) => <option key={s.id} value={s.id}>{label(s.id)}</option>)}
        </select>
      </div>
      <div className="rp-range small muted">{t('reports.e86.trendsIntro', { season: thisName, last: label(data.last.id) })}</div>
      <div className="kpis rp-kpis">
        <Compare label={t('reports.e86.kpiOut')} now={now.outs} then={then.outs} />
        <Compare label={t('reports.e86.kpiLow')} now={now.lows} then={then.lows} />
        <Compare label={t('reports.e86.kpiItems')} now={now.items} then={then.items} />
        <Compare label={t('reports.e86.kpiAvgOut')} now={now.avgOutMinutes} then={then.avgOutMinutes} format={(m) => (m == null ? '—' : dur(t, m))} />
      </div>
      {!then.reports && !whole.reports ? <div className="alert info"><Icon name="alert" size={16} />{t('reports.e86.noLastYear', { season: label(data.last.id) })}</div>
        : <div className="small muted rp-gap">{t('reports.e86.lastWhole', { season: label(data.last.id), out: whole.outs, low: whole.lows })}</div>}
      {data.newThisYear > 0 && <div className="small muted rp-gap">{t('reports.e86.newItems', { count: data.newThisYear })}</div>}
      {data.items.length > 0 && (
        <section className="card section">
          <div className="card-head"><h3>{t('reports.e86.trendItemsTitle')}</h3></div>
          <div className="table-wrap">
            <table className="table rp-table">
              <thead><tr><th>{t('reports.e86.colItem')}</th><th className="num">{t('reports.e86.thisYear')}</th><th className="num">{t('reports.e86.lastYear')}</th><th>{t('reports.e86.change')}</th></tr></thead>
              <tbody>
                {data.items.map((x) => {
                  const a = x.nowOuts + x.nowLows, b = x.thenOuts + x.thenLows;
                  return (
                    <tr key={x.key}>
                      <td><b>{x.name}</b><div className="tiny faint">{catLabel(t, data.categories, x.category)}</div></td>
                      <td className="num">{a}</td>
                      <td className="num">{b}</td>
                      <td><Change n={x.change} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="help rp-pad">{t('reports.e86.trendTimes')}</div>
        </section>
      )}
      {data.byCategory.length > 0 && (
        <section className="card card-pad section">
          <h3>{t('reports.e86.trendCategoriesTitle')}</h3>
          <div className="rp-legend" aria-hidden="true"><span><i className="rp-sw now" />{t('reports.e86.thisYear')}</span><span><i className="rp-sw then" />{t('reports.e86.lastYear')}</span></div>
          <div className="rp-hbars">
            {data.byCategory.map((c) => (
              <div key={c.category || 'none'} className="rp-hbar two">
                <span className="rp-hbar-name">{catLabel(t, data.categories, c.category)}</span>
                <span className="rp-hbar-pair" aria-hidden="true">
                  <span className="rp-hbar-track"><span className="rp-hbar-now" style={{ width: `${(c.now / maxCat) * 100}%` }} /></span>
                  <span className="rp-hbar-track"><span className="rp-hbar-then" style={{ width: `${(c.then / maxCat) * 100}%` }} /></span>
                </span>
                <span className="rp-hbar-n num" aria-label={`${t('reports.e86.thisYear')} ${c.now}, ${t('reports.e86.lastYear')} ${c.then}`}>{c.now} · {c.then}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** A number this season with last year's under it, and the change (fewer is better for the 86 List). */
function Compare({ label, now, then, format }) {
  const t = useT();
  const show = format || ((v) => v ?? '—');
  const diff = now != null && then != null ? now - then : null;
  return (
    <div className="card kpi">
      <div className="l">{label}</div>
      <div className="v">{show(now)}</div>
      <div className="s">{t('reports.e86.lastYear')}: {show(then)}{diff != null && diff !== 0 && <> · <Change n={diff} format={format ? (v) => format(Math.abs(v)) : null} /></>}</div>
    </div>
  );
}

/** "up 3" in red, "down 2" in green: for the 86 List, more often out is worse. */
function Change({ n, format }) {
  const t = useT();
  if (!n) return <span className="faint">{t('reports.e86.same')}</span>;
  const v = format ? format(n) : Math.abs(n);
  return <span className={n > 0 ? 'rp-bad' : 'rp-ok'}>{n > 0 ? '▲' : '▼'} {t(n > 0 ? 'reports.e86.up' : 'reports.e86.down', { count: v })}</span>;
}
