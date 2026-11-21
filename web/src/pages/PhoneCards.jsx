// Phone notifications (Web Push) and text messages (Twilio):
//   <PhoneCards />        My Shifts: each person turns them on for themselves
//   <TextSettingsCard />  Settings: what's set up, the restaurant-wide switch for texts, test text
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { IS_DEMO, getConfig, sendTestPush, sendTestText } from '../api.js';
import { pushSupported, isIOS, isStandalone, readyRegistration, currentSubscription, subscribePhone } from '../push.js';
import { formatPhone, normalizePhone } from '../../../core/notify-prefs.js';
import '../phone.css';

const PUSH_ENV = 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT';
const TWILIO_ENV = 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER)';

function useServerConfig() {
  const [config, setConfig] = useState(null);
  useEffect(() => { let live = true; getConfig().then((c) => live && setConfig(c || {})); return () => { live = false; }; }, []);
  return config;
}

/** My Shifts: phone notifications and texts. */
export function PhoneCards() {
  const config = useServerConfig();
  return <><PushCard /><TextCard config={config} /></>;
}

// iPhone's Share button: a square with an arrow up.
const ShareGlyph = () => (
  <svg className="share-glyph" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Share">
    <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

function PushCard() {
  const { call, isAdmin, toast } = useApp();
  const [info, setInfo] = useState(null); // { enabled, publicKey, thisDevice, devices } from push.publicKey
  const [reg, setReg] = useState(null);
  const [endpoint, setEndpoint] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (IS_DEMO) return undefined;
    let live = true;
    (async () => {
      const r = await readyRegistration();
      const sub = await currentSubscription(r);
      const i = await call('push.publicKey', { endpoint: sub?.endpoint || '' }).catch(() => ({ enabled: false }));
      if (live) { setReg(r); setEndpoint(sub?.endpoint || null); setInfo(i); }
    })();
    return () => { live = false; };
  }, []);

  const turnOn = async () => {
    setBusy(true);
    try {
      const sub = await subscribePhone(reg, info.publicKey); // first thing in the tap: iPhones need that to ask
      const r = await call('push.subscribe', { subscription: sub });
      setEndpoint(sub.endpoint);
      setInfo({ ...info, thisDevice: true, devices: r.devices });
      toast('Phone notifications on');
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Notifications weren’t allowed on this phone' : e.message, 'bad');
    } finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      const r = await call('push.unsubscribe', { endpoint });
      await (await currentSubscription(reg))?.unsubscribe();
      setEndpoint(null);
      setInfo({ ...info, thisDevice: false, devices: r.devices });
      toast('Phone notifications off');
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await sendTestPush();
      toast(r.sent > 1 ? `Test sent to ${r.sent} devices` : 'Test sent. It shows up in a few seconds.');
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };

  let body;
  if (IS_DEMO) {
    body = <div className="help">This is a demo, so there’s nothing to turn on. In the real app, staff get a notification on their phone for each new alert.</div>;
  } else if (!info) {
    body = <div className="help">Checking this phone…</div>;
  } else if (!info.enabled) {
    body = <div className="help">{isAdmin ? `Not set up yet. Add ${PUSH_ENV} in Vercel, then redeploy. (Make the keys with npm run vapid-keys.)` : 'Your restaurant hasn’t set these up yet.'}</div>;
  } else if (isIOS() && !isStandalone()) {
    body = (
      <div className="col" style={{ gap: 6 }}>
        <div className="small">On iPhone, add the app to your Home Screen first:</div>
        <ol className="phone-steps small">
          <li>Tap <b>Share</b> <ShareGlyph /> at the bottom of Safari.</li>
          <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li>Open the app from your Home Screen, come back here and tap <b>Turn on</b>.</li>
        </ol>
        <div className="help">Needs iOS 16.4 or later. Notifications only work from the Home Screen app.</div>
      </div>
    );
  } else if (!pushSupported() || !reg) {
    body = <div className="help">This browser can’t show notifications.{isIOS() ? ' Update your iPhone to iOS 16.4 or later.' : ' Try Chrome, Safari, Edge or Firefox.'}</div>;
  } else if (Notification.permission === 'denied' && !(endpoint && info.thisDevice)) {
    body = <div className="alert warn"><Icon name="alert" size={16} />Notifications are blocked for this app. Allow them in your phone or browser settings, then come back.</div>;
  } else if (endpoint && info.thisDevice) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="row small" style={{ gap: 6 }}><span className="badge ok"><Icon name="check" size={12} />On</span>This phone gets a notification for each new alert.</div>
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={test}><Icon name="send" />Send me a test</button>
          <button className="btn sm ghost" disabled={busy} onClick={turnOff}>Turn off</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="small muted">Get a notification on this phone when your schedule changes, a trade or time off needs you, or an event you’re working is updated.</div>
        <div><button className="btn sm primary" disabled={busy} onClick={turnOn}><Icon name="bell" />Turn on</button></div>
      </div>
    );
  }
  return (
    <div className="card card-pad section phone-card">
      <h3>Phone notifications</h3>
      {body}
    </div>
  );
}

