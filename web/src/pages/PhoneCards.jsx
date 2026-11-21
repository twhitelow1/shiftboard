// Phone notifications (Web Push) and text messages (Twilio):
//   <PhoneCards />        My Shifts: each person turns them on for themselves
//   <TextSettingsCard />  Settings: what's set up, the restaurant-wide switch for texts, test text
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { IS_DEMO, getConfig, sendTestPush, sendTestText } from '../api.js';
import { pushSupported, isIOS, isStandalone, readyRegistration, currentSubscription, subscribePhone } from '../push.js';
import { formatPhone, normalizePhone } from '../../../core/notify-prefs.js';
import '../phone.css';
import { t, useT } from '../i18n/index.js';


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
  <svg className="share-glyph" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t('common.share')}>
    <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

function PushCard() {
  const t = useT();
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
      toast(t('phoneCards.phoneNotificationsOn'));
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? t('phoneCards.notificationsWerentAllowedOnThis') : e.message, 'bad');
    } finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      const r = await call('push.unsubscribe', { endpoint });
      await (await currentSubscription(reg))?.unsubscribe();
      setEndpoint(null);
      setInfo({ ...info, thisDevice: false, devices: r.devices });
      toast(t('phoneCards.phoneNotificationsOff'));
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await sendTestPush();
      toast(r.sent > 1 ? t('phoneCards.testSentToSentDevices', { sent: r.sent }) : t('phoneCards.testSentItShowsUp'));
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };

  let body;
  if (IS_DEMO) {
    body = <div className="help">{t('phoneCards.thisIsADemoSo')}</div>;
  } else if (!info) {
    body = <div className="help">{t('phoneCards.checkingThisPhone')}</div>;
  } else if (!info.enabled) {
    body = <div className="help">{isAdmin ? t('phoneCards.notSetUpYetAdd', { PUSH_ENV: t('phoneCards.pushEnv') }) : t('phoneCards.yourRestaurantHasntSetThese')}</div>;
  } else if (isIOS() && !isStandalone()) {
    body = (
      <div className="col" style={{ gap: 6 }}>
        <div className="small">{t('phoneCards.onIphoneAddTheApp')}</div>
        <ol className="phone-steps small">
          <li>{t('phoneCards.tapBShareB')} <ShareGlyph />{' '}{t('phoneCards.atTheBottomOfSafari')}</li>
          <li>{t('phoneCards.tapBAddToHome')}</li>
          <li>{t('phoneCards.openTheAppFromYour')}</li>
        </ol>
        <div className="help">{t('phoneCards.needsIos164Or')}</div>
      </div>
    );
  } else if (!pushSupported() || !reg) {
    body = <div className="help">{t('phoneCards.thisBrowserCantShowNotifications')}{isIOS() ? t('phoneCards.updateYourIphoneToIos') : t('phoneCards.tryChromeSafariEdgeOr')}</div>;
  } else if (Notification.permission === 'denied' && !(endpoint && info.thisDevice)) {
    body = <div className="alert warn"><Icon name="alert" size={16} />{t('phoneCards.notificationsAreBlockedForThis')}</div>;
  } else if (endpoint && info.thisDevice) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="row small" style={{ gap: 6 }}><span className="badge ok"><Icon name="check" size={12} />{t('phoneCards.on')}</span>{t('phoneCards.thisPhoneGetsANotification')}</div>
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={test}><Icon name="send" />{t('phoneCards.sendMeATest')}</button>
          <button className="btn sm ghost" disabled={busy} onClick={turnOff}>{t('phoneCards.turnOff')}</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="small muted">{t('phoneCards.getANotificationOnThis')}</div>
        <div><button className="btn sm primary" disabled={busy} onClick={turnOn}><Icon name="bell" />{t('phoneCards.turnOn')}</button></div>
      </div>
    );
  }
  return (
    <div className="card card-pad section phone-card">
      <h3>{t('phoneCards.phoneNotifications')}</h3>
      {body}
    </div>
  );
}

