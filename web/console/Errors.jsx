// Errors & reports (DubLow Digital only): every restaurant's server, browser and phone app errors, grouped by
// fingerprint, and the reports people sent with "Report a problem". Filters, the detail (stack, occurrences,
// people affected, the screenshot), acknowledge / fixed / ignore, and "Copy as issue text" for a GitHub issue or
// a chat with Claude. API: server/platform/errors-console.js. What's kept and why: docs/BETA-TESTING.md.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ago, stamp } from './api.js';
import './errors.css';

const KIND = { server: 'Server', browser: 'Browser', phone: 'Phone app', report: 'Report' };
const SOURCE = { rpc: 'RPC', route: 'route', cron: 'daily sync', sync: 'Sync now', window: 'uncaught', promise: 'promise', boundary: 'React', global: 'uncaught', console: 'console', report: '' };
const STATUS = { new: 'New', acknowledged: 'Acknowledged', fixed: 'Fixed', ignored: 'Ignored' };
const PERIODS = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];

const titleOf = (e) => (e.kind === 'report' ? (e.report?.text || e.message) : `${e.name ? `${e.name}: ` : ''}${e.message}`);
const where = (e) => [e.method, e.route].filter(Boolean).join(' ');

function StatusPill({ status }) { return <span className={`pill es-${status}`}>{STATUS[status] || status}</span>; }
function KindPill({ e }) {
  return <span className={`pill ek-${e.kind}`}>{KIND[e.kind] || e.kind}{SOURCE[e.source] ? <span className="ek-src"> · {SOURCE[e.source]}</span> : null}</span>;
}

function readFilters() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  return { tenant: q.get('tenant') || '', status: q.get('status') ?? 'open', kind: q.get('kind') || '', since: q.get('since') || '7d', q: q.get('q') || '' };
}
function writeFilters(f) {
  const q = new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'since' && v === '7d') && !(k === 'status' && v === 'open')));
  if (f.status === '') q.set('status', 'all');
  const s = q.toString();
  history.replaceState(null, '', `#/errors${s ? `?${s}` : ''}`);
}

export default function ErrorsPage({ id, flash }) {
  return id ? <ErrorDetail key={id} id={id} flash={flash} /> : <ErrorList flash={flash} />;
}

