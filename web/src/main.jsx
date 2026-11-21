import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { applyBranding, logoUrl } from './theme.js';
import { call, login, logout, IS_DEMO, demoPersonas, demoSwitch, demoCurrent, getConfig, forgotPassword, resetPassword } from './api.js';
import { Ctx, Icon, Avatar, useToasts, Modal, setStartTimesOnly } from './ui.jsx';
import { canManageSchedule, canChangeSettings, canManageEvents, canApprove, roleLabel } from '../../core/roles.js';
import Schedule from './pages/Schedule.jsx';
import CalendarPage from './pages/Calendar.jsx';
import MyShifts from './pages/MyShifts.jsx';
import Swaps from './pages/Swaps.jsx';
import Events from './pages/Events.jsx';
import Forecast from './pages/Forecast.jsx';
import Tips from './pages/Tips.jsx';
import Team from './pages/Team.jsx';
import TimeOff from './pages/TimeOff.jsx';
import Settings from './pages/Settings.jsx';
import Venue from './pages/Venue.jsx';
import Training from './pages/Training.jsx';
import { t as tr, useT, I18nCtx, setCurrentLang, resolveLang, saveDeviceLang, deviceLang, unsavedDeviceLang, clearUnsaved, isLang, prettyDate, stamp } from './i18n/index.js';
import LanguageSwitch from './LanguageSwitch.jsx';

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
  { key: 'schedule', label: 'main.schedule', icon: 'grid' },
  { key: 'calendar', label: 'main.calendar', icon: 'calendar' },
  { key: 'my', label: 'main.myShifts', icon: 'user' },
  { key: 'swaps', label: 'main.swapsTrades', short: 'main.swaps', icon: 'swap', badge: 'swaps' },
  { key: 'events', label: 'main.eventsBeos', short: 'common.events', icon: 'glass' },
  { key: 'timeoff', label: 'main.timeOff', icon: 'sun', badge: 'timeoff' },
  { key: 'tips', label: 'main.tips', icon: 'dollar' },
  { key: 'training', label: 'main.training', icon: 'book' },
  { key: 'forecast', label: 'main.forecastLabor', icon: 'chart', mgr: true },
  { key: 'venue', label: 'main.venueFloorPlans', short: 'main.venue', icon: 'map', mgr: true },
  { key: 'team', label: 'main.teamJobCodes', icon: 'users', mgr: true },
  { key: 'settings', label: 'main.settings', icon: 'settings', admin: true },
];

// Shorter page titles for the phone's top bar, where the language switch and the bell sit too.
const PHONE_TITLE = { swaps: 'main.phoneTitleSwaps', events: 'main.phoneTitleEvents', forecast: 'main.phoneTitleForecast', venue: 'main.phoneTitleVenue', team: 'main.phoneTitleTeam' };

// The restaurant's name and logo for the sign-in screens (from /api/config, before anyone signs in).
const SignInBrand = React.createContext(null);

/** The restaurant's logo, or the first letter of its name in its color. */
export function BrandMark({ name, logo, size = 32 }) {
  if (logo) return <img className="brand-logo" src={logo} alt="" style={{ height: size, maxWidth: size * 4 }} />;
  return <div className="brand-mark" style={{ width: size, height: size }}>{(String(name || 'S').trim()[0] || 'S').toUpperCase()}</div>;
}
const DEFAULT_NAME = 'Our Restaurant';

function AuthCard({ children, onSubmit }) {
  const t = useT();
  const brand = React.useContext(SignInBrand);
  const named = brand?.name && brand.name !== DEFAULT_NAME;
  return (
    <div className="login">
      <div className="login-lang"><LanguageSwitch onDark /></div>
      <form className="card card-pad col" style={{ gap: 14, padding: 26 }} onSubmit={onSubmit}>
        <div className="brand" style={{ color: 'var(--text)', padding: 0 }}>
          <BrandMark name={named ? brand.name : 'S'} logo={brand?.logo} size={40} />
          <div><div className="brand-name">{named ? brand.name : t('main.shiftboard')}</div><div className="small muted">{named ? t('main.scheduleShiftboard') : t('main.restaurantScheduling')}</div></div>
        </div>
        {children}
      </form>
    </div>
  );
}

