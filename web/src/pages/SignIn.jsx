// Signing in (server/auth.js; docs/auth.md):
//   email + password → the second step: a code from the authenticator app, a recovery code or a passkey.
//   No second step yet → set one up right away (a passkey or an authenticator app, then recovery codes).
//   "Sign in with a passkey": no password (a passkey counts as both steps).
//   "Email me a sign-in link": email + a current authenticator code → a one-time link (15 minutes).
// Also the reset link (#/reset?token=…: a new password, then the same second step) and the sign-in link
// (#/link?token=…). No SMS codes anywhere.
import React, { useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';
import { forgotPassword } from '../api.js';
import { passwordStep, verifyCode, totpSetup, totpConfirm, addPasskey, passkeySignIn, requestLink, consumeLink, resetWithToken,
  passkeysSupported, devicePasskeyAvailable, passkeyCancelled } from '../auth-api.js';
import { useT } from '../i18n/index.js';
import { AuthCard } from './AuthCard.jsx';
import { ChooseFactor, TotpSetup, RecoveryCodesView, CodeInput, codeReady } from './TwoStep.jsx';

/** A passkey button (shown only when this browser can use passkeys). */
function PasskeyButton({ onDone, setErr, label }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!passkeysSupported()) return null;
  const go = async () => {
    setBusy(true); setErr('');
    try { await passkeySignIn(); onDone(); } catch (e) { if (!passkeyCancelled(e)) setErr(e.message); } finally { setBusy(false); }
  };
  return <button type="button" className="btn block" disabled={busy} onClick={go}><Icon name="key" />{busy ? t('signin.waitingForPasskey') : label || t('signin.withPasskey')}</button>;
}

/**
 * After the password (or a reset): step = { mfa: 'verify', ticket, methods } or { mfa: 'enroll', ticket }.
 * onDone runs once there's a session.
 */
export function SecondStep({ step, onDone, onBack }) {
  return step.mfa === 'enroll' ? <EnrollStep ticket={step.ticket} onDone={onDone} onBack={onBack} /> : <CodeStep step={step} onDone={onDone} onBack={onBack} />;
}

function CodeStep({ step, onDone, onBack }) {
  const t = useT();
  const hasTotp = step.methods?.includes('totp');
  const [recovery, setRecovery] = useState(!hasTotp);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!codeReady(code, recovery)) return;
    setBusy(true); setErr('');
    try { await verifyCode(step.ticket, recovery ? 'recovery' : 'totp', code); onDone(); } catch (x) { setErr(x.message); setCode(''); } finally { setBusy(false); }
  };
  return (
    <AuthCard onSubmit={submit}>
      <div><b className="auth-title">{t('signin.confirmItsYou')}</b><div className="small muted">{recovery ? t('signin.enterRecoveryCode') : t('signin.enterAppCode')}</div></div>
      <CodeInput key={recovery ? 'r' : 'c'} value={code} onChange={setCode} recovery={recovery} />
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy || !codeReady(code, recovery)}>{busy ? t('main.signingIn') : t('main.signIn')}</button>
      {step.methods?.includes('passkey') && <PasskeyButton onDone={onDone} setErr={setErr} label={t('signin.usePasskeyInstead')} />}
      {hasTotp && step.methods?.includes('recovery') && (
        <button type="button" className="btn ghost sm" onClick={() => { setRecovery(!recovery); setCode(''); setErr(''); }}>
          {recovery ? t('signin.useAppCode') : t('signin.useRecoveryCode')}</button>
      )}
      <div className="help">{t('signin.lostPhone')}</div>
      <button type="button" className="btn ghost sm" onClick={onBack}>{t('main.backToSignIn')}</button>
    </AuthCard>
  );
}

/** No second step yet: set one up before any session. */
function EnrollStep({ ticket, onDone, onBack }) {
  const t = useT();
  const [mode, setMode] = useState('choose'); // choose | totp | codes
  const [codes, setCodes] = useState([]);
  const [deviceKey, setDeviceKey] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { devicePasskeyAvailable().then(setDeviceKey); }, []);
  const passkey = async () => {
    setBusy(true); setErr('');
    try {
      const r = await addPasskey(ticket);
      if (r.recoveryCodes?.length) { setCodes(r.recoveryCodes); setMode('codes'); } else onDone();
    } catch (e) { if (!passkeyCancelled(e)) setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <AuthCard>
      <div><b className="auth-title">{mode === 'codes' ? t('security.saveRecoveryCodes') : t('signin.secureYourAccount')}</b>
        {mode !== 'codes' && <div className="small muted">{t('signin.secureHelp')}</div>}</div>
      {mode === 'choose' && <ChooseFactor passkey={passkeysSupported()} recommendPasskey={deviceKey} busy={busy} onPasskey={passkey} onTotp={() => setMode('totp')} />}
      {mode === 'totp' && <TotpSetup start={() => totpSetup(ticket)} confirm={(code) => totpConfirm(ticket, code)} onBack={() => setMode('choose')}
        onConfirmed={(r) => { if (r.recoveryCodes?.length) { setCodes(r.recoveryCodes); setMode('codes'); } else onDone(); }} />}
      {mode === 'codes' && <RecoveryCodesView codes={codes} onContinue={onDone} />}
      {err && <div className="alert bad">{err}</div>}
      {mode === 'choose' && <button type="button" className="btn ghost sm" onClick={onBack}>{t('main.backToSignIn')}</button>}
    </AuthCard>
  );
}