function TextCard({ config }) {
  const { call, me, settings, isAdmin } = useApp();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [editing, setEditing] = useState(false);
  const [run, busy] = useAction();
  const on = me.smsNotifications === true;
  const save = (args, msg) => run(() => call('sms.preferences', args), msg).then((r) => { if (r) setEditing(false); });

  let body;
  if (IS_DEMO) {
    body = <div className="help">This is a demo, so no texts are sent. In the real app, each person can choose to get their alerts by text too.</div>;
  } else if (!config) {
    body = null;
  } else if (!config.sms) {
    body = <div className="help">{isAdmin ? `Not set up yet. Add ${TWILIO_ENV} in Vercel, then redeploy.` : 'Your restaurant hasn’t set up texts yet.'}</div>;
  } else if (settings.smsNotifications === false) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="help">Your restaurant has texts turned off right now.</div>
        {on && <div><button className="btn sm ghost" disabled={busy} onClick={() => save({ on: false }, 'Texts off')}>Turn off my texts</button></div>}
      </div>
    );
  } else if (on && !editing) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="row small" style={{ gap: 6 }}><span className="badge ok"><Icon name="check" size={12} />On</span>Texts go to {formatPhone(me.smsPhone)}.</div>
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>Change number</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => save({ on: false }, 'Texts off')}>Turn off</button>
        </div>
      </div>
    );
  } else {
    const valid = !!normalizePhone(phone);
    body = (
      <div className="col" style={{ gap: 8 }}>
        {me.smsStoppedAt && !on && <div className="alert info"><Icon name="alert" size={16} />You replied STOP, so texts are off. Turn them back on here, or reply START.</div>}
        <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); if (valid) save({ on: true, phone }, 'Texts on. We sent you a welcome text.'); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Mobile number" aria-label="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn sm primary" disabled={busy || !valid}><Icon name="send" />{on ? 'Save' : 'Text me'}</button>
          {editing && <button type="button" className="btn sm ghost" onClick={() => { setEditing(false); setPhone(formatPhone(me.smsPhone)); }}>Cancel</button>}
        </form>
        <div className="help">Texts about your shifts, trades, time off and events. How many depends on your schedule. Msg &amp; data rates may apply. Reply STOP to stop, HELP for help.</div>
      </div>
    );
  }
  return (
    <div className="card card-pad section phone-card">
      <h3>Text messages</h3>
      {body}
    </div>
  );
}

/** Settings: texts (restaurant switch + test text) and whether phone notifications are set up. */
export function TextSettingsCard() {
  const { settings, call, me } = useApp();
  const config = useServerConfig();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [run, busy] = useAction();
  const on = settings.smsNotifications !== false;
  return (
    <div className="card card-pad col phone-card" style={{ gap: 12 }}>
      <h2>Texts &amp; phone notifications</h2>
      {IS_DEMO ? <div className="help">This is a demo, so no texts or phone notifications are sent. They work in the hosted app.</div> : !config ? null : (
        <div className="col" style={{ gap: 6 }}>
          {config.sms
            ? <div className="alert ok"><Icon name="check" size={16} />Texts: connected to Twilio.{config.smsFrom ? ` Texts come from ${config.smsFrom}.` : ''}</div>
            : <div className="alert warn"><Icon name="alert" size={16} />Texts: not set up yet. Add {TWILIO_ENV} in Vercel, then redeploy.</div>}
          {config.push
            ? <div className="alert ok"><Icon name="check" size={16} />Phone notifications: ready. Each person turns them on in My Shifts.</div>
            : <div className="alert warn"><Icon name="alert" size={16} />Phone notifications: not set up yet. Add {PUSH_ENV} in Vercel (make the keys with npm run vapid-keys), then redeploy.</div>}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={on} disabled={busy}
        onChange={(e) => run(() => call('sms.setRestaurant', { on: e.target.checked }), e.target.checked ? 'Texts on' : 'Texts off for everyone')} />
        Text staff a copy of their notifications</label>
      <div className="help">Only people who turn texts on themselves in My Shifts, with their own mobile number, get them. Managers can’t turn texts on for someone. Replying STOP turns them off.</div>
      {config?.sms && (
        <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); run(() => sendTestText(phone), (r) => `Test text sent to ${r.to}`); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your mobile number" aria-label="Your mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn sm" disabled={busy || !normalizePhone(phone)}><Icon name="send" />Send me a test text</button>
        </form>
      )}
    </div>
  );
}
