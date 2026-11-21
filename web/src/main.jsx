import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { call, login, logout, IS_DEMO, demoPersonas, demoSwitch, demoCurrent, getConfig, forgotPassword, resetPassword } from './api.js';
import { Ctx, Icon, Avatar, useToasts, Modal, setStartTimesOnly } from './ui.jsx';
import { canManageSchedule, canChangeSettings, canManageEvents, canApprove, roleLabel } from '../../core/roles.js';
import Schedule from './pages/Schedule.jsx';
import CalendarPage from './pages/Calendar.jsx';
import MyShifts from './pages/MyShifts.jsx';
import Swaps from './pages/Swaps.jsx';
import Events from './pages/Events.jsx';
import Forecast from './pages/Forecast.jsx';
import Team from './pages/Team.jsx';
import TimeOff from './pages/TimeOff.jsx';
import Settings from './pages/Settings.jsx';
import Venue from './pages/Venue.jsx';
import { prettyDate } from '../../core/time.js';

function useHashRoute() {
  const get = () => (location.hash.replace(/^#\/?/, '') || '').split('/');
  const [parts, setParts] = useState(get);
  useEffect(() => {
    const on = () => { setParts(get()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
const go = (path) => { location.hash = `#/${path}`; };

const NAV = [
  { key: 'schedule', label: 'Schedule', icon: 'grid' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar' },
  { key: 'my', label: 'My Shifts', icon: 'user' },
  { key: 'swaps', label: 'Swaps & Trades', short: 'Swaps', icon: 'swap', badge: 'swaps' },
  { key: 'events', label: 'Events & BEOs', short: 'Events', icon: 'glass' },
  { key: 'timeoff', label: 'Time Off', icon: 'sun', badge: 'timeoff' },
  { key: 'forecast', label: 'Forecast & Labor', icon: 'chart', mgr: true },
  { key: 'venue', label: 'Venue & Floor Plans', short: 'Venue', icon: 'map', mgr: true },
  { key: 'team', label: 'Team & Job Codes', icon: 'users', mgr: true },
  { key: 'settings', label: 'Settings', icon: 'settings', admin: true },
];

function AuthCard({ children, onSubmit }) {
  return (
    <div className="login">
      <form className="card card-pad col" style={{ gap: 14, padding: 26 }} onSubmit={onSubmit}>
        <div className="brand" style={{ color: 'var(--text)', padding: 0 }}>
          <div className="brand-mark">S</div>
          <div><div className="brand-name">ShiftBoard</div><div className="small muted">Restaurant scheduling</div></div>
        </div>
        {children}
      </form>
    </div>
  );
}

function Login({ onDone, emailEnabled }) {
  const [mode, setMode] = useState('login'); // login | forgot | sent
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (mode === 'forgot') { await forgotPassword(email); setMode('sent'); }
      else { await login(email, password); onDone(); }
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  if (mode === 'sent') return (
    <AuthCard onSubmit={(e) => { e.preventDefault(); setMode('login'); }}>
      <div className="alert ok"><Icon name="send" size={16} />If {email} has an account, we just emailed a link to reset the password. It works for 1 hour.</div>
      <button className="btn block">Back to sign in</button>
    </AuthCard>
  );
  return (
    <AuthCard onSubmit={submit}>
      {mode === 'forgot' && <div className="small muted">Enter your sign-in email and we'll send you a link to choose a new password.</div>}
      <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
      {mode === 'login' && <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{mode === 'forgot' ? (busy ? 'Sending…' : 'Email me a reset link') : (busy ? 'Signing in…' : 'Sign in')}</button>
      {emailEnabled
        ? <button type="button" className="btn ghost sm" onClick={() => { setErr(''); setMode(mode === 'login' ? 'forgot' : 'login'); }}>{mode === 'login' ? 'Forgot your password?' : 'Back to sign in'}</button>
        : <div className="help">Forgot your password? Ask a manager to reset it.</div>}
    </AuthCard>
  );
}

// Opened from an email link (#/reset?token=…): set a password for a new account or reset a forgotten one.
function ResetPassword({ token, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== pw2) return setErr('The two passwords don’t match');
    setBusy(true); setErr('');
    try { await resetPassword(token, pw); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <AuthCard onSubmit={submit}>
      <div><b>Choose your password</b><div className="small muted">At least 6 characters. You'll be signed in right after.</div></div>
      <label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={6} autoFocus /></label>
      <label className="field"><span>Repeat it</span><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={6} /></label>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : 'Save and sign in'}</button>
      <a className="btn ghost sm" href="#/">Back to sign in</a>
    </AuthCard>
  );
}

function Notifications({ onClose }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    call('notifications.list').then((r) => { setItems(r); call('notifications.readAll'); });
  }, []);
  return (
    <>
      <div className="overlay" style={{ background: 'rgba(15,23,42,.25)' }} onClick={onClose} />
      <div className="drawer">
        <div className="modal-head"><h2 style={{ flex: 1 }}>Notifications</h2><button className="btn ghost icon sm" onClick={onClose}><Icon name="x" /></button></div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items?.length === 0 && <div className="empty">You're all caught up.</div>}
          {items?.map((n) => (
            <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => { if (n.link) location.hash = n.link; onClose(); }}>
              <Icon name="bell" size={16} style={{ marginTop: 2, flex: 'none', color: 'var(--text-3)' }} />
              <div><div>{n.text}</div><div className="tiny faint">{new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function App() {
  const [boot, setBoot] = useState(null);
  const [authed, setAuthed] = useState(IS_DEMO ? true : null);
  const [version, setVersion] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, toasts] = useToasts();
  const parts = useHashRoute();
  const [config, setConfig] = useState({ email: false, emailFrom: null });
  useEffect(() => { getConfig().then(setConfig); }, []);

  const load = useCallback(async () => {
    try {
      const b = await call('app.bootstrap');
      setBoot(b); setAuthed(true);
    } catch (e) {
      if (e.status === 401) setAuthed(false);
      else toast(e.message, 'bad');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load, version]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const ctx = useMemo(() => {
    if (!boot) return null;
    const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j]));
    const people = Object.fromEntries(boot.employees.map((e) => [e.id, e]));
    const isMgr = canManageSchedule(boot.me);
    setStartTimesOnly(boot.settings?.startTimesOnly);
    return { ...boot, jobs, people, isMgr, emailEnabled: config.email, emailFrom: config.emailFrom, isAdmin: canChangeSettings(boot.me), isEvents: canManageEvents(boot.me),
      canApprove: canApprove(boot.me, boot.settings), call, toast, refresh, version, go };
  }, [boot, toast, refresh, version, config]);

  if (parts[0]?.startsWith('reset')) {
    const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
    return <ResetPassword token={token} onDone={() => { location.hash = '#/'; setAuthed(true); refresh(); }} />;
  }
  if (authed === false) return <Login emailEnabled={config.email} onDone={() => { setAuthed(true); refresh(); }} />;
  if (!ctx) return <div className="empty" style={{ paddingTop: 120 }}>Loading…</div>;

  const route = parts[0] || (ctx.isMgr ? 'schedule' : 'my');
  const nav = NAV.filter((n) => (!n.mgr || ctx.isMgr) && (!n.admin || ctx.isAdmin));
  const badges = { swaps: (ctx.canApprove ? ctx.pendingApprovals : 0) + ctx.openOffers, timeoff: 0 };
  const current = NAV.find((n) => n.key === route) || NAV[0];

  const Page = {
    schedule: Schedule, calendar: CalendarPage, my: MyShifts, swaps: Swaps, events: Events,
    forecast: Forecast, team: Team, timeoff: TimeOff, settings: Settings, venue: Venue,
  }[route] || Schedule;

  const signOut = async () => { await logout(); setBoot(null); setAuthed(false); };

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">S</div>
            <div style={{ minWidth: 0 }}><div className="brand-name">ShiftBoard</div><div className="brand-sub">{ctx.settings.restaurantName}</div></div>
          </div>
          {nav.map((n) => (
            <button key={n.key} className={`nav-item ${route === n.key ? 'active' : ''}`} onClick={() => go(n.key)}>
              <Icon name={n.icon} />{n.label}
              {n.badge && badges[n.badge] > 0 && <span className="count">{badges[n.badge]}</span>}
            </button>
          ))}
          <div className="sidebar-foot">
            <div className="row" style={{ padding: '4px 8px 10px' }}>
              <Avatar user={ctx.me} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ctx.me.name}</div>
                <div className="tiny" style={{ color: '#94a3b8' }}>{roleLabel(ctx.me)}</div>
              </div>
            </div>
            {!IS_DEMO && <button className="nav-item" onClick={signOut}><Icon name="logout" />Sign out</button>}
          </div>
        </aside>

        <div className="main">
          {IS_DEMO && <DemoBar onSwitch={refresh} />}
          <header className="topbar">
            <h1 style={{ flex: 1 }}>{current.label}</h1>
            <button className="btn ghost icon" onClick={() => setNotifOpen(true)} aria-label="Notifications" style={{ position: 'relative' }}>
              <Icon name="bell" />
              {ctx.unread > 0 && <span className="count" style={{ position: 'absolute', top: -2, right: -4 }}>{ctx.unread}</span>}
            </button>
            <span className="mobile-only"><Avatar user={ctx.me} size="sm" /></span>
          </header>
          <main className="content">
            <Page parts={parts} />
          </main>
        </div>

        <nav className="bottomnav">
          {[
            { key: ctx.isMgr ? 'schedule' : 'my', label: ctx.isMgr ? 'Schedule' : 'My Shifts', icon: ctx.isMgr ? 'grid' : 'user' },
            { key: ctx.isMgr ? 'my' : 'schedule', label: ctx.isMgr ? 'Mine' : 'Schedule', icon: ctx.isMgr ? 'user' : 'grid' },
            { key: 'swaps', label: 'Swaps', icon: 'swap', badge: badges.swaps },
            { key: 'events', label: 'Events', icon: 'glass' },
          ].map((n) => (
            <button key={n.key} className={route === n.key ? 'active' : ''} onClick={() => go(n.key)}>
              <Icon name={n.icon} />{n.label}
              {n.badge > 0 && <span className="dot" />}
            </button>
          ))}
          <button className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen(true)}><Icon name="more" />More</button>
        </nav>

        {moreOpen && (
          <Modal title="Menu" onClose={() => setMoreOpen(false)}>
            <div className="list" style={{ margin: '-8px -18px' }}>
              {nav.map((n) => (
                <div key={n.key} className="list-item click" onClick={() => { go(n.key); setMoreOpen(false); }}>
                  <Icon name={n.icon} size={20} /><span style={{ fontWeight: 600, flex: 1 }}>{n.label}</span>
                  {n.badge && badges[n.badge] > 0 && <span className="count">{badges[n.badge]}</span>}
                </div>
              ))}
              {!IS_DEMO && <div className="list-item click" onClick={signOut}><Icon name="logout" size={20} /><span style={{ fontWeight: 600 }}>Sign out</span></div>}
            </div>
          </Modal>
        )}
        {notifOpen && <Notifications onClose={() => { setNotifOpen(false); refresh(); }} />}
        {toasts}
      </div>
    </Ctx.Provider>
  );
}

function DemoBar({ onSwitch }) {
  const [cur, setCur] = useState(demoCurrent());
  const personas = useMemo(() => demoPersonas(), []);
  return (
    <div className="demo-bar no-print">
      <strong>Live demo</strong>
      <span className="desktop-only" style={{ opacity: .85 }}>Clock set to {prettyDate('2026-09-27')} · the 9/28 schedule is the real one; sales, pay rates &amp; BEO menus are sample data.</span>
      <span className="spacer" />
      <label className="row" style={{ gap: 6 }}><span className="desktop-only">View as</span><span className="mobile-only">Viewing as</span>
        <select value={cur} onChange={(e) => { demoSwitch(e.target.value); setCur(e.target.value); onSwitch(); location.hash = '#/'; }}>
          {personas.map((p) => <option key={p.id} value={p.id}>{p.name} ({roleLabel(p.role)})</option>)}
        </select>
      </label>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
