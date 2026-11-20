import React, { useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { DOW_LONG, DOW_SHORT } from '../../../core/time.js';
import { IS_DEMO, sendTestEmail } from '../api.js';

export default function Settings() {
  const { settings, call, emailEnabled, emailFrom } = useApp();
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

  const save = () => run(() => call('settings.update', { ...s, weekStartDow: Number(s.weekStartDow), dayparts: s.dayparts.map((d) => ({ ...d, share: Number(d.share) })) }), 'Settings saved');

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
        <Field label="Shift tags (comma separated)" help="Quick picks when adding a shift — sections, rooms, roles for the night"><input className="input" {...listField('tags')} /></Field>
        <Field label="Rooms / areas for events"><input className="input" {...listField('rooms')} /></Field>
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