function Login({ onDone, emailEnabled }) {
  const t = useT();
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
      <div className="alert ok"><Icon name="send" size={16} />{t('main.ifEmailHasAnAccount', { email })}</div>
      <button className="btn block">{t('main.backToSignIn')}</button>
    </AuthCard>
  );
  return (
    <AuthCard onSubmit={submit}>
      {mode === 'forgot' && <div className="small muted">{t('main.enterYourSignInEmail')}</div>}
      <label className="field"><span>{t('common.email')}</span><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
      {mode === 'login' && <label className="field"><span>{t('main.password')}</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{mode === 'forgot' ? (busy ? t('main.sending') : t('main.emailMeAResetLink')) : (busy ? t('main.signingIn') : t('main.signIn'))}</button>
      {emailEnabled
        ? <button type="button" className="btn ghost sm" onClick={() => { setErr(''); setMode(mode === 'login' ? 'forgot' : 'login'); }}>{mode === 'login' ? t('main.forgotYourPassword') : t('main.backToSignIn')}</button>
        : <div className="help">{t('main.forgotYourPasswordAskA')}</div>}
    </AuthCard>
  );
}

// Opened from an email link (#/reset?token=…): set a password for a new account or reset a forgotten one.
function ResetPassword({ token, onDone }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== pw2) return setErr(t('main.theTwoPasswordsDontMatch'));
    setBusy(true); setErr('');
    try { await resetPassword(token, pw); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <AuthCard onSubmit={submit}>
      <div><b>{t('main.chooseYourPassword')}</b><div className="small muted">{t('main.atLeast6CharactersYoull')}</div></div>
      <label className="field"><span>{t('main.newPassword')}</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={6} autoFocus /></label>
      <label className="field"><span>{t('main.repeatIt')}</span><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={6} /></label>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? t('main.saving') : t('main.saveAndSignIn')}</button>
      <a className="btn ghost sm" href="#/">{t('main.backToSignIn')}</a>
    </AuthCard>
  );
}

