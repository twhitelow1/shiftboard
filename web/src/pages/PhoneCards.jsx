// Phone notifications (Web Push) and text messages (Twilio):
//   <PhoneCards />        My Shifts: each person turns them on for themselves
//   <TextSettingsCard />  Settings: what's set up, the restaurant-wide switch for texts, test text
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { IS_DEMO, getConfig, sendTestPush, sendTestText } from '../api.js';
import { pushSupported, isIOS, isStandalone, readyRegistration, currentSubscription, subscribePhone } from '../push.js';
import { formatPhone, normalizePhone } from '../../../core/notify-prefs.js';
import { CONSENT_TEXT } from '../../../core/consent.js';
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
  const { has } = useApp();
  return <><PushCard />{(!has || has('sms')) && <TextCard config={config} />}</>;
}

// iPhone's Share button: a square with an arrow up.
const ShareGlyph = () => (
  <svg className="share-glyph" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label={t('common.share')}>
    <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

function PushCard() {
  const t = useT();
  const { call, isAdmin, toast, managed } = useApp();
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
    body = <div className="help">{!isAdmin ? t('phoneCards.yourRestaurantHasntSetThese') : managed ? t('platform.askDublowPush') : t('phoneCards.notSetUpYetAdd', { PUSH_ENV: t('phoneCards.pushEnv') })}</div>;
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
  const { call, me, settings, isAdmin, managed } = useApp();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [editing, setEditing] = useState(false);
  const [agree, setAgree] = useState(false); // the consent box: never ticked to start with
  const [run, busy] = useAction();
  const on = me.smsConsent === true;
  const save = (args, msg) => run(() => call('sms.preferences', args), msg).then((r) => { if (r) { setEditing(false); setAgree(false); } });

  let body;
  if (IS_DEMO) {
    body = <div className="help">{t('phoneCards.thisIsADemoSo2')}</div>;
  } else if (!config) {
    body = null;
  } else if (!config.sms) {
    body = <div className="help">{!isAdmin ? t('phoneCards.yourRestaurantHasntSetUp') : managed ? t('platform.askDublowTexts') : t('phoneCards.notSetUpYetAdd2', { TWILIO_ENV: t('phoneCards.twilioEnv') })}</div>;
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
        {me.smsStatus === 'stopped' && <div className="alert info"><Icon name="alert" size={16} />{t('phoneCards.youRepliedStopSoTexts')}</div>}
        <form className="col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (valid && agree) save({ on: true, phone, consent: true, lang: t.lang }, me.smsWelcomedAt ? t('phoneCards.textsOn') : t('phoneCards.textsOnWeSentYou')); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phoneCards.mobileNumber')} aria-label={t('phoneCards.mobileNumber')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="consent-box"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{CONSENT_TEXT[t.lang === 'es' ? 'es' : 'en'].sms}</span></label>
          <div className="row wrap phone-row">
            <button className="btn sm primary" disabled={busy || !valid || !agree}><Icon name="send" />{on ? t('common.save') : t('phoneCards.textMe')}</button>
            {editing && <button type="button" className="btn sm ghost" onClick={() => { setEditing(false); setAgree(false); setPhone(formatPhone(me.smsPhone)); }}>{t('common.cancel')}</button>}
          </div>
        </form>
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

/** Settings → Text messages: every consent record as a CSV, for carrier and Twilio audits (admins). */
function ConsentLogLink() {
  const t = useT();
  const { isAdmin } = useApp();
  if (!isAdmin) return null;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div><a className="btn sm" href="/api/consents.csv" download style={{ whiteSpace: 'normal', height: 'auto', minHeight: 30, padding: '5px 10px', textAlign: 'left' }}><Icon name="download" />{t('consent.downloadLog')}</a></div>
      <div className="help">{t('consent.logHelp')}</div>
    </div>
  );
}

/** Settings: texts (restaurant switch + test text) and whether phone notifications are set up. */
export function TextSettingsCard() {
  const t = useT();
  const { settings, call, me, has, managed } = useApp();
  const sms = !has || has('sms'); // texts are a plan feature; phone notifications are in every plan
  const config = useServerConfig();
  const [phone, setPhone] = useState(formatPhone(me.smsPhone) || me.phone || '');
  const [run, busy] = useAction();
  const on = settings.smsNotifications !== false;
  return (
    <div className="card card-pad col phone-card" style={{ gap: 12 }}>
      <h2>{t('phoneCards.textsPhoneNotifications')}</h2>
      {IS_DEMO ? <div className="help">{t('phoneCards.thisIsADemoSo3')}</div> : !config ? null : (
        <div className="col" style={{ gap: 6 }}>
          {!sms ? null : config.sms
            ? <div className="alert ok"><Icon name="check" size={16} />{t('phoneCards.textsConnectedToTwilio')}{config.smsFrom ? t('phoneCards.textsComeFromSmsfrom', { smsFrom: config.smsFrom }) : ''}</div>
            : <div className="alert warn"><Icon name="alert" size={16} />{managed ? t('platform.askDublowTexts') : t('phoneCards.textsNotSetUpYet', { TWILIO_ENV: t('phoneCards.twilioEnv') })}</div>}
          {config.push
            ? <div className="alert ok"><Icon name="check" size={16} />{t('phoneCards.phoneNotificationsReadyEachPerson')}</div>
            : <div className="alert warn"><Icon name="alert" size={16} />{managed ? t('platform.askDublowPush') : t('phoneCards.phoneNotificationsNotSetUp', { PUSH_ENV: t('phoneCards.pushEnv') })}</div>}
        </div>
      )}
      {sms && <><label className="check"><input type="checkbox" checked={on} disabled={busy}
        onChange={(e) => run(() => call('sms.setRestaurant', { on: e.target.checked }), e.target.checked ? t('phoneCards.textsOn') : t('phoneCards.textsOffForEveryone'))} />{t('phoneCards.textStaffACopyOf')}</label>
      <div className="help">{t('phoneCards.onlyPeopleWhoTurnTexts')}</div></>}
      {sms && config?.sms && (me.smsConsent ? (
        <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); run(() => sendTestText(phone), (r) => t('phoneCards.testTextSentToTo', { to: r.to })); }}>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phoneCards.yourMobileNumber')} aria-label={t('phoneCards.yourMobileNumber')} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn sm" disabled={busy || !normalizePhone(phone)}><Icon name="send" />{t('phoneCards.sendMeATestText')}</button>
        </form>
      ) : <div className="help">{t('consent.testTextNeedsConsent')}</div>)}
      {!IS_DEMO && <ConsentLogLink />}
    </div>
  );
}
