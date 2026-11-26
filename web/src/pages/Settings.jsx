import React, { useEffect, useRef, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { IS_DEMO, sendTestEmail } from '../api.js';
import { textOn } from '../../../core/areas.js';
import { applyBranding, logoUrl, imageToPng, THEMES } from '../theme.js';
import TipPoolSettings from './TipPoolSettings.jsx';
import { TextSettingsCard } from './PhoneCards.jsx';
import { IntegrationsCard } from './IntegrationsSettings.jsx'; // ADP, Toast, Tripleseat, the text sender, the email From
import { TrainingSettingsCard } from './TrainingShared.jsx';
import EightySixSettings from './EightySixSettings.jsx';
import RoomsPositions from './RoomsPositions.jsx';
import SeasonsCard from './SeasonsSettings.jsx'; // the seasons reports count by
import { AnnouncementSettingsCard } from './Announcements.jsx'; // texts per person per day, quiet hours
import RolesEditor, { RolesCard } from './RolesEditor.jsx'; // Settings → Roles & features
import { tx, useT, dowLong, dowShort , LANGUAGE_NAMES } from '../i18n/index.js';

export default function Settings({ parts = [] }) {
  const t = useT();
  const { settings, call, emailEnabled, emailFrom, has, managed, isAdmin, isMgr } = useApp();
  const [s, setS] = useState(() => JSON.parse(JSON.stringify(settings)));
  const [run, busy] = useAction();
  const [pw, setPw] = useState('');
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + Number(s.weekStartDow)) % 7);
  const toggleClosed = (d) => setS({ ...s, closedDays: s.closedDays.includes(d) ? s.closedDays.filter((x) => x !== d) : [...s.closedDays, d] });
  const setHours = (d, k, v) => setS({ ...s, hours: { ...s.hours, [d]: { ...(s.hours[d] || {}), [k]: v } } });
  const listField = (k) => ({ value: (s[k] || []).join(', '), onChange: (e) => setS({ ...s, [k]: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }) });
  const setDp = (i, k, v) => setS({ ...s, dayparts: s.dayparts.map((d, j) => (j === i ? { ...d, [k]: v } : d)) });
  const shareTotal = s.dayparts.reduce((t, d) => t + Number(d.share || 0), 0);

  // Branding saves on its own (BrandingCard), and so do the rooms and their colors (Rooms & positions),
  // so this Save never overwrites them.
  const save = () => run(() => call('settings.update', { ...s, brandColor: undefined, navColor: undefined, bgColor: undefined, appearance: undefined, areas: undefined, areaColors: undefined, sectionOrder: undefined, supervisorsCanApprove: undefined,
    weekStartDow: Number(s.weekStartDow), dayparts: s.dayparts.map((d) => ({ ...d, share: Number(d.share) })) }), t('settings.settingsSaved'));
  // #/settings/rooms[/<room>]: open Rooms & positions (at that room).
  const rooms = parts[1] === 'rooms' ? <RoomsPositions key={parts[2] || ''} focus={decodeURIComponent(parts[2] || '')} /> : <RoomsPositions />;

  const passwordCard = !IS_DEMO && (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('settings.myPassword')}</h2>
      <div className="row wrap"><input className="input" type="password" placeholder={t('settings.newPassword6Characters')} value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 300 }} autoComplete="new-password" />
        <button className="btn" disabled={busy || pw.length < 10} onClick={() => run(() => call('employees.changePassword', { password: pw }), t('settings.passwordChanged')).then(() => setPw(''))}>{t('settings.change')}</button></div>
    </div>
  );
  // Managers run the schedule's rooms and positions; the rest of Settings is for admins.
  if (!isAdmin) return <div style={{ maxWidth: 820 }} className="col">{isMgr && rooms}{passwordCard}</div>;
  if (parts[1] === 'roles') return <RolesEditor />; // #/settings/roles (it saves on its own, like Rooms & positions)

  return (
    <div style={{ maxWidth: 820 }} className="col">
      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('common.restaurant')}</h2>
        <div className="grid2">
          <Field label={t('common.name')}><input className="input" value={s.restaurantName} onChange={set('restaurantName')} /></Field>
          <Field label={t('settings.weekStartsOn')}>
            <select className="input" value={s.weekStartDow} onChange={set('weekStartDow')}>{[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{dowLong(d)}</option>)}</select>
          </Field>
          <Field label={t('settings.language')} help={t('settings.languageHelp')}>
            <select className="input" value={s.language === 'en' || s.language === 'es' ? s.language : 'auto'} onChange={set('language')}>
              <option value="auto">{t('settings.languageAuto')}</option>
              <option value="en" lang="en">{LANGUAGE_NAMES.en}</option>
              <option value="es" lang="es">{LANGUAGE_NAMES.es}</option>
            </select>
          </Field>
        </div>
        <Field label={t('settings.hoursClosedDays')} help={t('settings.closeTimeIsUsedTo')}>
          <div className="col" style={{ gap: 6 }}>
            {order.map((d) => (
              <div key={d} className="row hours-row">
                <span style={{ width: 44, fontWeight: 700 }}>{dowShort(d)}</span>
                <label className="check small" style={{ width: 90 }}><input type="checkbox" checked={s.closedDays.includes(d)} onChange={() => toggleClosed(d)} />{t('common.closed')}</label>
                {!s.closedDays.includes(d) && <>
                  <input className="input sm" type="time" style={{ width: 120 }} value={s.hours[d]?.open || ''} onChange={(e) => setHours(d, 'open', e.target.value)} />
                  <span className="faint">–</span>
                  <input className="input sm" type="time" style={{ width: 120 }} value={s.hours[d]?.close || ''} onChange={(e) => setHours(d, 'close', e.target.value)} />
                </>}
              </div>
            ))}
          </div>
        </Field>
      </div>

      {rooms}

      <RolesCard />

      <BrandingCard />

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('settings.schedulingRules')}</h2>
        <div className="grid3">
          <Field label={t('settings.overtimeAfterHrsWeek')}><input className="input" type="number" value={s.overtimeHours} onChange={set('overtimeHours')} /></Field>
          <Field label={t('settings.untilCloseEstimateCapHrs')}><input className="input" type="number" value={s.openEndHours} onChange={set('openEndHours')} /></Field>
          <Field label={t('settings.minNoticeForSwapsHrs')}><input className="input" type="number" value={s.minSwapNoticeHours} onChange={set('minSwapNoticeHours')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={s.requireSwapApproval} onChange={set('requireSwapApproval')} />{t('settings.managersMustApproveTradesGiveaways')}</label>
        <label className="check"><input type="checkbox" checked={s.requirePickupApproval} onChange={set('requirePickupApproval')} />{t('settings.managersMustApproveOpenShift')}</label>
        <a className="help" href="#/settings/roles">{t('roles.approveMoved')}</a>
        <label className="check"><input type="checkbox" checked={!!s.startTimesOnly} onChange={set('startTimesOnly')} />
          <span>{t('settings.showStartTimesOnlyThe')}</span></label>
        <Field label={t('settings.shiftTagsCommaSeparated')} help={t('settings.quickPicksWhenAddingA')}><input className="input" {...listField('tags')} /></Field>
        <Field label={t('settings.roomsAreasForEvents')}><input className="input" {...listField('rooms')} /></Field>
        <Field label={t('settings.departments')}><input className="input" {...listField('departments')} /></Field>
      </div>

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('common.email')}</h2>
        {IS_DEMO ? <div className="help">{t('settings.emailIsAvailableInThe')}</div> : emailEnabled
          ? <div className="alert ok"><Icon name="check" size={16} />{t('settings.connectedToResendEmailsCome', { emailFrom })}</div>
          : <div className="alert warn"><Icon name="alert" size={16} />{managed ? t('platform.askDublowEmail') : t('settings.notSetUpYetAdd')}</div>}
        <label className="check"><input type="checkbox" checked={s.emailNotifications !== false} onChange={set('emailNotifications')} disabled={!emailEnabled} />{t('settings.emailStaffACopyOf')}</label>
        <div className="help">{t('settings.peopleYouAddWithAn')}</div>
        {emailEnabled && <div><button className="btn sm" disabled={busy} onClick={() => run(() => sendTestEmail(), (r) => t('settings.testEmailSentToTo', { to: r.to }))}><Icon name="send" />{t('settings.sendMeATestEmail')}</button></div>}
      </div>

      <TextSettingsCard />
      <AnnouncementSettingsCard />
      <SeasonsCard />
      <IntegrationsCard />

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('settings.forecasting')}</h2>
        <div className="grid3">
          <Field label={t('settings.targetLabor')}><input className="input" type="number" value={s.targetLaborPct} onChange={set('targetLaborPct')} /></Field>
          <Field label={t('settings.weeksOfHistoryToUse')}><input className="input" type="number" min="2" max="16" value={s.forecastWeeks} onChange={set('forecastWeeks')} /></Field>
        </div>
        <Field label={t('settings.dayparts')} help={t('settings.sharePortionOfDailyCovers', { round: Math.round(shareTotal * 100) })}>
          <div className="col" style={{ gap: 6 }}>
            {s.dayparts.map((d, i) => (
              <div key={i} className="row wrap">
                <input className="input sm" style={{ width: 110 }} value={d.name} onChange={(e) => setDp(i, 'name', e.target.value)} />
                <input className="input sm" type="time" style={{ width: 115 }} value={d.start} onChange={(e) => setDp(i, 'start', e.target.value)} />
                <input className="input sm" type="time" style={{ width: 115 }} value={d.end} onChange={(e) => setDp(i, 'end', e.target.value)} />
                <span className="small faint">{t('settings.peak')}</span><input className="input sm" type="time" style={{ width: 115 }} value={d.peak} onChange={(e) => setDp(i, 'peak', e.target.value)} />
                <span className="small faint">{t('settings.share')}</span><input className="input sm" type="number" step="0.05" style={{ width: 80 }} value={d.share} onChange={(e) => setDp(i, 'share', e.target.value)} />
                <button className="btn sm icon ghost" onClick={() => setS({ ...s, dayparts: s.dayparts.filter((_, j) => j !== i) })}><Icon name="x" /></button>
              </div>
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setS({ ...s, dayparts: [...s.dayparts, { name: 'Late night', start: '22:00', end: '01:00', peak: '23:00', share: 0.1 }] })}><Icon name="plus" />{t('settings.addDaypart')}</button>
          </div>
        </Field>
      </div>

      <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />{t('settings.saveSettings')}</button></div>

      {has('tips') && <TipPoolSettings />}
      {has('training') && <TrainingSettingsCard />}
      {has('eightySix') && <EightySixSettings />}

      {passwordCard}
    </div>
  );
}

