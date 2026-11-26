// Tips: staff see their own share and how it was worked out; managers enter each day's tips,
// see the split, export it and finalize the week. The math is core/tips.js.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, Empty, useAction } from '../ui.jsx';
import { weekStart } from '../../../core/time.js';
import { roleLabel } from '../../../core/roles.js';
import { fmtCents, toCents, fmtHours, fmtPoints, fmtPct, dayTotal, contributionLabel, salesLabel, periodLabel, tipWarningText } from '../../../core/tips.js';
import { useWeek, WeekNav } from './Schedule.jsx';
import TipPoolSettings, { poolSummary } from './TipPoolSettings.jsx';
import '../tips.css';
import { tipsCsvRows, toCsv } from '../../../core/exports.js';
import { t, useT, stamp , t as tr } from '../i18n/index.js';

const TAB_KEY = 'sb_tips_tab';
const savedTab = () => { try { return sessionStorage.getItem(TAB_KEY); } catch { return null; } };

export default function Tips({ parts = [] }) {
  const t = useT();
  const { isMgr, settings } = useApp();
  const [ws, setWs] = useWeek();
  const [tab, setTabState] = useState(() => (isMgr ? (['enter', 'report', 'mine'].includes(savedTab()) ? savedTab() : 'enter') : 'mine'));
  const setTab = (k) => { setTabState(k); try { sessionStorage.setItem(TAB_KEY, k); } catch { /* ignore */ } };
  // A link from a notification (#/tips/2026-09-28) opens that week.
  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '')) { setWs(weekStart(parts[1], settings.weekStartDow)); if (isMgr) setTab('mine'); }
  }, [parts[1]]);

  return (
    <div className="tips-page">
      <div className="toolbar">
        <WeekNav ws={ws} setWs={setWs} />
        <span className="spacer" />
        {isMgr && (
          <div className="seg" role="tablist">
            {[['enter', t('tips.tabEnter')], ['report', t('tips.tabReport')], ['mine', t('tips.tabMine')]].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </div>
      {isMgr && tab !== 'mine' ? <Manager ws={ws} tab={tab} /> : <MyTips ws={ws} />}
    </div>
  );
}

// ---------- staff ----------
function sourceText(me) {
  if (me.source === 'toast') return tr('tips.hoursFromToast');
  if (me.source === 'adp') return tr('tips.hoursFromAdp');
  if (me.source === 'mixed') return tr('tips.hoursFromToastAndSchedule');
  if (me.source === 'schedule') return me.estimated ? tr('tips.hoursFromScheduleEstimated') : tr('tips.hoursFromSchedule');
  return '';
}

function MyTips({ ws }) {
  const t = useT();
  const { call, version } = useApp();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); call('myTips.week', { weekStart: ws }).then(setD).catch((e) => setErr(e.message)); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!d) return <div className="empty">{t('common.loading')}</div>;
  if (!d.pools.length) return <div className="card"><Empty icon="dollar" title={t('tips.noTipPoolYet')}>{t('tips.onceYourRestaurantSetsUp')}</Empty></div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card card-pad tip-hero">
        <div className="small" style={{ opacity: .85, fontWeight: 600 }}>{t('tips.yourTipsLabel', { label: d.label })}</div>
        <div className="tip-hero-amt">{fmtCents(d.total)}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {d.final ? <span className="tip-pill"><Icon name="check" size={14} />{t('tips.final')}</span> : <span className="tip-pill">{t('tips.estimateCanChangeUntilThe')}</span>}
        </div>
      </div>
      {d.waiting.map((name) => <div key={name} className="alert info"><Icon name="clock" size={16} />{t('tips.nameYourShareShowsHere', { name })}</div>)}
      {!d.items.length && !d.waiting.length && <div className="card"><Empty icon="dollar" title={t('tips.noTipsThisWeek')}>{t('tips.tipsShowUpHereAfter')}</Empty></div>}
      {d.items.length > 0 && (
        <div className="card list">
          {d.items.map((it) => (
            <div key={`${it.poolId}-${it.start}`} className="tip-mine">
              <div className="row" style={{ alignItems: 'baseline' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{it.label}</div>
                  <div className="small muted">{it.poolName}{it.period === 'week' ? t('tips.wholeWeek') : ''}{' '}{t('tips.poolAmount', { amount: fmtCents(it.poolTotal) })}</div>
                </div>
                <div className="tip-amt-lg">{fmtCents(it.me.amount)}</div>
              </div>
              <div className="tip-formula">{it.lines.map((l) => <div key={l}>{l}</div>)}</div>
              {sourceText(it.me) && <div className="tiny faint">{sourceText(it.me)}</div>}
            </div>
          ))}
        </div>
      )}
      <details className="card card-pad tip-rules">
        <summary>{t('tips.bHowThePoolWorks')}</summary>
        {d.pools.map((p) => (
          <div key={p.id} style={{ marginTop: 10 }}>
            {d.pools.length > 1 && <div style={{ fontWeight: 700 }}>{p.name}</div>}
            <ul className="tip-words">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        ))}
      </details>
    </div>
  );
}

// ---------- managers ----------
function Manager({ ws, tab }) {
  const t = useT();
  const { call, version, isAdmin } = useApp();
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  const load = () => call('tips.week', { weekStart: ws }).then((r) => { setRep(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setRep(null); load(); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!rep) return <div className="empty">{t('common.loading')}</div>;
  if (!rep.pools.length) {
    return isAdmin
      ? <div className="col" style={{ gap: 12 }}><div className="alert info"><Icon name="sparkle" size={16} />{t('tips.setUpYourTipPool')}</div><TipPoolSettings /></div>
      : <div className="card"><Empty icon="dollar" title={t('tips.noTipPoolYet')}>{t('tips.anAdminSetsItUp')}</Empty></div>;
  }
  return (
    <div className="col" style={{ gap: 14 }}>
      <LockBar rep={rep} />
      {tab === 'enter' ? rep.pools.map((pr) => <EnterPool key={pr.pool.id} pr={pr} pools={rep.pools.map((x) => x.pool)} locked={!!rep.locked} />) : <Report rep={rep} />}
    </div>
  );
}

function LockBar({ rep }) {
  const t = useT();
  const { call, isAdmin } = useApp();
  const [run, busy] = useAction();
  const [confirm, setConfirm] = useState(false);
  const fmtAt = (iso) => stamp(iso);
  if (rep.locked) {
    return (
      <div className="alert ok tip-lock">
        <Icon name="check" size={16} />
        <div style={{ flex: 1 }}>{t('tips.bFinalBLockedBy')}{' '}{rep.locked.byName || t('tips.aManager')}{' '}{t('tips.onFmtatTheseNumbersWont', { fmtAt: fmtAt(rep.locked.at) })}</div>
        {isAdmin ? <button className="btn sm" disabled={busy} onClick={() => run(() => call('tips.unlock', { weekStart: rep.weekStart }), t('tips.weekReopened'))}>{t('tips.unlock')}</button>
          : <span className="small">{t('tips.onlyAnAdminCanUnlock')}</span>}
      </div>
    );
  }
  return (
    <div className="card card-pad row wrap tip-lockbar">
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 700 }}>{t('tips.weekTotalAmount', { amount: fmtCents(rep.total) })}</div>
        <div className="small muted">{t('tips.notFinalYetFinalizeWhen')}</div>
      </div>
      <button className="btn primary" onClick={() => setConfirm(true)}><Icon name="check" />{t('tips.finalizeWeek')}</button>
      {confirm && (
        <Modal title={t('tips.finalizeLabel', { label: periodLabel(rep.weekStart, rep.end, t.lang) })} onClose={() => setConfirm(false)}
          footer={<><button className="btn" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => call('tips.finalize', { weekStart: rep.weekStart }), t('tips.weekFinalizedEveryoneWasTold')); if (r) setConfirm(false); }}>{t('tips.finalize')}</button></>}>
          <div>{t('tips.amountGoesToCountPeople', { amount: fmtCents(rep.total), count: rep.people.length })}</div>
          <div className="help">{t('tips.afterThisOnlyAnAdmin')}</div>
        </Modal>
      )}
    </div>
  );
}

