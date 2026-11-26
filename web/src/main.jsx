import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { applyBranding, logoUrl } from './theme.js';
import { call, logout, IS_DEMO, demoPersonas, demoSwitch, demoCurrent, getConfig, billingPortal } from './api.js';
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
import EightySix from './pages/EightySix.jsx';
import Reports from './pages/Reports.jsx';
import Account from './pages/Security.jsx';
import Announcements from './pages/Announcements.jsx';
import TradeStats from './pages/reports/TradeStats.jsx';
import { SignIn, ResetPassword, LinkSignIn } from './pages/SignIn.jsx';
import { Welcome, ConsentGate } from './pages/Onboarding.jsx';
import { AuthCard, SignInBrand, BrandMark, DEFAULT_NAME } from './pages/AuthCard.jsx';
import { t as tr, useT, I18nCtx, setCurrentLang, resolveLang, saveDeviceLang, deviceLang, unsavedDeviceLang, clearUnsaved, isLang, prettyDate, stamp, fmtTime } from './i18n/index.js';
import LanguageSwitch from './LanguageSwitch.jsx';
export { BrandMark }; // the sign-in card lives in pages/AuthCard.jsx now

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

// feature: the plan feature a page needs (server/platform/plans.js); pages without one are in every plan.
const NAV = [
  { key: 'schedule', label: 'main.schedule', icon: 'grid' },
  { key: 'calendar', label: 'main.calendar', icon: 'calendar' },
  { key: 'my', label: 'main.myShifts', icon: 'user' },
  { key: '86', label: 'main.eightySix', icon: 'ban', feature: 'eightySix' },
  { key: 'swaps', label: 'main.swapsTrades', short: 'main.swaps', icon: 'swap', badge: 'swaps' },
  { key: 'announcements', label: 'announcements.title', icon: 'megaphone', feature: 'announcements' },
  { key: 'trade-stats', label: 'tradeStats.title', icon: 'chart', mgr: true, hide: true }, // linked from Team and Swaps
  { key: 'events', label: 'main.eventsBeos', short: 'common.events', icon: 'glass', feature: 'events' },
  { key: 'timeoff', label: 'main.timeOff', icon: 'sun', badge: 'timeoff' },
  { key: 'tips', label: 'main.tips', icon: 'dollar', feature: 'tips' },
  { key: 'training', label: 'main.training', icon: 'book', feature: 'training' },
  { key: 'forecast', label: 'main.forecastLabor', icon: 'chart', mgr: true, feature: 'forecast' },
  { key: 'reports', label: 'reports.nav', icon: 'report', mgr: true, feature: 'reports' }, // managers and up (core/reports.js)
  { key: 'venue', label: 'main.venueFloorPlans', short: 'main.venue', icon: 'map', mgr: true, feature: 'venue' },
  { key: 'team', label: 'main.teamJobCodes', icon: 'users', mgr: true },
  // Managers get Settings for Rooms & positions (the schedule's layout); the rest of it is admins'.
  { key: 'settings', label: 'main.settings', icon: 'settings', mgr: true },
  { key: 'account', label: 'security.mySettings', icon: 'lock' }, // My settings: profile, Sign-in & security
];

// Shorter page titles for the phone's top bar, where the language switch and the bell sit too.
const PHONE_TITLE = { swaps: 'main.phoneTitleSwaps', events: 'main.phoneTitleEvents', forecast: 'main.phoneTitleForecast', venue: 'main.phoneTitleVenue', team: 'main.phoneTitleTeam', 'trade-stats': 'tradeStats.phoneTitle' };

// The address has no restaurant, or the restaurant's account is paused (server/platform/). Signed out or in.
function NoticeCard({ title, help, icon = 'alert' }) {
  return (
    <AuthCard onSubmit={(e) => e.preventDefault()}>
      <div className="alert warn"><Icon name={icon} size={16} /><b>{title}</b></div>
      {help && <div className="small muted">{help}</div>}
    </AuthCard>
  );
}