/** The sign-in screen: password, passkey, email link, forgot password. */
export function SignIn({ onDone, emailEnabled }) {
  const t = useT();
  const [mode, setMode] = useState('login'); // login | forgot | sent | link | linkSent
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const back = () => { setStep(null); setMode('login'); setErr(''); setPassword(''); setCode(''); };
  if (step) return <SecondStep step={step} onDone={onDone} onBack={back} />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (mode === 'forgot') { await forgotPassword(email); setMode('sent'); }
      else if (mode === 'link') { await requestLink(email, code); setMode('linkSent'); }
      else setStep(await passwordStep(email, password));
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  if (mode === 'sent' || mode === 'linkSent') return (
    <AuthCard onSubmit={(e) => { e.preventDefault(); back(); }}>
      <div className="alert ok"><Icon name="send" size={16} />{mode === 'sent' ? t('main.ifEmailHasAnAccount', { email }) : t('signin.linkSent', { email })}</div>
      <button className="btn block">{t('main.backToSignIn')}</button>
    </AuthCard>
  );
  return (
    <AuthCard onSubmit={submit}>
      {mode === 'forgot' && <div className="small muted">{t('main.enterYourSignInEmail')}</div>}
      {mode === 'link' && <div><b className="auth-title">{t('signin.emailLinkTitle')}</b><div className="small muted">{t('signin.emailLinkHelp')}</div></div>}
      <label className="field"><span>{t('common.email')}</span><input className="input" type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
      {mode === 'login' && <label className="field"><span>{t('main.password')}</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
      {mode === 'link' && <CodeInput value={code} onChange={setCode} autoFocus={false} label={t('signin.codeFromApp')} />}
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy || (mode === 'link' && !codeReady(code))}>
        {mode === 'forgot' ? (busy ? t('main.sending') : t('main.emailMeAResetLink')) : mode === 'link' ? (busy ? t('main.sending') : t('signin.sendLink')) : (busy ? t('main.signingIn') : t('main.signIn'))}
      </button>
      {mode === 'login' && <>
        <div className="or-line"><span>{t('signin.or')}</span></div>
        <PasskeyButton onDone={onDone} setErr={setErr} />
        {emailEnabled && <button type="button" className="btn block" onClick={() => { setErr(''); setMode('link'); }}><Icon name="mail" />{t('signin.emailMeALink')}</button>}
      </>}
      {emailEnabled
        ? <button type="button" className="btn ghost sm" onClick={() => { setErr(''); setMode(mode === 'login' ? 'forgot' : 'login'); }}>{mode === 'login' ? t('main.forgotYourPassword') : t('main.backToSignIn')}</button>
        : <div className="help">{t('main.forgotYourPasswordAskA')}</div>}
    </AuthCard>
  );
}

/** Opened from a reset email (#/reset?token=…): a new password, then the second step like any sign-in. */
export function ResetPassword({ token, onDone }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);
  if (step) return <SecondStep step={step} onDone={onDone} onBack={() => { location.hash = '#/'; }} />;
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== pw2) return setErr(t('main.theTwoPasswordsDontMatch'));
    setBusy(true); setErr('');
    try { setStep(await resetWithToken(token, pw)); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <AuthCard onSubmit={submit}>
      <div><b className="auth-title">{t('main.chooseYourPassword')}</b><div className="small muted">{t('signin.passwordRules')}</div></div>
      <label className="field"><span>{t('main.newPassword')}</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoFocus /></label>
      <label className="field"><span>{t('main.repeatIt')}</span><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={10} /></label>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? t('main.saving') : t('signin.saveAndContinue')}</button>
      <a className="btn ghost sm" href="#/">{t('main.backToSignIn')}</a>
    </AuthCard>
  );
}

/** Opened from a sign-in link email (#/link?token=…): signs in once. */
export function LinkSignIn({ token, onDone }) {
  const t = useT();
  const [err, setErr] = useState('');
  useEffect(() => {
    consumeLink(token).then(onDone, (e) => setErr(e.message));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AuthCard>
      {err ? <div className="alert bad">{err}</div> : <div className="small muted">{t('signin.signingInWithLink')}</div>}
      {err && <a className="btn block" href="#/">{t('main.backToSignIn')}</a>}
    </AuthCard>
  );
}
