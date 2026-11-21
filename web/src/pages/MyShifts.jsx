import React, { useEffect, useState } from 'react';
import { useApp, Icon, shiftTime, JobDot, Empty, useAction, startTimesOnly } from '../ui.jsx';
import { canManageUser } from '../../../core/roles.js';
import { addDays, weekStart, parseDate, MONTHS, DOW_SHORT, dow, prettyDate, fmtTime } from '../../../core/time.js';
import { hoursOf } from '../../../core/forecast.js';
import { icalLink, IS_DEMO } from '../api.js';
import ShiftDialog from './ShiftDialog.jsx';
import { PhoneCards } from './PhoneCards.jsx';

export default function MyShifts() {
  const { call, version, today, me, jobs, settings, employees, refresh, toast } = useApp();
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

  if (!data) return <div className="empty">Loading…</div>;
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
          <div className="small" style={{ opacity: .85, fontWeight: 600 }}>{nextShift.date === today ? 'Today' : 'Next shift'}</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{prettyDate(nextShift.date)} · {shiftTime(nextShift)}</div>
          <div style={{ opacity: .9 }}>{jobs[nextShift.jobCodeId]?.name}{nextShift.tag ? ` · ${nextShift.tag}` : ''}{nextShift.eventId ? ' · Event shift' : ''}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} onClick={() => open(nextShift)}>{nextShift.published ? 'Trade or give away' : 'Details'}</button>
            {nextShift.eventId && <a className="btn sm" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }} href={`#/events/${nextShift.eventId}`}>View BEO</a>}
          </div>
        </div>
      )}

      {openShifts.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>Open shifts you can pick up</h2><span className="badge ok">{openShifts.length}</span></div>
          <div className="card list">
            {openShifts.slice(0, 8).map((s) => <ShiftRow key={s.id} s={s} onClick={() => open(s)} right={<span className="badge ok">Pick up</span>} />)}
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title"><h2>My shifts</h2></div>
        {!mine.length && <div className="card"><Empty title="No shifts yet">Once your manager publishes the schedule, your shifts show up here.</Empty></div>}
        {Object.entries(weeks).map(([w, list]) => {
          const hrs = list.reduce((t, s) => t + hoursOf(s, settings), 0);
          return (
            <div key={w} style={{ marginBottom: 14 }}>
              <div className="row small muted" style={{ margin: '0 2px 6px', fontWeight: 700 }}>
                <span>{w === thisWeek ? 'This week' : w === addDays(thisWeek, 7) ? 'Next week' : `Week of ${prettyDate(w, { dow: false })}`}</span>
                <span className="spacer" /><span className="num">{list.length} shifts · ~{hrs.toFixed(1)} hrs</span>
              </div>
              <div className="card list">
                {list.map((s) => <ShiftRow key={s.id} s={s} past={s.date < today} onClick={() => open(s)}
                  right={s.pending ? <span className="badge warn">Swap pending</span> : !s.published ? <span className="badge" title="Not posted to staff yet">Draft</span> : s.date < today ? <span className="small faint">Done</span>
                    : <button className="btn sm" onClick={(e) => { e.stopPropagation(); open(s); }}><Icon name="swap" />Trade</button>} />)}
              </div>
            </div>
          );
        })}
      </div>

      {myTimeOff.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>My time off</h2><a className="btn sm ghost" href="#/timeoff">Manage</a></div>
          <div className="card list">
            {myTimeOff.map((t) => (
              <div key={t.id} className="list-item"><Icon name="sun" size={18} /><div style={{ flex: 1 }}>{prettyDate(t.startDate)}{t.endDate !== t.startDate ? ` – ${prettyDate(t.endDate)}` : ''}</div><span className={`badge ${t.status === 'approved' ? 'ok' : 'warn'}`}>{t.status}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="card card-pad section">
        <h3>Sync to your phone calendar</h3>
        <p className="small muted" style={{ margin: '4px 0 10px' }}>Subscribe once and your shifts appear in Google Calendar or Apple Calendar automatically, including trades.</p>
        {IS_DEMO ? <span className="help">Available in the hosted app.</span> : ical
          ? <div className="row"><input className="input sm" readOnly value={ical} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={() => navigator.clipboard?.writeText(ical)}><Icon name="copy" /></button></div>
          : <button className="btn sm" onClick={async () => setIcal(await icalLink())}><Icon name="link" />Get calendar link</button>}
      </div>

      <AppearanceCard />
      {!IS_DEMO && <EmailPrefCard />}
      <PhoneCards />
      {!IS_DEMO && <PasswordCard />}

      {dialog && <ShiftDialog shift={dialog} startIn={startIn} events={data.events} onClose={(c) => { setDialog(null); if (c) load(); }} />}
    </div>
  );
}

/**
 * Managers and admins: when someone on the schedule looks like you (TODD, imported, never signed in)
 * but isn't your account, offer to connect them so their shifts show here.
 */
function ThatsMe({ data }) {
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
    const r = await run(() => call('employees.merge', { fromId: c.id, intoId: me.id }), `Connected: ${c.name}'s shifts are now yours`);
    if (r) refresh();
  };
  return candidates.map((c) => {
    const n = data.shifts.filter((s) => s.userId === c.id).length;
    return (
      <div key={c.id} className="alert info section col" style={{ alignItems: 'stretch', gap: 8 }}>
        <div className="row" style={{ gap: 8 }}><Icon name="user" size={16} />
          <span>Is this you? <b>{(c.sheetName || c.name).toUpperCase()}</b> is on the schedule{n ? ` with ${n} shift${n === 1 ? '' : 's'}` : ''}, but isn’t connected to your sign-in, so those shifts don’t show here.</span></div>
        {sure !== c.id ? (
          <div className="row wrap"><button className="btn sm primary" onClick={() => setSure(c.id)}>That’s me: connect</button><button className="btn sm ghost" onClick={() => notMe(c.id)}>Not me</button></div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            <div className="small">Are you sure? {c.name}’s shifts, positions, pay rates, time off and trades move to your account, and the separate {c.name} record is removed. You keep your sign-in and role.</div>
            <div className="row wrap"><button className="btn sm danger solid" disabled={busy} onClick={() => connect(c)}>Connect</button><button className="btn sm" onClick={() => setSure(null)}>Cancel</button></div>
          </div>
        )}
      </div>
    );
  });
}

function ShiftRow({ s, onClick, right, past }) {
  const { jobs } = useApp();
  const d = parseDate(s.date);
  const j = jobs[s.jobCodeId];
  return (
    <div className={`scard ${past ? 'my-past' : ''}`} onClick={onClick}>
      <div className="date"><div className="m">{DOW_SHORT[d.getUTCDay()]}</div><div className="d">{d.getUTCDate()}</div></div>
      <div className="body">
        <div className="title num">{shiftTime(s)}{!s.end && !startTimesOnly() && <span className="faint small" style={{ fontWeight: 500 }}> until close</span>}</div>
        <div className="small muted row" style={{ gap: 6 }}><JobDot job={j} />{j?.name}{s.area ? ` · ${s.area}` : ''}{s.tag ? ` · ${s.tag}` : ''}{s.eventId ? ' · Event' : ''}</div>
      </div>
      {right}
      <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />
    </div>
  );
}

/** Light or dark mode for me only, or the restaurant's default. */
function AppearanceCard() {
  const { call, me, settings, refresh } = useApp();
  const [run, busy] = useAction();
  const mine = me.appearance || '';
  const label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[settings.appearance || 'auto'];
  const pick = async (v) => { const r = await run(() => call('account.preferences', { appearance: v }), 'Saved'); if (r) refresh(); };
  return (
    <div className="card card-pad section">
      <h3>Appearance</h3>
      <div className="seg" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {[['', `Restaurant default (${label})`], ['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => (
          <button key={k || 'default'} className={mine === k ? 'on' : ''} disabled={busy} onClick={() => pick(k)}>{l}</button>
        ))}
      </div>
      <div className="help">Auto follows your phone or computer’s light/dark setting.</div>
    </div>
  );
}

function EmailPrefCard() {
  const { call, me, emailEnabled } = useApp();
  const [run, busy] = useAction();
  if (!emailEnabled || !me.email) return null;
  const on = me.emailNotifications !== false;
  return (
    <div className="card card-pad section">
      <h3>Email notifications</h3>
      <label className="check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={on} disabled={busy}
          onChange={(e) => run(() => call('account.preferences', { emailNotifications: e.target.checked }), e.target.checked ? 'Email notifications on' : 'Email notifications off')} />
        Email me at {me.email} when my schedule changes, a trade or time off needs me, or an event I'm working is updated
      </label>
    </div>
  );
}

function PasswordCard() {
  const { call } = useApp();
  const [pw, setPw] = useState('');
  const [run, busy] = useAction();
  return (
    <div className="card card-pad section">
      <h3>Change my password</h3>
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input" type="password" placeholder="New password (6+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" style={{ maxWidth: 300 }} />
        <button className="btn" disabled={busy || pw.length < 6} onClick={() => run(() => call('employees.changePassword', { password: pw }), 'Password changed').then(() => setPw(''))}>Save</button>
      </div>
    </div>
  );
}
