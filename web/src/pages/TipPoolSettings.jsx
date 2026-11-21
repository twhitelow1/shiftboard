// Settings → Tip pool (admins): the pools, who shares each one, how it's split, and a live example.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, useAction } from '../ui.jsx';
import { scheduleAreas, sameArea } from '../../../core/areas.js';
import { roleLabel, roleLabelPlural } from '../../../core/roles.js';
import {
  TIP_METHODS, TIP_PERIODS, TIP_SOURCES, tipOption, MANAGER_ROLES, SUGGESTED_POINTS, DEFAULT_CONTRIBUTIONS, normalizePool,
  describePool, exampleSplit, explainShare, fmtCents, toCents, fmtHours, fmtPoints, fmtPct,
} from '../../../core/tips.js';
import '../tips.css';
import { useT , t as tr, getLang } from '../i18n/index.js';

const ROLE_CHOICES = ['manager', 'admin', 'super_admin', 'supervisor'];

/** The plain-words warning shown wherever pools are set up. */
export function FlsaNote() {
  const t = useT();
  return (
    <div className="alert warn">
      <Icon name="alert" size={16} />
      <div>{t('tipPoolSettings.bUsLawFlsaB')}</div>
    </div>
  );
}

export default function TipPoolSettings() {
  const t = useT();
  const { call, version, jobs } = useApp();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = () => call('tipPools.list').then(setData).catch(() => setData({ pools: [], overlaps: [] }));
  useEffect(() => { load(); }, [version]);
  const jobName = (id) => jobs[id]?.name || t('common.position');

  return (
    <div className="card card-pad col" style={{ gap: 12 }} id="tip-pool">
      <div className="row"><h2 style={{ flex: 1 }}>{t('tipPoolSettings.tipPool')}</h2>
        <button className="btn sm primary" onClick={() => setEdit({})}><Icon name="plus" />{t('tipPoolSettings.addAPool')}</button></div>
      <div className="small muted" style={{ marginTop: -6 }}>{t('tipPoolSettings.whoSharesTipsAndHow')}</div>
      <FlsaNote />
      {data?.overlaps?.map((o) => <div key={o} className="alert bad"><Icon name="alert" size={16} />{t('tipPoolSettings.oGiveOneOfThem', { o })}</div>)}
      {data && !data.pools.length && <div className="help">{t('tipPoolSettings.noPoolYetAddOne')}</div>}
      {data?.pools.length > 0 && (
        <div className="card list tip-pool-list">
          {data.pools.map((p) => (
            <div key={p.id} className="list-item click" onClick={() => setEdit(p)}>
              <Icon name="dollar" size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{p.name}</div>
                <div className="small muted">{poolSummary(p, data.pools, jobName)}</div>
              </div>
              <span className="btn sm ghost"><Icon name="edit" />{t('common.edit')}</span>
            </div>
          ))}
        </div>
      )}
      {edit && <PoolEditor pool={edit} pools={data?.pools || []} onClose={(changed) => { setEdit(null); if (changed) load(); }} />}
    </div>
  );
}

export function poolSummary(p, pools, jobName) {
  const where = p.areas.length ? p.areas.join(', ') : pools.some((x) => x.id !== p.id && x.areas.length) ? tr('tipPoolSettings.allOtherAreas') : tr('tipPoolSettings.allAreas');
  return [tipOption(TIP_PERIODS.find((x) => x.id === p.period), getLang())?.label, tipOption(TIP_METHODS.find((m) => m.id === p.method), getLang())?.label, where,
    p.jobs.map((j) => jobName(j.jobCodeId)).join(', ')].join(' · ');
}

function newPool(jobCodes, pools) {
  const jobs = [];
  for (const [re, points] of SUGGESTED_POINTS) {
    const j = jobCodes.find((x) => !x.archived && re.test(x.name.trim()) && !jobs.some((y) => y.jobCodeId === x.id));
    if (j) jobs.push({ jobCodeId: j.id, points });
  }
  return normalizePool({ name: pools.length ? tr('tipPoolSettings.newPoolName') : tr('tipPoolSettings.housePoolName'), jobs, contributions: DEFAULT_CONTRIBUTIONS(), excludeRoles: [...MANAGER_ROLES] });
}

