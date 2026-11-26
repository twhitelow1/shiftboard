// The ShiftBoard platform console, for DubLow Digital staff: restaurants, plans and features, integration
// settings, support sign-in and the audit log. English only (it's not for restaurant staff). Served at
// admin.<PLATFORM_DOMAIN> and at /platform on legacy hosts; its API is server/platform/console.js.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './console.css';
import { api, ago, day, stamp, money, dateInput, fromDateInput } from './api.js';
import ErrorsPage, { ConsoleBoundary } from './Errors.jsx';
import { installErrorReporting, reportError } from '../src/errors.js';

// The console's own crashes go to Errors & reports too.
installErrorReporting({ endpoint: '/api/platform/client-errors', app: 'console' });

const STATUS_LABEL = { trialing: 'Trial', active: 'Active', past_due: 'Past due', suspended: 'Suspended', canceled: 'Canceled' };
const STATUS_HELP = {
  trialing: 'Free trial until the trial end date.',
  active: 'Paying (or the free beta).',
  past_due: 'A payment failed; still open. Admins see “Payment failed”.',
  suspended: 'Nobody can sign in. Data is kept.',
  canceled: 'Nobody can sign in. Data is kept.',
};
const ACTION_LABEL = {
  'admin.signin': 'Signed in to the console', 'admin.create': 'Added a platform admin', 'admin.password': 'Changed their password',
  'tenant.create': 'Created the restaurant', 'tenant.update': 'Changed settings', 'tenant.pause': 'Paused the restaurant', 'tenant.resume': 'Reactivated the restaurant',
  'tenant.integrations': 'Changed integrations', 'tenant.invite': 'Sent the owner an invite', 'support.start': 'Started a support sign-in', 'support.signin': 'Signed in as the owner (support)',
  'error.status': 'Changed an error’s status (Errors & reports)',
};

const Flash = createContext(() => {});
const useFlash = () => useContext(Flash);

