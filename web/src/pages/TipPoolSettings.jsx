// Settings → Tip pool (admins): the pools, who shares each one, how it's split, and a live example.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, useAction } from '../ui.jsx';
import { scheduleAreas, sameArea } from '../../../core/areas.js';
import { roleLabel } from '../../../core/roles.js';
import {
  TIP_METHODS, TIP_PERIODS, TIP_SOURCES, MANAGER_ROLES, SUGGESTED_POINTS, DEFAULT_CONTRIBUTIONS, normalizePool,
  describePool, exampleSplit, explainShare, fmtCents, toCents, fmtHours, fmtPoints, fmtPct,
} from '../../../core/tips.js';
import '../tips.css';

const ROLE_CHOICES = ['manager', 'admin', 'super_admin', 'supervisor'];

/** The plain-words warning shown wherever pools are set up. */
export function FlsaNote() {
  return (
    <div className="alert warn">
      <Icon name="alert" size={16} />
      <div><b>US law (FLSA):</b> managers and supervisors can’t keep any part of a tip pool, and neither can owners. New pools leave out Managers, Admins and Super Admins. Some states have stricter rules, so check with your accountant.</div>
    </div>
  );
}

export default function TipPoolSettings() {
  const { call, version, jobs } = useApp();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => call('tipPools.list').then(setData).catch(() => setData({ pools: [], overlaps: [] }));
  useEffect(() => { load(); }, [version]);
  const jobName = (id) => jobs[id]?.name || 'Position';

  return (
    <div className="card card-pad col" style={{ gap: 12 }} id="tip-pool">
      <div className="row"><h2 style={{ flex: 1 }}>Tip pool</h2>
        <button className="btn sm primary" onClick={() => setEdit({})}><Icon name="plus" />Add a pool</button></div>
      <div className="small muted" style={{ marginTop: -6 }}>Who shares tips and how they’re split. Managers enter each day’s tips on the Tips page; staff see their own share.</div>
      <FlsaNote />
      {data?.overlaps?.map((o) => <div key={o} className="alert bad"><Icon name="alert" size={16} />{o} Give one of them an area, or take the position out of one.</div>)}
      {data && !data.pools.length && <div className="help">No pool yet. Add one to start splitting tips.</div>}
      {data?.pools.length > 0 && (
        <div className="card list tip-pool-list">
          {data.pools.map((p) => (
            <div key={p.id} className="list-item click" onClick={() => setEdit(p)}>
              <Icon name="dollar" size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{p.name}</div>
                <div className="small muted">{poolSummary(p, data.pools, jobName)}</div>
              </div>
              <span className="btn sm ghost"><Icon name="edit" />Edit</span>
            </div>
          ))}
        </div>
      )}
      {edit && <PoolEditor pool={edit} pools={data?.pools || []} onClose={(changed) => { setEdit(null); if (changed) load(); }} />}
    </div>
  );
}

export function poolSummary(p, pools, jobName) {
  const where = p.areas.length ? p.areas.join(', ') : pools.some((x) => x.id !== p.id && x.areas.length) ? 'All other areas' : 'All areas';
  return [TIP_PERIODS.find((x) => x.id === p.period)?.label, TIP_METHODS.find((m) => m.id === p.method)?.label, where,
    p.jobs.map((j) => jobName(j.jobCodeId)).join(', ')].join(' · ');
}

function newPool(jobCodes, pools) {
  const jobs = [];
  for (const [re, points] of SUGGESTED_POINTS) {
    const j = jobCodes.find((x) => !x.archived && re.test(x.name.trim()) && !jobs.some((y) => y.jobCodeId === x.id));
    if (j) jobs.push({ jobCodeId: j.id, points });
  }
  return normalizePool({ name: pools.length ? 'New pool' : 'House pool', jobs, contributions: DEFAULT_CONTRIBUTIONS(), excludeRoles: [...MANAGER_ROLES] });
}

