// Tips: staff see their own share and how it was worked out; managers enter each day's tips,
// see the split, export it and finalize the week. The math is core/tips.js.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, Empty, useAction } from '../ui.jsx';
import { weekStart } from '../../../core/time.js';
import { roleLabel } from '../../../core/roles.js';
import { fmtCents, toCents, fmtHours, fmtPoints, fmtPct, dayTotal, contributionLabel, salesLabel, periodLabel } from '../../../core/tips.js';
import { useWeek, WeekNav } from './Schedule.jsx';
import TipPoolSettings, { poolSummary } from './TipPoolSettings.jsx';
import '../tips.css';

const TAB_KEY = 'sb_tips_tab';
const savedTab = () => { try { return sessionStorage.getItem(TAB_KEY); } catch { return null; } };

export default function Tips({ parts = [] }) {
  const { isMgr, settings } = useApp();
  const [ws, setWs] = useWeek();
  const [tab, setTabState] = useState(() => (isMgr ? (['enter', 'report', 'mine'].includes(savedTab()) ? savedTab() : 'enter') : 'mine'));
  const setTab = (t) => { setTabState(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* ignore */ } };
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
            {[['enter', 'Enter tips'], ['report', 'Report'], ['mine', 'Mine']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        )}
      </div>
      {isMgr && tab !== 'mine' ? <Manager ws={ws} tab={tab} /> : <MyTips ws={ws} />}
    </div>
  );
}

// ---------- staff ----------
function sourceText(me) {
  if (me.source === 'toast') return 'Hours from Toast';
  if (me.source === 'mixed') return 'Hours from Toast and the schedule';
  if (me.source === 'schedule') return me.estimated ? 'Hours from the schedule (“until close” estimated)' : 'Hours from the schedule';
  return '';
}

