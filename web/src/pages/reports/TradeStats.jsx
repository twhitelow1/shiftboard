// Trades & pickups by season (managers and up): per person, the shifts they put up and picked up, from one
// helper on the server (core/trade-stats.js). Season picker (the seasons with data, plus custom dates), position
// and room filters, name search, sorting by any column, a person's requests, seasons side by side, CSV.
// Self-contained so the Reports hub can register it: the page (default export) and headline().
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Empty, JobDot, Avatar } from '../../ui.jsx';
import { statsCsv } from '../../../../core/trade-stats.js';
import { fmtTime } from '../../../../core/time.js';
import { useT, tx, prettyDate, stampDay, num } from '../../i18n/index.js';
import '../../reports.css';

/** Columns of the table, in order. */
export const COLUMNS = ['putUp', 'pickedUp', 'tradesDone', 'notTaken', 'cancelled', 'hoursGiven', 'hoursTaken', 'netHours'];
const HOURS = new Set(['hoursGiven', 'hoursTaken', 'netHours']);
/** Every count, for the CSV. */
const CSV = ['putUp', 'givenAway', 'tradesOffered', 'taken', 'waiting', 'notTaken', 'cancelled', 'pickedUp', 'openPickedUp', 'giveawaysTaken', 'tradesDone', 'hoursGiven', 'hoursTaken', 'netHours'];
const DEFS = [['putUp', 'def_putUp'], ['pickedUp', 'def_pickedUp'], ['tradesDone', 'def_tradesDone'], ['notTaken', 'def_notTaken'], ['cancelled', 'def_cancelled'], ['waiting', 'def_waiting'], ['netHours', 'def_hours']];
const fmt = (k, v) => (HOURS.has(k) ? num(v, { maximumFractionDigits: 1 }) : num(v));

/** The hub's one-liner: "12 put up · 9 picked up this season". ctx: { call, t } (useApp's call; t optional). */
export async function headline({ call, t = tx }) {
  const r = await call('tradeStats.summary', {});
  return t('tradeStats.headline', { putUp: r.totals.putUp, pickedUp: r.totals.pickedUp });
}

