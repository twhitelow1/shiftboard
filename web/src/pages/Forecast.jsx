import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, Modal, money, useAction, JobDot, Empty } from '../ui.jsx';
import { addDays, dow, parseDate, range } from '../../../core/time.js';
import { useWeek, WeekNav } from './Schedule.jsx';
import LaborReview from './LaborReview.jsx';
import ActualHours from './ActualHours.jsx';
import { ForecastPars } from './ProgrammingParts.jsx';
import { useT, dowShort, dowLong, getLang, prettyDate, num, t as tr } from '../i18n/index.js';

// Two tabs: the week ahead (forecast & scheduled labor), and Labor review of past weeks (#/forecast/labor).
/** How a day's forecast was worked out, in the current language (core/forecast.js basisKey). */
export const basisText = (d) => (d.basisKey ? tr(`forecast.basis_${d.basisKey}`, { ...d.basisParams, dow: d.basisParams ? dayPlural(d.basisParams.dow) : '' }) : d.basis);
// 'Mon' (English adds the s: "prior Mons") · 'lunes', 'sábados' (Spanish).
const dayPlural = (i) => (getLang() === 'es' ? dowLong(i).replace(/o$/, 'os') : dowShort(i));

export default function Forecast({ parts }) {
  const t = useT();
  const tab = parts?.[1] === 'labor' ? 'labor' : 'forecast';
  return (
    <div>
      <div className="tabs">
        <button className={tab === 'forecast' ? 'on' : ''} onClick={() => { location.hash = '#/forecast'; }}><Icon name="chart" size={16} />{t('forecast.forecast')}</button>
        <button className={tab === 'labor' ? 'on' : ''} onClick={() => { location.hash = '#/forecast/labor'; }}><Icon name="clock" size={16} />{t('forecast.laborReview')}</button>
      </div>
      {tab === 'labor' ? <LaborReview /> : <ForecastWeek />}
    </div>
  );
}

