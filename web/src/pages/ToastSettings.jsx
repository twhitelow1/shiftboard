// Settings → Integrations → Toast (the card is in AdpSettings.jsx), also in Labor review's "Clock-in setup".
// Shows whether Toast is configured (env vars only), the restaurant, the last sync, Sync now,
// and how Toast's employees and jobs match ShiftBoard's people and positions.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, money, useAction } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { IS_DEMO } from '../api.js';
import { toastStatus, toastSyncRange } from '../toast-api.js';
import '../labor.css';
import { nameWithLegal } from '../../../core/names.js';
import { useT, prettyDate, stamp , t as tr } from '../i18n/index.js';

export const ENV_NAMES = ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'];
const when = (iso) => (iso ? stamp(iso) : '');

/** Toast status + the latest synced info. Reloads when `version` changes. */
export function useToast() {
  const { call, version, has } = useApp();
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const load = () => {
    if (has && !has('toast')) { setStatus({ configured: false, missing: [], off: true }); return; } // not in the plan
    toastStatus().then(setStatus).catch((e) => setError(e.message));
    if (!IS_DEMO) call('toast.get').then(setInfo).catch((e) => setError(e.message));
  };
  useEffect(load, [version]);
  return { status, info, error, reload: load };
}

/** "Sync now" for a date range, with progress. Used here and on Labor review. */
export function useToastSync() {
  const { toast, refresh } = useApp();
  const [progress, setProgress] = useState(null);
  const sync = async ({ from, to, replaceManual }) => {
    setProgress({ done: 0, total: 1 });
    try {
      const r = await toastSyncRange({ from, to, replaceManual, onProgress: setProgress });
      toast(`${tr('toastSettings.syncedDays', { count: r.days, amount: money(r.sales), entries: r.entries })}${r.kept ? tr('toastSettings.keptTypedIn', { count: r.kept }) : ''}`);
      return r;
    } catch (e) {
      toast(e.message, 'bad');
      return null;
    } finally {
      setProgress(null);
      refresh();
    }
  };
  return [sync, progress];
}

export function SyncProgress({ progress }) {
  const t = useT();
  if (!progress) return null;
  const pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="small muted">{t('toastSettings.syncing')}{progress.date ? ` ${prettyDate(progress.date)}` : ''}{t('toastSettings.doneOfTotalDays', { done: progress.done, total: progress.total })}</div>
      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** A button + modal with the same panel, for managers on Labor review. */
export function ToastSetupButton({ label = tr('toastSettings.toastSetup') }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}><Icon name="link" />{label}</button>
      {open && <Modal wide title={t('toastSettings.toastPos')} sub={t('toastSettings.dailySalesCoversAndClock')} onClose={() => setOpen(false)}><ToastPanel inModal /></Modal>}
    </>
  );
}