export default function TradeStats() {
  const t = useT();
  const { call, isMgr, jobCodes, layout, settings, version } = useApp();
  const [season, setSeason] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [jobCodeId, setJob] = useState('');
  const [area, setArea] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(false);
  const [view, setView] = useState('table');
  const [sort, setSort] = useState({ key: 'putUp', dir: -1 });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [defs, setDefs] = useState(false);
  const [person, setPerson] = useState(null);
  const custom = season === 'custom';
  const args = useMemo(() => ({
    ...(custom ? { from: range.from, to: range.to } : season ? { season } : {}), jobCodeId, area, compare: view === 'compare',
  }), [custom, range, season, jobCodeId, area, view]);

  useEffect(() => {
    if (!isMgr || (custom && !(range.from && range.to && range.from <= range.to))) return;
    let live = true;
    call('tradeStats.summary', args).then((r) => { if (live) { setData(r); setError(''); } }, (e) => live && setError(e.message));
    return () => { live = false; };
  }, [args, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isMgr) return <div className="card"><Empty icon="lock" title={t('tradeStats.title')}>{t('tradeStats.managersOnly')}</Empty></div>;
  const rooms = (layout?.rooms || []).map((r) => r.room).filter(Boolean);
  const roomList = rooms.length ? rooms : settings.areas || [];
  const label = (k) => t(`tradeStats.col_${k}`);
  const match = (r) => (!q || r.name.toLowerCase().includes(q.trim().toLowerCase())) && (!active || r.putUp || r.pickedUp || r.tradesDone);
  const rows = (data?.rows || []).filter(match).sort((a, b) => (sort.key === 'name' ? a.name.localeCompare(b.name) * sort.dir
    : (a[sort.key] - b[sort.key]) * sort.dir || a.name.localeCompare(b.name)));
  const periodLabel = data ? (data.period.custom ? `${prettyDate(data.period.start, { dow: false })} – ${prettyDate(data.period.end, { dow: false })}` : data.period.label) : '';

  const exportCsv = () => {
    const cols = [{ key: 'name', label: t('tradeStats.name') }, ...CSV.map((k) => ({ key: k, label: label(k) }))];
    const csv = statsCsv(rows, cols);
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades-pickups-${data.period.custom ? `${data.period.start}_${data.period.end}` : data.period.id}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' ? 1 : -1 }));
  const th = (key, cls = 'n') => (
    <th key={key} className={cls} aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => sortBy(key)} title={t('tradeStats.sortBy', { col: key === 'name' ? t('tradeStats.name') : label(key) })}>
        {key === 'name' ? t('tradeStats.name') : label(key)}{sort.key === key && <Icon name={sort.dir > 0 ? 'up' : 'down'} size={12} />}
      </button>
    </th>
  );

  return (
    <div style={{ maxWidth: 1100 }} className="ts">
      <div className="card card-pad section">
        <div className="ts-head">
          <h2>{t('tradeStats.title')}{periodLabel ? <span className="muted" style={{ fontWeight: 600 }}> · {periodLabel}</span> : null}</h2>
          <button className="btn sm ghost" aria-expanded={defs} onClick={() => setDefs(!defs)}><Icon name="book" />{t('tradeStats.howCounted')}</button>
        </div>
        <div className="small muted">{t('tradeStats.subtitle')}</div>
        {defs && (
          <div className="ts-defs" role="note">
            <dl>{DEFS.map(([k, d]) => <React.Fragment key={k}><dt>{k === 'netHours' ? t('tradeStats.hours') : label(k)}</dt><dd>{t(`tradeStats.${d}`)}</dd></React.Fragment>)}</dl>
            <div className="small muted" style={{ marginTop: 8 }}>{t('tradeStats.def_days')}</div>
          </div>
        )}
      </div>

      <div className="ts-controls">
        <label className="field"><span>{t('tradeStats.season')}</span>
          <select className="input" value={season || data?.period?.id || ''} onChange={(e) => setSeason(e.target.value)}>
            {(data?.seasons || []).map((s) => <option key={s.id} value={s.id}>{s.current ? t('tradeStats.current', { label: s.label }) : s.label}</option>)}
            {data && !data.period.custom && !data.seasons.some((s) => s.id === data.period.id) && <option value={data.period.id}>{data.period.label}</option>}
            <option value="custom">{t('tradeStats.custom')}</option>
          </select>
        </label>
        {custom && <>
          <label className="field"><span>{t('tradeStats.from')}</span><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="field"><span>{t('tradeStats.to')}</span><input className="input" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </>}
        <label className="field"><span>{t('tradeStats.position')}</span>
          <select className="input" value={jobCodeId} onChange={(e) => setJob(e.target.value)}>
            <option value="">{t('tradeStats.allPositions')}</option>
            {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </label>
        <label className="field"><span>{t('tradeStats.room')}</span>
          <select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">{t('tradeStats.allRooms')}</option>
            {roomList.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="field"><span>{t('tradeStats.search')}</span><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tradeStats.searchPh')} /></label>
      </div>
      <div className="ts-bar">
        <div className="seg" role="tablist">
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>{t('tradeStats.byPerson')}</button>
          <button className={view === 'compare' ? 'on' : ''} disabled={custom} onClick={() => setView('compare')}>{t('tradeStats.compare')}</button>
        </div>
        <label className="check small"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('tradeStats.hideZeros')}</label>
        <span className="spacer" />
        <button className="btn sm" disabled={!data || !rows.length} onClick={exportCsv}><Icon name="download" />{t('tradeStats.exportCsv')}</button>
      </div>

      {error && <div className="alert bad section"><Icon name="alert" size={16} />{error}</div>}
      {custom && !(range.from && range.to && range.from <= range.to) && <div className="alert info section"><Icon name="calendar" size={16} />{t('tradeStats.pickDates')}</div>}
      {!data && !error && <div className="empty">{t('common.loading')}</div>}

      {data && view === 'table' && <>
        <div className="ts-totals">
          {['putUp', 'pickedUp', 'tradesDone', 'notTaken', 'cancelled'].map((k) => <span key={k} className="ts-total"><b>{fmt(k, data.totals[k])}</b>{label(k)}</span>)}
        </div>
        <div className="card ts-scroll">
          {!rows.length ? <Empty icon="swap" title={data.rows.length ? t('tradeStats.noneFound') : t('tradeStats.noActivity')} /> : (
            <table className="table ts-table">
              <thead><tr>{th('name', 'ts-stick')}{COLUMNS.map((k) => th(k))}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.userId} className="click" tabIndex={0} onClick={() => setPerson(r)} onKeyDown={(e) => e.key === 'Enter' && setPerson(r)}>
                    <td className="ts-stick"><b>{r.name}</b>{r.active === false && <span className="badge" style={{ marginLeft: 6 }}>{t('tradeStats.inactive')}</span>}</td>
                    {COLUMNS.map((k) => <td key={k} className={`n${!r[k] ? ' zero' : ''}${k === 'netHours' && r[k] ? (r[k] > 0 ? ' pos' : ' neg') : ''}`}>{k === 'netHours' && r[k] > 0 ? '+' : ''}{fmt(k, r[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="help" style={{ marginTop: 6 }}>{t('tradeStats.tapPerson')}</div>
      </>}

      {data && view === 'compare' && data.compare && <Compare data={data} q={q} active={active} onPerson={setPerson} />}
      {person && <PersonRequests person={person} args={args} period={periodLabel} onClose={() => setPerson(null)} />}
    </div>
  );
}

/** This season next to the same season last year and the season before: put up and picked up for each. */
function Compare({ data, q, active, onPerson }) {
  const t = useT();
  const { periods, rows, totals } = data.compare;
  const head = [t('tradeStats.thisSeason'), t('tradeStats.lastYear'), t('tradeStats.otherSeason')];
  const list = rows.filter((r) => (!q || r.name.toLowerCase().includes(q.trim().toLowerCase())) && (!active || r.cells.some((c) => c.putUp || c.pickedUp)));
  const pair = (c) => [
    <td key="u" className={`n ts-edge${!c.putUp ? ' zero' : ''}`}>{num(c.putUp)}</td>,
    <td key="p" className={`n${!c.pickedUp ? ' zero' : ''}`}>{num(c.pickedUp)}</td>,
  ];
  return <>
    <p className="small muted" style={{ marginTop: 0 }}>{t('tradeStats.compareHint')}</p>
    <div className="card ts-scroll">
      <table className="table ts-table">
        <thead>
          <tr><th className="ts-stick" />{periods.map((p, i) => <th key={p.id} colSpan={2} className="ts-group">{head[i] || ''}<div className="tiny faint" style={{ textTransform: 'none', letterSpacing: 0 }}>{p.label}</div></th>)}</tr>
          <tr><th className="ts-stick">{t('tradeStats.name')}</th>{periods.map((p) => <React.Fragment key={p.id}><th className="n ts-edge">{t('tradeStats.col_putUp')}</th><th className="n">{t('tradeStats.col_pickedUp')}</th></React.Fragment>)}</tr>
        </thead>
        <tbody>
          <tr className="ts-sum"><td className="ts-stick">{t('tradeStats.total')}</td>{totals.map((c, i) => <React.Fragment key={i}>{pair(c)}</React.Fragment>)}</tr>
          {list.map((r) => (
            <tr key={r.userId} className="click" tabIndex={0} onClick={() => onPerson(r)} onKeyDown={(e) => e.key === 'Enter' && onPerson(r)}>
              <td className="ts-stick"><b>{r.name}</b></td>
              {r.cells.map((c, i) => <React.Fragment key={i}>{pair(c)}</React.Fragment>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>;
}

/** One person's requests in the period, each with what it counted for. */
function PersonRequests({ person, args, period, onClose }) {
  const t = useT();
  const { call, jobs, people } = useApp();
  const [data, setData] = useState(null);
  useEffect(() => { call('tradeStats.list', { ...args, compare: undefined, userId: person.userId }).then(setData, () => setData({ requests: [] })); }, [person.userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shift = (s) => (s ? `${prettyDate(s.date)} · ${fmtTime(s.start, t.lang)}${s.end ? `–${fmtTime(s.end, t.lang)}` : ''}` : t('tradeStats.shiftGone'));
  return (
    <Modal title={person.name} sub={period} onClose={onClose}>
      {!data && <div className="empty">{t('common.loading')}</div>}
      {data && !data.requests.length && <Empty icon="swap" title={t('tradeStats.noRequests')} />}
      {data?.requests.map((r) => (
        <div key={r.id} className="ts-req">
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="badge">{t(`tradeStats.type_${r.type}`)}</span>
            {r.outcome && <span className={`badge ${{ taken: 'ok', waiting: 'brand', notTaken: 'warn', cancelled: '' }[r.outcome]}`}>{t(`tradeStats.outcome_${r.outcome}`)}</span>}
            {!r.outcome && r.status === 'approved' && <span className="badge ok">{t('tradeStats.outcome_taken')}</span>}
            <span className="spacer" />
            <span className="tiny faint">{t('tradeStats.asked', { date: stampDay(r.createdAt) })}{r.movedAt ? ` · ${t('tradeStats.moved', { date: stampDay(r.movedAt) })}` : ''}</span>
          </div>
          <div className="small row wrap" style={{ gap: 5 }}>
            {r.shift && <JobDot job={jobs[r.shift.jobCodeId]} />}<b>{shift(r.shift)}</b>
            {r.shift && <span className="muted">{jobs[r.shift.jobCodeId]?.name}{r.shift.area ? ` · ${r.shift.area}` : ''}</span>}
          </div>
          {r.type === 'swap' && r.targetShift && <div className="small muted">{t('tradeStats.forShift', { shift: shift(r.targetShift) })}</div>}
          {r.otherUserId && <div className="small row" style={{ gap: 6 }}><Avatar user={people[r.otherUserId]} size="sm" />{t(r.side === 'pickup' ? 'tradeStats.fromName' : 'tradeStats.withName', { name: r.otherName })}</div>}
          <div className="ts-chips">
            {r.counts.filter((k) => ['putUp', 'pickedUp', 'tradesDone'].includes(k)).map((k) => <span key={k} className="badge brand">{t(`tradeStats.col_${k}`)}</span>)}
            {r.hoursGiven ? <span className="badge">{t('tradeStats.hoursGivenN', { n: num(r.hoursGiven) })}</span> : null}
            {r.hoursTaken ? <span className="badge">{t('tradeStats.hoursTakenN', { n: num(r.hoursTaken) })}</span> : null}
          </div>
        </div>
      ))}
    </Modal>
  );
}

/** My Shifts: my own counts this season (staff never see anyone else's). */
export function MyTradeCounts() {
  const t = useT();
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  useEffect(() => { call('tradeStats.get', {}).then(setData, () => {}); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const c = data.counts;
  if (!c.putUp && !c.pickedUp && !c.tradesDone) return null;
  return (
    <div className="card card-pad section row wrap" style={{ gap: 10 }}>
      <Icon name="swap" size={18} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <b>{t('tradeStats.myTitle', { season: data.period.label })}</b>
        <div className="small muted">{t('tradeStats.myLine', { putUp: c.putUp, pickedUp: c.pickedUp, trades: c.tradesDone })}</div>
      </div>
    </div>
  );
}

/** A link to the report (Team and Swaps), for managers. */
export function TradeStatsLink({ style }) {
  const t = useT();
  const { isMgr } = useApp();
  if (!isMgr) return null;
  return <a className="btn sm" href="#/trade-stats" style={style}><Icon name="chart" />{t('tradeStats.link')}</a>;
}