function useHash() {
  const get = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(get);
  useEffect(() => {
    const on = () => { setParts(get()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
const go = (path) => { location.hash = `#/${path}`; };

function Status({ status }) {
  return <span className={`pill st-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

function Field({ label, help, error, children, wide }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : help ? <span className="field-help">{help}</span> : null}
    </label>
  );
}

function useAction() {
  const flash = useFlash();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, ok) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) flash(typeof ok === 'function' ? ok(r) : ok);
      return r;
    } catch (e) {
      flash(e.message, 'bad');
      return null;
    } finally { setBusy(false); }
  }, [flash]);
  return [run, busy];
}

// ---------- sign-in ----------
/** Signed in with a temporary password: set your own before anything else (then save it in your password manager). */
function FirstPassword({ admin, onDone }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== again) { setErr('The two passwords don’t match'); return; }
    setBusy(true); setErr('');
    try { await api('/password', { method: 'POST', body: { password: pw } }); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <h2>Set your own password</h2>
        <div className="muted small">You signed in as {admin.email} with a temporary password. Choose your own (12+ characters) and save it in your password manager.</div>
        <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
        <label className="field"><span>Type it again</span><input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
        {err && <div className="note warn small">{err}</div>}
        <button className="btn primary" disabled={busy || pw.length < 12}>Save password</button>
      </form>
    </div>
  );
}

function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onDone(await api('/login', { method: 'POST', body: { email, password } })); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand-row"><div className="logo">S</div><div><div className="brand-name">ShiftBoard Platform</div><div className="muted small">DubLow Digital staff only</div></div></div>
        <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {err && <div className="note bad">{err}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

// ---------- restaurants ----------
function TenantList({ meta }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/tenants').then(setList).catch((e) => setError(e.message)); }, []);
  const shown = useMemo(() => (list || []).filter((t) => !q || `${t.name} ${t.slug} ${t.ownerEmail} ${t.address || ''}`.toLowerCase().includes(q.toLowerCase())), [list, q]);
  const counts = useMemo(() => (list || []).reduce((c, t) => ({ ...c, [t.status]: (c[t.status] || 0) + 1 }), {}), [list]);
  return (
    <>
      <div className="page-head">
        <div><h1>Restaurants</h1><div className="muted small">{list ? `${list.length} on the platform · ${Object.entries(counts).map(([s, n]) => `${n} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ')}` : 'Loading…'}</div></div>
        <button className="btn primary" onClick={() => go('new')}>+ New restaurant</button>
      </div>
      {error && <div className="note bad">{error}</div>}
      {list && list.length > 3 && <input className="input search" placeholder="Search name, address, owner…" value={q} onChange={(e) => setQ(e.target.value)} />}
      {list && (
        <div className="card table-card">
          <table className="table responsive">
            <thead><tr><th>Restaurant</th><th>Address</th><th>Status</th><th>Plan</th><th className="num">Staff</th><th className="num">AI this month</th><th>Last activity</th><th>Created</th></tr></thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="click" onClick={() => go(`t/${t.id}`)}>
                  <td data-label="Restaurant"><div className="strong">{t.name}{t.isDefault && <span className="pill subtle">first client</span>}</div><div className="muted small mono">{t.slug}</div></td>
                  <td data-label="Address" className="small">{t.address ? <a href={t.address} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t.address.replace(/^https?:\/\//, '')}</a> : <span className="muted">No address yet</span>}</td>
                  <td data-label="Status"><Status status={t.status} />{t.status === 'trialing' && t.trialEndsAt && <div className="muted tiny">ends {day(t.trialEndsAt)}</div>}</td>
                  <td data-label="Plan">{meta?.plans[t.plan]?.label || t.plan}</td>
                  <td data-label="Staff" className="num">{t.staff}</td>
                  <td data-label="AI this month" className="num">{t.ai?.inPlan || t.ai?.calls ? <span title={t.ai.ownUsd ? `+ ${usd(t.ai.ownUsd)} on their own key` : ''}>{usd(t.ai.usedUsd)} <span className="muted tiny">/ {usd(t.ai.capUsd)}</span></span> : <span className="muted">—</span>}</td>
                  <td data-label="Last activity" title={stamp(t.lastActivity)}>{ago(t.lastActivity)}</td>
                  <td data-label="Created">{day(t.createdAt)}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={8} className="muted center">No restaurants match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function slugify(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

function InviteResult({ invite, owner }) {
  const flash = useFlash();
  if (!invite) return null;
  if (invite.emailed) return <div className="note ok">Invite emailed to <b>{invite.to || owner}</b>. The link works for 7 days.</div>;
  if (invite.link) {
    return (
      <div className="note warn col">
        <div>{invite.error ? `${invite.error}. ` : ''}Email isn’t set up for this restaurant, so here is the owner’s invite link. <b>It’s shown only this once</b>: copy it and send it to the owner. It works for 7 days.</div>
        <div className="copy-row"><input className="input mono" readOnly value={invite.link} onFocus={(e) => e.target.select()} />
          <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(invite.link).then(() => flash('Link copied'))}>Copy</button></div>
      </div>
    );
  }
  return <div className="note bad">The invite couldn’t be made: {invite.error}</div>;
}

function NewTenant({ meta }) {
  const trialEnd = dateInput(new Date(Date.now() + (meta?.trialDays || 14) * 86_400_000).toISOString());
  const [f, setF] = useState({ name: '', slug: '', ownerName: '', ownerEmail: '', plan: 'starter', status: 'trialing', trialEndsAt: trialEnd });
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugCheck, setSlugCheck] = useState(null);
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const slug = slugEdited ? f.slug : slugify(f.name);

  useEffect(() => {
    if (!slug) { setSlugCheck(null); return undefined; }
    const h = setTimeout(() => api(`/slug-check?slug=${encodeURIComponent(slug)}`).then(setSlugCheck).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [slug]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErrors({});
    try {
      const r = await api('/tenants', { method: 'POST', body: { ...f, slug, trialEndsAt: f.status === 'trialing' ? fromDateInput(f.trialEndsAt) : null } });
      setDone(r);
    } catch (x) { setErrors({ [x.field || '_']: x.message }); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <>
        <div className="page-head"><div><h1>{done.tenant.name} is ready</h1><div className="muted small mono">{done.tenant.schema}</div></div></div>
        <div className="card pad col">
          <div>Address: {done.tenant.address ? <a href={done.tenant.address} target="_blank" rel="noreferrer">{done.tenant.address}</a> : <span className="muted">none yet. Add a domain, or set PLATFORM_DOMAIN.</span>}</div>
          <InviteResult invite={done.invite} owner={f.ownerEmail} />
          <div className="row"><button className="btn primary" onClick={() => go(`t/${done.tenant.id}`)}>Open {done.tenant.name}</button><button className="btn" onClick={() => go('')}>All restaurants</button></div>
        </div>
      </>
    );
  }

  const domain = meta?.platformDomain;
  return (
    <>
      <div className="page-head"><div><a className="back" href="#/">← Restaurants</a><h1>New restaurant</h1></div></div>
      <form className="card pad form-grid" onSubmit={submit}>
        <Field label="Restaurant name" error={errors.name}><input className="input" value={f.name} onChange={set('name')} required maxLength={80} autoFocus placeholder="The Corner Bistro" /></Field>
        <Field label="Address (slug)" error={errors.slug || (slugCheck && !slugCheck.ok ? slugCheck.problem : '')}
          help={slug ? (domain ? `${slug}.${domain}` : `Schema t_${slug.replace(/-/g, '_')}. Set PLATFORM_DOMAIN to give it a subdomain.`) : `Lowercase letters, numbers and dashes. Reserved: ${(meta?.reserved || []).slice(0, 4).join(', ')}…`}>
          <input className="input mono" value={slug} onChange={(e) => { setSlugEdited(true); setF((x) => ({ ...x, slug: e.target.value.toLowerCase() })); }} required maxLength={40} placeholder="corner-bistro" />
        </Field>
        <Field label="Owner’s name" error={errors.ownerName}><input className="input" value={f.ownerName} onChange={set('ownerName')} required maxLength={80} /></Field>
        <Field label="Owner’s email" error={errors.ownerEmail} help="They become the Super Admin and get the invite."><input className="input" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} required /></Field>
        <Field label="Plan" error={errors.plan}>
          <select className="input" value={f.plan} onChange={set('plan')}>
            {Object.entries(meta?.plans || {}).map(([k, p]) => <option key={k} value={k}>{p.label}{p.priceCents ? ` · ${money(p.priceCents)}/${p.interval}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Status" error={errors.status} help={STATUS_HELP[f.status]}>
          <select className="input" value={f.status} onChange={set('status')}>
            <option value="trialing">Trial</option><option value="active">Active</option>
          </select>
        </Field>
        {f.status === 'trialing' && <Field label="Trial ends" error={errors.trialEndsAt}><input className="input" type="date" value={f.trialEndsAt} onChange={set('trialEndsAt')} required /></Field>}
        {errors._ && <div className="note bad wide">{errors._}</div>}
        <div className="wide note subtle small">This creates the restaurant’s own database schema, its settings with its name, and the owner as Super Admin, then {meta?.email ? 'emails the owner an invite to set their password' : 'shows you the owner’s invite link once (email isn’t set up on this deployment)'}.</div>
        <div className="wide row"><button className="btn primary" disabled={busy || (slugCheck && !slugCheck.ok)}>{busy ? 'Creating…' : 'Create restaurant'}</button><a className="btn" href="#/">Cancel</a></div>
      </form>
    </>
  );
}

// ---------- one restaurant ----------
function TenantDetail({ id, meta }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/tenants/${id}`).then(setT).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="note bad">{error}</div>;
  if (!t || !meta) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <a className="back" href="#/">← Restaurants</a>
          <h1>{t.name} <Status status={t.status} /></h1>
          <div className="muted small">{t.address ? <a href={t.address} target="_blank" rel="noreferrer">{t.address.replace(/^https?:\/\//, '')}</a> : 'No address yet'} · <span className="mono">{t.schema}</span>{t.isDefault && ' · first client (env fallback)'}</div>
        </div>
      </div>
      <div className="stats">
        <div><span>Plan</span><b>{meta.plans[t.plan]?.label || t.plan}</b></div>
        <div><span>Staff</span><b>{t.staff}</b></div>
        <div><span>Last activity</span><b title={stamp(t.lastActivity)}>{ago(t.lastActivity)}</b></div>
        <div><span>Created</span><b>{day(t.createdAt)}</b></div>
        <div><span>Owner</span><b className="ellipsis">{t.ownerEmail || '—'}</b></div>
      </div>
      <div className="grid-2">
        <div className="col">
          <AccountCard t={t} meta={meta} onSaved={setT} />
          <FeaturesCard t={t} meta={meta} onSaved={setT} />
          <DomainsCard t={t} meta={meta} onSaved={setT} />
        </div>
        <div className="col">
          <SupportCard t={t} />
          <AiCard t={t} onSaved={setT} />
          <IntegrationsCard t={t} meta={meta} onSaved={setT} />
          <NotesCard t={t} onSaved={setT} />
          <BillingCard t={t} />
          <ActivityCard entries={t.audit} />
        </div>
      </div>
    </>
  );
}

function AccountCard({ t, meta, onSaved }) {
  const [f, setF] = useState({ name: t.name, status: t.status, plan: t.plan, trialEndsAt: dateInput(t.trialEndsAt), ownerName: t.ownerName, ownerEmail: t.ownerEmail });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = (e) => {
    e.preventDefault();
    const pausing = ['suspended', 'canceled'].includes(f.status) && f.status !== t.status;
    if (pausing && !confirm(`${STATUS_LABEL[f.status]} ${t.name}? Nobody there can sign in until it’s reactivated. Their data is kept.${t.isDefault ? '\n\nThis is the first client (Chasing Rabbits).' : ''}`)) return;
    run(() => api(`/tenants/${t.id}`, { method: 'PATCH', body: { ...f, trialEndsAt: fromDateInput(f.trialEndsAt) } }), 'Saved').then((r) => r && onSaved(r));
  };
  return (
    <form className="card pad" onSubmit={save}>
      <h2>Account</h2>
      <div className="form-grid">
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} maxLength={80} required /></Field>
        <Field label="Status" help={STATUS_HELP[f.status]}>
          <select className="input" value={f.status} onChange={set('status')}>{meta.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
        </Field>
        <Field label="Plan">
          <select className="input" value={f.plan} onChange={set('plan')}>{Object.entries(meta.plans).map(([k, p]) => <option key={k} value={k}>{p.label}{p.priceCents ? ` · ${money(p.priceCents)}/${p.interval}` : ''}</option>)}</select>
        </Field>
        <Field label="Trial ends" help={f.status === 'trialing' ? 'Admins see “Your free trial ends in N days”.' : 'Only used while on trial.'}><input className="input" type="date" value={f.trialEndsAt} onChange={set('trialEndsAt')} /></Field>
        <Field label="Owner’s name"><input className="input" value={f.ownerName} onChange={set('ownerName')} /></Field>
        <Field label="Owner’s email" help="“Sign in as owner” uses this account."><input className="input" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} /></Field>
      </div>
      <div className="row end"><button className="btn primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function FeaturesCard({ t, meta, onSaved }) {
  const [over, setOver] = useState(t.features || {});
  const [run, busy] = useAction();
  const planHas = (k) => meta.plans[t.plan]?.features.includes(k);
  const value = (k) => (typeof over[k] === 'boolean' ? (over[k] ? 'on' : 'off') : 'plan');
  const choose = (k, v) => setOver((o) => { const n = { ...o }; if (v === 'plan') delete n[k]; else n[k] = v === 'on'; return n; });
  const dirty = JSON.stringify(over) !== JSON.stringify(t.features || {});
  return (
    <div className="card pad">
      <h2>Features</h2>
      <div className="muted small">The {meta.plans[t.plan]?.label} plan’s features, unless you switch one on or off for this restaurant. Enforced on the server; the app hides what’s off.</div>
      <div className="features">
        {meta.features.map((f) => {
          const on = value(f.key) === 'plan' ? planHas(f.key) : value(f.key) === 'on';
          return (
            <div key={f.key} className="feature-row">
              <div className={`dot ${on ? 'on' : ''}`} aria-hidden />
              <div className="feature-text"><div className="strong">{f.label}</div><div className="muted tiny">{f.hint}</div></div>
              <select className="input sm" value={value(f.key)} onChange={(e) => choose(f.key, e.target.value)} aria-label={`${f.label}`}>
                <option value="plan">Plan ({planHas(f.key) ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="row end"><button className="btn primary" disabled={busy || !dirty} onClick={() => run(() => api(`/tenants/${t.id}`, { method: 'PATCH', body: { features: over } }), 'Features saved').then((r) => r && onSaved(r))}>Save features</button></div>
    </div>
  );
}

function DomainsCard({ t, meta, onSaved }) {
  const [text, setText] = useState((t.domains || []).join('\n'));
  const [run, busy] = useAction();
  return (
    <div className="card pad">
      <h2>Domains</h2>
      <div className="muted small">
        {meta.platformDomain ? <>Always at <span className="mono">{t.isDefault ? (meta.legacyHosts[0] || 'its legacy host') : `${t.slug}.${meta.platformDomain}`}</span>. </> : <>PLATFORM_DOMAIN isn’t set, so every unlisted host goes to the first client. </>}
        Add custom domains here (one per line) after adding them to the Vercel project; each must point at Vercel.
      </div>
      <textarea className="input mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="schedule.restaurant.com" />
      <div className="row end"><button className="btn primary" disabled={busy} onClick={() => run(() => api(`/tenants/${t.id}`, { method: 'PATCH', body: { domains: text.split(/[\s,]+/).filter(Boolean) } }), 'Domains saved').then((r) => { if (r) { onSaved(r); setText(r.domains.join('\n')); } })}>Save domains</button></div>
    </div>
  );
}

function NotesCard({ t, onSaved }) {
  const [notes, setNotes] = useState(t.notes || '');
  const [run, busy] = useAction();
  return (
    <div className="card pad">
      <h2>Notes</h2>
      <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Contacts, onboarding status, anything DubLow should remember…" />
      <div className="row end"><button className="btn" disabled={busy || notes === (t.notes || '')} onClick={() => run(() => api(`/tenants/${t.id}`, { method: 'PATCH', body: { notes } }), 'Notes saved').then((r) => r && onSaved(r))}>Save notes</button></div>
    </div>
  );
}

function SupportCard({ t }) {
  const [minutes, setMinutes] = useState(30);
  const [invite, setInvite] = useState(null);
  const [link, setLink] = useState('');
  const [run, busy] = useAction();
  const paused = ['suspended', 'canceled'].includes(t.status);
  const signIn = async () => {
    const w = window.open('about:blank', '_blank'); // opened during the click, so it isn't blocked
    const r = await run(() => api(`/tenants/${t.id}/support`, { method: 'POST', body: { minutes } }), (x) => `Signing in as ${x.as} for ${x.minutes} minutes`);
    if (!r) { w?.close(); return; }
    if (w) w.location.href = r.url; else setLink(r.url);
  };
  return (
    <div className="card pad">
      <h2>Support</h2>
      <div className="muted small">Opens the restaurant signed in as its owner, with a banner everyone there can see, for the time you pick. Logged in the activity below.</div>
      {paused ? <div className="note warn">Paused restaurants can’t be signed in to. Reactivate it first.</div> : (
        <div className="row wrap">
          <select className="input sm" style={{ width: 'auto' }} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
          <button className="btn primary" disabled={busy || !t.address} onClick={signIn}>Sign in as owner</button>
          <button className="btn" disabled={busy} onClick={() => run(() => api(`/tenants/${t.id}/invite`, { method: 'POST', body: {} })).then((r) => r && setInvite(r))}>Resend owner invite</button>
        </div>
      )}
      {link && <div className="note warn">Your browser blocked the new tab. <a href={link} target="_blank" rel="noreferrer">Open the support link</a> (works once, for a few minutes).</div>}
      <InviteResult invite={invite} owner={t.ownerEmail} />
    </div>
  );
}

function IntegrationsCard({ t, meta, onSaved }) {
  const fields = t.integrations.fields;
  const [vals, setVals] = useState(() => Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [f.key, f.value])));
  const [secrets, setSecrets] = useState({}); // key -> new value, '' to clear
  const [editing, setEditing] = useState({});
  const [run, busy] = useAction();
  const eff = t.integrations.effective;
  const changed = {};
  for (const f of fields) {
    if (f.secret) { if (f.key in secrets) changed[f.key] = secrets[f.key]; } else if ((vals[f.key] || '') !== (f.value || '')) changed[f.key] = vals[f.key] || '';
  }
  const save = () => run(() => api(`/tenants/${t.id}/integrations`, { method: 'PUT', body: changed }), 'Integrations saved').then((r) => {
    if (!r) return;
    setSecrets({}); setEditing({}); onSaved(r);
  });
  const groups = [
    ['toast', 'Toast POS', eff.toast ? 'Connected' : 'Not set up', t.resolved.toast ? '' : 'Toast isn’t in this restaurant’s plan.'],
    ['adp', 'ADP (clock-ins)', eff.adp ? 'Connected' : 'Not set up', t.resolved.adp ? 'ADP Workforce Now with the API Central add-on: the project’s client ID and secret, and the certificate and key from its CSR. Without API access, managers import ADP timecard CSV exports in Labor review.' : 'ADP isn’t in this restaurant’s plan.'],
    ['tripleseat', 'Tripleseat (events)', eff.tripleseat ? 'Connected' : 'Not set up', t.resolved.tripleseat ? 'An OAuth 2.0 application from Tripleseat (Settings → API, made by a Tripleseat account admin): its client ID and secret. Location ID limits it to one venue. The webhook link is in the restaurant’s Settings → Integrations → Tripleseat (admins); paste the webhook’s signing key here.' : 'Tripleseat isn’t in this restaurant’s plan.'],
    ['twilio', 'Texts (Twilio sender)', eff.sms ? 'Ready' : eff.smsAccount ? 'Needs a sender' : 'No Twilio account on the platform', t.resolved.sms ? 'The account SID and auth token are the platform’s; each restaurant has its own sender (its A2P 10DLC brand and campaign).' : 'Texts aren’t in this restaurant’s plan.'],
    ['email', 'Email', eff.email ? `From ${eff.emailFrom}` : 'Not set up', 'Uses the platform’s Resend key. The From address’s domain must be verified in Resend.'],
    ['anthropic', 'Anthropic (Ask ShiftBoard)', fields.find((f) => f.key === 'ANTHROPIC_OWN_API_KEY')?.set ? 'Their own key' : 'DubLow’s key', t.resolved.assistant ? 'Optional: the restaurant’s own Anthropic API key. Its usage is still metered but not capped; without it, Ask ShiftBoard uses DubLow’s key (ANTHROPIC_API_KEY) up to the cap.' : 'Ask ShiftBoard isn’t in this restaurant’s plan.'],
  ];
  return (
    <div className="card pad">
      <h2>Integrations</h2>
      {t.isDefault && <div className="muted small">The first client falls back to the deployment’s env vars for anything left blank here.</div>}
      {!meta.encryption && <div className="note warn small">PLATFORM_ENCRYPTION_KEY isn’t set, so secrets (like the Toast client secret) can’t be saved.</div>}
      {groups.map(([g, title, state, note]) => (
        <div key={g} className="int-group">
          <div className="int-head"><h3>{title}</h3><span className={`pill ${/Connected|Ready|From|Their own/.test(state) ? 'st-active' : 'subtle'}`}>{state}</span></div>
          {note && <div className="muted tiny">{note}</div>}
          <div className="form-grid">
            {fields.filter((f) => f.group === g).map((f) => (f.secret ? (
              <Field key={f.key} label={f.label} help="Encrypted. Never shown again after saving.">
                {editing[f.key] || !f.set
                  ? (f.multiline
                    ? <textarea className="input mono" rows={4} autoComplete="off" spellCheck={false} value={secrets[f.key] ?? ''} placeholder={f.set ? 'Paste the new file contents' : 'Paste the file contents (-----BEGIN …)'}
                        onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))} />
                    : <input className="input mono" type="password" autoComplete="off" value={secrets[f.key] ?? ''} placeholder={f.set ? 'New value' : 'Not set'}
                        onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))} />)
                  : <div className="secret-row">
                      <span className="mono">{secrets[f.key] === '' ? 'Will be cleared' : `Set · ends in ${f.last4 || '••••'}`}</span>
                      <button type="button" className="btn sm" onClick={() => setEditing((x) => ({ ...x, [f.key]: true }))}>Replace</button>
                      <button type="button" className="btn sm ghost" onClick={() => setSecrets((s) => ({ ...s, [f.key]: '' }))}>Clear</button>
                    </div>}
              </Field>
            ) : (
              <Field key={f.key} label={f.label}>
                <input className="input mono" value={vals[f.key] || ''} placeholder={f.placeholder || ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
              </Field>
            )))}
          </div>
        </div>
      ))}
      <div className="row end"><button className="btn primary" disabled={busy || !Object.keys(changed).length} onClick={save}>Save integrations</button></div>
    </div>
  );
}

// Ask ShiftBoard (server/ai/): this month's AI spend on DubLow's key against the restaurant's cap, and the cap.
const usd = (v) => `$${Number(v || 0).toFixed(Number(v || 0) < 10 ? 2 : 0)}`;
function AiCard({ t, onSaved }) {
  const ai = t.ai || {};
  const [cap, setCap] = useState(ai.override ?? '');
  const [run, busy] = useAction();
  const pct = ai.capUsd > 0 ? Math.min(100, Math.round((ai.usedUsd / ai.capUsd) * 100)) : ai.usedUsd > 0 ? 100 : 0;
  const save = (e) => {
    e.preventDefault();
    run(() => api(`/tenants/${t.id}`, { method: 'PATCH', body: { aiCapUsd: cap === '' ? null : Number(cap) } }), 'AI cap saved').then((r) => r && onSaved(r));
  };
  return (
    <form className="card pad" onSubmit={save}>
      <h2>Ask ShiftBoard (AI)</h2>
      <div className="muted small">{ai.inPlan ? 'Claude Haiku in the app, on DubLow’s Anthropic key. Every call is metered; when this month’s spend reaches the cap, the assistant says so until the 1st. A restaurant’s own key (Integrations) isn’t capped.' : 'Not in this restaurant’s plan (Features: Ask ShiftBoard).'}</div>
      <div className="ai-meter" role="img" aria-label={`${pct}% of the cap`}><span style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''} /></div>
      <div className="kv">
        <div><span>{ai.month} on DubLow’s key</span><b>{usd(ai.usedUsd)} of {usd(ai.capUsd)}</b></div>
        <div><span>On their own key</span><b>{usd(ai.ownUsd)}</b></div>
        <div><span>Calls · errors</span><b>{ai.calls || 0} · {ai.errors || 0}</b></div>
      </div>
      <div className="form-grid">
        <Field label="Monthly cap (USD)" help={`Blank: the plan’s (${usd(ai.planCapUsd)}). 0 stops it on DubLow’s key.`}>
          <input className="input" type="number" min="0" max="10000" step="0.5" inputMode="decimal" value={cap} placeholder={String(ai.planCapUsd ?? '')} onChange={(e) => setCap(e.target.value)} />
        </Field>
      </div>
      <div className="row end"><button className="btn primary" disabled={busy || String(cap) === String(ai.override ?? '')}>Save cap</button></div>
    </form>
  );
}

function BillingCard({ t }) {
  const b = t.billing || {};
  return (
    <div className="card pad">
      <h2>Billing</h2>
      <div className="muted small">Stripe comes in phase 2: sign-up through Checkout, monthly card payments, webhooks keeping the status and plan in sync, and the customer portal. These fields fill in then.</div>
      <div className="kv">
        <div><span>Stripe customer</span><b className="mono">{b.stripeCustomerId || '—'}</b></div>
        <div><span>Subscription</span><b className="mono">{b.subscriptionId || '—'}</b></div>
        <div><span>Period ends</span><b>{day(b.currentPeriodEnd)}</b></div>
      </div>
    </div>
  );
}

function ActivityCard({ entries, tenants }) {
  if (!entries) return null;
  return (
    <div className="card pad">
      <h2>Activity</h2>
      <AuditList entries={entries} tenants={tenants} />
    </div>
  );
}

function detailText(d = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === 'object' && 'from' in v && 'to' in v) parts.push(`${k}: ${short(v.from)} → ${short(v.to)}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.join(', ')}`);
    else parts.push(`${k}: ${short(v)}`);
  }
  return parts.join(' · ');
}
const short = (v) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function AuditList({ entries, tenants }) {
  if (!entries.length) return <div className="muted small">Nothing yet.</div>;
  return (
    <ul className="audit">
      {entries.map((a) => (
        <li key={a.id}>
          <div className="audit-head"><b>{ACTION_LABEL[a.action] || a.action}</b>{tenants && a.tenantId && <a href={`#/t/${a.tenantId}`}>{tenants[a.tenantId] || a.tenantId}</a>}<span className="muted tiny" title={stamp(a.at)}>{ago(a.at)}</span></div>
          <div className="muted tiny">{a.adminEmail || 'self-serve'}{Object.keys(a.details || {}).length ? ` · ${detailText(a.details)}` : ''}</div>
        </li>
      ))}
    </ul>
  );
}

function AuditPage() {
  const [entries, setEntries] = useState(null);
  const [tenants, setTenants] = useState({});
  useEffect(() => {
    api('/audit?limit=200').then(setEntries);
    api('/tenants').then((l) => setTenants(Object.fromEntries(l.map((t) => [t.id, t.name]))));
  }, []);
  return (
    <>
      <div className="page-head"><div><h1>Audit log</h1><div className="muted small">Every platform action, newest first.</div></div></div>
      <div className="card pad">{entries ? <AuditList entries={entries} tenants={tenants} /> : <div className="muted">Loading…</div>}</div>
    </>
  );
}

function AdminsPage({ admin }) {
  const [list, setList] = useState(null);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [pw, setPw] = useState('');
  const [run, busy] = useAction();
  const load = () => api('/admins').then(setList);
  useEffect(() => { load(); }, []);
  return (
    <>
      <div className="page-head"><div><h1>Platform admins</h1><div className="muted small">DubLow Digital staff who can use this console. Separate from every restaurant’s accounts.</div></div></div>
      <div className="grid-2">
        <div className="card pad">
          <h2>Admins</h2>
          <ul className="plain">{(list || []).map((a) => <li key={a.id}><b>{a.name || a.email}</b> <span className="muted small">{a.email} · last sign-in {ago(a.lastLoginAt)}</span></li>)}</ul>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); run(() => api('/admins', { method: 'POST', body: f }), 'Admin added').then((r) => { if (r) { setF({ name: '', email: '', password: '' }); load(); } }); }}>
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Temporary password" help="At least 12 characters. They choose their own when they first sign in."><input className="input" type="password" autoComplete="new-password" required minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <div className="row end wide"><button className="btn primary" disabled={busy}>Add admin</button></div>
          </form>
        </div>
        <form className="card pad" onSubmit={(e) => { e.preventDefault(); run(() => api('/password', { method: 'POST', body: { password: pw } }), 'Password changed. Other sessions are signed out.').then((r) => r && setPw('')); }}>
          <h2>My password</h2>
          <div className="muted small">Signed in as {admin.email}.</div>
          <Field label="New password" help="At least 12 characters."><input className="input" type="password" autoComplete="new-password" minLength={12} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <div className="row end"><button className="btn primary" disabled={busy}>Change password</button></div>
        </form>
      </div>
    </>
  );
}

// ---------- shell ----------
function App() {
  const [admin, setAdmin] = useState(undefined); // undefined: checking; null: signed out; 'elsewhere': not on this host
  const [meta, setMeta] = useState(null);
  const [flashes, setFlashes] = useState([]);
  const parts = useHash();
  const flash = useCallback((text, kind = 'ok') => {
    const id = Math.random();
    setFlashes((f) => [...f, { id, text, kind }]);
    setTimeout(() => setFlashes((f) => f.filter((x) => x.id !== id)), kind === 'bad' ? 6000 : 3000);
  }, []);
  useEffect(() => { api('/session').then(setAdmin).catch((e) => setAdmin(e.status === 404 ? 'elsewhere' : null)); }, []);
  useEffect(() => { if (admin?.email) api('/meta').then(setMeta).catch((e) => flash(e.message, 'bad')); }, [admin]);

  if (admin === undefined) return <div className="center muted pad-xl">Loading…</div>;
  if (admin === 'elsewhere') return <div className="login"><div className="card login-card"><h2>Not here</h2><div className="muted">The platform console isn’t available at this address.</div></div></div>;
  if (!admin) return <Flash.Provider value={flash}><Login onDone={setAdmin} /></Flash.Provider>;
  if (admin.mustChange) return <Flash.Provider value={flash}><FirstPassword admin={admin} onDone={() => setAdmin({ ...admin, mustChange: false })} /></Flash.Provider>;

  const signOut = async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); setAdmin(null); };
  const [rawPage, arg] = parts;
  const page = (rawPage || '').split('?')[0];
  const view = page === 'errors' ? <ErrorsPage id={arg} flash={flash} />
    : page === 'new' ? <NewTenant meta={meta} />
    : page === 't' && arg ? <TenantDetail key={arg} id={arg} meta={meta} />
      : page === 'audit' ? <AuditPage />
        : page === 'admins' ? <AdminsPage admin={admin} />
          : <TenantList meta={meta} />;
  const tab = page === 'audit' ? 'audit' : page === 'admins' ? 'admins' : page === 'errors' ? 'errors' : 'restaurants';
  return (
    <Flash.Provider value={flash}>
      <header className="top">
        <a className="brand-row" href="#/"><div className="logo">S</div><div className="brand-name">ShiftBoard <span className="muted">Platform</span></div></a>
        <nav className="tabs">
          <a className={tab === 'restaurants' ? 'on' : ''} href="#/">Restaurants</a>
          <a className={tab === 'errors' ? 'on' : ''} href="#/errors">Errors &amp; reports</a>
          <a className={tab === 'audit' ? 'on' : ''} href="#/audit">Audit log</a>
          <a className={tab === 'admins' ? 'on' : ''} href="#/admins">Admins</a>
        </nav>
        <div className="who"><span className="muted small ellipsis">{admin.email}</span><button className="btn sm ghost" onClick={signOut}>Sign out</button></div>
      </header>
      <main className="main-wrap">{view}</main>
      <div className="flashes">{flashes.map((f) => <div key={f.id} className={`flash ${f.kind}`}>{f.text}</div>)}</div>
    </Flash.Provider>
  );
}

createRoot(document.getElementById('root')).render(<ConsoleBoundary onError={(e, info) => reportError(e, 'boundary', { componentStack: info?.componentStack })}><App /></ConsoleBoundary>);