/** embedded: inside Settings → Integrations (its title and status are above). connect: the credentials are pasted there, not in Vercel. */
export function ToastPanel({ inModal, embedded, connect }) {
  const t = useT();
  const { today, managed } = useApp();
  const { status, info, error } = useToast();
  const [from, setFrom] = useState(addDays(today, -14));
  const [to, setTo] = useState(addDays(today, -1));
  const [replaceManual, setReplaceManual] = useState(false);
  const [sync, progress] = useToastSync();

  const head = (badge) => (embedded ? null : (
    <div className="row wrap" style={{ gap: 8 }}>
      <h3 style={{ flex: 1 }}>{inModal ? '' : t('toastSettings.toastPos')}</h3>{badge}
    </div>
  ));
  const intro = <div className="small muted" style={{ marginTop: -4 }}>{t('toastSettings.pullsDailySalesAndCovers')}</div>;

  if (IS_DEMO || status?.demo) {
    return <div className="col" style={{ gap: 8 }}>{head(<span className="badge">{t('toastSettings.notInTheDemo')}</span>)}{intro}
      <div className="help">{t('toastSettings.toastSyncWorksInThe')}</div></div>;
  }
  if (error && !status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="alert bad">{error}</div></div>;
  if (!status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="small faint">{t('common.loading')}</div></div>;

  if (!status.configured) {
    return (
      <div className="col" style={{ gap: 10 }}>
        {head(<span className="badge warn">{t('toastSettings.notSetUp')}</span>)}{intro}
        {connect ? <div className="help">{t('integrations.pasteAbove')}</div> : managed
          ? <div className="alert warn"><Icon name="alert" size={16} /><div>{t('platform.askDublowToast')}</div></div>
          : <><div className="alert warn"><Icon name="alert" size={16} /><div>{t('toastSettings.add')}{' '}{status.missing.join(', ')}{' '}{t('toastSettings.inVercelSettingsEnvironmentVariables')}</div></div>
            <SetupHelp /></>}
      </div>
    );
  }

  const last = info?.lastSync;
  const yesterday = addDays(today, -1);
  const bad = from > to || to > yesterday;
  return (
    <div className="col" style={{ gap: 12 }}>
      {head(<span className="badge ok"><Icon name="check" size={12} />{t('toastSettings.connected')}</span>)}
      {intro}
      <div className="tp-facts">
        <div><span>{t('common.restaurant')}</span><b>{info?.restaurantName ? `${info.restaurantName}${info.locationName ? ` · ${info.locationName}` : ''}` : t('toastSettings.showsAfterTheFirstSync')}</b></div>
        <div><span>{t('toastSettings.lastSync')}</span><b>{last ? `${when(last.at)}${last.by === 'cron' ? ' (daily)' : ''}` : t('toastSettings.never')}</b></div>
        <div><span>{t('toastSettings.dailySync')}</span><b>{status.cron ? t('toastSettings.onEveryMorning') : t('toastSettings.offAddCronSecretIn')}</b></div>
      </div>
      {last && (last.ok
        ? <div className="alert ok"><Icon name="check" size={16} /><div>{t('toastSettings.lastSyncLine', { date: prettyDate(last.from), date2: prettyDate(last.to), count: last.days, amount: money(last.totals?.sales), covers: last.totals?.covers ?? 0, entries: last.totals?.entries ?? 0 })}{last.totals?.salesKept ? t('toastSettings.keptCountDaysYouTyped', { count: last.totals.salesKept }) : ''}.{!last.finished && t('toastSettings.notFinishedSyncAgainTo')}</div></div>
        : <div className="alert bad"><Icon name="alert" size={16} /><div>{t('toastSettings.lastSyncFailedError', { error: last.error })}</div></div>)}
      {last?.warning && <div className="help">{last.warning}</div>}

      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label={t('toastSettings.from')}><input className="input sm" type="date" value={from} max={yesterday} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('toastSettings.to')}><input className="input sm" type="date" value={to} max={yesterday} onChange={(e) => setTo(e.target.value)} /></Field>
        <button className="btn primary sm" disabled={!!progress || bad} onClick={() => sync({ from, to, replaceManual })}><Icon name="download" />{t('toastSettings.syncNow')}</button>
      </div>
      <label className="check small"><input type="checkbox" checked={replaceManual} onChange={(e) => setReplaceManual(e.target.checked)} />{t('toastSettings.replaceSalesDaysTypedIn')}</label>
      <SyncProgress progress={progress} />
      <div className="help">{t('toastSettings.syncingAgainIsSafeDays')}</div>

      {info && (info.employees.length > 0 || info.jobs.length > 0) && <Matching info={info} inModal={inModal} />}
      {!inModal && !connect && <SetupHelp />}
    </div>
  );
}

function SetupHelp() {
  const t = useT();
  return (
    <details className="tp-help">
      <summary>{t('toastSettings.howToGetToastApi')}</summary>
      <ol>
        <li>{t('toastSettings.inToastWebSomeoneWith')}</li>
        <li>{t('toastSettings.pickTheseScopesCodeOrders')}</li>
        <li>{t('toastSettings.inVercelAddCodeToast')}</li>
      </ol>
    </details>
  );
}

/** Match Toast employees → people and Toast jobs → positions. Only what's changed is saved. */
function Matching({ info }) {
  const t = useT();
  const { call, employees: people, jobCodes } = useApp();
  const [emp, setEmp] = useState({});
  const [job, setJob] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [showAllJobs, setShowAllJobs] = useState(false);
  const [run, busy] = useAction();
  const sortedPeople = useMemo(() => [...people].sort((a, b) => a.name.localeCompare(b.name)), [people]);
  const activeJobs = jobCodes.filter((j) => !j.archived);
  const valueOf = (map, row, field) => (row.id in map ? map[row.id] : row[field]) || '';

  // Who needs attention: unmatched people who clocked in (or are current), then everyone else.
  const needs = info.employees.filter((e) => !e.userId && (e.entries > 0 || !e.deleted));
  const rest = info.employees.filter((e) => !needs.includes(e) && (e.userId || e.entries > 0));
  const shown = showAll ? [...needs, ...rest] : needs;
  const jobsNeed = info.jobs.filter((j) => !j.jobCodeId && (!j.deleted || j.entries > 0));
  const jobsRest = info.jobs.filter((j) => j.jobCodeId && (!j.deleted || j.entries > 0));
  const jobsShown = showAllJobs ? [...jobsNeed, ...jobsRest] : jobsNeed;
  const changes = Object.keys(emp).length + Object.keys(job).length;
  const save = async () => {
    const r = await run(() => call('toast.saveMapping', {
      employees: Object.entries(emp).map(([id, userId]) => ({ id, userId: userId || null, allowShared: true })),
      jobs: Object.entries(job).map(([id, jobCodeId]) => ({ id, jobCodeId: jobCodeId || null })),
    }), (x) => t('toastSettings.savedCountClockInsUpdated', { count: x.entriesUpdated }));
    if (r) { setEmp({}); setJob({}); }
  };
  const by = (m) => (m === 'email' ? t('toastSettings.byEmail') : m === 'name' ? t('toastSettings.byName') : m === 'manual' ? t('toastSettings.byHand') : '');

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 style={{ flex: 1 }}>{t('common.people')}</h3>
        <span className="small muted">{t('toastSettings.filtercountOfEmployeescountMatched', { filterCount: info.employees.filter((e) => e.userId).length, employeesCount: info.employees.length })}</span>
      </div>
      {info.totals.unmatchedEntries > 0 && <div className="alert warn"><Icon name="alert" size={16} />{t('toastSettings.unmatchedentriesClockInsBelongTo', { unmatchedEntries: info.totals.unmatchedEntries })}</div>}
      <div className="tp-list">
        {!shown.length && <div className="small faint" style={{ padding: '8px 0' }}>{t('toastSettings.everyoneWhoClocksInIs')}</div>}
        {shown.map((e) => (
          <div key={e.id} className="tp-row">
            <div className="tp-who">
              <div style={{ fontWeight: 600 }}>{e.name}{e.deleted && <span className="badge" style={{ marginLeft: 6 }}>{t('toastSettings.goneFromToast')}</span>}</div>
              <div className="tiny faint">{[e.email, e.entries ? t('toastSettings.clockInsLast', { count: e.entries, date: prettyDate(e.lastDate) }) : t('toastSettings.noClockInsYet'), by(e.matchedBy)].filter(Boolean).join(' · ')}</div>
            </div>
            <select className="input sm" value={valueOf(emp, e, 'userId')} onChange={(x) => setEmp({ ...emp, [e.id]: x.target.value })} aria-label={t('toastSettings.shiftboardPersonForName', { name: e.name })}>
              <option value="">{t('toastSettings.notMatched')}</option>
              {sortedPeople.map((p) => <option key={p.id} value={p.id}>{nameWithLegal(p)}{p.active === false ? t('toastSettings.inactive') : ''}</option>)}
            </select>
          </div>
        ))}
      </div>
      {rest.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(!showAll)}>{showAll ? t('toastSettings.hideMatchedPeople') : t('toastSettings.showMatchedPeopleRestcount', { restCount: rest.length })}</button>}

      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        <h3 style={{ flex: 1 }}>{t('toastSettings.positions')}</h3>
        <span className="small muted">{t('toastSettings.filtercountOfJobscountMatched', { filterCount: info.jobs.filter((j) => j.jobCodeId).length, jobsCount: info.jobs.length })}</span>
      </div>
      <div className="tp-list">
        {!jobsShown.length && <div className="small faint" style={{ padding: '8px 12px' }}>{t('toastSettings.everyToastJobIsMatched')}</div>}
        {jobsShown.map((j) => (
          <div key={j.id} className="tp-row">
            <div className="tp-who">
              <div style={{ fontWeight: 600 }}>{j.title}</div>
              <div className="tiny faint">{[j.code, `${j.entries} clock-ins`, by(j.matchedBy)].filter(Boolean).join(' · ')}</div>
            </div>
            <select className="input sm" value={valueOf(job, j, 'jobCodeId')} onChange={(x) => setJob({ ...job, [j.id]: x.target.value })} aria-label={t('toastSettings.positionForTitle', { title: j.title })}>
              <option value="">{t('toastSettings.notMatched')}</option>
              {activeJobs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ))}
      </div>
      {jobsRest.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAllJobs(!showAllJobs)}>{showAllJobs ? t('toastSettings.hideMatchedPositions') : t('toastSettings.showMatchedPositionsJobsrestcount', { jobsRestCount: jobsRest.length })}</button>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!changes || busy} onClick={save}><Icon name="check" />{t('toastSettings.saveMatches')}</button>
        {changes > 0 && <button className="btn ghost sm" onClick={() => { setEmp({}); setJob({}); }}>{t('common.undo')}</button>}
        <span className="help">{t('toastSettings.newToastEmployeesAreMatched')}</span>
      </div>
    </div>
  );
}