function EnterPool({ pr, pools, locked }) {
  const t = useT();
  const { jobs } = useApp();
  const [day, setDay] = useState(null);
  const jobName = (id) => jobs[id]?.name || t('common.position');
  const { pool } = pr;
  return (
    <div className="card">
      <div className="card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{pool.name}</h2>
          <div className="small muted">{poolSummary(pool, pools, jobName)}</div>
        </div>
        <div className="tip-amt-lg">{fmtCents(pr.total)}</div>
      </div>
      <div className="list">
        {pr.days.map((d) => {
          const has = !!d.entry;
          const bits = [];
          if (d.useToast) bits.push(t('tips.bitToastTips'));
          else if (has) { if (d.card) bits.push(t('tips.bitCard', { amount: fmtCents(d.card) })); if (d.cash) bits.push(t('tips.bitCash', { amount: fmtCents(d.cash) })); }
          if (d.entry?.adjustments?.length) bits.push(t('tips.bitAdjustments', { count: d.entry.adjustments.length }));
          if (d.workers) bits.push(`${t('tips.bitWorked', { count: d.workers })}${d.toastHours ? t('tips.bitToastHours') : ''}`);
          return (
            <button key={d.date} className="list-item click tip-day" disabled={locked} onClick={() => setDay(d)}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontWeight: 700 }}>{periodLabel(d.date, d.date)}</div>
                {bits.length > 0 && <div className="small muted">{bits.join(' · ')}</div>}
              </div>
              {has || d.total ? <span className="tip-amt">{fmtCents(d.total)}</span> : <span className={`small ${d.workers ? 'tip-todo' : 'faint'}`}>{locked ? '—' : d.workers ? t('tips.addTips') : t('tips.nobodyWorked')}</span>}
              {!locked && <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />}
            </button>
          );
        })}
      </div>
      {day && <DayEditor pool={pool} day={day} onClose={() => setDay(null)} />}
    </div>
  );
}