function TextCard({ config }) {
  const t = useT();
  const { call, me, settings, isAdmin } = useApp();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [editing, setEditing] = useState(false);
  const [run, busy] = useAction();
  const on = me.smsNotifications === true;
  const save = (args, msg) => run(() => call('sms.preferences', args), msg).then((r) => { if (r) setEditing(false); });

  let body;
  if (IS_DEMO) {
    body = <div className="help">{t('phoneCards.thisIsADemoSo2')}</div>;
  } else if (!config) {
    body = null;
  } else if (!config.sms) {
    body = <div className="help">{isAdmin ? t('phoneCards.notSetUpYetAdd2', { TWILIO_ENV: t('phoneCards.twilioEnv') }) : t('phoneCards.yourRestaurantHasntSetUp')}</div>;
  } else if (settings.smsNotifications === false) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="help">{t('phoneCards.yourRestaurantHasTextsTurned')}</div>
        {on && <div><button className="btn sm ghost" disabled={busy} onClick={() => save({ on: false }, t('phoneCards.textsOff'))}>{t('phoneCards.turnOffMyTexts')}</button></div>}
      </div>
    );
  } else if (on && !editing) {
    body = (
      <div className="col" style={{ gap: 8 }}>
        <div className="row small" style={{ gap: 6 }}><span className="badge ok"><Icon name="check" size={12} />{t('phoneCards.on')}</span>{t('phoneCards.textsGoToPhone', { phone: formatPhone(me.smsPhone) })}</div>
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>{t('phoneCards.changeNumber')}</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => save({ on: false }, t('phoneCards.textsOff'))}>{t('phoneCards.turnOff')}</button>
        </div>
      </div>
    );
  } else {
    const valid = !!normalizePhone(phone);
    body = (
      <div className="col" style={{ gap: 8 }}>
        {me.smsStoppedAt && !on && <div className="alert info"><Icon name="alert" size={16} />{t('phoneCards.youRepliedStopSoTexts')}</div>}
        <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); if (valid) save({ on: true, phone }, t('phoneCards.textsOnWeSentYou')); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phoneCards.mobileNumber')} aria-label={t('phoneCards.mobileNumber')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn sm primary" disabled={busy || !valid}><Icon name="send" />{on ? t('common.save') : t('phoneCards.textMe')}</button>
          {editing && <button type="button" className="btn sm ghost" onClick={() => { setEditing(false); setPhone(formatPhone(me.smsPhone)); }}>{t('common.cancel')}</button>}
        </form>
        <div className="help">{t('phoneCards.textsAboutYourShiftsTrades')}</div>
      </div>
    );
  }
  return (
    <div className="card card-pad section phone-card">
      <h3>{t('phoneCards.textMessages')}</h3>
      {body}
    </div>
  );
}

/** Settings: texts (restaurant switch + test text) and whether phone notifications are set up. */
export function TextSettingsCard() {
  const t = useT();
  const { settings, call, me } = useApp();
  const config = useServerConfig();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [run, busy] = useAction();
  const on = settings.smsNotifications !== false;
  return (
    <div className="card card-pad col phone-card" style={{ gap: 12 }}>
      <h2>{t('phoneCards.textsPhoneNotifications')}</h2>
      {IS_DEMO ? <div className="help">{t('phoneCards.thisIsADemoSo3')}</div> : !config ? null : (
        <div className="col" style={{ gap: 6 }}>
          {config.sms
            ? <div className="alert ok"><Icon name="check" size={16} />{t('phoneCards.textsConnectedToTwilio')}{config.smsFrom ? t('phoneCards.textsComeFromSmsfrom', { smsFrom: config.smsFrom }) : ''}</div>
            : <div className="alert warn"><Icon name="alert" size={16} />{t('phoneCards.textsNotSetUpYet', { TWILIO_ENV: t('phoneCards.twilioEnv') })}</div>}
          {config.push
            ? <div className="alert ok"><Icon name="check" size={16} />{t('phoneCards.phoneNotificationsReadyEachPerson')}</div>
            : <div className="alert warn"><Icon name="alert" size={16} />{t('phoneCards.phoneNotificationsNotSetUp', { PUSH_ENV: t('phoneCards.pushEnv') })}</div>}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={on} disabled={busy}
        onChange={(e) => run(() => call('sms.setRestaurant', { on: e.target.checked }), e.target.checked ? t('phoneCards.textsOn') : t('phoneCards.textsOffForEveryone'))} />{t('phoneCards.textStaffACopyOf')}</label>
      <div className="help">{t('phoneCards.onlyPeopleWhoTurnTexts')}</div>
      {config?.sms && (
        <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); run(() => sendTestText(phone), (r) => t('phoneCards.testTextSentToTo', { to: r.to })); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phoneCards.yourMobileNumber')} aria-label={t('phoneCards.yourMobileNumber')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn sm" disabled={busy || !normalizePhone(phone)}><Icon name="send" />{t('phoneCards.sendMeATestText')}</button>
        </form>
      )}
    </div>
  );
}