function ForecastWeek() {
  const t = useT();
  const { call, version, jobs, settings, isAdmin } = useApp();
  const [ws, setWs] = useWeek();
  const [f, setF] = useState(null);
  const [dp, setDp] = useState('Dinner');
  const [edit, setEdit] = useState(null);
  const [salesOpen, setSalesOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [run, busy] = useAction();
  const load = () => call('forecast.week', { weekStart: ws }).then(setF);
  useEffect(() => { load(); }, [ws, version]);
  if (!f) return <div className="empty">{t('common.loading')}</div>;

  const open = f.days.filter((d) => !d.closed);
  const maxCovers = Math.max(1, ...f.days.map((d) => d.totalCovers));
  const dayparts = settings.dayparts.map((d) => d.name);
  const allJobIds = [...new Set(f.days.flatMap((d) => d.dayparts.filter((x) => x.name === dp).flatMap((x) => x.rows.map((r) => r.jobCodeId))))];
  const gaps = f.days.reduce((t, d) => t + d.dayparts.reduce((a, x) => a + x.rows.reduce((b, r) => b + Math.max(0, r.gap), 0), 0), 0);
  const noHistory = open.every((d) => !d.samples && !d.override);

  return (
    <div>
      <div className="toolbar">
        <WeekNav ws={ws} setWs={setWs} />
        <span className="spacer" />
        <button className="btn sm" onClick={() => setSalesOpen(true)}><Icon name="upload" />{t('forecast.salesHistory')}</button>
        <button className="btn sm" onClick={() => setRulesOpen(true)}><Icon name="settings" />{t('forecast.laborRules')}</button>
      </div>
      {settings.demo && <div className="alert info section"><Icon name="sparkle" size={16} />{t('forecast.salesHistoryHereIsSample')}</div>}
      {noHistory && <div className="alert warn section"><Icon name="alert" size={16} />{t('forecast.noSalesHistoryYetAdd')}</div>}

      <div className="kpis">
        <div className="card kpi"><div className="l">{t('forecast.forecastCovers')}</div><div className="v">{num(f.totals.covers)}</div><div className="s">{t('forecast.incl')}{' '}{f.days.reduce((t, d) => t + d.eventGuests, 0)}{' '}{t('forecast.eventGuests')}</div></div>
        <div className="card kpi"><div className="l">{t('forecast.forecastSales')}</div><div className="v">{money(f.totals.sales)}</div><div className="s">{t('forecast.restaurantEventRevenue')}</div></div>
        <div className="card kpi"><div className="l">{t('forecast.scheduledLabor')}</div><div className="v">{money(f.totals.cost)}</div><div className="s">{t('common.hoursHrs', { hours: f.totals.hours })}</div></div>
        <div className="card kpi"><div className="l">{t('forecast.labor')}</div><div className="v" style={{ color: f.totals.laborPct > f.targetLaborPct ? 'var(--bad)' : 'var(--ok)' }}>{f.totals.laborPct ?? '—'}%</div><div className="s">{t('forecast.targetTargetlaborpct', { targetLaborPct: f.targetLaborPct })}</div></div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>{t('forecast.coversByDay')}</h2>
          <div className="legend"><span><i style={{ background: 'var(--brand)' }} />{t('common.restaurant')}</span><span><i style={{ background: '#f59e0b' }} />{t('common.events')}</span></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="bars">
            {f.days.map((d) => (
              <div key={d.date} className="b" title={basisText(d)}>
                <div className="lbl">{d.closed ? '' : d.totalCovers}</div>
                {d.eventGuests > 0 && <div className="seg2" style={{ height: `${(d.eventGuests / maxCovers) * 140}px` }} />}
                <div className="seg1" style={{ height: `${(d.covers / maxCovers) * 140}px`, opacity: d.override ? 0.75 : 1 }} />
              </div>
            ))}
          </div>
          <div className="bars-x">{f.days.map((d) => <div key={d.date}>{dowShort(d.dow)} {parseDate(d.date).getUTCDate()}</div>)}</div>
        </div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>{t('forecast.dailyForecastLabor')}</h2><span className="small muted desktop-only">{t('forecast.tapAForecastToOverride')}</span></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('common.day')}</th><th>{t('forecast.covers')}</th><th>{t('forecast.sales')}</th><th>{t('common.events')}</th><th>{t('forecast.basis')}</th><th>{t('forecast.actual')}</th><th>{t('common.hours')}</th><th>{t('forecast.labor2')}</th><th>{t('forecast.labor')}</th></tr></thead>
            <tbody>
              {f.days.map((d) => (
                <tr key={d.date}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{prettyDate(d.date)}</td>
                  {d.closed ? <td colSpan={8} className="faint">{t('common.closed')}</td> : <>
                    <td><button className="btn sm ghost num" onClick={() => setEdit(d)} style={{ fontWeight: 700 }}>{d.covers}{d.override && <span className="badge brand" style={{ marginLeft: 4 }}>{t('forecast.set')}</span>}</button></td>
                    <td className="num">{money(d.sales)}</td>
                    <td className="small">{d.events.length ? d.events.map((e) => <div key={e.id}><a href={`#/events/${e.id}`}>{e.name}</a>{e.guestCount > 0 && <span className="faint"> ({e.guestCount})</span>}</div>) : <span className="faint">—</span>}</td>
                    <td className="small muted">{basisText(d)}</td>
                    <td className="num small">{d.actual ? `${d.actual.covers} · ${money(d.actual.sales)}` : <span className="faint">—</span>}</td>
                    <td className="num">{d.hours}</td>
                    <td className="num">{money(d.laborCost)}</td>
                    <td><span className={`badge ${d.laborPct == null ? '' : d.laborPct > f.targetLaborPct ? 'bad' : 'ok'}`}>{d.laborPct ?? '—'}%</span></td>
                  </>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <div className="card-head row wrap">
          <h2 style={{ flex: 1 }}>{t('forecast.staffingScheduledVsRecommended')}</h2>
          <div className="seg">{dayparts.map((n) => <button key={n} className={dp === n ? 'on' : ''} onClick={() => setDp(n)}>{n}</button>)}</div>
          {gaps > 0 && <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('forecast.fillGaps', { weekStart: ws }), (r) => t('forecast.addedCreatedOpenDraftShifts', { created: r.created })).then(load)}><Icon name="plus" />{t('forecast.fillCountGapsWithOpen', { count: gaps })}</button>}
        </div>
        {!allJobIds.length ? <Empty icon="chart" title={t('forecast.noLaborRulesForThis')}>{t('forecast.setRulesLike1Server')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('forecast.positionAtPeak')}</th>{f.days.map((d) => <th key={d.date} style={{ textAlign: 'center' }}>{dowShort(d.dow)}</th>)}</tr></thead>
              <tbody>
                {allJobIds.map((jid) => (
                  <tr key={jid}>
                    <td style={{ whiteSpace: 'nowrap' }}><span className="row" style={{ gap: 6 }}><JobDot job={jobs[jid]} />{jobs[jid]?.name}</span></td>
                    {f.days.map((d) => {
                      const x = d.dayparts.find((p) => p.name === dp)?.rows.find((r) => r.jobCodeId === jid);
                      if (!x) return <td key={d.date} className="faint" style={{ textAlign: 'center' }}>—</td>;
                      if (x.recommended == null) return <td key={d.date} style={{ textAlign: 'center' }} className="num small">{x.scheduled}</td>;
                      const cls = x.scheduled < x.recommended ? 'under' : x.scheduled > x.recommended + 1 ? 'over' : 'okay';
                      return <td key={d.date}><div className={`gapcell ${cls}`}>{x.scheduled}/{x.recommended}</div></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad legend" style={{ paddingTop: 8 }}>
          <span><i style={{ background: 'var(--bad-soft)' }} />{t('forecast.underStaffed')}</span><span><i style={{ background: 'var(--ok-soft)' }} />{t('forecast.onTarget')}</span><span><i style={{ background: 'var(--warn-soft)' }} />{t('forecast.overBy2')}</span>
          <span className="faint">{t('forecast.scheduledRecommendedOnTheFloor', { peak: settings.dayparts.find((d) => d.name === dp)?.peak })}</span>
        </div>
      </div>

      {/* The regular programming's pars next to the forecast's suggestion (core/programming.js); the forecast stays as it is. */}
      <ForecastPars f={f} dp={dp} />

      {/* Staffing learned from clock-ins (ADP or Toast), next to the rules above. */}
      <ActualHours ws={ws} />

      {edit && <OverrideDialog day={edit} onClose={(c) => { setEdit(null); if (c) load(); }} />}
      {salesOpen && <SalesDialog ws={ws} onClose={(c) => { setSalesOpen(false); if (c) load(); }} />}
      {rulesOpen && <RulesDialog onClose={(c) => { setRulesOpen(false); if (c) load(); }} />}
    </div>
  );
}

function OverrideDialog({ day, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [covers, setCovers] = useState(day.covers);
  const [sales, setSales] = useState(day.sales);
  const [run, busy] = useAction();
  const avg = day.covers ? day.sales / day.covers : 60;
  return (
    <Modal title={t('forecast.forecastForDate', { date: prettyDate(day.date) })} sub={basisText(day)} onClose={() => onClose(false)}
      footer={<>
        {day.override && <button className="btn" disabled={busy} onClick={() => run(() => call('forecast.override', { date: day.date, clear: true }), t('forecast.backToAutomatic')).then(() => onClose(true))}>{t('forecast.useAutomatic')}</button>}
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => run(() => call('forecast.override', { date: day.date, covers, sales }), t('forecast.forecastUpdated')).then(() => onClose(true))}>{t('common.save')}</button>
      </>}>
      <div className="grid2">
        <Field label={t('forecast.restaurantCovers')}><input className="input" type="number" value={covers} onChange={(e) => { setCovers(e.target.value); setSales(Math.round(Number(e.target.value) * avg)); }} /></Field>
        <Field label={t('forecast.restaurantSales')}><input className="input" type="number" value={sales} onChange={(e) => setSales(e.target.value)} /></Field>
      </div>
      <div className="help">{t('forecast.eventGuestsEventguestsAreAdded', { eventGuests: day.eventGuests })}</div>
    </Modal>
  );
}

function SalesDialog({ ws, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [rows, setRows] = useState(null);
  const [paste, setPaste] = useState('');
  const [run, busy] = useAction();
  const start = addDays(ws, -14);
  useEffect(() => {
    call('sales.list', { start, end: addDays(ws, 6) }).then((list) => {
      const by = Object.fromEntries(list.map((r) => [r.date, r]));
      setRows(range(start, 21).map((d) => ({ date: d, covers: by[d]?.covers ?? '', sales: by[d]?.sales ?? '' })));
    });
  }, [ws]);
  const parsedPaste = paste.trim().split('\n').map((l) => l.split(/[,\t]/).map((c) => c.trim())).filter((c) => c.length >= 2 && /\d/.test(c[0])).map(([d, covers, sales]) => {
    const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    const date = us ? `${us[3].length === 2 ? '20' + us[3] : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : d;
    return { date, covers: Number(String(covers).replace(/[$,]/g, '')), sales: Number(String(sales || 0).replace(/[$,]/g, '')) };
  }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  const save = async () => {
    const data = [...(rows || []).filter((r) => r.covers !== '' || r.sales !== ''), ...parsedPaste];
    const r = await run(() => call('sales.upsert', { rows: data }), (r) => t('forecast.savedSavedDaysOfSales', { saved: r.saved }));
    if (r) onClose(true);
  };
  return (
    <Modal wide title={t('forecast.dailySalesCovers')} sub={t('forecast.actualsDriveTheForecastEnter')} onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy} onClick={save}>{t('common.save')}</button></>}>
      <div className="grid2">
        <div>
          <h3 style={{ marginBottom: 8 }}>{t('forecast.recentDays')}</h3>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>{t('common.date')}</th><th>{t('forecast.covers')}</th><th>{t('forecast.sales2')}</th></tr></thead>
              <tbody>{rows?.map((r, i) => (
                <tr key={r.date}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{prettyDate(r.date)}</td>
                  <td><input className="input sm" type="number" value={r.covers} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, covers: e.target.value } : x)))} /></td>
                  <td><input className="input sm" type="number" value={r.sales} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, sales: e.target.value } : x)))} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
        <div className="col">
          <h3>{t('forecast.pasteFromYourPos')}</h3>
          <textarea className="input" style={{ minHeight: 220, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder={t('forecast.dateCoversSales920')} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="help">{parsedPaste.length ? t('forecast.parsedpastecountRowsReady', { parsedPasteCount: parsedPaste.length }) : t('forecast.oneDayPerLineDate')}</div>
        </div>
      </div>
    </Modal>
  );
}

function RulesDialog({ onClose }) {
  const t = useT();
  const { call, settings, jobCodes } = useApp();
  const [rules, setRules] = useState(settings.laborRules || []);
  const [run, busy] = useAction();
  const setR = (i, k) => (e) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const active = jobCodes.filter((j) => !j.archived);
  return (
    <Modal wide title={t('forecast.laborRules')} sub={t('forecast.howManyOfEachPosition')} onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy} onClick={() => run(() => call('settings.laborRules', { laborRules: rules }), t('forecast.laborRulesSaved')).then(() => onClose(true))}>{t('forecast.saveRules')}</button></>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('common.position')}</th><th>{t('forecast.daypart')}</th><th>{t('forecast.basedOn')}</th><th>{t('forecast.n1PerCount')}</th><th>{t('forecast.min')}</th><th>{t('forecast.max')}</th><th /></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.id || i}>
                <td><select className="input sm" value={r.jobCodeId} onChange={setR(i, 'jobCodeId')}>{active.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></td>
                <td><select className="input sm" value={r.daypart} onChange={setR(i, 'daypart')}><option value="">{t('forecast.allDayparts')}</option>{settings.dayparts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}</select></td>
                <td><select className="input sm" value={r.basis} onChange={setR(i, 'basis')}><option value="covers">{t('forecast.covers')}</option><option value="sales">{t('forecast.sales2')}</option><option value="fixed">{t('forecast.fixedCount')}</option></select></td>
                <td><input className="input sm" type="number" style={{ width: 90 }} value={r.per} onChange={setR(i, 'per')} /></td>
                <td><input className="input sm" type="number" style={{ width: 64 }} value={r.min} onChange={setR(i, 'min')} /></td>
                <td><input className="input sm" type="number" style={{ width: 64 }} value={r.max || ''} onChange={setR(i, 'max')} placeholder="—" /></td>
                <td><button className="btn sm icon ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Icon name="x" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRules([...rules, { jobCodeId: active[0]?.id, daypart: 'Dinner', basis: 'covers', per: 20, min: 1, max: 0 }])}><Icon name="plus" />{t('forecast.addRule')}</button>
      <div className="help">{t('forecast.examplesServerDinnerCovers22')}</div>
    </Modal>
  );
}