const BRAND_PRESETS = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#dc2626', '#db2777', '#9333ea', '#111827'];
const NAV_PRESETS = ['#0f172a', '#111827', '#1e1b4b', '#14532d', '#3f1d0b', '#ffffff'];

/** Logo and colors. Colors preview live and save with their own button; a logo saves as soon as it's picked. */
function BrandingCard() {
  const t = useT();
  const { settings, call, refresh, toast, me } = useApp();
  const [color, setColor] = useState(settings.brandColor || '');
  const [nav, setNav] = useState(settings.navColor || '');
  const [bg, setBg] = useState(settings.bgColor || '');
  const [mode, setMode] = useState(settings.appearance || 'auto');
  const [suggested, setSuggested] = useState('');
  const [run, busy] = useAction();
  const [uploading, setUploading] = useState(false);
  const saved = useRef(settings);
  saved.current = settings;
  const logo = logoUrl(settings, IS_DEMO);

  // Preview while picking; put the saved look back when leaving the page.
  useEffect(() => { applyBranding({ color, nav, bg, mode, logo }); }, [color, nav, bg, mode, logo]);
  useEffect(() => () => {
    const st = saved.current;
    applyBranding({ color: st.brandColor, nav: st.navColor, bg: st.bgColor, mode: me?.appearance || st.appearance, logo: logoUrl(st, IS_DEMO) });
  }, []);

  const changed = color !== (settings.brandColor || '') || nav !== (settings.navColor || '') || bg !== (settings.bgColor || '') || mode !== (settings.appearance || 'auto');
  const saveColors = async () => {
    const r = await run(() => call('settings.update', { brandColor: color, navColor: nav, bgColor: bg, appearance: mode }), t('settings.themeSaved'));
    if (r) refresh();
  };
  const pickTheme = (t) => { setColor(t.color); setNav(t.nav); setBg(t.bg); };
  const current = THEMES.find((t) => t.color === color && t.nav === nav && t.bg === bg);
  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { dataUrl, color: found } = await imageToPng(file);
      await call('branding.setLogo', { dataUrl });
      toast(t('settings.logoSaved'));
      if (found && found !== color) setSuggested(found);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setUploading(false);
    }
  };
  const removeLogo = async () => { const r = await run(() => call('branding.removeLogo', {}), t('settings.logoRemoved')); if (r) refresh(); };
  const shown = color || '#4f46e5';
  const navShown = nav || '#0f172a';

  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('settings.brandingTheme')}</h2>
      <div className="small muted" style={{ marginTop: -6 }}>{t('settings.yourLogoColorsAndLight')}</div>
      <Field label={t('settings.logo')} help={IS_DEMO ? t('settings.logoUploadWorksInThe') : t('settings.pngJpgSvgOrWebp')}>
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <div className="brand-preview" style={{ background: navShown }}>
            {logo ? <img src={logo} alt={t('settings.logo')} className="brand-logo" style={{ height: 40, maxWidth: 160 }} />
              : <div className="brand-mark" style={{ width: 40, height: 40, background: shown, color: textOn(shown) }}>{(settings.restaurantName || 'S').trim()[0]?.toUpperCase()}</div>}
            <span style={{ color: textOn(navShown) === '#000' ? '#0f172a' : '#fff', fontWeight: 800 }}>{settings.restaurantName}</span>
          </div>
          {!IS_DEMO && (
            <div className="row wrap">
              <label className="btn sm primary"><Icon name="upload" />{uploading ? t('settings.uploading') : logo ? t('settings.replaceLogo') : t('settings.uploadLogo')}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={uploading} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {logo && <button type="button" className="btn sm ghost" disabled={busy} onClick={removeLogo}><Icon name="trash" />{t('common.remove')}</button>}
            </div>
          )}
        </div>
      </Field>
      <Field label={t('settings.theme')} help={t('settings.setsTheBrandColorSidebar')}>
        <div className="theme-grid">
          {THEMES.map((t) => {
            const tc = t.color || '#4f46e5', tn = t.nav || '#0f172a', tb = t.bg || '#f4f5f7';
            return (
              <button key={t.id} type="button" className={`theme-tile ${current?.id === t.id ? 'on' : ''}`} onClick={() => pickTheme(t)} aria-label={tx('settings.labelTheme', { label: tx(`settings.theme_${t.id}`) })}>
                <span className="theme-mini" style={{ background: tb }}>
                  <span className="theme-mini-nav" style={{ background: tn }} />
                  <span className="theme-mini-body"><span className="theme-mini-bar" style={{ background: tc }} /><span className="theme-mini-card" /></span>
                </span>
                <span className="theme-name">{tx(`settings.theme_${t.id}`)}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label={t('settings.mode')} help={t('settings.theDefaultForEveryoneEach')}>
        <div className="seg">
          {[['auto', t('settings.modeAuto')], ['light', t('myShifts.modeLight')], ['dark', t('myShifts.modeDark')]].map(([k, l]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
        </div>
      </Field>
      <div className="grid2">
        <Field label={t('settings.brandColor')} help={t('settings.buttonsLinksHighlightsAndThe')}>
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={shown} onChange={(e) => setColor(e.target.value)} aria-label={t('settings.brandColor')} />
            {BRAND_PRESETS.map((c) => <button key={c} type="button" className={`swatch-btn ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
            {suggested && <button type="button" className="btn sm" onClick={() => { setColor(suggested); setSuggested(''); }}><span className="swatch-btn" style={{ background: suggested, width: 14, height: 14 }} />{t('settings.useLogoColor')}</button>}
            {color && <button type="button" className="btn sm ghost" onClick={() => setColor('')}>{t('settings.default')}</button>}
          </div>
        </Field>
        <Field label={t('settings.sidebarColor')}>
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={navShown} onChange={(e) => setNav(e.target.value)} aria-label={t('settings.sidebarColor')} />
            {NAV_PRESETS.map((c) => <button key={c} type="button" className={`swatch-btn ${nav === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setNav(c)} aria-label={c} />)}
            {nav && <button type="button" className="btn sm ghost" onClick={() => setNav('')}>{t('settings.default')}</button>}
          </div>
        </Field>
        <Field label={t('settings.backgroundColor')} help={t('settings.thePageBehindTheCards')}>
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={bg || '#f4f5f7'} onChange={(e) => setBg(e.target.value)} aria-label={t('settings.backgroundColor')} />
            {['#f4f5f7', '#ffffff', '#f8fafc', '#faf7f2', '#f2f7f3', '#eff6f8', '#f7f3fa'].map((c) => <button key={c} type="button" className={`swatch-btn ${bg === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setBg(c)} aria-label={c} />)}
            {bg && <button type="button" className="btn sm ghost" onClick={() => setBg('')}>{t('settings.default')}</button>}
          </div>
        </Field>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn primary" disabled={!changed || busy} onClick={saveColors}><Icon name="check" />{t('settings.saveTheme')}</button>
        {changed && <button type="button" className="btn ghost" onClick={() => { setColor(settings.brandColor || ''); setNav(settings.navColor || ''); setBg(settings.bgColor || ''); setMode(settings.appearance || 'auto'); }}>{t('common.undo')}</button>}
        {changed && <span className="small muted">{t('settings.previewingTheWholeAppShows')}</span>}
      </div>
    </div>
  );
}
