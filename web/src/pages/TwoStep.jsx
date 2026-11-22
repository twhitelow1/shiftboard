// The pieces of two-step sign-in that the sign-in screens, the welcome wizard and My settings share:
// choosing a passkey or an authenticator app, setting up the app (QR code + manual key + a code to confirm),
// and the 10 recovery codes (copy / download, "I saved these").
import React, { useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import { Icon } from '../ui.jsx';
import { useT } from '../i18n/index.js';

/** A QR code as an inline SVG (no network, no canvas). */
export function QrCode({ text, size = 184 }) {
  const t = useT();
  const path = useMemo(() => {
    if (!text) return null;
    const { data, size: n } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, n };
  }, [text]);
  if (!path) return <div className="qr-box" style={{ width: size, height: size }} />;
  return (
    <svg className="qr-box" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} role="img" aria-label={t('security.qrLabel')} shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** A 6-digit code box (or a recovery code): big, numeric keyboard, filled in by the phone when it can. */
export function CodeInput({ value, onChange, recovery = false, autoFocus = true, label }) {
  const t = useT();
  return (
    <label className="field">
      <span>{label || (recovery ? t('signin.recoveryCode') : t('signin.sixDigitCode'))}</span>
      <input className="input code-input" value={value} autoFocus={autoFocus} required
        onChange={(e) => onChange(recovery ? e.target.value.toUpperCase().replace(/[^A-Z0-9-\s]/g, '').slice(0, 12) : e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode={recovery ? 'text' : 'numeric'} autoComplete={recovery ? 'off' : 'one-time-code'} autoCapitalize="characters" spellCheck={false}
        pattern={recovery ? undefined : '[0-9]{6}'} placeholder={recovery ? 'XXXXX-XXXXX' : '123456'} />
    </label>
  );
}
export const codeReady = (code, recovery = false) => (recovery ? code.replace(/[^A-Z0-9]/gi, '').length === 10 : /^\d{6}$/.test(code));

/** Pick how to secure the account: a passkey (recommended when this device can make one) or an authenticator app. */
export function ChooseFactor({ passkey, recommendPasskey, onPasskey, onTotp, busy }) {
  const t = useT();
  const opts = [
    passkey && { key: 'passkey', icon: 'key', title: t('security.usePasskey'), help: t('security.passkeyHelp'), rec: recommendPasskey, onClick: onPasskey },
    { key: 'totp', icon: 'phone', title: t('security.useAuthenticator'), help: t('security.authenticatorHelp'), rec: !passkey || !recommendPasskey, onClick: onTotp },
  ].filter(Boolean);
  return (
    <div className="col" style={{ gap: 10 }}>
      {opts.map((o) => (
        <button key={o.key} type="button" className="factor-option" disabled={busy} onClick={o.onClick}>
          <Icon name={o.icon} size={22} />
          <span className="factor-text">
            <span className="factor-title">{o.title}{o.rec && <span className="badge ok">{t('security.recommended')}</span>}</span>
            <span className="small muted">{o.help}</span>
          </span>
          <Icon name="right" size={18} />
        </button>
      ))}
    </div>
  );
}

/** Group a base32 key in fours so it's easy to type. */
const grouped = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim();

/**
 * Set up an authenticator app. start() → { secret, otpauthUrl }; confirm(code) → whatever the server answers
 * (recovery codes and maybe a session); onConfirmed gets it. onBack: go back to choosing.
 */
export function TotpSetup({ start, confirm, onConfirmed, onBack }) {
  const t = useT();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    start().then((s) => live && setSetup(s), (e) => live && setErr(e.message));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!codeReady(code)) return;
    setBusy(true); setErr('');
    try { onConfirmed(await confirm(code)); } catch (e) { setErr(e.message); setCode(''); } finally { setBusy(false); }
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <ol className="steps-list small">
        <li>{t('security.totpStep1')}</li>
        <li>{t('security.totpStep2')}</li>
        <li>{t('security.totpStep3')}</li>
      </ol>
      <div className="qr-wrap">
        <QrCode text={setup?.otpauthUrl} />
        {setup && <a className="btn sm mobile-only" href={setup.otpauthUrl}><Icon name="phone" />{t('security.openInApp')}</a>}
      </div>
      <div className="field">
        <span>{t('security.orTypeKey')}</span>
        <div className="row" style={{ gap: 6 }}>
          <code className="secret-key" aria-label={t('security.setupKey')}>{setup ? grouped(setup.secret) : '…'}</code>
          <button type="button" className="btn sm" disabled={!setup} onClick={() => { navigator.clipboard?.writeText(setup.secret); setCopied(true); }}><Icon name="copy" />{copied ? t('security.copied') : t('security.copy')}</button>
        </div>
      </div>
      <CodeInput value={code} onChange={setCode} autoFocus={false} label={t('security.enterCodeFromApp')} />
      {err && <div className="alert bad">{err}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn primary grow" disabled={busy || !setup || !codeReady(code)} onClick={submit}>{busy ? t('security.checking') : t('security.confirm')}</button>
        {onBack && <button type="button" className="btn ghost" onClick={onBack}>{t('security.back')}</button>}
      </div>
    </div>
  );
}

/** The 10 recovery codes: shown once, copy or download, and (when asked) "I saved these" before going on. */
export function RecoveryCodesView({ codes, onContinue, requireAck = true, continueLabel, restaurant = 'ShiftBoard' }) {
  const t = useT();
  const [saved, setSaved] = useState(!requireAck);
  const [copied, setCopied] = useState(false);
  const text = `${t('security.codesFileTitle', { restaurant })}\n\n${codes.join('\n')}\n\n${t('security.codesFileHelp')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'shiftboard-recovery-codes.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small">{t('security.codesIntro')}</div>
      <ol className="recovery-codes" aria-label={t('security.recoveryCodes')}>
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ol>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn sm grow" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); setCopied(true); }}><Icon name="copy" />{copied ? t('security.copied') : t('security.copyCodes')}</button>
        <button type="button" className="btn sm grow" onClick={download}><Icon name="download" />{t('security.downloadCodes')}</button>
      </div>
      {requireAck && <label className="check big-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />{t('security.iSavedThese')}</label>}
      {onContinue && <button type="button" className="btn primary block" disabled={!saved} onClick={onContinue}>{continueLabel || t('security.continue')}</button>}
    </div>
  );
}
