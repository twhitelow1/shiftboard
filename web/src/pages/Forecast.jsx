import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, Modal, money, useAction, JobDot, Empty } from '../ui.jsx';
import { addDays, dow, DOW_SHORT, parseDate, prettyDate, range } from '../../../core/time.js';
import { useWeek, WeekNav } from './Schedule.jsx';

export default function Forecast() {
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
  if (!f) return <div className="empty">Loading…</div>;

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
        <button className="btn sm" onClick={() => setSalesOpen(true)}><Icon name="upload" />Sales history</button>
        <button className="btn sm" onClick={() => setRulesOpen(true)}><Icon name="settings" />Labor rules</button>
      </div>
      {settings.demo && <div className="alert info section"><Icon name="sparkle" size={16} />Sales history here is sample data. Import your POS daily sales (Toast, Square, etc. export → CSV) and the forecast uses your real numbers.</div>}
      {noHistory && <div className="alert warn section"><Icon name="alert" size={16} />No sales history yet — add a few weeks of daily covers & sales, or type your own forecast into the table.</div>}

      <div className="kpis">
        <div className="card kpi"><div className="l">Forecast covers</div><div className="v">{f.totals.covers.toLocaleString()}</div><div className="s">incl. {f.days.reduce((t, d) => t + d.eventGuests, 0)} event guests</div></div>
        <div className="card kpi"><div className="l">Forecast sales</div><div className="v">{money(f.totals.sales)}</div><div className="s">restaurant + event revenue</div></div>
        <div className="card kpi"><div className="l">Scheduled labor</div><div className="v">{money(f.totals.cost)}</div><div className="s">{f.totals.hours} hrs</div></div>
        <div className="card kpi"><div className="l">Labor %</div><div className="v" style={{ color: f.totals.laborPct > f.targetLaborPct ? 'var(--bad)' : 'var(--ok)' }}>{f.totals.laborPct ?? '—'}%</div><div className="s">target {f.targetLaborPct}%</div></div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>Covers by day</h2>
          <div className="legend"><span><i style={{ background: 'var(--brand)' }} />Restaurant</span><span><i style={{ background: '#f59e0b' }} />Events</span></div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4 }}>
          <div className="bars">
            {f.days.map((d) => (
              <div key={d.date} className="b" title={d.basis}>
                <div className="lbl">{d.closed ? '' : d.totalCovers}</div>
                {d.eventGuests > 0 && <div className="seg2" style={{ height: `${(d.eventGuests / maxCovers) * 140}px` }} />}
                <div className="seg1" style={{ height: `${(d.covers / maxCovers) * 140}px`, opacity: d.override ? 0.75 : 1 }} />
              </div>
            ))}
          </div>
          <div className="bars-x">{f.days.map((d) => <div key={d.date}>{DOW_SHORT[d.dow]} {parseDate(d.date).getUTCDate()}</div>)}</div>
        </div>
      </div>

      <div className="card section">
        <div className="card-head"><h2 style={{ flex: 1 }}>Daily forecast & labor</h2><span className="small muted desktop-only">Tap a forecast to override it</span></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Day</th><th>Covers</th><th>Sales</th><th>Events</th><th>Basis</th><th>Actual</th><th>Hours</th><th>Labor $</th><th>Labor %</th></tr></thead>
            <tbody>
              {f.days.map((d) => (
                <tr key={d.date}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{prettyDate(d.date)}</td>
                  {d.closed ? <td colSpan={8} className="faint">Closed</td> : <>
                    <td><button className="btn sm ghost num" onClick={() => setEdit(d)} style={{ fontWeight: 700 }}>{d.covers}{d.override && <span className="badge brand" style={{ marginLeft: 4 }}>set</span>}</button></td>
                    <td className="num">{money(d.sales)}</td>
                    <td className="small">{d.events.length ? d.events.map((e) => <div key={e.id}><a href={`#/events/${e.id}`}>{e.name}</a>{e.guestCount > 0 && <span className="faint"> ({e.guestCount})</span>}</div>) : <span className="faint">—</span>}</td>
                    <td className="small muted">{d.basis}</td>
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
          <h2 style={{ flex: 1 }}>Staffing: scheduled vs. recommended</h2>
          <div className="seg">{dayparts.map((n) => <button key={n} className={dp === n ? 'on' : ''} onClick={() => setDp(n)}>{n}</button>)}</div>
          {gaps > 0 && <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('forecast.fillGaps', { weekStart: ws }), (r) => `Added ${r.created} open draft shifts — review them on the schedule`).then(load)}><Icon name="plus" />Fill {gaps} gap{gaps > 1 ? 's' : ''} with open shifts</button>}
        </div>
        {!allJobIds.length ? <Empty icon="chart" title="No labor rules for this daypart">Set rules like “1 server per 22 covers” under Labor rules.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Position (at peak)</th>{f.days.map((d) => <th key={d.date} style={{ textAlign: 'center' }}>{DOW_SHORT[d.dow]}</th>)}</tr></thead>
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
          <span><i style={{ background: 'var(--bad-soft)' }} />Under-staffed</span><span><i style={{ background: 'var(--ok-soft)' }} />On target</span><span><i style={{ background: 'var(--warn-soft)' }} />Over by 2+</span>
          <span className="faint">Scheduled/recommended on the floor at {settings.dayparts.find((d) => d.name === dp)?.peak} peak. Event shifts excluded — events are staffed from their BEO.</span>
        </div>
      </div>

      {edit && <OverrideDialog day={edit} onClose={(c) => { setEdit(null); if (c) load(); }} />}
      {salesOpen && <SalesDialog ws={ws} onClose={(c) => { setSalesOpen(false); if (c) load(); }} />}
      {rulesOpen && <RulesDialog onClose={(c) => { setRulesOpen(false); if (c) load(); }} />}
    </div>
  );
}

function OverrideDialog({ day, onClose }) {
  const { call } = useApp();
  const [covers, setCovers] = useState(day.covers);
  const [sales, setSales] = useState(day.sales);
  const [run, busy] = useAction();
  const avg = day.covers ? day.sales / day.covers : 60;
  return (
    <Modal title={`Forecast for ${prettyDate(day.date)}`} sub={day.basis} onClose={() => onClose(false)}
      footer={<>
        {day.override && <button className="btn" disabled={busy} onClick={() => run(() => call('forecast.override', { date: day.date, clear: true }), 'Back to automatic').then(() => onClose(true))}>Use automatic</button>}
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => run(() => call('forecast.override', { date: day.date, covers, sales }), 'Forecast updated').then(() => onClose(true))}>Save</button>
      </>}>
      <div className="grid2">
        <Field label="Restaurant covers"><input className="input" type="number" value={covers} onChange={(e) => { setCovers(e.target.value); setSales(Math.round(Number(e.target.value) * avg)); }} /></Field>
        <Field label="Restaurant sales ($)"><input className="input" type="number" value={sales} onChange={(e) => setSales(e.target.value)} /></Field>
      </div>
      <div className="help">Event guests ({day.eventGuests}) are added on top from BEOs. Use this for holidays, weather, a big game, etc.</div>
    </Modal>
  );
}