const centsText = (c) => (c ? (c / 100).toFixed(2) : '');

function DayEditor({ pool, day, onClose }) {
  const t = useT();
  const { call, jobs, employees } = useApp();
  const [run, busy] = useAction();
  const e = day.entry || {};
  const [card, setCard] = useState(centsText(e.card));
  const [cash, setCash] = useState(centsText(e.cash));
  const [useToast, setUseToast] = useState(!!e.useToast);
  const [sales, setSales] = useState(() => Object.fromEntries(Object.entries(e.sales || {}).map(([k, v]) => [k, centsText(v)])));
  const [adj, setAdj] = useState(() => (e.adjustments || []).map((a) => ({ ...a, amount: (a.cents / 100).toFixed(2) })));
  const [note, setNote] = useState(e.note || '');
  const jobName = (id) => jobs[id]?.name || t('common.position');
  const salesLines = pool.contributions.filter((c) => c.type === 'sales');
  const eligible = employees.filter((u) => u.active !== false && !pool.excludeRoles.includes(u.role));

  const parsed = useMemo(() => {
    const out = { card: toCents(card), cash: toCents(cash), sales: {}, bad: '' };
    if (!useToast && (out.card == null || out.card < 0)) out.bad = t('tips.badCard');
    if (!useToast && (out.cash == null || out.cash < 0)) out.bad = t('tips.badCash');
    for (const c of salesLines) {
      const v = toCents(sales[c.id]);
      if (v == null || v < 0) out.bad = t('tips.badSales', { label: salesLabel(c, jobName, t.lang) });
      out.sales[c.id] = v || 0;
    }
    out.adjustments = adj.map((a) => ({ userId: a.userId, cents: toCents(a.amount), note: a.note }));
    return out;
  }, [card, cash, useToast, sales, adj, t]);
  const total = dayTotal(pool, { card: parsed.card || 0, cash: parsed.cash || 0, useToast, sales: parsed.sales }, day.toast);
  const adjTotal = parsed.adjustments.reduce((t, a) => t + (a.cents || 0), 0);

  const save = async () => {
    const r = await run(() => call('tipEntries.save', { poolId: pool.id, date: day.date, card: useToast ? 0 : parsed.card, cash: useToast ? 0 : parsed.cash, useToast, sales: parsed.sales, adjustments: parsed.adjustments, note }), t('tips.tipsSaved'));
    if (r) onClose();
  };
  const setA = (i, patch) => setAdj(adj.map((a, k) => (k === i ? { ...a, ...patch } : a)));

  return (
    <Modal title={`${pool.name} · ${periodLabel(day.date, day.date, t.lang)}`} sub={`${t('tips.dayWorkers', { count: day.workers })}${pool.period === 'week' ? t('tips.splitWithWeek') : ''}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !!parsed.bad} onClick={save}><Icon name="check" />{t('common.save')}</button></>}>
      {day.toastAvailable && (
        <label className="check tip-toast"><input type="checkbox" checked={useToast} onChange={(ev) => setUseToast(ev.target.checked)} />
          <span>{t('tips.useTipsFromToastAmount', { amount: fmtCents(day.toast.card), amount2: fmtCents(day.toast.cash) })}</span></label>
      )}
      {!useToast && (
        <div className="grid2 tip-money">
          <Field label={t('tips.cardTips')}><MoneyInput value={card} onChange={setCard} /></Field>
          <Field label={t('tips.cashTips')}><MoneyInput value={cash} onChange={setCash} /></Field>
        </div>
      )}
      {salesLines.map((c) => (
        <Field key={c.id} label={salesLabel(c, jobName, t.lang)} help={`${contributionLabel(c, jobName, t.lang)}.`}>
          <MoneyInput value={sales[c.id] || ''} onChange={(v) => setSales({ ...sales, [c.id]: v })} />
        </Field>
      ))}
      <div className="tip-daytotal">
        {pool.contributions.map((c, i) => <div key={c.id} className="row small"><span style={{ flex: 1 }}>{contributionLabel(c, jobName, t.lang)}</span><span className="num">{fmtCents(total.contributions[i].cents)}</span></div>)}
        <div className="row" style={{ fontWeight: 800 }}><span style={{ flex: 1 }}>{t('tips.poolForThisDay')}</span><span className="num">{fmtCents(total.total)}</span></div>
      </div>

      <Field label={t('tips.adjustments')} help={t('tips.eachOneComesOffThe')}>
        <div className="col" style={{ gap: 8 }}>
          {adj.map((a, i) => (
            <div key={i} className="tip-adj">
              <select className="input sm" value={a.userId} onChange={(ev) => setA(i, { userId: ev.target.value })} aria-label={t('tips.person')}>
                <option value="">{t('tips.who')}</option>
                {eligible.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <MoneyInput value={a.amount} onChange={(v) => setA(i, { amount: v })} small allowMinus />
              <input className="input sm" placeholder={t('tips.whyEveryoneSeesThisNote')} value={a.note} maxLength={200} onChange={(ev) => setA(i, { note: ev.target.value })} />
              <button type="button" className="btn sm icon ghost" aria-label={t('tips.removeAdjustment')} onClick={() => setAdj(adj.filter((_, k) => k !== i))}><Icon name="x" /></button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => setAdj([...adj, { userId: '', amount: '', note: '' }])}><Icon name="plus" />{t('tips.addAdjustment')}</button></div>
          {adjTotal > 0 && <div className="small muted">{t('tips.amountOffTheTopAmount2', { amount: fmtCents(adjTotal), amount2: fmtCents(Math.max(0, total.total - adjTotal)) })}{pool.period === 'week' ? t('tips.forThisDay') : ''}</div>}
        </div>
      </Field>
      <Field label={t('tips.noteManagersOnly')}><input className="input" value={note} maxLength={300} onChange={(ev) => setNote(ev.target.value)} placeholder={t('tips.optional')} /></Field>
      {parsed.bad && <div className="alert bad">{parsed.bad}</div>}
    </Modal>
  );
}

function MoneyInput({ value, onChange, small, allowMinus }) {
  return (
    <div className={`tip-money-input ${small ? 'sm' : ''}`}>
      <span>$</span>
      <input className={`input num ${small ? 'sm' : ''}`} inputMode="decimal" placeholder="0.00" value={value}
        onChange={(e) => onChange(e.target.value.replace(allowMinus ? /[^\d.,-]/g : /[^\d.,]/g, ''))} />
    </div>
  );
}

function sourceBadge(p) {
  const out = [];
  if (p.source === 'toast') out.push(<span key="s" className="badge ok">{t('tips.toast')}</span>);
  else if (p.source === 'adp') out.push(<span key="s" className="badge ok">ADP</span>);
  else if (p.source === 'mixed') out.push(<span key="s" className="badge ok">{t('tips.toastSched')}</span>);
  else if (p.source === 'schedule') out.push(<span key="s" className="badge">{t('tips.schedule')}{p.estimated ? t('tips.est') : ''}</span>);
  if (p.noPunch?.length) out.push(<span key="n" className="badge warn">{t('tips.noToastPunch')}</span>);
  return out;
}

function Report({ rep }) {
  const t = useT();
  const { jobs, employees } = useApp();
  const jobName = (id) => jobs[id]?.name || t('common.position');
  const warnings = rep.pools.flatMap((pr) => pr.periods.flatMap((per) => per.warnings.map((w) => ({ ...w, text: tipWarningText(w, t.lang), where: `${pr.pool.name}, ${periodLabel(per.start, per.end, t.lang)}` }))));
  const noPunch = rep.pools.flatMap((pr) => pr.periods.flatMap((per) => per.people.filter((p) => p.noPunch.length).map((p) => `${p.name} (${pr.pool.name}, ${p.noPunch.map((d) => periodLabel(d, d, t.lang)).join(', ')})`)));

  const exportCsv = () => {
    // Legal name and the name they go by, for payroll (core/exports.js).
    const csv = toCsv(tipsCsvRows(rep, { people: Object.fromEntries(employees.map((e) => [e.id, e])), jobName }));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `tips-${rep.weekStart}.csv`;
    a.click();
  };

  return (
    <>
      {warnings.map((w, i) => <div key={i} className={`alert ${w.block ? 'bad' : 'warn'}`}><Icon name="alert" size={16} /><div><b>{w.where}:</b> {w.text}</div></div>)}
      {noPunch.length > 0 && <div className="alert warn"><Icon name="clock" size={16} /><div>{t('tips.toastHasPunchesForThese')}{' '}{noPunch.join('; ')}{t('tips.theirScheduledHoursAreUsed')}</div></div>}

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>{t('tips.everyoneThisWeek')}</h2>
          <button className="btn sm" onClick={exportCsv}><Icon name="download" />{t('tips.csv')}</button>
        </div>
        {rep.people.length ? (
          <div className="tip-table">
            {rep.people.map((p) => (
              <div key={p.userId} className="tip-row tip-row-2">
                <span className="tip-name">{p.name}</span>
                <span className="tip-cells"><span>{t('common.hoursHrs', { hours: fmtHours(p.minutes) })}</span></span>
                <span className="tip-amt">{fmtCents(p.amount)}</span>
              </div>
            ))}
            <div className="tip-row tip-row-2 tip-total"><span className="tip-name">{t('tips.total')}</span><span className="tip-cells" /><span className="tip-amt">{fmtCents(rep.total)}</span></div>
          </div>
        ) : <Empty icon="dollar" title={t('tips.nothingToSplitYet')}>{t('tips.enterTipsForTheDays')}</Empty>}
      </div>

      {rep.pools.map((pr) => (
        <div key={pr.pool.id} className="col" style={{ gap: 8 }}>
          <div className="section-title" style={{ margin: '6px 2px 0' }}><h2 style={{ flex: 1 }}>{pr.pool.name}</h2><span className="tip-amt">{fmtCents(pr.total)}</span></div>
          {pr.periods.filter((per) => per.total || per.people.length).map((per) => (
            <details key={per.start} className="card tip-period" open={pr.periods.length === 1 || undefined}>
              <summary className="card-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{periodLabel(per.start, per.end, t.lang)}</div>
                  <div className="small muted">{per.workers} {per.workers === 1 ? t('tips.person2') : t('tips.people')}{pr.pool.method === 'equal' ? '' : t('tips.pointsPoints', { points: fmtPoints(per.totalPoints) })}{per.adjustments ? t('tips.amountAdjustments', { amount: fmtCents(per.adjustments) }) : ''}</div>
                </div>
                <span className="tip-amt">{fmtCents(per.total)}</span>
              </summary>
              <div className="tip-table">
                <div className="tip-row tip-head"><span>{t('common.name')}</span><span className="tip-cells"><span>{t('common.hours')}</span><span>{t('tips.points')}</span><span>{t('common.share')}</span></span><span className="tip-amt">{t('tips.amount')}</span></div>
                {per.people.map((p) => (
                  <div key={p.userId} className="tip-row">
                    <span className="tip-name">{p.name} {sourceBadge(p)}
                      {p.adjustments.map((a, i) => <span key={i} className="tiny muted tip-adjnote">{a.cents < 0 ? '−' : '+'}{fmtCents(Math.abs(a.cents))} {a.note}</span>)}
                    </span>
                    <span className="tip-cells"><span>{t('common.hoursHrs', { hours: fmtHours(p.minutes) })}</span><span>{pr.pool.method === 'equal' ? '—' : t('tips.pointsPts', { points: fmtPoints(p.points) })}</span><span>{fmtPct(p.sharePct)}</span></span>
                    <span className="tip-amt">{fmtCents(p.amount)}</span>
                  </div>
                ))}
                {per.excluded.length > 0 && <div className="tip-excluded small muted">{t('tips.leftOutRole')}{' '}{per.excluded.map((x) => `${x.name} (${roleLabel(x.role, t.lang)}, ${fmtHours(x.minutes)} hrs)`).join(', ')}</div>}
              </div>
            </details>
          ))}
          {!pr.periods.some((per) => per.total || per.people.length) && <div className="help" style={{ padding: '0 4px' }}>{t('tips.nobodyWorkedInThisPool')}</div>}
        </div>
      ))}
    </>
  );
}
