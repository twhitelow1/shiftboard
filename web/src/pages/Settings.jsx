import React, { useEffect, useRef, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { DOW_LONG, DOW_SHORT } from '../../../core/time.js';
import { IS_DEMO, sendTestEmail } from '../api.js';
import { scheduleAreas, uniqueAreas, bannerColor, textOn, sameArea } from '../../../core/areas.js';
import { applyBranding, logoUrl, imageToPng, THEMES } from '../theme.js';

export default function Settings() {
  const { settings, call, emailEnabled, emailFrom, jobCodes } = useApp();
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

  // Branding saves on its own (BrandingCard), so this Save never overwrites the colors.
  const save = () => run(() => call('settings.update', { ...s, brandColor: undefined, navColor: undefined, bgColor: undefined, appearance: undefined, weekStartDow: Number(s.weekStartDow), dayparts: s.dayparts.map((d) => ({ ...d, share: Number(d.share) })) }), 'Settings saved');

  return (
    <div style={{ maxWidth: 820 }} className="col">
      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>Restaurant</h2>
        <div className="grid2">
          <Field label="Name"><input className="input" value={s.restaurantName} onChange={set('restaurantName')} /></Field>
          <Field label="Week starts on">
            <select className="input" value={s.weekStartDow} onChange={set('weekStartDow')}>{[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DOW_LONG[d]}</option>)}</select>
          </Field>
        </div>
        <Field label="Hours & closed days" help="Close time is used to estimate “until close” shifts for labor cost.">
          <div className="col" style={{ gap: 6 }}>
            {order.map((d) => (
              <div key={d} className="row">
                <span style={{ width: 44, fontWeight: 700 }}>{DOW_SHORT[d]}</span>
                <label className="check small" style={{ width: 90 }}><input type="checkbox" checked={s.closedDays.includes(d)} onChange={() => toggleClosed(d)} />Closed</label>
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

      <BrandingCard />

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>Scheduling rules</h2>
        <div className="grid3">
          <Field label="Overtime after (hrs/week)"><input className="input" type="number" value={s.overtimeHours} onChange={set('overtimeHours')} /></Field>
          <Field label="“Until close” estimate cap (hrs)"><input className="input" type="number" value={s.openEndHours} onChange={set('openEndHours')} /></Field>
          <Field label="Min. notice for swaps (hrs)"><input className="input" type="number" value={s.minSwapNoticeHours} onChange={set('minSwapNoticeHours')} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={s.requireSwapApproval} onChange={set('requireSwapApproval')} />Managers must approve trades & giveaways</label>
        <label className="check"><input type="checkbox" checked={s.requirePickupApproval} onChange={set('requirePickupApproval')} />Managers must approve open-shift pickups</label>
        <label className="check"><input type="checkbox" checked={s.supervisorsCanApprove !== false} onChange={set('supervisorsCanApprove')} />Supervisors can approve trades, pickups and time off (never their own)</label>
        <label className="check"><input type="checkbox" checked={!!s.startTimesOnly} onChange={set('startTimesOnly')} />
          <span>Show start times only: the schedule, My Shifts, trades and notifications show just the in time (4PM), with no end time or “CL”. End times you enter are still used for hours and labor.</span></label>
        <Field label="Shift tags (comma separated)" help="Quick picks when adding a shift — sections, rooms, roles for the night"><input className="input" {...listField('tags')} /></Field>
        <Field label="Rooms / areas for events"><input className="input" {...listField('rooms')} /></Field>
        <Field label="Schedule areas (comma separated, in order)" help="Where people work: rooms, bars, host stands. The schedule groups shifts under these, in this order, like the banners on your sheet. The rooms above are offered too. Importing a schedule adds its banners here."><input className="input" {...listField('areas')} /></Field>
        <Field label="Banner colors" help="The color of each banner on the schedule sheet. Importing a PDF picks these up from it.">
          <div className="row wrap" style={{ gap: 6 }}>
            {uniqueAreas([...jobCodes.filter((j) => !j.archived).map((j) => j.department), ...scheduleAreas(s)]).map((name, i) => {
              const color = bannerColor(s, name, i);
              const setColor = (c) => {
                const rest = Object.fromEntries(Object.entries(s.areaColors || {}).filter(([k]) => !sameArea(k, name)));
                setS({ ...s, areaColors: { ...rest, [name]: c } });
              };
              return (
                <label key={name} className="sheet-swatch" style={{ background: color, color: textOn(color), cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
                  {name}<input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 22, height: 18, padding: 0, border: 0, background: 'none' }} />
                </label>
              );
            })}
          </div>
        </Field>
        <Field label="Departments"><input className="input" {...listField('departments')} /></Field>
      </div>

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>Email</h2>
        {IS_DEMO ? <div className="help">Email is available in the hosted app.</div> : emailEnabled
          ? <div className="alert ok"><Icon name="check" size={16} />Connected to Resend. Emails come from {emailFrom}.</div>
          : <div className="alert warn"><Icon name="alert" size={16} />Not set up yet. Add RESEND_API_KEY and EMAIL_FROM in Vercel (Settings → Environment Variables), then redeploy.</div>}
        <label className="check"><input type="checkbox" checked={s.emailNotifications !== false} onChange={set('emailNotifications')} disabled={!emailEnabled} />Email staff a copy of their notifications: new schedule, shift changes, trades, time off and event updates</label>
        <div className="help">People you add with an email get a link to set their password, and anyone can reset a forgotten password from the sign-in page. Each person can turn notification emails off in My Shifts.</div>
        {emailEnabled && <div><button className="btn sm" disabled={busy} onClick={() => run(() => sendTestEmail(), (r) => `Test email sent to ${r.to}`)}><Icon name="send" />Send me a test email</button></div>}
      </div>

      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>Forecasting</h2>
        <div className="grid3">
          <Field label="Target labor %"><input className="input" type="number" value={s.targetLaborPct} onChange={set('targetLaborPct')} /></Field>
          <Field label="Weeks of history to use"><input className="input" type="number" min="2" max="16" value={s.forecastWeeks} onChange={set('forecastWeeks')} /></Field>
        </div>
        <Field label="Dayparts" help={`Share = portion of daily covers in that daypart (currently totals ${Math.round(shareTotal * 100)}%). Peak = time used to count staff on the floor.`}>
          <div className="col" style={{ gap: 6 }}>
            {s.dayparts.map((d, i) => (
              <div key={i} className="row wrap">
                <input className="input sm" style={{ width: 110 }} value={d.name} onChange={(e) => setDp(i, 'name', e.target.value)} />
                <input className="input sm" type="time" style={{ width: 115 }} value={d.start} onChange={(e) => setDp(i, 'start', e.target.value)} />
                <input className="input sm" type="time" style={{ width: 115 }} value={d.end} onChange={(e) => setDp(i, 'end', e.target.value)} />
                <span className="small faint">peak</span><input className="input sm" type="time" style={{ width: 115 }} value={d.peak} onChange={(e) => setDp(i, 'peak', e.target.value)} />
                <span className="small faint">share</span><input className="input sm" type="number" step="0.05" style={{ width: 80 }} value={d.share} onChange={(e) => setDp(i, 'share', e.target.value)} />
                <button className="btn sm icon ghost" onClick={() => setS({ ...s, dayparts: s.dayparts.filter((_, j) => j !== i) })}><Icon name="x" /></button>
              </div>
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setS({ ...s, dayparts: [...s.dayparts, { name: 'Late night', start: '22:00', end: '01:00', peak: '23:00', share: 0.1 }] })}><Icon name="plus" />Add daypart</button>
          </div>
        </Field>
      </div>

      <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={save}><Icon name="check" />Save settings</button></div>

      {!IS_DEMO && (
        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>My password</h2>
          <div className="row"><input className="input" type="password" placeholder="New password (6+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} style={{ maxWidth: 300 }} autoComplete="new-password" />
            <button className="btn" disabled={busy || pw.length < 6} onClick={() => run(() => call('employees.changePassword', { password: pw }), 'Password changed').then(() => setPw(''))}>Change</button></div>
        </div>
      )}
    </div>
  );
}

const BRAND_PRESETS = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#dc2626', '#db2777', '#9333ea', '#111827'];
const NAV_PRESETS = ['#0f172a', '#111827', '#1e1b4b', '#14532d', '#3f1d0b', '#ffffff'];

/** Logo and colors. Colors preview live and save with their own button; a logo saves as soon as it's picked. */
function BrandingCard() {
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
    const r = await run(() => call('settings.update', { brandColor: color, navColor: nav, bgColor: bg, appearance: mode }), 'Theme saved');
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
      toast('Logo saved');
      if (found && found !== color) setSuggested(found);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setUploading(false);
    }
  };
  const removeLogo = async () => { const r = await run(() => call('branding.removeLogo', {}), 'Logo removed'); if (r) refresh(); };
  const shown = color || '#4f46e5';
  const navShown = nav || '#0f172a';

  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>Branding & theme</h2>
      <div className="small muted" style={{ marginTop: -6 }}>Your logo, colors and light/dark mode across the app, the sign-in page, the browser tab and emails.</div>
      <Field label="Logo" help={IS_DEMO ? 'Logo upload works in the hosted app.' : 'PNG, JPG, SVG or WebP. It’s resized to fit; a square or wide logo on a transparent background looks best.'}>
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <div className="brand-preview" style={{ background: navShown }}>
            {logo ? <img src={logo} alt="Logo" className="brand-logo" style={{ height: 40, maxWidth: 160 }} />
              : <div className="brand-mark" style={{ width: 40, height: 40, background: shown, color: textOn(shown) }}>{(settings.restaurantName || 'S').trim()[0]?.toUpperCase()}</div>}
            <span style={{ color: textOn(navShown) === '#000' ? '#0f172a' : '#fff', fontWeight: 800 }}>{settings.restaurantName}</span>
          </div>
          {!IS_DEMO && (
            <div className="row wrap">
              <label className="btn sm primary"><Icon name="upload" />{uploading ? 'Uploading…' : logo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden disabled={uploading} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {logo && <button type="button" className="btn sm ghost" disabled={busy} onClick={removeLogo}><Icon name="trash" />Remove</button>}
            </div>
          )}
        </div>
      </Field>
      <Field label="Theme" help="Sets the brand color, sidebar and background together. Adjust any of them below.">
        <div className="theme-grid">
          {THEMES.map((t) => {
            const tc = t.color || '#4f46e5', tn = t.nav || '#0f172a', tb = t.bg || '#f4f5f7';
            return (
              <button key={t.id} type="button" className={`theme-tile ${current?.id === t.id ? 'on' : ''}`} onClick={() => pickTheme(t)} aria-label={`${t.label} theme`}>
                <span className="theme-mini" style={{ background: tb }}>
                  <span className="theme-mini-nav" style={{ background: tn }} />
                  <span className="theme-mini-body"><span className="theme-mini-bar" style={{ background: tc }} /><span className="theme-mini-card" /></span>
                </span>
                <span className="theme-name">{t.label}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Mode" help="The default for everyone. Each person can still pick their own in My Shifts.">
        <div className="seg">
          {[['auto', 'Auto (follow the device)'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>)}
        </div>
      </Field>
      <div className="grid2">
        <Field label="Brand color" help="Buttons, links, highlights and the top of emails.">
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={shown} onChange={(e) => setColor(e.target.value)} aria-label="Brand color" />
            {BRAND_PRESETS.map((c) => <button key={c} type="button" className={`swatch-btn ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
            {suggested && <button type="button" className="btn sm" onClick={() => { setColor(suggested); setSuggested(''); }}><span className="swatch-btn" style={{ background: suggested, width: 14, height: 14 }} />Use logo color</button>}
            {color && <button type="button" className="btn sm ghost" onClick={() => setColor('')}>Default</button>}
          </div>
        </Field>
        <Field label="Sidebar color">
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={navShown} onChange={(e) => setNav(e.target.value)} aria-label="Sidebar color" />
            {NAV_PRESETS.map((c) => <button key={c} type="button" className={`swatch-btn ${nav === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setNav(c)} aria-label={c} />)}
            {nav && <button type="button" className="btn sm ghost" onClick={() => setNav('')}>Default</button>}
          </div>
        </Field>
        <Field label="Background color" help="The page behind the cards, in light mode.">
          <div className="row wrap" style={{ gap: 6 }}>
            <input type="color" className="color-input" value={bg || '#f4f5f7'} onChange={(e) => setBg(e.target.value)} aria-label="Background color" />
            {['#f4f5f7', '#ffffff', '#f8fafc', '#faf7f2', '#f2f7f3', '#eff6f8', '#f7f3fa'].map((c) => <button key={c} type="button" className={`swatch-btn ${bg === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setBg(c)} aria-label={c} />)}
            {bg && <button type="button" className="btn sm ghost" onClick={() => setBg('')}>Default</button>}
          </div>
        </Field>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn primary" disabled={!changed || busy} onClick={saveColors}><Icon name="check" />Save theme</button>
        {changed && <button type="button" className="btn ghost" onClick={() => { setColor(settings.brandColor || ''); setNav(settings.navColor || ''); setBg(settings.bgColor || ''); setMode(settings.appearance || 'auto'); }}>Undo</button>}
        {changed && <span className="small muted">Previewing: the whole app shows these colors until you save or leave this page.</span>}
      </div>
    </div>
  );
}