function Notifications({ onClose }) {
  const t = useT();
  const [items, setItems] = useState(null);
  useEffect(() => {
    call('notifications.list').then((r) => { setItems(r); call('notifications.readAll'); });
  }, []);
  return (
    <>
      <div className="overlay" style={{ background: 'rgba(15,23,42,.25)' }} onClick={onClose} />
      <div className="drawer">
        <div className="modal-head"><h2 style={{ flex: 1 }}>{t('main.notifications')}</h2><button className="btn ghost icon sm" onClick={onClose}><Icon name="x" /></button></div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items?.length === 0 && <div className="empty">{t('main.youreAllCaughtUp')}</div>}
          {items?.map((n) => (
            <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => { if (n.link) location.hash = n.link; onClose(); }}>
              <Icon name="bell" size={16} style={{ marginTop: 2, flex: 'none', color: 'var(--text-3)' }} />
              <div><div>{n.text}</div><div className="tiny faint">{stamp(n.at)}</div></div>
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
  // The restaurant's colors and logo: from its settings once signed in, from /api/config before.
  useEffect(() => {
    const st = boot?.settings;
    if (st) applyBranding({ color: st.brandColor, nav: st.navColor, bg: st.bgColor, mode: boot.me?.appearance || st.appearance, logo: logoUrl(st, IS_DEMO) });
    else if (config.brand) applyBranding(config.brand);
  }, [boot, config]);

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

  // ----- language (web/src/i18n): the person's, the restaurant's, this device's or the browser's -----
  const [, setLangTick] = useState(0);
  const lang = resolveLang(boot ? { me: boot.me, settings: boot.settings } : { configLanguage: config.language });
  setCurrentLang(lang); // before the pages render, for the plain helpers (t, prettyDate…)
  const t = useMemo(() => (key, params) => tr(key, params), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Switch language right away, on the same screen. Signed in, it's saved on the account too ('' = automatic). */
  const setLang = useCallback((l) => {
    if (boot) {
      saveDeviceLang(isLang(l) ? l : null);
      setBoot((b) => (b ? { ...b, me: { ...b.me, language: isLang(l) ? l : '' } } : b));
      // Then reload, so what the server writes (notifications, warnings) comes in the new language too.
      call('account.preferences', { language: isLang(l) ? l : '' }).then(() => refresh(), (e) => toast(e.message, 'bad'));
    } else {
      saveDeviceLang(l, { unsaved: true });
      setLangTick((n) => n + 1);
    }
  }, [boot, refresh, toast]);
  // Signed in: a language picked on the sign-in screen goes to the account; the account's choice is
  // remembered on this device for the next sign-in screen. The demo keeps one language for every persona.
  const meId = boot?.me?.id;
  const meLang = boot?.me?.language || '';
  useEffect(() => {
    if (!meId) return;
    const pending = unsavedDeviceLang();
    clearUnsaved();
    if (pending && pending !== meLang) { setLang(pending); return; }
    if (IS_DEMO && deviceLang() && deviceLang() !== meLang) { setLang(deviceLang()); return; }
    if (isLang(meLang)) saveDeviceLang(meLang);
  }, [meId, meLang]); // eslint-disable-line react-hooks/exhaustive-deps
  const i18n = useMemo(() => ({ lang, setLang, choice: meLang }), [lang, setLang, meLang]);

  const ctx = useMemo(() => {
    if (!boot) return null;
    const jobs = Object.fromEntries(boot.jobCodes.map((j) => [j.id, j]));
    const people = Object.fromEntries(boot.employees.map((e) => [e.id, e]));
    const isMgr = canManageSchedule(boot.me);
    setStartTimesOnly(boot.settings?.startTimesOnly);
    return { ...boot, jobs, people, isMgr, emailEnabled: config.email, emailFrom: config.emailFrom, isAdmin: canChangeSettings(boot.me), isEvents: canManageEvents(boot.me),
      canApprove: canApprove(boot.me, boot.settings), call, toast, refresh, version, go, lang, setLang };
  }, [boot, toast, refresh, version, config, lang, setLang]);

  if (parts[0]?.startsWith('reset')) {
    const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
    return <I18nCtx.Provider value={i18n}><SignInBrand.Provider value={config.brand}><ResetPassword token={token} onDone={() => { location.hash = '#/'; setAuthed(true); refresh(); }} /></SignInBrand.Provider></I18nCtx.Provider>;
  }
  if (authed === false) return <I18nCtx.Provider value={i18n}><SignInBrand.Provider value={config.brand}><Login emailEnabled={config.email} onDone={() => { setAuthed(true); refresh(); }} /></SignInBrand.Provider></I18nCtx.Provider>;
  if (!ctx) return <div className="empty" style={{ paddingTop: 120 }}>{t('common.loading')}</div>;

  const route = parts[0] || (ctx.isMgr ? 'schedule' : 'my');
  const nav = NAV.filter((n) => (!n.mgr || ctx.isMgr) && (!n.admin || ctx.isAdmin));
  const badges = { swaps: (ctx.canApprove ? ctx.pendingApprovals : 0) + ctx.openOffers, timeoff: 0 };
  const current = NAV.find((n) => n.key === route) || NAV[0];

  const Page = {
    schedule: Schedule, calendar: CalendarPage, my: MyShifts, swaps: Swaps, events: Events,
    forecast: Forecast, team: Team, timeoff: TimeOff, settings: Settings, venue: Venue, tips: Tips,
    forecast: Forecast, team: Team, timeoff: TimeOff, settings: Settings, venue: Venue, training: Training,
  }[route] || Schedule;

  const signOut = async () => { await logout(); setBoot(null); setAuthed(false); };

  return (
    <I18nCtx.Provider value={i18n}>
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <BrandMark name={ctx.settings.restaurantName} logo={logoUrl(ctx.settings, IS_DEMO)} />
            {ctx.settings.restaurantName && ctx.settings.restaurantName !== DEFAULT_NAME
              ? <div style={{ minWidth: 0 }}><div className="brand-name">{ctx.settings.restaurantName}</div><div className="brand-sub">{t('main.shiftboard')}</div></div>
              : <div style={{ minWidth: 0 }}><div className="brand-name">{t('main.shiftboard')}</div><div className="brand-sub">{ctx.settings.restaurantName}</div></div>}
          </div>
          {nav.map((n) => (
            <button key={n.key} className={`nav-item ${route === n.key ? 'active' : ''}`} onClick={() => go(n.key)}>
              <Icon name={n.icon} />{t(n.label)}
              {n.badge && badges[n.badge] > 0 && <span className="count">{badges[n.badge]}</span>}
            </button>
          ))}
          <div className="sidebar-foot">
            <div className="row" style={{ padding: '4px 8px 10px' }}>
              <Avatar user={ctx.me} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="sidebar-user" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ctx.me.name}</div>
                <div className="tiny" style={{ color: '#94a3b8' }}>{roleLabel(ctx.me, lang)}</div>
              </div>
            </div>
            {!IS_DEMO && <button className="nav-item" onClick={signOut}><Icon name="logout" />{t('main.signOut')}</button>}
          </div>
        </aside>

        <div className="main">
          {IS_DEMO && <DemoBar onSwitch={refresh} />}
          <header className="topbar">
            <span className="mobile-only topbar-logo"><BrandMark name={ctx.settings.restaurantName} logo={logoUrl(ctx.settings, IS_DEMO)} size={28} /></span>
            <h1 className="topbar-title"><span className="desktop-only">{t(current.label)}</span><span className="mobile-only">{t(PHONE_TITLE[current.key] || current.label)}</span></h1>
            <LanguageSwitch />
            <button className="btn ghost icon topbar-bell" onClick={() => setNotifOpen(true)} aria-label={t('main.notifications')} style={{ position: 'relative' }}>
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
            { key: ctx.isMgr ? 'schedule' : 'my', label: ctx.isMgr ? t('main.schedule') : t('main.myShifts'), icon: ctx.isMgr ? 'grid' : 'user' },
            { key: ctx.isMgr ? 'my' : 'schedule', label: ctx.isMgr ? t('main.mine') : t('main.schedule'), icon: ctx.isMgr ? 'user' : 'grid' },
            { key: 'swaps', label: t('main.swaps'), icon: 'swap', badge: badges.swaps },
            ctx.isMgr ? { key: 'events', label: t('common.events'), icon: 'glass' } : { key: 'timeoff', label: t('main.timeOff'), icon: 'sun' },
          ].map((n) => (
            <button key={n.key} className={route === n.key ? 'active' : ''} onClick={() => go(n.key)}>
              <Icon name={n.icon} />{n.label}
              {n.badge > 0 && <span className="dot" />}
            </button>
          ))}
          <button className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen(true)}><Icon name="more" />{t('main.more')}</button>
        </nav>

        {moreOpen && (
          <Modal title={t('main.menu')} onClose={() => setMoreOpen(false)}>
            <div className="list" style={{ margin: '-8px -18px' }}>
              {nav.map((n) => (
                <div key={n.key} className="list-item click" onClick={() => { go(n.key); setMoreOpen(false); }}>
                  <Icon name={n.icon} size={20} /><span style={{ fontWeight: 600, flex: 1 }}>{t(n.label)}</span>
                  {n.badge && badges[n.badge] > 0 && <span className="count">{badges[n.badge]}</span>}
                </div>
              ))}
              {!IS_DEMO && <div className="list-item click" onClick={signOut}><Icon name="logout" size={20} /><span style={{ fontWeight: 600 }}>{t('main.signOut')}</span></div>}
            </div>
          </Modal>
        )}
        {notifOpen && <Notifications onClose={() => { setNotifOpen(false); refresh(); }} />}
        {toasts}
      </div>
    </Ctx.Provider>
    </I18nCtx.Provider>
  );
}

function DemoBar({ onSwitch }) {
  const t = useT();
  const [cur, setCur] = useState(demoCurrent());
  const personas = useMemo(() => demoPersonas(), []);
  return (
    <div className="demo-bar no-print">
      <strong>{t('main.liveDemo')}</strong>
      <span className="desktop-only" style={{ opacity: .85 }}>{t('main.clockSetToDateThe', { date: prettyDate('2026-09-27') })}</span>
      <span className="spacer" />
      <label className="row" style={{ gap: 6 }}><span className="desktop-only">{t('main.viewAs')}</span><span className="mobile-only">{t('main.viewingAs')}</span>
        <select value={cur} onChange={(e) => { demoSwitch(e.target.value); setCur(e.target.value); onSwitch(); location.hash = '#/'; }}>
          {personas.map((p) => <option key={p.id} value={p.id}>{p.name} ({roleLabel(p.role, t.lang)})</option>)}
        </select>
      </label>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