function ErrorList({ flash }) {
  const [f, setF] = useState(readFilters);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const status = f.status === 'all' ? '' : f.status;
    const qs = new URLSearchParams({ ...f, status }).toString();
    return api(`/errors?${qs}`).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }, [f]);
  useEffect(() => { writeFilters(f); load(); }, [f, load]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const tenants = data?.tenants || {};
  const counts = data?.counts;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Errors &amp; reports</h1>
          <div className="muted small">{counts ? `${counts.new} new · ${counts.acknowledged} acknowledged · ${counts.fixed} fixed · ${counts.ignored} ignored` : 'Loading…'}</div>
        </div>
        <button className="btn" onClick={() => load().then(() => flash('Up to date'))}>Refresh</button>
      </div>
      <div className="err-filters">
        <select className="input" value={f.tenant} onChange={set('tenant')} aria-label="Restaurant">
          <option value="">All restaurants</option>
          {Object.entries(tenants).map(([tid, name]) => <option key={tid} value={tid}>{name}</option>)}
        </select>
        <select className="input" value={f.status} onChange={set('status')} aria-label="Status">
          <option value="open">Open (new + acknowledged)</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">Any status</option>
        </select>
        <select className="input" value={f.kind} onChange={set('kind')} aria-label="Type">
          <option value="">Every type</option>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}{k === 'report' ? 's' : ' errors'}</option>)}
        </select>
        <select className="input" value={f.since} onChange={set('since')} aria-label="When">
          {PERIODS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" placeholder="Search message, frame, route, fingerprint" value={f.q} onChange={set('q')} />
      </div>
      {error && <div className="note bad">{error}</div>}
      {data && !data.items.length && <div className="card pad muted center">Nothing here. {f.status === 'open' ? 'No open errors or reports for these filters.' : ''}</div>}
      {data && data.items.length > 0 && (
        <div className="card table-card">
          <table className="table responsive err-table">
            <thead><tr><th>Status</th><th>What</th><th>Restaurants</th><th className="num">{f.since === 'all' ? 'Count' : 'In period'}</th><th className="num">People</th><th>Last seen</th></tr></thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id} className="click" onClick={() => { location.hash = `#/errors/${e.id}`; }}>
                  <td data-label="Status"><StatusPill status={e.status} /></td>
                  <td data-label="What" className="err-what">
                    <a href={`#/errors/${e.id}`} onClick={(ev) => ev.stopPropagation()} className="err-title">{titleOf(e)}</a>
                    <div className="err-sub"><KindPill e={e} />{e.hasScreenshot && <span className="pill">Screenshot</span>}<span className="mono muted ellipsis">{e.kind === 'report' ? (e.report?.page || '') : (where(e) || e.topFrame)}</span></div>
                  </td>
                  <td data-label="Restaurants" className="small">{e.tenants.length ? e.tenants.map((t) => tenants[t] || t).join(', ') : <span className="muted">—</span>}</td>
                  <td data-label={f.since === 'all' ? 'Count' : 'In period'} className="num">{f.since === 'all' ? e.count : e.recent}{f.since !== 'all' && e.count !== e.recent ? <span className="muted tiny"> / {e.count}</span> : null}</td>
                  <td data-label="People" className="num">{e.usersAffected}</td>
                  <td data-label="Last seen" className="small" title={stamp(e.lastSeen)}>{ago(e.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function ErrorDetail({ id, flash }) {
  const [e, setE] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const load = useCallback(() => api(`/errors/${encodeURIComponent(id)}`).then(setE).catch((x) => setError(x.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const setStatus = async (status) => {
    setBusy(true);
    try { await api(`/errors/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }); await load(); flash(`Marked ${STATUS[status].toLowerCase()}`); } catch (x) { flash(x.message, 'bad'); } finally { setBusy(false); }
  };
  const devices = useMemo(() => [...new Set((e?.events || []).map((v) => v.device).filter(Boolean))], [e]);
  if (error) return <><a className="back" href="#/errors">← Errors &amp; reports</a><div className="note bad">{error}</div></>;
  if (!e) return <div className="muted">Loading…</div>;
  const tenants = e.tenantNames || {};
  const latest = e.events[0] || {};
  const ctx = latest.context || {};
  const report = e.kind === 'report';
  const shots = e.events.filter((v) => v.hasFile);
  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <a className="back" href="#/errors">← Errors &amp; reports</a>
          <h1 className="err-h1">{report ? 'Report' : titleOf(e)}</h1>
          <div className="row wrap"><StatusPill status={e.status} /><KindPill e={e} />{!report && <span className="mono muted small" title="Fingerprint">{e.fingerprint}</span>}
            {e.statusBy && <span className="muted tiny">{STATUS[e.status]} {e.statusBy === 'reopened' ? 'again: it came back' : `by ${e.statusBy}`} {e.statusAt ? ago(e.statusAt) : ''}</span>}</div>
        </div>
        <div className="row wrap err-actions">
          {e.status !== 'acknowledged' && e.status !== 'fixed' && <button className="btn" disabled={busy} onClick={() => setStatus('acknowledged')}>Acknowledge</button>}
          {e.status !== 'fixed' && <button className="btn" disabled={busy} onClick={() => setStatus('fixed')}>Mark fixed</button>}
          {e.status !== 'ignored' && <button className="btn" disabled={busy} onClick={() => setStatus('ignored')}>Ignore</button>}
          {e.status !== 'new' && <button className="btn ghost" disabled={busy} onClick={() => setStatus('new')}>Reopen</button>}
          <button className="btn primary" onClick={async () => { if (await copy(e.issueText)) flash('Copied. Paste it into a GitHub issue or a chat with Claude.'); else setShowIssue(true); }}>Copy as issue text</button>
        </div>
      </div>

      <div className="grid-2 err-grid">
        <div className="col">
          {report && (
            <div className="card pad">
              <h2>What they said</h2>
              <blockquote className="err-quote">{e.report?.text || e.message}</blockquote>
              <div className="kv">
                <div><span>Page (as they said)</span><b>{e.report?.page || '—'}</b></div>
                <div><span>Where the app was</span><b className="mono">{latest.page || '—'}</b></div>
                <div><span>Sent</span><b title={stamp(e.firstSeen)}>{ago(e.firstSeen)}</b></div>
              </div>
            </div>
          )}
          {shots.length > 0 && (
            <div className="card pad">
              <h2>Screenshot</h2>
              {shots.map((v) => (
                <a key={v.id} href={`/api/platform/errors/${encodeURIComponent(e.id)}/files/${v.id}`} target="_blank" rel="noreferrer">
                  <img className="err-shot" src={`/api/platform/errors/${encodeURIComponent(e.id)}/files/${v.id}`} alt="The screenshot sent with the report" />
                </a>
              ))}
            </div>
          )}
          <div className="card pad">
            <h2>Summary</h2>
            <div className="kv err-kv">
              {!report && <div><span>Where</span><b className="mono">{where(e) || latest.page || '—'}{e.httpStatus ? ` (${e.httpStatus})` : ''}</b></div>}
              {!report && <div><span>Top frame</span><b className="mono">{e.topFrame || '—'}</b></div>}
              {!report && <div><span>Grouped as</span><b className="mono">{e.fpMessage}</b></div>}
              {!report && <div><span>Seen</span><b>{e.count} time{e.count === 1 ? '' : 's'}</b></div>}
              <div><span>People affected</span><b>{e.usersAffected}{e.usersAffected ? '' : ' signed in'}</b></div>
              {!report && <div><span>First · last</span><b title={`${stamp(e.firstSeen)} · ${stamp(e.lastSeen)}`}>{ago(e.firstSeen)} · {ago(e.lastSeen)}</b></div>}
              <div><span>App versions</span><b className="mono">{e.versions.join(', ') || '—'}</b></div>
              <div><span>Devices</span><b>{devices.slice(0, 4).join('; ') || '—'}</b></div>
            </div>
            {e.byTenant?.length > 0 && (
              <div className="err-tenants">
                {e.byTenant.map((t) => <span key={t.tenantId || 'none'} className="pill">{t.tenantId ? (t.name || tenants[t.tenantId] || t.tenantId) : 'No restaurant (console or signed out)'} · {t.count}</span>)}
              </div>
            )}
          </div>
          {(ctx.errors?.length > 0 || ctx.rpc?.length > 0 || ctx.error) && (
            <div className="card pad">
              <h2>What the app attached</h2>
              {ctx.error && <><h3>The error on screen</h3><pre className="err-pre">{`${ctx.error.name ? `${ctx.error.name}: ` : ''}${ctx.error.message}${ctx.error.stack ? `\n${ctx.error.stack}` : ''}`}</pre></>}
              {ctx.errors?.length > 0 && (
                <><h3>Recent errors in the app</h3><ul className="plain small">{ctx.errors.map((x, i) => <li key={i}><span className="mono muted">{x.at ? x.at.slice(11, 19) : ''}</span> {x.name ? `${x.name}: ` : ''}{x.message} {x.source && <span className="muted">({x.source})</span>}</li>)}</ul></>
              )}
              {ctx.rpc?.length > 0 && (
                <><h3>Last calls to the server</h3><div className="err-rpc">{ctx.rpc.map((r, i) => <span key={i} className={`pill ${r.status >= 500 || r.status === 0 ? 'es-new' : r.status >= 400 ? 'es-acknowledged' : ''}`}><span className="mono">{r.method}</span> {r.status || 'no answer'}{r.ms != null ? ` · ${r.ms}ms` : ''}</span>)}</div></>
              )}
              <div className="muted tiny" style={{ marginTop: 8 }}>{[ctx.app, ctx.screen, ctx.lang, ctx.online === false ? 'offline' : ''].filter(Boolean).join(' · ')}</div>
            </div>
          )}
        </div>
        <div className="col">
          {e.stack && <div className="card pad"><h2>Stack <span className="muted tiny">(latest)</span></h2><pre className="err-pre">{e.stack}</pre></div>}
          {ctx.componentStack && <div className="card pad"><h2>React components</h2><pre className="err-pre">{ctx.componentStack}</pre></div>}
          {showIssue && <div className="card pad"><h2>Issue text</h2><textarea className="input mono" rows={12} readOnly value={e.issueText} onFocus={(x) => x.target.select()} /></div>}
          <div className="card pad">
            <h2>Occurrences <span className="muted tiny">(latest {e.events.length})</span></h2>
            <div className="err-occ">
              {e.events.map((v) => (
                <div key={v.id} className="err-occ-row">
                  <div className="row wrap"><b title={stamp(v.at)}>{ago(v.at)}</b><span className="muted small">{v.tenantId ? (tenants[v.tenantId] || v.tenantId) : 'no restaurant'}</span>{v.userId && <span className="mono tiny muted" title="User id">{v.userId}</span>}</div>
                  <div className="muted small"><span className="mono">{[v.method, v.route].filter(Boolean).join(' ') || v.page || '—'}</span>{v.version ? ` · ${v.version}` : ''}{v.device ? ` · ${v.device}` : ''}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** The console's own safety net: a crash shows a plain message (English, like the console) and is reported. */
export class ConsoleBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { this.props.onError?.(error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="login"><div className="card login-card">
        <h2>Something went wrong</h2>
        <div className="muted">This page hit a problem, and it’s been recorded under Errors &amp; reports. Reloading usually fixes it.</div>
        <button className="btn primary" onClick={() => location.reload()}>Reload</button>
      </div></div>
    );
  }
}
