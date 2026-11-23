// The welcome wizard (#/welcome?token=…, from the invitation email; server/onboarding.js), one step per
// screen with progress dots:
//   1. password   2. secure your account (a passkey or an authenticator app, then 10 recovery codes)
//   3. profile (name, mobile number, photo)   4. consent   → done → My Shifts
// Progress is kept on the server, so a reload picks up where it was. #/welcome?preview=1 (admins in the demo)
// walks through the same screens with sample data and no server calls, for screenshots.
//
// Also the consent screen on its own (ConsentForm), and ConsentGate: the one-time screen at sign-in for people
// who were here before consent records existed.
import React, { useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';
import { useT, translateError } from '../i18n/index.js';
import { onboarding, passkeysSupported, devicePasskeyAvailable, passkeyCancelled } from '../auth-api.js';
import { CONSENT_TEXT, LEGAL_LINKS, termsParts } from '../../../core/consent.js';
import { passwordProblem } from '../../../core/auth-factors.js';
import { normalizePhone } from '../../../core/notify-prefs.js';
import { consentBoxes, initialChoices, canSubmit, consentPayload } from '../consent-form.js';
import { AuthCard } from './AuthCard.jsx';
import { ChooseFactor, TotpSetup, RecoveryCodesView } from './TwoStep.jsx';
import { PhotoPicker } from './ProfilePhoto.jsx';

const STEPS = ['password', 'secure', 'profile', 'consent'];
const lang2 = (l) => (l === 'es' ? 'es' : 'en');

function Dots({ at }) {
  const t = useT();
  return (
    <div className="wizard-dots" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={Math.min(at + 1, STEPS.length)}
      aria-label={t('welcome.stepOf', { n: Math.min(at + 1, STEPS.length), total: STEPS.length })}>
      {STEPS.map((s, i) => <span key={s} className={`dot ${i < at ? 'done' : i === at ? 'on' : ''}`} />)}
      <span className="small muted">{at < STEPS.length ? t('welcome.stepOf', { n: at + 1, total: STEPS.length }) : t('welcome.allSet')}</span>
    </div>
  );
}

// ---------- the consent screen ----------

/** The terms sentence with its two links. */
function TermsText({ lang, legal }) {
  return termsParts(lang, legal || LEGAL_LINKS).map((p, i) => (p.href
    ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{p.text}</a>
    : <React.Fragment key={i}>{p.text}</React.Fragment>));
}

/**
 * The three boxes, none ticked to start with. boxes: consentBoxes(); onSubmit(payload) with only explicit true
 * counting. phone: the mobile number (texts need one); it's asked for here when texts are ticked without one.
 */
export function ConsentForm({ boxes, legal, phone: phone0 = '', onSubmit, busy, err, submitLabel }) {
  const t = useT();
  const lang = lang2(t.lang);
  const [c, setC] = useState(initialChoices);
  const [phone, setPhone] = useState(phone0);
  const box = (ch) => boxes.find((b) => b.channel === ch);
  const tick = (ch) => (e) => setC({ ...c, [ch]: e.target.checked });
  const needPhone = c.sms && !normalizePhone(phone);
  return (
    <div className="col" style={{ gap: 12 }}>
      <label className="consent-box">
        <input type="checkbox" checked={c.terms} onChange={tick('terms')} aria-required="true" />
        <span><TermsText lang={lang} legal={legal} /> <span className="consent-tag req">{t('consent.required')}</span></span>
      </label>
      {box('sms').show ? (
        <label className="consent-box">
          <input type="checkbox" checked={c.sms} onChange={tick('sms')} />
          <span>{CONSENT_TEXT[lang].sms} <span className="consent-tag">{t('consent.optional')}</span></span>
        </label>
      ) : box('sms').on ? <div className="consent-on"><Icon name="check" size={16} />{t('consent.textsAreOn')}</div> : null}
      {c.sms && (
        <label className="field">
          <span>{t('consent.mobileForTexts')}</span>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(303) 555-0142" />
          {needPhone && <div className="help">{t('consent.needNumber')}</div>}
        </label>
      )}
      {box('email').show ? (
        <label className="consent-box">
          <input type="checkbox" checked={c.email} onChange={tick('email')} />
          <span>{CONSENT_TEXT[lang].email} <span className="consent-tag">{t('consent.optional')}</span></span>
        </label>
      ) : box('email').on ? <div className="consent-on"><Icon name="check" size={16} />{t('consent.emailsAreOn')}</div> : null}
      <div className="help">{t('consent.youCanChange')}</div>
      {err && <div className="alert bad">{err}</div>}
      <button type="button" className="btn primary block" disabled={busy || !canSubmit(c, phone)} onClick={() => onSubmit(consentPayload(boxes, c, { phone, lang }))}>
        {busy ? t('main.saving') : submitLabel || t('consent.agreeAndContinue')}</button>
      {!c.terms && <div className="help center">{t('consent.termsNeeded')}</div>}
    </div>
  );
}

/** The one-time consent screen after sign-in, for people from before consent records (and anyone without terms). */
export function ConsentGate({ me, sms, legal, call, onDone, onSignOut }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const boxes = consentBoxes({ consent: me.consent || {}, sms });
  const submit = async (payload) => {
    setBusy(true); setErr('');
    try { await call('consent.accept', payload); onDone(); } catch (e) { setErr(translateError(e.message)); } finally { setBusy(false); }
  };
  return (
    <AuthCard wide>
      <div><b className="auth-title">{t('consent.gateTitle')}</b><div className="small muted">{t('consent.gateHelp')}</div></div>
      <ConsentForm boxes={boxes} legal={legal} phone={me.smsPhone || me.phone || ''} onSubmit={submit} busy={busy} err={err} />
      {onSignOut && <button type="button" className="btn ghost sm" onClick={onSignOut}>{t('main.signOut')}</button>}
    </AuthCard>
  );
}

// ---------- the wizard ----------

const SAMPLE = {
  name: 'Alex Demo', email: 'alex@demo.shiftboard', lang: 'en', restaurant: 'Our Restaurant', sms: true, legal: LEGAL_LINKS,
  steps: { password: false, factor: null, recoverySaved: false, profile: false }, profile: { name: 'Alex Demo', phone: '', photoId: null },
  consent: { terms: false, sms: false, email: false },
};
const SAMPLE_CODES = ['7KQ4M-X2DPA', 'H8VNC-3RTWE', 'Q2ZLM-9KD4F', 'B5XJP-W7HNA', 'T3MRG-8QCVZ', 'L9FDK-2PXWE', 'N4HQB-6TJMR', 'C7WZS-5LKPD', 'P2RVN-4XHGB', 'E6JTQ-9MZCW'];
const firstOpen = (s) => (!s.password ? 0 : !s.factor || !s.recoverySaved ? 1 : !s.profile ? 2 : 3);

export function Welcome({ token, preview = false, startAt, onDone }) {
  const t = useT();
  const [info, setInfo] = useState(preview ? SAMPLE : null);
  const [at, setAt] = useState(preview ? Math.max(0, STEPS.indexOf(startAt)) : 0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState('');

  useEffect(() => {
    if (preview) return;
    onboarding.start(token).then((s) => { setInfo(s); setAt(firstOpen(s.steps)); }, (e) => setFatal(e.message));
  }, [token, preview]);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { return await fn(); } catch (e) { setErr(e.message); return null; } finally { setBusy(false); }
  };
  const next = (s) => { if (s) setInfo((i) => ({ ...i, ...s })); setErr(''); setAt((a) => a + 1); window.scrollTo(0, 0); };

  if (fatal) return (
    <AuthCard wide>
      <div className="alert bad"><Icon name="alert" size={16} />{fatal}</div>
      <a className="btn block" href="#/">{t('main.backToSignIn')}</a>
    </AuthCard>
  );
  if (!info) return <AuthCard wide><div className="small muted">{t('common.loading')}</div></AuthCard>;

  const top = <><Dots at={at} />{preview && <div className="alert info small"><Icon name="alert" size={16} />{t('welcome.previewNote')}</div>}</>;
  const title = (k, help) => <div><b className="auth-title">{k}</b>{help && <div className="small muted">{help}</div>}</div>;

  if (at === 0) return <PasswordStep info={info} top={top} title={title} busy={busy} err={err} setErr={setErr}
    onSubmit={(pw) => run(async () => { if (!preview) await onboarding.password(pw); next({ steps: { ...info.steps, password: true } }); })} />;
  if (at === 1) return <SecureStep info={info} top={top} title={title} preview={preview} onDone={() => next({ steps: { ...info.steps, recoverySaved: true } })} />;
  if (at === 2) return <ProfileStep info={info} top={top} title={title} preview={preview} busy={busy} err={err} run={run}
    onSaved={(s) => next(s)} />;
  if (at === 3) return (
    <AuthCard wide top={top}>
      {title(t('welcome.consentTitle'), t('welcome.consentHelp'))}
      <ConsentForm boxes={consentBoxes({ consent: info.consent || {}, sms: info.sms })} legal={info.legal} phone={info.profile?.phone || ''} busy={busy} err={err}
        submitLabel={t('welcome.finish')}
        onSubmit={(payload) => run(async () => { if (!preview) await onboarding.complete(payload); next(); })} />
    </AuthCard>
  );
  return (
    <AuthCard wide top={top}>
      <div className="done-mark"><Icon name="check" size={32} /></div>
      {title(t('welcome.doneTitle', { name: String(info.profile?.name || info.name).split(' ')[0] }), t('welcome.doneHelp'))}
      <button type="button" className="btn primary block" onClick={() => (preview ? (location.hash = '#/team') : onDone())}>{preview ? t('welcome.endPreview') : t('welcome.goToMyShifts')}</button>
    </AuthCard>
  );
}

function PasswordStep({ info, top, title, busy, err, setErr, onSubmit }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const problem = passwordProblem(pw, { email: info.email, name: info.name });
    if (problem) return setErr(translateError(problem));
    if (pw !== pw2) return setErr(t('main.theTwoPasswordsDontMatch'));
    onSubmit(pw);
  };
  return (
    <AuthCard wide top={top} onSubmit={submit}>
      {title(t('welcome.hi', { name: String(info.name || '').split(' ')[0] }), t('welcome.passwordHelp', { restaurant: info.restaurant }))}
      <input type="email" autoComplete="username" value={info.email} readOnly hidden />
      <label className="field"><span>{t('main.newPassword')}</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoFocus /></label>
      <label className="field"><span>{t('main.repeatIt')}</span><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={10} /></label>
      <div className="help">{t('signin.passwordRules')}</div>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? t('main.saving') : t('welcome.next')}</button>
    </AuthCard>
  );
}

