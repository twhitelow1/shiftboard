// Settings → Integrations → ADP, also opened from Labor review ("Clock-in setup"). Shows the clock-in
// source (ADP, Toast or both), the CSV import, the API sync's status (which env vars are present),
// Sync now and the last sync, and how ADP's people and departments match ShiftBoard's.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, useAction } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { IS_DEMO } from '../api.js';
import { adpStatus, adpSyncRange } from '../adp-api.js';
import { AdpImportButton } from './AdpImport.jsx';
import { ToastPanel, SyncProgress } from './ToastSettings.jsx';
import { TripleseatPanel } from './TripleseatSettings.jsx';
import '../labor.css';
import { useT, prettyDate, stamp, t as tr } from '../i18n/index.js';

export const ADP_ENV = ['ADP_CLIENT_ID', 'ADP_CLIENT_SECRET', 'ADP_CERT_PEM', 'ADP_KEY_PEM'];
export const ADP_DOCS = 'https://developers.adp.com';
const when = (iso) => (iso ? stamp(iso) : '');

/** ADP status + what's been imported or synced. Reloads when `version` changes. */
export function useAdp() {
  const { call, version } = useApp();
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    adpStatus().then(setStatus).catch((e) => setError(e.message));
    call('adp.get').then(setInfo).catch((e) => setError(e.message));
  }, [version]);
  return { status, info, error };
}

/** "Sync now" for a date range, with progress. Used here and on Labor review. */
export function useAdpSync() {
  const { toast, refresh } = useApp();
  const [progress, setProgress] = useState(null);
  const sync = async ({ from, to }) => {
    setProgress({ done: 0, total: 1 });
    try {
      const r = await adpSyncRange({ from, to, onProgress: setProgress });
      toast(tr('adp.syncedDays', { count: r.days, entries: r.entries }));
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

/** The card on the Settings page: ADP (and the clock-in source), then Toast, then Tripleseat (events). */
export function IntegrationsCard() {
  const t = useT();
  const { has } = useApp();
  const adp = !has || has('adp'), toast = !has || has('toast'), tripleseat = !has || (has('tripleseat') && has('events'));
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('toastSettings.integrations')}</h2>
      {adp && <AdpPanel />}
      {adp && toast && <hr className="adp-hr" />}
      {toast && <ToastPanel />}
      {tripleseat && (adp || toast) && <hr className="adp-hr" />}
      {tripleseat && <TripleseatPanel />}
    </div>
  );
}

/** Labor review's setup button: ADP and Toast in one place. */
export function ClockSetupButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { has } = useApp();
  const [tab, setTab] = useState(() => (has && !has('adp') ? 'toast' : 'adp'));
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}><Icon name="link" />{t('adp.clockSetup')}</button>
      {open && (
        <Modal wide title={t('adp.clockSetup')} sub={t('adp.clockSetupSub')} onClose={() => setOpen(false)}>
          {(!has || (has('adp') && has('toast'))) && (
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button className={tab === 'adp' ? 'on' : ''} onClick={() => setTab('adp')}>ADP</button>
              <button className={tab === 'toast' ? 'on' : ''} onClick={() => setTab('toast')}>Toast</button>
            </div>
          )}
          {tab === 'adp' ? <AdpPanel inModal /> : <ToastPanel inModal />}
        </Modal>
      )}
    </>
  );
}

/** Which clock counts: automatic, ADP, Toast, or both (ADP wins). Admins change it; everyone else sees it. */
export function ClockSourceField({ clock }) {
  const t = useT();
  const { call, isAdmin } = useApp();
  const [run, busy] = useAction();
  if (!clock) return null;
  const now = t(`adp.source_${clock.source}`);
  return (
    <Field label={t('adp.clockInSource')} help={t('adp.clockInSourceHelp')}>
      {isAdmin ? (
        <select className="input" value={clock.setting} disabled={busy} onChange={(e) => run(() => call('clock.setSource', { source: e.target.value }), t('adp.sourceSaved'))}>
          <option value="auto">{t('adp.sourceAuto', { now })}</option>
          <option value="adp">{t('adp.source_adp')}</option>
          <option value="toast">{t('adp.source_toast')}</option>
          <option value="both">{t('adp.source_both')}</option>
        </select>
      ) : <b>{clock.setting === 'auto' ? t('adp.sourceAuto', { now }) : now}</b>}
    </Field>
  );
}