function SalesDialog({ ws, onClose }) {
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
    const r = await run(() => call('sales.upsert', { rows: data }), (r) => `Saved ${r.saved} days of sales`);
    if (r) onClose(true);
  };
  return (
    <Modal wide title="Daily sales & covers" sub="Actuals drive the forecast. Enter recent days, or paste an export." onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="grid2">
        <div>
          <h3 style={{ marginBottom: 8 }}>Recent days</h3>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Date</th><th>Covers</th><th>Sales $</th></tr></thead>
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
          <h3>Paste from your POS</h3>
          <textarea className="input" style={{ minHeight: 220, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} placeholder={'date, covers, sales\n9/20/2026, 262, 17810\n9/19/2026, 240, 15720'} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="help">{parsedPaste.length ? `${parsedPaste.length} rows ready` : 'One day per line: date, covers, net sales. Works with CSV or copied spreadsheet columns.'}</div>
        </div>
      </div>
    </Modal>
  );
}

function RulesDialog({ onClose }) {
  const { call, settings, jobCodes } = useApp();
  const [rules, setRules] = useState(settings.laborRules || []);
  const [run, busy] = useAction();
  const setR = (i, k) => (e) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const active = jobCodes.filter((j) => !j.archived);
  return (
    <Modal wide title="Labor rules" sub="How many of each position you need, driven by forecast covers or sales" onClose={() => onClose(false)}
      footer={<><button className="btn" onClick={() => onClose(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => call('settings.laborRules', { laborRules: rules }), 'Labor rules saved').then(() => onClose(true))}>Save rules</button></>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Position</th><th>Daypart</th><th>Based on</th><th>1 per / count</th><th>Min</th><th>Max</th><th /></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.id || i}>
                <td><select className="input sm" value={r.jobCodeId} onChange={setR(i, 'jobCodeId')}>{active.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></td>
                <td><select className="input sm" value={r.daypart} onChange={setR(i, 'daypart')}><option value="">All dayparts</option>{settings.dayparts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}</select></td>
                <td><select className="input sm" value={r.basis} onChange={setR(i, 'basis')}><option value="covers">Covers</option><option value="sales">Sales $</option><option value="fixed">Fixed count</option></select></td>
                <td><input className="input sm" type="number" style={{ width: 90 }} value={r.per} onChange={setR(i, 'per')} /></td>
                <td><input className="input sm" type="number" style={{ width: 64 }} value={r.min} onChange={setR(i, 'min')} /></td>
                <td><input className="input sm" type="number" style={{ width: 64 }} value={r.max || ''} onChange={setR(i, 'max')} placeholder="—" /></td>
                <td><button className="btn sm icon ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Icon name="x" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRules([...rules, { jobCodeId: active[0]?.id, daypart: 'Dinner', basis: 'covers', per: 20, min: 1, max: 0 }])}><Icon name="plus" />Add rule</button>
      <div className="help">Examples: Server · Dinner · Covers · 22 → one server per 22 dinner covers. Bartender · Sales · 1500 → one per $1,500. Host · Fixed · 1. Daypart share of daily covers is set in Settings.</div>
    </Modal>
  );
}