function SecureStep({ info, top, title, preview, onDone }) {
  const t = useT();
  const resumeCodes = !!info.steps.factor && !info.steps.recoverySaved;
  const [mode, setMode] = useState(resumeCodes ? 'codes' : 'choose'); // choose | totp | codes
  const [codes, setCodes] = useState(preview && resumeCodes ? SAMPLE_CODES : []);
  const [deviceKey, setDeviceKey] = useState(preview);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!preview) devicePasskeyAvailable().then(setDeviceKey); }, [preview]);
  // After a reload on the codes screen the earlier codes are gone: new ones replace them.
  useEffect(() => { if (!preview && resumeCodes) onboarding.regenerate().then((r) => setCodes(r.recoveryCodes), (e) => setErr(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const passkey = async () => {
    setBusy(true); setErr('');
    try { const r = preview ? { recoveryCodes: SAMPLE_CODES } : await onboarding.passkey(); setCodes(r.recoveryCodes); setMode('codes'); }
    catch (e) { if (!passkeyCancelled(e)) setErr(e.message); } finally { setBusy(false); }
  };
  const saved = async () => {
    setBusy(true); setErr('');
    try { if (!preview) await onboarding.saved(); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <AuthCard wide top={top}>
      {mode === 'codes' ? title(t('security.saveRecoveryCodes')) : title(t('signin.secureYourAccount'), t('welcome.secureHelp'))}
      {mode === 'choose' && <ChooseFactor passkey={preview || passkeysSupported()} recommendPasskey={deviceKey} busy={busy} onPasskey={passkey} onTotp={() => setMode('totp')} />}
      {mode === 'totp' && <TotpSetup onBack={() => setMode('choose')}
        start={() => (preview ? Promise.resolve({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/ShiftBoard:alex%40demo.shiftboard?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ShiftBoard' }) : onboarding.totpSetup())}
        confirm={(code) => (preview ? Promise.resolve({ recoveryCodes: SAMPLE_CODES }) : onboarding.totpConfirm(code))}
        onConfirmed={(r) => { setCodes(r.recoveryCodes); setMode('codes'); }} />}
      {mode === 'codes' && (codes.length ? <RecoveryCodesView codes={codes} restaurant={info.restaurant} onContinue={saved} continueLabel={t('welcome.next')} />
        : !err && <div className="small muted">{t('common.loading')}</div>)}
      {err && <div className="alert bad">{err}</div>}
    </AuthCard>
  );
}

function ProfileStep({ info, top, title, preview, busy, err, run, onSaved }) {
  const t = useT();
  const [name, setName] = useState(info.profile?.name || info.name || '');
  const [phone, setPhone] = useState(info.profile?.phone || '');
  const [photoId, setPhotoId] = useState(info.profile?.photoId || null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [localSrc, setLocalSrc] = useState(''); // what was just picked (not signed in yet: /api/photos can't serve it)
  const me = { id: 'me', name, photoId: preview ? null : photoId };
  const savePhoto = async (dataUrl) => {
    setPhotoBusy(true);
    try {
      if (!preview) setPhotoId((await onboarding.photo(dataUrl)).photoId);
      setLocalSrc(dataUrl);
    } finally { setPhotoBusy(false); }
  };
  const removePhoto = async () => {
    setPhotoBusy(true);
    try { if (!preview) await onboarding.photo(null); setPhotoId(null); setLocalSrc(''); } finally { setPhotoBusy(false); }
  };
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const s = preview ? { ...info, profile: { name, phone, photoId } } : await onboarding.profile(name, phone);
      onSaved({ profile: { ...(s.profile || {}), name, phone: s.profile?.phone ?? phone, photoId } });
    });
  };
  const badPhone = phone.trim() && !normalizePhone(phone);
  return (
    <AuthCard wide top={top} onSubmit={submit}>
      {title(t('welcome.profileTitle'), t('welcome.profileHelp'))}
      <label className="field"><span>{t('common.name')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>
      <label className="field"><span>{t('welcome.mobileOptional')}</span>
        <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(303) 555-0142" />
        <div className="help">{badPhone ? translateError('Enter your mobile number, like (303) 555-0123') : t('welcome.mobileHelp')}</div>
      </label>
      <div className="field"><span>{t('welcome.photo')}</span>
        <PhotoPicker user={me} src={localSrc} busy={photoBusy} onSave={savePhoto} onRemove={removePhoto} />
      </div>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy || !name.trim() || badPhone}>{busy ? t('main.saving') : t('welcome.next')}</button>
    </AuthCard>
  );
}
