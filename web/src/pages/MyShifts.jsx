import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, shiftTime, JobDot, Empty, useAction, startTimesOnly } from '../ui.jsx';
import { canManageUser } from '../../../core/roles.js';
import { addDays, weekStart, parseDate, dow } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import { icalLink, IS_DEMO } from '../api.js';
import ShiftDialog from './ShiftDialog.jsx';
import { PhoneCards } from './PhoneCards.jsx';
import { ShiftSection } from './Sections.jsx';
import { ModCard } from './TrainingShared.jsx';
import { EightySixBanner } from './EightySix.jsx';
import { StockCard } from './Stock.jsx';
import { KudosCard } from './Kudos.jsx';
import { useT, tx, dowShort, fmtTime, prettyDate, LANGUAGE_NAMES } from '../i18n/index.js';
import { STATUS } from './TimeOff.jsx';
import { CONSENT_TEXT } from '../../../core/consent.js';
import { MyAnnouncements } from './Announcements.jsx';
import { MyTradeCounts } from './reports/TradeStats.jsx';

export default function MyShifts() {
  const t = useT();
  const { call, version, today, me, jobs, settings, employees, refresh, toast, has } = useApp();
  const canAsk = has('trades') && has('tradeRequests'); // Roles & features: trading and picking up shifts
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [startIn, setStartIn] = useState(null);
  const open = (s, how = null) => { setStartIn(how); setDialog(s); };
  const [ical, setIcal] = useState(null);
  const end = addDays(today, 35);
  const thisWeek = weekStart(today, settings.weekStartDow);

  // From the start of this week, so the days already worked this week show too.
  const load = () => call('shifts.list', { start: thisWeek < addDays(today, -1) ? thisWeek : addDays(today, -1), end }).then(setData);
  useEffect(() => { load(); }, [version]);

  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const mine = data.shifts.filter((s) => s.userId === me.id && s.date >= thisWeek).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const upcoming = mine.filter((s) => s.date >= today);
  const myJobs = new Set((me.jobCodes || []).map((j) => j.jobCodeId));
  const openShifts = data.shifts.filter((s) => !s.userId && s.date >= today && myJobs.has(s.jobCodeId)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const myTimeOff = data.timeOff.filter((t) => t.userId === me.id && t.endDate >= today);

  const weeks = {};
  for (const s of mine) (weeks[weekStart(s.date, settings.weekStartDow)] ||= []).push(s);
  const nextShift = upcoming[0];

  return (
    <div style={{ maxWidth: 820 }}>
      <ThatsMe data={data} />
      {nextShift && (
        <div className="card card-pad section" style={{ background: 'linear-gradient(135deg, var(--brand), var(--brand-2))', color: '#fff', border: 0 }}>
          <div className="small" style={{ opacity: .85, fontWeight: 600 }}>{nextShift.date === today ? t('common.today') : t('myShifts.nextShift')}</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{prettyDate(nextShift.date)} · {shiftTime(nextShift)}</div>
          <div style={{ opacity: .9 }}>{jobs[nextShift.jobCodeId]?.name}{nextShift.tag ? ` · ${nextShift.tag}` : ''}{nextShift.eventId ? t('myShifts.eventShift') : ''}</div>
          <ShiftSection shift={nextShift} full className="on-brand" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} onClick={() => open(nextShift)}>{nextShift.published ? t('myShifts.tradeOrGiveAway') : t('myShifts.details')}</button>
            {nextShift.eventId && <a className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} href={`#/events/${nextShift.eventId}`}>{t('myShifts.viewBeo')}</a>}
          </div>
        </div>
      )}

      <MyAnnouncements />
      <div className="section"><ModCard compact /></div>
      {has('eightySix') && <EightySixBanner className="section" />}
      {has('stock') && <StockCard className="section" />}
      {has('impact') && <div className="section"><KudosCard /></div>}

      {openShifts.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>{t('myShifts.openShiftsYouCanPick')}</h2><span className="badge ok">{openShifts.length}</span></div>
          <div className="card list">
            {openShifts.slice(0, 8).map((s) => <ShiftRow key={s.id} s={s} onClick={() => open(s)} right={canAsk && <span className="badge ok">{t('myShifts.pickUp')}</span>} />)}
          </div>
        </div>
      )}

      <MyTradeCounts />
      <div className="quick-actions section no-print">
        {has('timeOff') && <a className="btn" href="#/timeoff/new"><Icon name="sun" />{t('myShifts.requestTimeOff')}</a>}
        {canAsk && <a className="btn" href="#/swaps"><Icon name="swap" />{t('myShifts.tradeAShift')}</a>}
        {has('timeOff') && <a className="btn" href="#/timeoff/availability"><Icon name="clock" />{t('myShifts.myAvailability')}</a>}
      </div>

      <div className="section">
        <div className="section-title"><h2>{t('myShifts.myShifts')}</h2></div>
        {!mine.length && <div className="card"><Empty title={t('myShifts.noShiftsYet')}>{t('myShifts.onceYourManagerPublishesThe')}</Empty></div>}
        {Object.entries(weeks).map(([w, list]) => {
          const hrs = list.reduce((t, s) => t + hoursOf(s, settings), 0);
          return (
            <div key={w} style={{ marginBottom: 14 }}>
              <div className="row small muted" style={{ margin: '0 2px 6px', fontWeight: 700 }}>
                <span>{w === thisWeek ? t('myShifts.thisWeek') : w === addDays(thisWeek, 7) ? t('common.nextWeek') : t('myShifts.weekOfDate', { date: prettyDate(w, { dow: false }) })}</span>
                <span className="spacer" /><span className="num">{t('myShifts.listcountShiftsHrsHrs', { listCount: list.length, hrs: hrs.toFixed(1) })}</span>
              </div>
              <div className="card list">
                {list.map((s) => <ShiftRow key={s.id} s={s} past={s.date < today} onClick={() => open(s)}
                  right={s.pending ? <span className="badge warn">{t('myShifts.swapPending')}</span> : !s.published ? <span className="badge" title={t('myShifts.notPostedToStaffYet')}>{t('myShifts.draft')}</span> : s.date < today ? <span className="small faint">{t('common.done')}</span>
                    : canAsk && <button className="btn sm" onClick={(e) => { e.stopPropagation(); open(s); }}><Icon name="swap" />{t('common.trade')}</button>} />)}
              </div>
            </div>
          );
        })}
      </div>

      {myTimeOff.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>{t('myShifts.myTimeOff')}</h2><a className="btn sm ghost" href="#/timeoff">{t('myShifts.seeAll')}</a></div>
          <div className="card list">
            {myTimeOff.map((t) => (
              <div key={t.id} className="list-item"><Icon name="sun" size={18} /><div style={{ flex: 1 }}>{prettyDate(t.startDate)}{t.endDate !== t.startDate ? ` – ${prettyDate(t.endDate)}` : ''}</div><span className={`badge ${t.status === 'approved' ? 'ok' : 'warn'}`}>{STATUS[t.status] ? tx(STATUS[t.status]) : t.status}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="card card-pad section">
        <h3>{t('myShifts.syncToYourPhoneCalendar')}</h3>
        <p className="small muted" style={{ margin: '4px 0 10px' }}>{t('myShifts.subscribeOnceAndYourShifts')}</p>
        {IS_DEMO ? <span className="help">{t('myShifts.availableInTheHostedApp')}</span> : ical
          ? <div className="row"><input className="input sm" readOnly value={ical} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={() => navigator.clipboard?.writeText(ical)}><Icon name="copy" /></button></div>
          : <button className="btn sm" onClick={async () => setIcal(await icalLink())}><Icon name="link" />{t('myShifts.getCalendarLink')}</button>}
      </div>

      <LanguageCard />
      <AppearanceCard />
      {!IS_DEMO && <EmailPrefCard />}
      <PhoneCards />
      <MySettingsCard />

      {dialog && <ShiftDialog shift={dialog} startIn={startIn} events={data.events} onClose={(c) => { setDialog(null); if (c) load(); }} />}
    </div>
  );
}

/**
 * Managers and admins: when someone on the schedule looks like you (TODD, imported, never signed in)
 * but isn't your account, offer to connect them so their shifts show here.
 */
function ThatsMe({ data }) {
  const t = useT();
  const { me, employees, call, refresh, toast } = useApp();
  const [dismissed, setDismissed] = useState(() => { try { return JSON.parse(localStorage.getItem('sb_notme') || '[]'); } catch { return []; } });
  const [sure, setSure] = useState(null);
  const [run, busy] = useAction();
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = (n) => String(n || '').trim().split(/\s+/)[0];
  const mineKeys = new Set([me.sheetName, me.name, first(me.name)].map(key).filter((k) => k.length >= 2));
  const candidates = (employees || []).filter((e) => e.id !== me.id && e.active !== false && !e.email && !e.hasPassword && !dismissed.includes(e.id)
    && canManageUser(me, e) && [e.sheetName, e.name, first(e.name)].some((v) => mineKeys.has(key(v))));
  if (!candidates.length) return null;
  const notMe = (id) => { const next = [...dismissed, id]; setDismissed(next); try { localStorage.setItem('sb_notme', JSON.stringify(next)); } catch { /* ignore */ } };
  const connect = async (c) => {
    const r = await run(() => call('employees.merge', { fromId: c.id, intoId: me.id }), t('myShifts.connectedNameSShiftsAre', { name: c.name }));
    if (r) refresh();
  };
  return candidates.map((c) => {
    const n = data.shifts.filter((s) => s.userId === c.id).length;
    return (
      <div key={c.id} className="alert info section col" style={{ alignItems: 'stretch', gap: 8 }}>
        <div className="row" style={{ gap: 8 }}><Icon name="user" size={16} />
          <span>{n ? t('myShifts.isThisYouShifts', { count: n, value: (c.sheetName || c.name).toUpperCase() }) : t('myShifts.isThisYou', { value: (c.sheetName || c.name).toUpperCase() })}</span></div>
        {sure !== c.id ? (
          <div className="row wrap"><button className="btn sm primary" onClick={() => setSure(c.id)}>{t('myShifts.thatsMeConnect')}</button><button className="btn sm ghost" onClick={() => notMe(c.id)}>{t('myShifts.notMe')}</button></div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            <div className="small">{t('myShifts.areYouSureNameS', { name: c.name })}</div>
            <div className="row wrap"><button className="btn sm danger solid" disabled={busy} onClick={() => connect(c)}>{t('myShifts.connect')}</button><button className="btn sm" onClick={() => setSure(null)}>{t('common.cancel')}</button></div>
          </div>
        )}
      </div>
    );
  });
}

function ShiftRow({ s, onClick, right, past }) {
  const t = useT();
  const { jobs } = useApp();
  const d = parseDate(s.date);
  const j = jobs[s.jobCodeId];
  return (
    <div className={`scard ${past ? 'my-past' : ''}`} onClick={onClick}>
      <div className="date"><div className="m">{dowShort(d.getUTCDay())}</div><div className="d">{d.getUTCDate()}</div></div>
      <div className="body">
        <div className="title num">{shiftTime(s)}{!s.end && !startTimesOnly() && <span className="faint small" style={{ fontWeight: 500 }}>{' '}{t('myShifts.untilClose')}</span>}</div>
        <div className="small muted row" style={{ gap: 6 }}><JobDot job={j} />{j?.name}{s.area ? ` · ${s.area}` : ''}{s.tag ? ` · ${s.tag}` : ''}{s.eventId ? t('myShifts.event') : ''}</div>
        <ShiftSection shift={s} />
      </div>
      {right}
      <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />
    </div>
  );
}

/** My language (the same choice as the switch at the top right), or the restaurant's default. */
function LanguageCard() {
  const t = useT();
  const { me, settings, setLang } = useApp();
  const mine = me.language === 'en' || me.language === 'es' ? me.language : '';
  const fallback = settings.language === 'en' || settings.language === 'es' ? LANGUAGE_NAMES[settings.language] : t('myShifts.modeAuto');
  return (
    <div className="card card-pad section">
      <h3>{t('myShifts.language')}</h3>
      <div className="seg" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {[['', t('myShifts.restaurantDefault', { label: fallback })], ['en', LANGUAGE_NAMES.en], ['es', LANGUAGE_NAMES.es]].map(([k, l]) => (
          <button key={k || 'default'} className={mine === k ? 'on' : ''} lang={k || undefined} onClick={() => mine !== k && setLang(k)}>{l}</button>
        ))}
      </div>
      <div className="help">{t('myShifts.languageHelp')}</div>
    </div>
  );
}

/** Light or dark mode for me only, or the restaurant's default. */
function AppearanceCard() {
  const t = useT();
  const { call, me, settings, refresh } = useApp();
  const [run, busy] = useAction();
  const mine = me.appearance || '';
  const label = { auto: t('myShifts.modeAuto'), light: t('myShifts.modeLight'), dark: t('myShifts.modeDark') }[settings.appearance || 'auto'];
  const pick = async (v) => { const r = await run(() => call('account.preferences', { appearance: v }), t('common.saved')); if (r) refresh(); };
  return (
    <div className="card card-pad section">
      <h3>{t('myShifts.appearance')}</h3>
      <div className="seg" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {[['', t('myShifts.restaurantDefault', { label })], ['auto', t('myShifts.modeAuto')], ['light', t('myShifts.modeLight')], ['dark', t('myShifts.modeDark')]].map(([k, l]) => (
          <button key={k || 'default'} className={mine === k ? 'on' : ''} disabled={busy} onClick={() => pick(k)}>{l}</button>
        ))}
      </div>
      <div className="help">{t('myShifts.autoFollowsYourPhoneOr')}</div>
    </div>
  );
}

/** Notification emails: the person's email consent, with the exact words (core/consent.js), recorded each time. */
function EmailPrefCard() {
  const t = useT();
  const { call, me, emailEnabled } = useApp();
  const [run, busy] = useAction();
  if (!emailEnabled || !me.email) return null;
  const on = me.emailConsent === true;
  return (
    <div className="card card-pad section">
      <h3>{t('myShifts.emailNotifications')}</h3>
      <label className="consent-box" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={on} disabled={busy}
          onChange={(e) => run(() => call('account.preferences', { emailConsent: e.target.checked, lang: t.lang }), e.target.checked ? t('myShifts.emailNotificationsOn') : t('myShifts.emailNotificationsOff'))} />
        <span>{CONSENT_TEXT[t.lang === 'es' ? 'es' : 'en'].email}</span></label>
      <div className="help">{t('consent.emailsGoTo', { email: me.email })}</div>
    </div>
  );
}

/** My settings, with my photo: profile photo, phone, password, two-step sign-in (pages/Security.jsx). */
function MySettingsCard() {
  const t = useT();
  const { me } = useApp();
  return (
    <a className="card card-pad section row my-settings-link" href="#/account">
      <Avatar user={me} size="lg" />
      <span className="grow"><b>{t('security.mySettings')}</b><span className="small muted block">{t('security.mySettingsHelp')}</span></span>
      <Icon name="right" size={16} />
    </a>
  );
}