function MyTips({ ws }) {
  const { call, version } = useApp();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); call('myTips.week', { weekStart: ws }).then(setD).catch((e) => setErr(e.message)); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;
  if (!d.pools.length) return <div className="card"><Empty icon="dollar" title="No tip pool yet">Once your restaurant sets up tip pooling, your share shows up here.</Empty></div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card card-pad tip-hero">
        <div className="small" style={{ opacity: .85, fontWeight: 600 }}>Your tips · {d.label}</div>
        <div className="tip-hero-amt">{fmtCents(d.total)}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {d.final ? <span className="tip-pill"><Icon name="check" size={14} />Final</span> : <span className="tip-pill">Estimate: can change until the week is final</span>}
        </div>
      </div>
      {d.waiting.map((name) => <div key={name} className="alert info"><Icon name="clock" size={16} />{name}: your share shows here once a manager finalizes the week.</div>)}
      {!d.items.length && !d.waiting.length && <div className="card"><Empty icon="dollar" title="No tips this week">Tips show up here after a manager enters them for days you worked.</Empty></div>}
      {d.items.length > 0 && (
        <div className="card list">
          {d.items.map((it) => (
            <div key={`${it.poolId}-${it.start}`} className="tip-mine">
              <div className="row" style={{ alignItems: 'baseline' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{it.label}</div>
                  <div className="small muted">{it.poolName}{it.period === 'week' ? ' · whole week' : ''} · pool {fmtCents(it.poolTotal)}</div>
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
        <summary><b>How the pool works</b></summary>
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
  const { call, version, isAdmin } = useApp();
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  const load = () => call('tips.week', { weekStart: ws }).then((r) => { setRep(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setRep(null); load(); }, [ws, version]);
  if (err) return <div className="alert bad">{err}</div>;
  if (!rep) return <div className="empty">Loading…</div>;
  if (!rep.pools.length) {
    return isAdmin
      ? <div className="col" style={{ gap: 12 }}><div className="alert info"><Icon name="sparkle" size={16} />Set up your tip pool first. You can change it any time in Settings → Tip pool.</div><TipPoolSettings /></div>
      : <div className="card"><Empty icon="dollar" title="No tip pool yet">An admin sets it up in Settings → Tip pool.</Empty></div>;
  }
  return (
    <div className="col" style={{ gap: 14 }}>
      <LockBar rep={rep} />
      {tab === 'enter' ? rep.pools.map((pr) => <EnterPool key={pr.pool.id} pr={pr} pools={rep.pools.map((x) => x.pool)} locked={!!rep.locked} />) : <Report rep={rep} />}
    </div>
  );
}

function LockBar({ rep }) {
  const { call, isAdmin } = useApp();
  const [run, busy] = useAction();
  const [confirm, setConfirm] = useState(false);
  const fmtAt = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (rep.locked) {
    return (
      <div className="alert ok tip-lock">
        <Icon name="check" size={16} />
        <div style={{ flex: 1 }}><b>Final.</b> Locked by {rep.locked.byName || 'a manager'} on {fmtAt(rep.locked.at)}. These numbers won’t change.</div>
        {isAdmin ? <button className="btn sm" disabled={busy} onClick={() => run(() => call('tips.unlock', { weekStart: rep.weekStart }), 'Week reopened')}>Unlock</button>
          : <span className="small">Only an admin can unlock it.</span>}
      </div>
    );
  }
  return (
    <div className="card card-pad row wrap tip-lockbar">
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 700 }}>Week total {fmtCents(rep.total)}</div>
        <div className="small muted">Not final yet. Finalize when the week’s tips are in: the numbers lock and each person is told their share.</div>
      </div>
      <button className="btn primary" onClick={() => setConfirm(true)}><Icon name="check" />Finalize week</button>
      {confirm && (
        <Modal title={`Finalize ${rep.label}?`} onClose={() => setConfirm(false)}
          footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => call('tips.finalize', { weekStart: rep.weekStart }), 'Week finalized. Everyone was told their share.'); if (r) setConfirm(false); }}>Finalize</button></>}>
          <div>{fmtCents(rep.total)} goes to {rep.people.length} {rep.people.length === 1 ? 'person' : 'people'}. The numbers lock and each person gets a notification with their own share.</div>
          <div className="help">After this, only an admin can unlock the week.</div>
        </Modal>
      )}
    </div>
  );
}

function EnterPool({ pr, pools, locked }) {
  const { jobs } = useApp();
  const [day, setDay] = useState(null);
  const jobName = (id) => jobs[id]?.name || 'Position';
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
          if (d.useToast) bits.push('Toast tips');
          else if (has) { if (d.card) bits.push(`Card ${fmtCents(d.card)}`); if (d.cash) bits.push(`Cash ${fmtCents(d.cash)}`); }
          if (d.entry?.adjustments?.length) bits.push(`${d.entry.adjustments.length} adjustment${d.entry.adjustments.length > 1 ? 's' : ''}`);
          if (d.workers) bits.push(`${d.workers} worked${d.toastHours ? ' · Toast hours' : ''}`);
          return (
            <button key={d.date} className="list-item click tip-day" disabled={locked} onClick={() => setDay(d)}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontWeight: 700 }}>{periodLabel(d.date, d.date)}</div>
                {bits.length > 0 && <div className="small muted">{bits.join(' · ')}</div>}
              </div>
              {has || d.total ? <span className="tip-amt">{fmtCents(d.total)}</span> : <span className={`small ${d.workers ? 'tip-todo' : 'faint'}`}>{locked ? '—' : d.workers ? 'Add tips' : 'Nobody worked'}</span>}
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
  const { call, jobs, employees } = useApp();
  const [run, busy] = useAction();
  const e = day.entry || {};
  const [card, setCard] = useState(centsText(e.card));
  const [cash, setCash] = useState(centsText(e.cash));
  const [useToast, setUseToast] = useState(!!e.useToast);
  const [sales, setSales] = useState(() => Object.fromEntries(Object.entries(e.sales || {}).map(([k, v]) => [k, centsText(v)])));
  const [adj, setAdj] = useState(() => (e.adjustments || []).map((a) => ({ ...a, amount: (a.cents / 100).toFixed(2) })));
  const [note, setNote] = useState(e.note || '');
  const jobName = (id) => jobs[id]?.name || 'Position';
  const salesLines = pool.contributions.filter((c) => c.type === 'sales');
  const eligible = employees.filter((u) => u.active !== false && !pool.excludeRoles.includes(u.role));

  const parsed = useMemo(() => {
    const out = { card: toCents(card), cash: toCents(cash), sales: {}, bad: '' };
    if (!useToast && (out.card == null || out.card < 0)) out.bad = 'Card tips: enter an amount like 812.40';
    if (!useToast && (out.cash == null || out.cash < 0)) out.bad = 'Cash tips: enter an amount like 120.00';
    for (const c of salesLines) {
      const v = toCents(sales[c.id]);
      if (v == null || v < 0) out.bad = `${salesLabel(c, jobName)}: enter an amount`;
      out.sales[c.id] = v || 0;
    }
    out.adjustments = adj.map((a) => ({ userId: a.userId, cents: toCents(a.amount), note: a.note }));
    return out;
  }, [card, cash, useToast, sales, adj]);
  const total = dayTotal(pool, { card: parsed.card || 0, cash: parsed.cash || 0, useToast, sales: parsed.sales }, day.toast);
  const adjTotal = parsed.adjustments.reduce((t, a) => t + (a.cents || 0), 0);

  const save = async () => {
    const r = await run(() => call('tipEntries.save', { poolId: pool.id, date: day.date, card: useToast ? 0 : parsed.card, cash: useToast ? 0 : parsed.cash, useToast, sales: parsed.sales, adjustments: parsed.adjustments, note }), 'Tips saved');
    if (r) onClose();
  };
  const setA = (i, patch) => setAdj(adj.map((a, k) => (k === i ? { ...a, ...patch } : a)));

  return (
    <Modal title={`${pool.name} · ${periodLabel(day.date, day.date)}`} sub={`${day.workers} ${day.workers === 1 ? 'person' : 'people'} worked in this pool${pool.period === 'week' ? ' · split with the whole week' : ''}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !!parsed.bad} onClick={save}><Icon name="check" />Save</button></>}>
      {day.toastAvailable && (
        <label className="check tip-toast"><input type="checkbox" checked={useToast} onChange={(ev) => setUseToast(ev.target.checked)} />
          <span>Use tips from Toast: {fmtCents(day.toast.card)} card, {fmtCents(day.toast.cash)} cash</span></label>
      )}
      {!useToast && (
        <div className="grid2 tip-money">
          <Field label="Card tips"><MoneyInput value={card} onChange={setCard} /></Field>
          <Field label="Cash tips"><MoneyInput value={cash} onChange={setCash} /></Field>
        </div>
      )}
      {salesLines.map((c) => (
        <Field key={c.id} label={salesLabel(c, jobName)} help={`${contributionLabel(c, jobName)}.`}>
          <MoneyInput value={sales[c.id] || ''} onChange={(v) => setSales({ ...sales, [c.id]: v })} />
        </Field>
      ))}
      <div className="tip-daytotal">
        {pool.contributions.map((c, i) => <div key={c.id} className="row small"><span style={{ flex: 1 }}>{contributionLabel(c, jobName)}</span><span className="num">{fmtCents(total.contributions[i].cents)}</span></div>)}
        <div className="row" style={{ fontWeight: 800 }}><span style={{ flex: 1 }}>Pool for this day</span><span className="num">{fmtCents(total.total)}</span></div>
      </div>

      <Field label="Adjustments" help="Each one comes off the top before the split, so the shares still add up to the pool. Use a minus sign to take money off.">
        <div className="col" style={{ gap: 8 }}>
          {adj.map((a, i) => (
            <div key={i} className="tip-adj">
              <select className="input sm" value={a.userId} onChange={(ev) => setA(i, { userId: ev.target.value })} aria-label="Person">
                <option value="">Who?</option>
                {eligible.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <MoneyInput value={a.amount} onChange={(v) => setA(i, { amount: v })} small allowMinus />
              <input className="input sm" placeholder="Why (everyone sees this note)" value={a.note} maxLength={200} onChange={(ev) => setA(i, { note: ev.target.value })} />
              <button type="button" className="btn sm icon ghost" aria-label="Remove adjustment" onClick={() => setAdj(adj.filter((_, k) => k !== i))}><Icon name="x" /></button>
            </div>
          ))}
          <div><button type="button" className="btn sm" onClick={() => setAdj([...adj, { userId: '', amount: '', note: '' }])}><Icon name="plus" />Add adjustment</button></div>
          {adjTotal > 0 && <div className="small muted">{fmtCents(adjTotal)} off the top · {fmtCents(Math.max(0, total.total - adjTotal))} left to split{pool.period === 'week' ? ' (for this day)' : ''}</div>}
        </div>
      </Field>
      <Field label="Note (managers only)"><input className="input" value={note} maxLength={300} onChange={(ev) => setNote(ev.target.value)} placeholder="Optional" /></Field>
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
  if (p.source === 'toast') out.push(<span key="s" className="badge ok">Toast</span>);
  else if (p.source === 'mixed') out.push(<span key="s" className="badge ok">Toast + sched.</span>);
  else if (p.source === 'schedule') out.push(<span key="s" className="badge">Schedule{p.estimated ? ' (est.)' : ''}</span>);
  if (p.noPunch?.length) out.push(<span key="n" className="badge warn">No Toast punch</span>);
  return out;
}

function Report({ rep }) {
  const { jobs } = useApp();
  const jobName = (id) => jobs[id]?.name || 'Position';
  const warnings = rep.pools.flatMap((pr) => pr.periods.flatMap((per) => per.warnings.map((w) => ({ ...w, where: `${pr.pool.name}, ${per.label}` }))));
  const noPunch = rep.pools.flatMap((pr) => pr.periods.flatMap((per) => per.people.filter((p) => p.noPunch.length).map((p) => `${p.name} (${pr.pool.name}, ${p.noPunch.map((d) => periodLabel(d, d)).join(', ')})`)));

  const exportCsv = () => {
    const rows = [['Pool', 'Period', 'Name', 'Positions', 'Hours', 'Hours from', 'Shifts', 'Points', 'Share %', 'Split', 'Adjustment', 'Adjustment notes', 'Amount']];
    for (const pr of rep.pools) {
      for (const per of pr.periods) {
        for (const p of per.people) {
          rows.push([pr.pool.name, per.label, p.name, p.jobs.map((j) => jobName(j.jobCodeId)).join(' + '), fmtHours(p.minutes), p.source + (p.estimated ? ' (estimated)' : ''), p.shifts,
            pr.pool.method === 'equal' ? '' : fmtPoints(p.points), p.sharePct.toFixed(2), (p.split / 100).toFixed(2), (p.adjustment / 100).toFixed(2),
            p.adjustments.map((a) => a.note).join('; '), (p.amount / 100).toFixed(2)]);
        }
      }
    }
    rows.push([]);
    rows.push(['Week total', rep.label, '', '', '', '', '', '', '', '', '', '', (rep.total / 100).toFixed(2)]);
    for (const p of rep.people) rows.push(['Week', rep.label, p.name, '', fmtHours(p.minutes), '', '', '', '', '', '', '', (p.amount / 100).toFixed(2)]);
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `tips-${rep.weekStart}.csv`;
    a.click();
  };

  return (
    <>
      {warnings.map((w, i) => <div key={i} className={`alert ${w.block ? 'bad' : 'warn'}`}><Icon name="alert" size={16} /><div><b>{w.where}:</b> {w.text}</div></div>)}
      {noPunch.length > 0 && <div className="alert warn"><Icon name="clock" size={16} /><div>Toast has punches for these days but not for: {noPunch.join('; ')}. Their scheduled hours are used. Check they worked.</div></div>}

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Everyone this week</h2>
          <button className="btn sm" onClick={exportCsv}><Icon name="download" />CSV</button>
        </div>
        {rep.people.length ? (
          <div className="tip-table">
            {rep.people.map((p) => (
              <div key={p.userId} className="tip-row tip-row-2">
                <span className="tip-name">{p.name}</span>
                <span className="tip-cells"><span>{fmtHours(p.minutes)} hrs</span></span>
                <span className="tip-amt">{fmtCents(p.amount)}</span>
              </div>
            ))}
            <div className="tip-row tip-row-2 tip-total"><span className="tip-name">Total</span><span className="tip-cells" /><span className="tip-amt">{fmtCents(rep.total)}</span></div>
          </div>
        ) : <Empty icon="dollar" title="Nothing to split yet">Enter tips for the days of this week.</Empty>}
      </div>

      {rep.pools.map((pr) => (
        <div key={pr.pool.id} className="col" style={{ gap: 8 }}>
          <div className="section-title" style={{ margin: '6px 2px 0' }}><h2 style={{ flex: 1 }}>{pr.pool.name}</h2><span className="tip-amt">{fmtCents(pr.total)}</span></div>
          {pr.periods.filter((per) => per.total || per.people.length).map((per) => (
            <details key={per.start} className="card tip-period" open={pr.periods.length === 1 || undefined}>
              <summary className="card-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{per.label}</div>
                  <div className="small muted">{per.workers} {per.workers === 1 ? 'person' : 'people'}{pr.pool.method === 'equal' ? '' : ` · ${fmtPoints(per.totalPoints)} points`}{per.adjustments ? ` · ${fmtCents(per.adjustments)} adjustments` : ''}</div>
                </div>
                <span className="tip-amt">{fmtCents(per.total)}</span>
              </summary>
              <div className="tip-table">
                <div className="tip-row tip-head"><span>Name</span><span className="tip-cells"><span>Hours</span><span>Points</span><span>Share</span></span><span className="tip-amt">Amount</span></div>
                {per.people.map((p) => (
                  <div key={p.userId} className="tip-row">
                    <span className="tip-name">{p.name} {sourceBadge(p)}
                      {p.adjustments.map((a, i) => <span key={i} className="tiny muted tip-adjnote">{a.cents < 0 ? '−' : '+'}{fmtCents(Math.abs(a.cents))} {a.note}</span>)}
                    </span>
                    <span className="tip-cells"><span>{fmtHours(p.minutes)} hrs</span><span>{pr.pool.method === 'equal' ? '—' : `${fmtPoints(p.points)} pts`}</span><span>{fmtPct(p.sharePct)}</span></span>
                    <span className="tip-amt">{fmtCents(p.amount)}</span>
                  </div>
                ))}
                {per.excluded.length > 0 && <div className="tip-excluded small muted">Left out (role): {per.excluded.map((x) => `${x.name} (${roleLabel(x.role)}, ${fmtHours(x.minutes)} hrs)`).join(', ')}</div>}
              </div>
            </details>
          ))}
          {!pr.periods.some((per) => per.total || per.people.length) && <div className="help" style={{ padding: '0 4px' }}>Nobody worked in this pool this week.</div>}
        </div>
      ))}
    </>
  );
}
