// Settings → Integrations → Toast, also opened from Forecast & Labor → Labor review ("Toast setup").
// Shows whether Toast is configured (env vars only), the restaurant, the last sync, Sync now,
// and how Toast's employees and jobs match ShiftBoard's people and positions.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, Modal, money, useAction } from '../ui.jsx';
import { addDays, prettyDate } from '../../../core/time.js';
import { IS_DEMO } from '../api.js';
import { toastStatus, toastSyncRange } from '../toast-api.js';
import '../labor.css';

export const ENV_NAMES = ['TOAST_CLIENT_ID', 'TOAST_CLIENT_SECRET', 'TOAST_RESTAURANT_GUID'];
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Toast status + the latest synced info. Reloads when `version` changes. */
export function useToast() {
  const { call, version } = useApp();
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const load = () => {
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
      toast(`Synced ${r.days} day${r.days === 1 ? '' : 's'}: ${money(r.sales)} sales, ${r.entries} clock-ins${r.kept ? `, kept ${r.kept} typed-in day${r.kept === 1 ? '' : 's'}` : ''}`);
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
  if (!progress) return null;
  const pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="small muted">Syncing{progress.date ? ` ${prettyDate(progress.date)}` : ''}… {progress.done} of {progress.total} days</div>
      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/** The card on the Settings page. */
export function IntegrationsCard() {
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>Integrations</h2>
      <ToastPanel />
    </div>
  );
}

/** A button + modal with the same panel, for managers on Labor review. */
export function ToastSetupButton({ label = 'Toast setup' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}><Icon name="link" />{label}</button>
      {open && <Modal wide title="Toast POS" sub="Daily sales, covers and clock-ins from Toast" onClose={() => setOpen(false)}><ToastPanel inModal /></Modal>}
    </>
  );
}