const newId = () => `tc_${Math.random().toString(36).slice(2, 8)}`;

function PoolEditor({ pool, pools, onClose }) {
  const t = useT();
  const { call, jobCodes, jobs, settings } = useApp();
  const [p, setP] = useState(() => (pool.id ? normalizePool(JSON.parse(JSON.stringify(pool))) : newPool(jobCodes, pools)));
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  const [tryAmt, setTryAmt] = useState('812.40');
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const jobName = (id) => jobs[id]?.name || t('common.position');
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
    const lang = t.lang;
    return { clean, ex, line: first ? explainShare(clean, ex, first, { jobName, you: false, lang })[0] : '', words: describePool(clean, { jobName, otherPools: [...others, clean], lang }) };
  }, [p, tryAmt, jobs, t]);

  const save = async () => {
    const body = { ...p, jobs: p.jobs.map((j) => ({ ...j, points: Number(j.points) })), contributions: p.contributions.map((c) => ({ ...c, percent: Number(c.percent) })) };
    const r = await run(() => call('tipPools.save', body), t('tipPoolSettings.tipPoolSaved'));
    if (r) onClose(true);
  };
  const remove = async () => {
    const r = await run(() => call('tipPools.delete', { id: p.id }), t('tipPoolSettings.tipPoolRemoved'));
    if (r) onClose(true);
  };

  return (
    <Modal wide title={pool.id ? t('common.editName', { name: pool.name }) : t('tipPoolSettings.newTipPool')} sub={t('tipPoolSettings.changesApplyToWeeksThat')} onClose={() => onClose(false)}
      footer={<>
        {pool.id && (sure
          ? <button className="btn danger solid" disabled={busy} onClick={remove}>{t('tipPoolSettings.yesRemoveIt')}</button>
          : <button className="btn danger ghost" onClick={() => setSure(true)}><Icon name="trash" />{t('common.remove')}</button>)}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t('tipPoolSettings.savePool')}</button>
      </>}>
      <Field label={t('common.name')}><input className="input" value={p.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder={t('tipPoolSettings.housePool')} /></Field>

      <Field label={t('tipPoolSettings.where')} help={t('tipPoolSettings.pickAreasForASeparate')}>
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className={`chip ${p.areas.length ? '' : 'on'}`} onClick={() => set('areas', [])}>{others.some((x) => x.areas.length) ? t('tipPoolSettings.allOtherAreas') : t('tipPoolSettings.allAreas')}</button>
          {areas.map((a) => <button key={a} type="button" className={`chip ${p.areas.some((x) => sameArea(x, a)) ? 'on' : ''}`} onClick={() => toggleArea(a)}>{a}</button>)}
        </div>
      </Field>

      <Field label={t('tipPoolSettings.whoSharesItAndTheir')} help={p.method === 'equal' ? t('tipPoolSettings.withAnEqualSplitPoints') : t('tipPoolSettings.aPositionWith10')}>
        <div className="col" style={{ gap: 6 }}>
          {p.jobs.map((j, i) => (
            <div key={j.jobCodeId} className="row tip-job-row">
              <span className="swatch" style={{ background: jobs[j.jobCodeId]?.color || '#999' }} />
              <span style={{ flex: 1, fontWeight: 600, minWidth: 0 }}>{jobName(j.jobCodeId)}</span>
              {p.method !== 'equal' && <>
                <input className="input sm num" type="number" inputMode="decimal" step="0.1" min="0.01" max="10" style={{ width: 84 }} value={j.points}
                  aria-label={t('tipPoolSettings.jobnamePoints', { jobName: jobName(j.jobCodeId) })} onChange={(e) => setJob(i, { points: e.target.value })} />
                <span className="small faint">{t('tipPoolSettings.pts')}</span>
              </>}
              <button type="button" className="btn sm icon ghost" aria-label={t('tipPoolSettings.removeJobname', { jobName: jobName(j.jobCodeId) })} onClick={() => set('jobs', p.jobs.filter((_, k) => k !== i))}><Icon name="x" /></button>
            </div>
          ))}
          {available.length > 0 && (
            <select className="input sm" style={{ maxWidth: 260 }} value="" onChange={(e) => e.target.value && set('jobs', [...p.jobs, { jobCodeId: e.target.value, points: 1 }])}>
              <option value="">{t('tipPoolSettings.addAPosition')}</option>
              {available.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          )}
        </div>
      </Field>
      {mgrJobs.length > 0 && <div className="alert bad"><Icon name="alert" size={16} />{mgrJobs.map((j) => jobName(j.jobCodeId)).join(', ')} {mgrJobs.length > 1 ? t('tipPoolSettings.areManagerPositions') : t('tipPoolSettings.isAManagerPosition')}{t('tipPoolSettings.managersCantTakeFromA')}</div>}

      <Field label={t('tipPoolSettings.howItsSplit')}>
        <div className="col tip-methods" style={{ gap: 6 }}>
          {TIP_METHODS.map((x) => tipOption(x, t.lang)).map((m) => (
            <label key={m.id} className={`tip-choice ${p.method === m.id ? 'on' : ''}`}>
              <input type="radio" name="tip-method" checked={p.method === m.id} onChange={() => set('method', m.id)} />
              <span><b>{m.label}</b>{m.id === 'hours_points' && <span className="badge brand" style={{ marginLeft: 6 }}>{t('tipPoolSettings.default')}</span>}<br /><span className="small muted">{m.help}</span></span>
            </label>
          ))}
        </div>
      </Field>

      <Field label={t('tipPoolSettings.howOften')} help={tipOption(TIP_PERIODS.find((x) => x.id === p.period), t.lang)?.help}>
        <div className="seg">{TIP_PERIODS.map((x) => <button key={x.id} type="button" className={p.period === x.id ? 'on' : ''} onClick={() => set('period', x.id)}>{tipOption(x, t.lang).label}</button>)}</div>
      </Field>

      <Field label={t('tipPoolSettings.whatGoesIn')} help={t('tipPoolSettings.managersTypeInTheDays')}>
        <div className="col" style={{ gap: 6 }}>
          {p.contributions.map((c, i) => (
            <div key={c.id || i} className="row wrap tip-contrib">
              {c.type === 'sales' ? <>
                <select className="input sm" style={{ width: 150 }} value={c.jobCodeId || ''} onChange={(e) => setContribution(i, { jobCodeId: e.target.value || null })} aria-label={t('tipPoolSettings.whoTipsOut')}>
                  <option value="">{t('tipPoolSettings.tipOut')}</option>
                  {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{t('tipPoolSettings.nameS', { name: j.name })}</option>)}
                </select>
                <span className="small">{t('tipPoolSettings.tipOut2')}</span>
                <input className="input sm num" type="number" inputMode="decimal" min="0" max="100" step="0.5" style={{ width: 74 }} value={c.percent} onChange={(e) => setContribution(i, { percent: e.target.value })} aria-label={t('tipPoolSettings.percent')} />
                <span className="small">{t('tipPoolSettings.of')}{' '}{c.jobCodeId ? t('tipPoolSettings.their') : ''}{t('tipPoolSettings.sales')}</span>
              </> : <>
                <input className="input sm num" type="number" inputMode="decimal" min="0" max="100" step="5" style={{ width: 74 }} value={c.percent} onChange={(e) => setContribution(i, { percent: e.target.value })} aria-label={t('tipPoolSettings.percent')} />
                <span className="small">{t('tipPoolSettings.of')}</span>
                <select className="input sm" style={{ width: 170 }} value={c.source} onChange={(e) => setContribution(i, { source: e.target.value })} aria-label={t('tipPoolSettings.whichTips')}>
                  {Object.keys(TIP_SOURCES).map((k) => <option key={k} value={k}>{t(`tipPoolSettings.source_${k}`)}</option>)}
                </select>
              </>}
              {p.contributions.length > 1 && <button type="button" className="btn sm icon ghost" aria-label={t('common.remove')} onClick={() => set('contributions', p.contributions.filter((_, k) => k !== i))}><Icon name="x" /></button>}
            </div>
          ))}
          <div className="row wrap">
            <button type="button" className="btn sm" onClick={() => set('contributions', [...p.contributions, { id: newId(), type: 'tips', source: 'card', percent: 100 }])}><Icon name="plus" />{t('tipPoolSettings.shareOfTips')}</button>
            <button type="button" className="btn sm" onClick={() => set('contributions', [...p.contributions, { id: newId(), type: 'sales', jobCodeId: jobCodes.find((j) => /^servers?$/i.test(j.name))?.id || null, percent: 3 }])}><Icon name="plus" />{t('tipPoolSettings.tipOutFromSales')}</button>
          </div>
        </div>
      </Field>

      <Field label={t('tipPoolSettings.leaveOutTheseRoles')} help={t('tipPoolSettings.checkedRolesNeverGetMoney')}>
        <div className="row wrap" style={{ gap: 14 }}>
          {ROLE_CHOICES.map((r) => <label key={r} className="check small"><input type="checkbox" checked={p.excludeRoles.includes(r)} onChange={() => toggleRole(r)} />{roleLabelPlural(r, t.lang)}</label>)}
        </div>
      </Field>
      {keepsManagers.length > 0
        ? <div className="alert bad"><Icon name="alert" size={16} />{keepsManagers.map((r) => roleLabelPlural(r, t.lang)).join(', ')}{' '}{t('tipPoolSettings.wouldShareThisPoolUnder')}</div>
        : !p.excludeRoles.includes('supervisor') && <div className="help">{t('tipPoolSettings.supervisorsShiftLeadsAreIn')}</div>}

      <div className="col" style={{ gap: 8 }}>
        <label className="check"><input type="checkbox" checked={p.events} onChange={(e) => set('events', e.target.checked)} />{t('tipPoolSettings.countEventBeoShifts')}</label>
        <label className="check"><input type="checkbox" checked={p.showEstimates} onChange={(e) => set('showEstimates', e.target.checked)} />{t('tipPoolSettings.staffCanSeeTheirEstimate')}</label>
      </div>

      <div className="tip-example">
        <h3>{t('tipPoolSettings.inPlainWords')}</h3>
        <ul className="tip-words">{preview.words.map((w) => <li key={w}>{w}</li>)}</ul>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <h3 style={{ flex: 1 }}>{t('tipPoolSettings.tryIt')}</h3>
          <label className="row small" style={{ gap: 6 }}>{t('tipPoolSettings.tipsInThePool')}<input className="input sm num" inputMode="decimal" style={{ width: 110 }} value={tryAmt} onChange={(e) => setTryAmt(e.target.value)} aria-label={t('tipPoolSettings.examplePoolAmount')} /></label>
        </div>
        {preview.ex ? <>
          <div className="small muted" style={{ margin: '4px 0 8px' }}>{p.period === 'week' ? t('tipPoolSettings.exampleWeek') : t('tipPoolSettings.exampleDay')}</div>
          <div className="tip-table">
            <div className="tip-row tip-head"><span>{t('tipPoolSettings.person')}</span><span className="tip-cells"><span>{t('common.hours')}</span><span>{t('tipPoolSettings.points')}</span><span>{t('common.share')}</span></span><span className="tip-amt">{t('tipPoolSettings.gets')}</span></div>
            {preview.ex.people.map((x) => (
              <div key={x.userId} className="tip-row">
                <span className="tip-name">{x.name}</span>
                <span className="tip-cells"><span>{t('common.hoursHrs', { hours: fmtHours(x.minutes) })}</span><span>{p.method === 'equal' ? '—' : t('tipPoolSettings.pointsPts', { points: fmtPoints(x.points) })}</span><span>{fmtPct(x.sharePct)}</span></span>
                <span className="tip-amt">{fmtCents(x.amount)}</span>
              </div>
            ))}
            <div className="tip-row tip-total"><span className="tip-name">{t('tipPoolSettings.total')}</span><span className="tip-cells" /><span className="tip-amt">{fmtCents(preview.ex.people.reduce((t, x) => t + x.amount, 0))}</span></div>
          </div>
          {preview.line && <div className="tip-formula">{preview.line}</div>}
        </> : <div className="help">{t('tipPoolSettings.addAPositionToSee')}</div>}
      </div>
    </Modal>
  );
}