export function AdpPanel({ inModal }) {
  const t = useT();
  const { today } = useApp();
  const { status, info, error } = useAdp();
  const [from, setFrom] = useState(addDays(today, -14));
  const [to, setTo] = useState(addDays(today, -1));
  const [sync, progress] = useAdpSync();
  const yesterday = addDays(today, -1);
  const api = status?.configured;
  const badge = IS_DEMO || status?.demo ? <span className="badge">{t('adp.csvInDemo')}</span>
    : api ? <span className="badge ok"><Icon name="check" size={12} />{t('adp.apiConnected')}</span>
      : <span className="badge">{t('adp.csvImport')}</span>;
  const last = info?.lastSync;
  const imp = info?.lastImport;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}><h3 style={{ flex: 1 }}>{inModal ? '' : 'ADP'}</h3>{badge}</div>
      <div className="small muted" style={{ marginTop: -4 }}>{t('adp.intro')}</div>
      {error && !info && <div className="alert bad">{error}</div>}
      {!info && !error && <div className="small faint">{t('common.loading')}</div>}
      {info && <ClockSourceField clock={info.clock} />}

      <div className="adp-block">
        <div className="row wrap" style={{ gap: 8 }}>
          <div style={{ flex: '1 1 220px' }}><b>{t('adp.fromAFile')}</b><div className="small muted">{t('adp.fromAFileHelp')}</div></div>
          <AdpImportButton className="btn sm primary" />
        </div>
        {imp && <div className="small">{t('adp.lastImportLine', { when: when(imp.at), file: imp.fileName || '—', count: (imp.counts?.new || 0) + (imp.counts?.updated || 0) + (imp.counts?.same || 0), from: imp.from ? prettyDate(imp.from) : '—', to: imp.to ? prettyDate(imp.to) : '—' })}</div>}
      </div>

      <div className="adp-block">
        <div><b>{t('adp.apiSync')}</b><div className="small muted">{t('adp.apiSyncHelp')}</div></div>
        {IS_DEMO || status?.demo ? <div className="help">{t('adp.apiNotInDemo')}</div> : !status ? <div className="small faint">{t('common.loading')}</div> : (
          <>
            <div className="adp-env">
              {ADP_ENV.map((k) => {
                const missing = status.missing.includes(k);
                const problem = status.problems?.find((p) => p.env === k);
                return <span key={k} className={`badge ${missing ? '' : problem ? 'bad' : 'ok'}`}><Icon name={missing ? 'x' : problem ? 'alert' : 'check'} size={12} /><code>{k}</code></span>;
              })}
              <span className={`badge ${status.cron ? 'ok' : ''}`}><Icon name={status.cron ? 'check' : 'x'} size={12} /><code>CRON_SECRET</code></span>
            </div>
            {status.problems?.map((p) => <div key={p.env} className="alert bad"><Icon name="alert" size={16} /><div><code>{p.env}</code>: {t(`adp.pem_${p.problem}`)}</div></div>)}
            {api && (
              <>
                <div className="tp-facts">
                  <div><span>{t('adp.lastSync')}</span><b>{last ? `${when(last.at)}${last.by === 'cron' ? t('adp.daily') : ''}` : t('adp.never')}</b></div>
                  <div><span>{t('adp.dailySync')}</span><b>{status.cron ? t('adp.dailyOn') : t('adp.dailyOff')}</b></div>
                  <div><span>{t('adp.timeCards')}</span><b>{status.team ? t('adp.teamCards') : t('adp.workerCards')}</b></div>
                </div>
                {last && (last.ok
                  ? <div className="alert ok"><Icon name="check" size={16} /><div>{t('adp.lastSyncLine', { from: prettyDate(last.from), to: prettyDate(last.to), count: last.days, entries: last.totals?.entries ?? 0 })}{!last.finished && t('adp.notFinished')}</div></div>
                  : <div className="alert bad"><Icon name="alert" size={16} /><div>{t('adp.lastSyncFailed', { error: last.error })}</div></div>)}
                <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
                  <Field label={t('adp.from')}><input className="input sm" type="date" value={from} max={yesterday} onChange={(e) => setFrom(e.target.value)} /></Field>
                  <Field label={t('adp.to')}><input className="input sm" type="date" value={to} max={yesterday} onChange={(e) => setTo(e.target.value)} /></Field>
                  <button className="btn primary sm" disabled={!!progress || from > to || to > yesterday} onClick={() => sync({ from, to })}><Icon name="download" />{t('adp.syncNow')}</button>
                </div>
                <SyncProgress progress={progress} />
              </>
            )}
          </>
        )}
      </div>

      {info && (info.workers.length > 0 || info.depts.length > 0) && <AdpMatching info={info} />}
      <AdpSetupHelp open={!inModal && !api && !info?.totals.entries} />
    </div>
  );
}

function AdpSetupHelp({ open }) {
  const t = useT();
  return (
    <details className="tp-help" open={open}>
      <summary>{t('adp.howToConnect')}</summary>
      <ol>
        <li>{t('adp.step1')}</li>
        <li>{t('adp.step2')}</li>
        <li>{t('adp.step3')}</li>
        <li>{t('adp.step4')}</li>
        <li>{t('adp.step5')}</li>
      </ol>
      <div className="help" style={{ marginTop: 6 }}>{t('adp.docsLine')}{' '}<a href={ADP_DOCS} target="_blank" rel="noreferrer">developers.adp.com</a>{' · '}<code>docs/integrations/ADP.md</code></div>
    </details>
  );
}