const newId = () => `tc_${Math.random().toString(36).slice(2, 8)}`;

function PoolEditor({ pool, pools, onClose }) {
  const { call, jobCodes, jobs, settings } = useApp();
  const [p, setP] = useState(() => (pool.id ? normalizePool(JSON.parse(JSON.stringify(pool))) : newPool(jobCodes, pools)));
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  const [tryAmt, setTryAmt] = useState('812.40');
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const jobName = (id) => jobs[id]?.name || 'Position';
  const areas = scheduleAreas(settings);
  const others = pools.filter((x) => x.id !== p.id);
  const available = jobCodes.filter((j) => !j.archived && !p.jobs.some((x) => x.jobCodeId === j.id));
  const mgrJobs = p.jobs.filter((j) => jobs[j.jobCodeId]?.defaultRole === 'manager');
  const keepsManagers = MANAGER_ROLES.filter((r) => !p.excludeRoles.includes(r));

  const setJob = (i, patch) => set('jobs', p.jobs.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  const setContribution = (i, patch) => set('contributions', p.contributions.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const toggleArea = (a) => set('areas', p.areas.some((x) => sameArea(x, a)) ? p.areas.filter((x) => !sameArea(x, a)) : [...p.areas, a]);
  const toggleRole = (r) => set('excludeRoles', p.excludeRoles.includes(r) ? p.excludeRoles.filter((x) => x !== r) : [...p.excludeRoles, r]);

  // The live example runs the same code as the real split.
  const preview = useMemo(() => {
    const clean = normalizePool({ ...p, jobs: p.jobs.map((j) => ({ ...j, points: Number(j.points) || 0 })).filter((j) => j.points > 0) });
    const cents = Math.max(0, toCents(tryAmt) || 0);
    const ex = clean.jobs.length ? exampleSplit(clean, cents, { jobName }) : null;
    const first = ex?.people.find((x) => x.units > 0);
    return { clean, ex, line: first ? explainShare(clean, ex, first, { jobName, you: false })[0] : '', words: describePool(clean, { jobName, otherPools: [...others, clean] }) };
  }, [p, tryAmt, jobs]);

  const save = async () => {
    const body = { ...p, jobs: p.jobs.map((j) => ({ ...j, points: Number(j.points) })), contributions: p.contributions.map((c) => ({ ...c, percent: Number(c.percent) })) };
    const r = await run(() => call('tipPools.save', body), 'Tip pool saved');
    if (r) onClose(true);
  };
  const remove = async () => {
    const r = await run(() => call('tipPools.delete', { id: p.id }), 'Tip pool removed');
    if (r) onClose(true);
  };

  return (
    <Modal wide title={pool.id ? `Edit ${pool.name}` : 'New tip pool'} sub="Changes apply to weeks that aren’t final yet." onClose={() => onClose(false)}
      footer={<>
        {pool.id && (sure
          ? <button className="btn danger solid" disabled={busy} onClick={remove}>Yes, remove it</button>
          : <button className="btn danger ghost" onClick={() => setSure(true)}><Icon name="trash" />Remove</button>)}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />Save pool</button>
      </>}>
      <Field label="Name"><input className="input" value={p.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="House pool" /></Field>

      <Field label="Where" help="Pick areas for a separate pool, like a Rabbit Hole bar pool. A pool with no areas counts every area that doesn’t have its own pool.">
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className={`chip ${p.areas.length ? '' : 'on'}`} onClick={() => set('areas', [])}>{others.some((x) => x.areas.length) ? 'All other areas' : 'All areas'}</button>
          {areas.map((a) => <button key={a} type="button" className={`chip ${p.areas.some((x) => sameArea(x, a)) ? 'on' : ''}`} onClick={() => toggleArea(a)}>{a}</button>)}
        </div>
      </Field>

      <Field label="Who shares it, and their points" help={p.method === 'equal' ? 'With an equal split, points don’t matter: everyone who worked gets the same.' : 'A position with 1.0 point gets twice the share per hour of one with 0.5.'}>
        <div className="col" style={{ gap: 6 }}>
          {p.jobs.map((j, i) => (
            <div key={j.jobCodeId} className="row tip-job-row">
              <span className="swatch" style={{ background: jobs[j.jobCodeId]?.color || '#999' }} />
              <span style={{ flex: 1, fontWeight: 600, minWidth: 0 }}>{jobName(j.jobCodeId)}</span>
              {p.method !== 'equal' && <>
                <input className="input sm num" type="number" inputMode="decimal" step="0.1" min="0.01" max="10" style={{ width: 84 }} value={j.points}
                  aria-label={`${jobName(j.jobCodeId)} points`} onChange={(e) => setJob(i, { points: e.target.value })} />
                <span className="small faint">pts</span>
              </>}
              <button type="button" className="btn sm icon ghost" aria-label={`Remove ${jobName(j.jobCodeId)}`} onClick={() => set('jobs', p.jobs.filter((_, k) => k !== i))}><Icon name="x" /></button>
            </div>
          ))}
          {available.length > 0 && (
            <select className="input sm" style={{ maxWidth: 260 }} value="" onChange={(e) => e.target.value && set('jobs', [...p.jobs, { jobCodeId: e.target.value, points: 1 }])}>
              <option value="">Add a position…</option>
              {available.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          )}
        </div>
      </Field>
      {mgrJobs.length > 0 && <div className="alert bad"><Icon name="alert" size={16} />{mgrJobs.map((j) => jobName(j.jobCodeId)).join(', ')} {mgrJobs.length > 1 ? 'are manager positions' : 'is a manager position'}. Managers can’t take from a tip pool under US law (FLSA).</div>}

      <Field label="How it’s split">
        <div className="col tip-methods" style={{ gap: 6 }}>
          {TIP_METHODS.map((m) => (
            <label key={m.id} className={`tip-choice ${p.method === m.id ? 'on' : ''}`}>
              <input type="radio" name="tip-method" checked={p.method === m.id} onChange={() => set('method', m.id)} />
              <span><b>{m.label}</b>{m.id === 'hours_points' && <span className="badge brand" style={{ marginLeft: 6 }}>Default</span>}<br /><span className="small muted">{m.help}</span></span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="How often" help={TIP_PERIODS.find((x) => x.id === p.period)?.help}>
        <div className="seg">{TIP_PERIODS.map((x) => <button key={x.id} type="button" className={p.period === x.id ? 'on' : ''} onClick={() => set('period', x.id)}>{x.label}</button>)}</div>
      </Field>

      <Field label="What goes in" help="Managers type in the day’s tips (or use Toast’s). A tip-out asks for that day’s sales.">
        <div className="col" style={{ gap: 6 }}>
          {p.contributions.map((c, i) => (
            <div key={c.id || i} className="row wrap tip-contrib">
              {c.type === 'sales' ? <>
                <select className="input sm" style={{ width: 150 }} value={c.jobCodeId || ''} onChange={(e) => setContribution(i, { jobCodeId: e.target.value || null })} aria-label="Who tips out">
                  <option value="">Tip-out</option>
                  {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}s</option>)}
                </select>
                <span className="small">tip out</span>
                <input className="input sm num" type="number" inputMode="decimal" min="0" max="100" step="0.5" style={{ width: 74 }} value={c.percent} onChange={(e) => setContribution(i, { percent: e.target.value })} aria-label="Percent" />
                <span className="small">% of {c.jobCodeId ? 'their ' : ''}sales</span>
              </> : <>
                <input className="input sm num" type="number" inputMode="decimal" min="0" max="100" step="5" style={{ width: 74 }} value={c.percent} onChange={(e) => setContribution(i, { percent: e.target.value })} aria-label="Percent" />
                <span className="small">% of</span>
                <select className="input sm" style={{ width: 170 }} value={c.source} onChange={(e) => setContribution(i, { source: e.target.value })} aria-label="Which tips">
                  {Object.entries(TIP_SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </>}
              {p.contributions.length > 1 && <button type="button" className="btn sm icon ghost" aria-label="Remove" onClick={() => set('contributions', p.contributions.filter((_, k) => k !== i))}><Icon name="x" /></button>}
            </div>
          ))}
          <div className="row wrap">
            <button type="button" className="btn sm" onClick={() => set('contributions', [...p.contributions, { id: newId(), type: 'tips', source: 'card', percent: 100 }])}><Icon name="plus" />Share of tips</button>
            <button type="button" className="btn sm" onClick={() => set('contributions', [...p.contributions, { id: newId(), type: 'sales', jobCodeId: jobCodes.find((j) => /^servers?$/i.test(j.name))?.id || null, percent: 3 }])}><Icon name="plus" />Tip-out from sales</button>
          </div>
        </div>
      </Field>

      <Field label="Leave out these roles" help="Checked roles never get money from this pool, even if they work a pool position.">
        <div className="row wrap" style={{ gap: 14 }}>
          {ROLE_CHOICES.map((r) => <label key={r} className="check small"><input type="checkbox" checked={p.excludeRoles.includes(r)} onChange={() => toggleRole(r)} />{roleLabel(r)}s</label>)}
        </div>
      </Field>
      {keepsManagers.length > 0
        ? <div className="alert bad"><Icon name="alert" size={16} />{keepsManagers.map((r) => `${roleLabel(r)}s`).join(', ')} would share this pool. Under US law (FLSA) managers can’t take from a tip pool.</div>
        : !p.excludeRoles.includes('supervisor') && <div className="help">Supervisors (shift leads) are in. If yours direct staff and can hire or fire, the law treats them as managers: leave them out.</div>}

      <div className="col" style={{ gap: 8 }}>
        <label className="check"><input type="checkbox" checked={p.events} onChange={(e) => set('events', e.target.checked)} />Count event (BEO) shifts</label>
        <label className="check"><input type="checkbox" checked={p.showEstimates} onChange={(e) => set('showEstimates', e.target.checked)} />Staff can see their estimate before the week is final</label>
      </div>

      <div className="tip-example">
        <h3>In plain words</h3>
        <ul className="tip-words">{preview.words.map((w) => <li key={w}>{w}</li>)}</ul>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <h3 style={{ flex: 1 }}>Try it</h3>
          <label className="row small" style={{ gap: 6 }}>Tips in the pool
            <input className="input sm num" inputMode="decimal" style={{ width: 110 }} value={tryAmt} onChange={(e) => setTryAmt(e.target.value)} aria-label="Example pool amount" /></label>
        </div>
        {preview.ex ? <>
          <div className="small muted" style={{ margin: '4px 0 8px' }}>A made-up {p.period === 'week' ? 'week' : 'day'} with these hours:</div>
          <div className="tip-table">
            <div className="tip-row tip-head"><span>Person</span><span className="tip-cells"><span>Hours</span><span>Points</span><span>Share</span></span><span className="tip-amt">Gets</span></div>
            {preview.ex.people.map((x) => (
              <div key={x.userId} className="tip-row">
                <span className="tip-name">{x.name}</span>
                <span className="tip-cells"><span>{fmtHours(x.minutes)} hrs</span><span>{p.method === 'equal' ? '—' : `${fmtPoints(x.points)} pts`}</span><span>{fmtPct(x.sharePct)}</span></span>
                <span className="tip-amt">{fmtCents(x.amount)}</span>
              </div>
            ))}
            <div className="tip-row tip-total"><span className="tip-name">Total</span><span className="tip-cells" /><span className="tip-amt">{fmtCents(preview.ex.people.reduce((t, x) => t + x.amount, 0))}</span></div>
          </div>
          {preview.line && <div className="tip-formula">{preview.line}</div>}
        </> : <div className="help">Add a position to see an example.</div>}
      </div>
    </Modal>
  );
}

