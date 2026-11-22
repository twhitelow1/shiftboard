// Forecast & Labor → "From your actual hours": staffing suggested from what each position really took
// per cover (core/calibrate.js), next to the rule-based grid above it. The forecast itself never changes.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, JobDot, Empty } from '../ui.jsx';
import { parseDate } from '../../../core/time.js';
import { useT, dowShort, dowLong, getLang, num } from '../i18n/index.js';
import '../labor.css';

const h = (n) => (n == null ? '—' : num(Math.round(n * 10) / 10, { maximumFractionDigits: 1 }));
// 'Fridays' · 'viernes', 'sábados'.
const dayPlural = (i) => (getLang() === 'es' ? dowLong(i).replace(/o$/, 'os') : `${dowLong(i)}s`);
const gap = (r) => Math.max(2, (r.suggested || 0) * 0.15);
const cls = (r) => (r.suggested == null ? '' : r.scheduled - r.suggested > gap(r) ? 'over' : r.suggested - r.scheduled > gap(r) ? 'under' : 'okay');

export default function ActualHours({ ws }) {
  const t = useT();
  const { call, version, jobs, settings } = useApp();
  const [weeks, setWeeks] = useState(() => Math.min(8, Math.max(4, Number(settings.calibrationWeeks) || 6)));
  const [dp, setDp] = useState('all');
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setErr(''); call('calibration.week', { weekStart: ws, weeks }).then(setC).catch((e) => setErr(e.message)); }, [ws, weeks, version]);

  const head = (
    <div className="card-head row wrap">
      <h2 style={{ flex: 1 }}>{t('calibration.title')}</h2>
      <div className="seg" role="group" aria-label={t('calibration.weeksOfHistory')}>
        {[4, 6, 8].map((w) => <button key={w} className={weeks === w ? 'on' : ''} onClick={() => setWeeks(w)}>{t('calibration.nWeeks', { count: w })}</button>)}
      </div>
    </div>
  );
  if (err) return <div className="card section">{head}<div className="card-pad"><div className="alert bad">{err}</div></div></div>;
  if (!c) return <div className="card section">{head}<div className="card-pad small faint">{t('common.loading')}</div></div>;

  const name = (id) => jobs[id]?.name || t('calibration.unknownPosition');
  const order = (id) => jobs[id]?.order ?? 999;
  const ids = [...new Set(c.days.flatMap((d) => d.rows.filter((r) => r.daypart === dp).map((r) => r.jobCodeId)))].sort((a, b) => order(a) - order(b) || name(a).localeCompare(name(b)));
  const source = c.source === 'adp' ? 'ADP' : c.source === 'both' ? 'ADP + Toast' : 'Toast';

  return (
    <div className="card section ah">
      {head}
      <div className="card-pad small muted" style={{ paddingTop: 0 }}>{t('calibration.sub', { weeks: c.weeks, source })}</div>
      {!c.sampleDays ? <Empty icon="clock" title={t('calibration.noHistory', { weeks: c.weeks })}>{t('calibration.noHistoryHelp')}</Empty> : (
        <>
          {c.clockWeeks < 4 && <div className="card-pad" style={{ paddingTop: 0 }}><div className="alert info"><Icon name="clock" size={16} />{t('calibration.fewWeeks', { count: c.clockWeeks })}</div></div>}
          {c.highlights.length > 0 && (
            <ul className="ah-highlights">
              {c.highlights.map((x) => (
                <li key={`${x.date}-${x.jobCodeId}`} className={x.diff > 0 ? 'over' : 'under'}>
                  <Icon name={x.diff > 0 ? 'up' : 'down'} size={14} />
                  <span>{t('calibration.highlight', {
                    day: dayPlural(x.dow), sched: h(x.history.sched), position: name(x.jobCodeId), actual: h(x.history.actual), covers: num(x.history.covers),
                    scheduled: h(x.scheduled), forecast: num(x.covers), suggested: h(x.suggested),
                  })}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="card-head row wrap" style={{ borderTop: '1px solid var(--border)' }}>
            <h3 style={{ flex: 1 }}>{t('calibration.byDay')}</h3>
            <div className="seg">
              <button className={dp === 'all' ? 'on' : ''} onClick={() => setDp('all')}>{t('calibration.allDay')}</button>
              {c.dayparts.map((n) => <button key={n} className={dp === n ? 'on' : ''} onClick={() => setDp(n)}>{n}</button>)}
            </div>
          </div>
          {!ids.length ? <div className="card-pad small faint">{t('calibration.nothingThisDaypart')}</div> : (
            <div className="table-wrap">
              <table className="table lr-table ah-table">
                <thead><tr><th>{t('common.position')}</th>{c.days.map((d) => <th key={d.date} style={{ textAlign: 'center' }}>{dowShort(d.dow)} {parseDate(d.date).getUTCDate()}<div className="tiny faint">{d.closed ? t('common.closed') : t('calibration.coversShort', { covers: num(d.covers) })}</div></th>)}</tr></thead>
                <tbody>
                  {ids.map((id) => (
                    <tr key={id}>
                      <td className="lr-stick"><span className="row" style={{ gap: 6 }}><JobDot job={jobs[id]} /><b>{name(id)}</b></span></td>
                      {c.days.map((d) => {
                        const r = d.rows.find((x) => x.jobCodeId === id && x.daypart === dp);
                        if (!r) return <td key={d.date} className="faint" style={{ textAlign: 'center' }}>—</td>;
                        const tip = r.history ? t('calibration.cellTip', { sched: h(r.history.sched), actual: h(r.history.actual), covers: num(r.history.covers), days: r.history.days }) : '';
                        return <td key={d.date} title={tip}><div className={`gapcell ${cls(r)}`}>{h(r.scheduled)}/{r.suggested == null ? '—' : h(r.suggested)}</div></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-pad legend" style={{ paddingTop: 8 }}>
            <span><i style={{ background: 'var(--warn-soft)' }} />{t('calibration.overScheduled')}</span><span><i style={{ background: 'var(--ok-soft)' }} />{t('calibration.aboutRight')}</span><span><i style={{ background: 'var(--bad-soft)' }} />{t('calibration.underScheduled')}</span>
            <span className="faint">{t('calibration.legend')}</span>
          </div>

          <div className="ah-trends">
            <div>
              <h3>{t('calibration.trendsTitle')}</h3>
              <div className="help">{t('calibration.trendsHelp', { weeks: c.weeks })}</div>
              <div className="table-wrap">
                <table className="table lr-table">
                  <thead><tr><th>{t('common.day')}</th><th>{t('calibration.avgScheduled')}</th><th>{t('calibration.avgWorked')}</th><th>+/−</th></tr></thead>
                  <tbody>
                    {c.byDow.map((d) => (
                      <tr key={d.dow}>
                        <td className="lr-stick"><b>{dowShort(d.dow)}</b><div className="tiny faint">{t('calibration.nDays', { count: d.days })}</div></td>
                        <td className="num">{h(d.sched)}</td>
                        <td className="num">{h(d.actual)}</td>
                        <td className="num">{Math.abs(d.diff) < 0.5 ? <span className="faint">0</span>
                          : <span className={`lr-diff ${d.diff > 0 ? 'over' : 'under'}`}>{t(d.diff > 0 ? 'calibration.overBy' : 'calibration.underBy', { h: h(Math.abs(d.diff)), pct: d.pct == null ? '' : Math.abs(Math.round(d.pct)) })}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3>{t('calibration.otTitle')}</h3>
              <div className="help">{t('calibration.otHelp', { otAfter: settings.overtimeHours || 40 })}</div>
              {!c.overtime.length ? <div className="small muted" style={{ padding: '8px 0' }}><Icon name="check" size={14} />{' '}{t('calibration.noOtRisk')}</div> : (
                <div className="tp-list">
                  {c.overtime.map((o) => (
                    <div key={o.userId} className="tp-row">
                      <div className="tp-who"><b>{o.name}</b><div className="tiny faint">{t('calibration.otLine', { scheduled: h(o.scheduled), projected: h(o.projected), ratio: Math.round(o.ratio * 100) })}{o.otWeeks ? ` · ${t('calibration.otWeeks', { count: o.otWeeks })}` : ''}</div></div>
                      <span className={`badge ${o.level === 'over' ? 'bad' : 'warn'}`}>{t(o.level === 'over' ? 'calibration.likelyOt' : 'calibration.closeToOt')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {c.unassignedHours > 0 && <div className="card-pad help" style={{ paddingTop: 0 }}>{t('calibration.unassigned', { h: h(c.unassignedHours) })}</div>}
        </>
      )}
    </div>
  );
}