/** Match ADP people → ShiftBoard people and ADP departments → positions. Only what's changed is saved. */
function AdpMatching({ info }) {
  const t = useT();
  const { call, employees: people, jobCodes } = useApp();
  const [emp, setEmp] = useState({});
  const [dept, setDept] = useState({});
  const [showAll, setShowAll] = useState(false);
  const [run, busy] = useAction();
  const sortedPeople = useMemo(() => [...people].sort((a, b) => a.name.localeCompare(b.name)), [people]);
  const activeJobs = jobCodes.filter((j) => !j.archived);
  const valueOf = (map, row, field) => (row.id in map ? map[row.id] : row[field]) || '';
  const needs = info.workers.filter((w) => !w.userId && (w.entries > 0 || !w.deleted));
  const rest = info.workers.filter((w) => !needs.includes(w) && (w.userId || w.entries > 0));
  const shown = showAll ? [...needs, ...rest] : needs;
  const changes = Object.keys(emp).length + Object.keys(dept).length;
  const by = (m) => ({ email: t('adp.byEmail'), id: t('adp.byId'), name: t('adp.byName'), manual: t('adp.byHand') }[m] || '');
  const save = async () => {
    const r = await run(() => call('adp.saveMapping', {
      workers: Object.entries(emp).map(([id, userId]) => ({ id, userId: userId || null, allowShared: true })),
      depts: Object.entries(dept).map(([id, jobCodeId]) => ({ id, jobCodeId: jobCodeId || null })),
    }), (x) => t('adp.savedMatches', { count: x.entriesUpdated }));
    if (r) { setEmp({}); setDept({}); }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 style={{ flex: 1 }}>{t('adp.people')}</h3>
        <span className="small muted">{t('adp.matchedOf', { matched: info.workers.filter((w) => w.userId).length, count: info.workers.length })}</span>
      </div>
      {info.totals.unmatchedEntries > 0 && <div className="alert warn"><Icon name="alert" size={16} />{t('adp.unmatchedEntries', { count: info.totals.unmatchedEntries })}</div>}
      <div className="tp-list">
        {!shown.length && <div className="small faint" style={{ padding: '8px 12px' }}>{t('adp.everyoneMatched')}</div>}
        {shown.map((w) => (
          <div key={w.id} className="tp-row">
            <div className="tp-who">
              <div style={{ fontWeight: 600 }}>{w.name}{w.deleted && <span className="badge" style={{ marginLeft: 6 }}>{t('adp.notActive')}</span>}</div>
              <div className="tiny faint">{[w.employeeId && t('adp.idN', { id: w.employeeId }), w.email, w.entries ? t('adp.clockInsLast', { count: w.entries, date: prettyDate(w.lastDate) }) : t('adp.noClockInsYet'), by(w.matchedBy)].filter(Boolean).join(' · ')}</div>
            </div>
            <select className="input sm" value={valueOf(emp, w, 'userId')} onChange={(x) => setEmp({ ...emp, [w.id]: x.target.value })} aria-label={t('adp.personFor', { name: w.name })}>
              <option value="">{t('adp.notMatched')}</option>
              {sortedPeople.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active === false ? t('adp.inactive') : ''}</option>)}
            </select>
          </div>
        ))}
      </div>
      {rest.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(!showAll)}>{showAll ? t('adp.hideMatched') : t('adp.showMatched', { count: rest.length })}</button>}

      {info.depts.length > 0 && (
        <>
          <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
            <h3 style={{ flex: 1 }}>{t('adp.departments')}</h3>
            <span className="small muted">{t('adp.matchedOf', { matched: info.depts.filter((d) => d.jobCodeId).length, count: info.depts.length })}</span>
          </div>
          <div className="help">{t('adp.departmentsHelp')}</div>
          <div className="tp-list">
            {info.depts.map((d) => (
              <div key={d.id} className="tp-row">
                <div className="tp-who"><div style={{ fontWeight: 600 }}>{d.title}</div><div className="tiny faint">{[t('adp.clockInsN', { count: d.entries }), by(d.matchedBy)].filter(Boolean).join(' · ')}</div></div>
                <select className="input sm" value={valueOf(dept, d, 'jobCodeId')} onChange={(x) => setDept({ ...dept, [d.id]: x.target.value })} aria-label={t('adp.positionFor', { title: d.title })}>
                  <option value="">{t('adp.useSchedule')}</option>
                  {activeJobs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!changes || busy} onClick={save}><Icon name="check" />{t('adp.saveMatches')}</button>
        {changes > 0 && <button className="btn ghost sm" onClick={() => { setEmp({}); setDept({}); }}>{t('common.undo')}</button>}
        <span className="help">{t('adp.matchingHelp')}</span>
      </div>
    </div>
  );
}