/**
 * Banners on the platform: support mode (DubLow staff signed in as the owner, for everyone to see), and for the
 * restaurant's admins only, the free trial ending or a failed payment. The button opens billing (phase 2: Stripe).
 */
function TenantBanners({ onEndSupport }) {
  const t = useT();
  const { tenant, me, toast } = React.useContext(Ctx);
  const [hidden, setHidden] = useState(false);
  if (!tenant) return null;
  const support = tenant.support;
  const billing = !hidden && tenant.billing;
  const openBilling = async () => {
    try {
      const r = await billingPortal();
      if (r?.url) location.href = r.url;
      else toast(t('platform.billingByDublow'));
    } catch (e) { toast(e.message, 'bad'); }
  };
  const until = support ? (() => { const d = new Date(support.until); return fmtTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`); })() : '';
  return (
    <>
      {support && (
        <div className="tenant-banner support no-print" role="status">
          <Icon name="alert" size={16} />
          <span className="tenant-banner-text">{t('platform.supportBanner', { by: support.by, name: me.name, time: until })}</span>
          <button className="btn sm" onClick={onEndSupport}>{t('platform.endSupport')}</button>
        </div>
      )}
      {billing && (
        <div className={`tenant-banner ${billing.kind === 'pastDue' ? 'bad' : 'info'} no-print`} role="status">
          <Icon name={billing.kind === 'pastDue' ? 'alert' : 'clock'} size={16} />
          <span className="tenant-banner-text">{billing.kind === 'pastDue' ? t('platform.paymentFailed')
            : billing.daysLeft > 0 ? t('platform.trialEndsIn', { count: billing.daysLeft }) : t('platform.trialEndsToday')}</span>
          <button className="btn sm" onClick={openBilling}>{billing.kind === 'pastDue' ? t('platform.updateCard') : t('platform.choosePlan')}</button>
          <button className="btn ghost icon sm" aria-label={t('platform.dismiss')} onClick={() => setHidden(true)}><Icon name="x" /></button>
        </div>
      )}
    </>
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
  // admin.<platform domain> is the platform console, not a restaurant: /api/config says where it lives.
  useEffect(() => { getConfig().then((c) => { if (c?.console) location.replace(c.console); else setConfig(c); }); }, []);
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
    // On the platform the restaurant's plan decides its features; the demo and a single-restaurant install have them all.
    const features = boot.tenant?.features || null;
    const has = (feature) => !features || features[feature] !== false;
    return { ...boot, jobs, people, isMgr, emailEnabled: config.email, emailFrom: config.emailFrom, isAdmin: canChangeSettings(boot.me), isEvents: canManageEvents(boot.me),
      canApprove: canApprove(boot.me, boot.settings), call, toast, refresh, version, go, lang, setLang,
      tenant: boot.tenant || null, has, managed: !!boot.tenant?.managed };
  }, [boot, toast, refresh, version, config, lang, setLang]);

  const notice = config.notFound ? { title: t('platform.notFoundTitle'), help: t('platform.notFoundHelp') }
    : config.paused ? { title: t('platform.pausedTitle'), help: t('platform.pausedHelp') } : null;
  if (notice) return <I18nCtx.Provider value={i18n}><SignInBrand.Provider value={config.brand}><NoticeCard {...notice} /></SignInBrand.Provider></I18nCtx.Provider>;

  // Links from emails: an invitation (the welcome wizard), a password reset, a sign-in link. The demo can preview
  // the wizard and the consent screen (#/welcome?preview=1) without any server.
  const hashParams = new URLSearchParams(location.hash.split('?')[1] || '');
  const signedOut = (node) => <I18nCtx.Provider value={i18n}><SignInBrand.Provider value={config.brand}>{node}</SignInBrand.Provider></I18nCtx.Provider>;
  const signedInNow = (to = '#/') => { location.hash = to; setAuthed(true); refresh(); };
  if (parts[0]?.startsWith('welcome')) {
    const preview = hashParams.get('preview') === '1';
    if (preview && !IS_DEMO) { location.hash = '#/'; return null; }
    return signedOut(<Welcome token={hashParams.get('token') || ''} preview={preview} startAt={hashParams.get('step') || ''} onDone={() => signedInNow('#/my')} />);
  }
  if (parts[0]?.startsWith('reset')) return signedOut(<ResetPassword token={hashParams.get('token') || ''} onDone={() => signedInNow()} />);
  if (parts[0]?.startsWith('link')) return signedOut(<LinkSignIn token={hashParams.get('token') || ''} onDone={() => signedInNow()} />);
  if (authed === false) return signedOut(<SignIn emailEnabled={config.email} onDone={() => { setAuthed(true); refresh(); }} />);
  if (!ctx) return <div className="empty" style={{ paddingTop: 120 }}>{t('common.loading')}</div>;
  // Signed in without having agreed to the terms (people from before consent records): the consent screen, once.
  // Not in the demo, and not while DubLow Digital is signed in for support (only the person can agree).
  if (ctx.me.needsTerms && !IS_DEMO && !ctx.tenant?.support) {
    const sms = !!config.sms && ctx.has('sms') && ctx.settings.smsNotifications !== false;
    return signedOut(<ConsentGate me={ctx.me} sms={sms} legal={config.legal} call={call} onDone={refresh} onSignOut={async () => { await logout(); setBoot(null); setAuthed(false); }} />);
  }

  const home = ctx.isMgr ? 'schedule' : 'my';
  const offPlan = (key) => NAV.some((n) => n.key === key && n.feature && !ctx.has(n.feature));
  // The phone app sends people who still need a second step to #/security-setup: My settings → Sign-in & security.
  const asked = parts[0] === 'security-setup' ? 'account' : parts[0];
  const route = asked && !offPlan(asked) ? asked : home;
  const nav = NAV.filter((n) => (!n.mgr || ctx.isMgr) && (!n.admin || ctx.isAdmin) && (!n.feature || ctx.has(n.feature)) && !n.hide);
  const badges = { swaps: (ctx.canApprove ? ctx.pendingApprovals : 0) + ctx.openOffers, timeoff: 0 };
  const current = NAV.find((n) => n.key === route) || NAV[0];

  const Page = {
    schedule: Schedule, calendar: CalendarPage, my: MyShifts, swaps: Swaps, events: Events, tips: Tips,
    forecast: Forecast, team: Team, timeoff: TimeOff, settings: Settings, venue: Venue, training: Training, 86: EightySix, reports: Reports,
    account: Account, announcements: Announcements, 'trade-stats': TradeStats,
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
            <div className="row" style={{ padding: '4px 8px 10px', cursor: 'pointer' }} onClick={() => go('account')} title={t('security.mySettings')}>
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
          <TenantBanners onEndSupport={signOut} />
          <header className="topbar">
            <span className="mobile-only topbar-logo"><BrandMark name={ctx.settings.restaurantName} logo={logoUrl(ctx.settings, IS_DEMO)} size={28} /></span>
            <h1 className="topbar-title"><span className="desktop-only">{t(current.label)}</span><span className="mobile-only">{t(PHONE_TITLE[current.key] || current.label)}</span></h1>
            <LanguageSwitch />
            <button className="btn ghost icon topbar-bell" onClick={() => setNotifOpen(true)} aria-label={t('main.notifications')} style={{ position: 'relative' }}>
              <Icon name="bell" />
              {ctx.unread > 0 && <span className="count" style={{ position: 'absolute', top: -2, right: -4 }}>{ctx.unread}</span>}
            </button>
            <a className="mobile-only topbar-avatar" href="#/account" aria-label={t('security.mySettings')}><Avatar user={ctx.me} size="sm" /></a>
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
            ctx.isMgr && ctx.has('events') ? { key: 'events', label: t('common.events'), icon: 'glass' } : { key: 'timeoff', label: t('main.timeOff'), icon: 'sun' },
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