export function ToastPanel({ inModal }) {
  const { today } = useApp();
  const { status, info, error } = useToast();
  const [from, setFrom] = useState(addDays(today, -14));
  const [to, setTo] = useState(addDays(today, -1));
  const [replaceManual, setReplaceManual] = useState(false);
  const [sync, progress] = useToastSync();

  const head = (badge) => (
    <div className="row wrap" style={{ gap: 8 }}>
      <h3 style={{ flex: 1 }}>{inModal ? '' : 'Toast POS'}</h3>{badge}
    </div>
  );
  const intro = <div className="small muted" style={{ marginTop: -4 }}>Pulls daily sales and covers into the forecast, and clock-ins for Labor review.</div>;

  if (IS_DEMO || status?.demo) {
    return <div className="col" style={{ gap: 8 }}>{head(<span className="badge">Not in the demo</span>)}{intro}
      <div className="help">Toast sync works in the hosted app. In this demo, Labor review shows sample clock-ins.</div></div>;
  }
  if (error && !status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="alert bad">{error}</div></div>;
  if (!status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="small faint">Loading…</div></div>;

  if (!status.configured) {
    return (
      <div className="col" style={{ gap: 10 }}>
        {head(<span className="badge warn">Not set up</span>)}{intro}
        <div className="alert warn"><Icon name="alert" size={16} /><div>
          Add {status.missing.join(', ')} in Vercel (Settings → Environment Variables), then redeploy.
        </div></div>
        <SetupHelp />
      </div>
    );
  }

  const last = info?.lastSync;
  const yesterday = addDays(today, -1);
  const bad = from > to || to > yesterday;
  return (
    <div className="col" style={{ gap: 12 }}>
      {head(<span className="badge ok"><Icon name="check" size={12} />Connected</span>)}
      {intro}
      <div className="tp-facts">
        <div><span>Restaurant</span><b>{info?.restaurantName ? `${info.restaurantName}${info.locationName ? ` · ${info.locationName}` : ''}` : 'Shows after the first sync'}</b></div>
        <div><span>Last sync</span><b>{last ? `${when(last.at)}${last.by === 'cron' ? ' (daily)' : ''}` : 'Never'}</b></div>
        <div><span>Daily sync</span><b>{status.cron ? 'On, every morning' : 'Off: add CRON_SECRET in Vercel'}</b></div>
      </div>
      {last && (last.ok
        ? <div className="alert ok"><Icon name="check" size={16} /><div>{prettyDate(last.from)} – {prettyDate(last.to)}: {last.days} day{last.days === 1 ? '' : 's'}, {money(last.totals?.sales)} sales, {last.totals?.covers ?? 0} covers, {last.totals?.entries ?? 0} clock-ins{last.totals?.salesKept ? `. Kept ${last.totals.salesKept} day${last.totals.salesKept === 1 ? '' : 's'} you typed in` : ''}.{!last.finished && ' Not finished: sync again to continue.'}</div></div>
        : <div className="alert bad"><Icon name="alert" size={16} /><div>Last sync failed: {last.error}</div></div>)}
      {last?.warning && <div className="help">{last.warning}</div>}

      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label="From"><input className="input sm" type="date" value={from} max={yesterday} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input sm" type="date" value={to} max={yesterday} onChange={(e) => setTo(e.target.value)} /></Field>
        <button className="btn primary sm" disabled={!!progress || bad} onClick={() => sync({ from, to, replaceManual })}><Icon name="download" />Sync now</button>
      </div>
      <label className="check small"><input type="checkbox" checked={replaceManual} onChange={(e) => setReplaceManual(e.target.checked)} />Replace sales days typed in by hand with Toast's numbers</label>
      <SyncProgress progress={progress} />
      <div className="help">Syncing again is safe: days are replaced, never doubled. Voided and deleted orders are left out. Today isn't synced until it's over.</div>

      {info && (info.employees.length > 0 || info.jobs.length > 0) && <Matching info={info} inModal={inModal} />}
      {!inModal && <SetupHelp />}
    </div>
  );
}

function SetupHelp() {
  return (
    <details className="tp-help">
      <summary>How to get Toast API access</summary>
      <ol>
        <li>In Toast Web, someone with the <b>Manage Integrations</b> permission opens the API access <b>Manage credentials</b> page and picks Create new credentials → <b>Standard API</b> for this location. It's read-only and needs Restaurant Management Suite Essentials or higher.</li>
        <li>Pick these scopes: <code>orders:read</code>, <code>labor:read</code>, <code>labor.employees:read</code>, <code>restaurants:read</code>.</li>
        <li>In Vercel, add <code>TOAST_CLIENT_ID</code>, <code>TOAST_CLIENT_SECRET</code> (mark it Sensitive), <code>TOAST_RESTAURANT_GUID</code> (the location's GUID), and <code>TOAST_API_HOST</code> if Toast shows a host other than ws-api.toasttab.com. Add <code>CRON_SECRET</code> (any long random string) for the daily sync. Then redeploy.</li>
      </ol>
    </details>
  );
}

/** Match Toast employees → people and Toast jobs → positions. Only what's changed is saved. */
function Matching({ info }) {
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
    }), (x) => `Saved. ${x.entriesUpdated} clock-in${x.entriesUpdated === 1 ? '' : 's'} updated`);
    if (r) { setEmp({}); setJob({}); }
  };
  const by = (m) => (m === 'email' ? 'by email' : m === 'name' ? 'by name' : m === 'manual' ? 'by hand' : '');

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 style={{ flex: 1 }}>People</h3>
        <span className="small muted">{info.employees.filter((e) => e.userId).length} of {info.employees.length} matched</span>
      </div>
      {info.totals.unmatchedEntries > 0 && <div className="alert warn"><Icon name="alert" size={16} />{info.totals.unmatchedEntries} clock-ins belong to Toast employees who aren't matched to anyone yet.</div>}
      <div className="tp-list">
        {!shown.length && <div className="small faint" style={{ padding: '8px 0' }}>Everyone who clocks in is matched.</div>}
        {shown.map((e) => (
          <div key={e.id} className="tp-row">
            <div className="tp-who">
              <div style={{ fontWeight: 600 }}>{e.name}{e.deleted && <span className="badge" style={{ marginLeft: 6 }}>Gone from Toast</span>}</div>
              <div className="tiny faint">{[e.email, e.entries ? `${e.entries} clock-ins, last ${prettyDate(e.lastDate)}` : 'No clock-ins yet', by(e.matchedBy)].filter(Boolean).join(' · ')}</div>
            </div>
            <select className="input sm" value={valueOf(emp, e, 'userId')} onChange={(x) => setEmp({ ...emp, [e.id]: x.target.value })} aria-label={`ShiftBoard person for ${e.name}`}>
              <option value="">Not matched</option>
              {sortedPeople.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active === false ? ' (inactive)' : ''}</option>)}
            </select>
          </div>
        ))}
      </div>
      {rest.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide matched people' : `Show matched people (${rest.length})`}</button>}

      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        <h3 style={{ flex: 1 }}>Positions</h3>
        <span className="small muted">{info.jobs.filter((j) => j.jobCodeId).length} of {info.jobs.length} matched</span>
      </div>
      <div className="tp-list">
        {!jobsShown.length && <div className="small faint" style={{ padding: '8px 12px' }}>Every Toast job is matched to a position.</div>}
        {jobsShown.map((j) => (
          <div key={j.id} className="tp-row">
            <div className="tp-who">
              <div style={{ fontWeight: 600 }}>{j.title}</div>
              <div className="tiny faint">{[j.code, `${j.entries} clock-ins`, by(j.matchedBy)].filter(Boolean).join(' · ')}</div>
            </div>
            <select className="input sm" value={valueOf(job, j, 'jobCodeId')} onChange={(x) => setJob({ ...job, [j.id]: x.target.value })} aria-label={`Position for ${j.title}`}>
              <option value="">Not matched</option>
              {activeJobs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ))}
      </div>
      {jobsRest.length > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAllJobs(!showAllJobs)}>{showAllJobs ? 'Hide matched positions' : `Show matched positions (${jobsRest.length})`}</button>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!changes || busy} onClick={save}><Icon name="check" />Save matches</button>
        {changes > 0 && <button className="btn ghost sm" onClick={() => { setEmp({}); setJob({}); }}>Undo</button>}
        <span className="help">New Toast employees are matched by email, then by name, at each sync. Your choices here are kept.</span>
      </div>
    </div>
  );
}
