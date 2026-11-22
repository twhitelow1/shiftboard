// My settings (#/account): my profile (photo, name, mobile number) and Sign-in & security (password, the
// authenticator app, passkeys, recovery codes). The routes are in server/auth.js; the demo shows a sample.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { securityInfo, totpSetup, totpConfirm, addPasskey, renamePasskey, removePasskey, removeTotp, newRecoveryCodes, passkeysSupported, passkeyCancelled } from '../auth-api.js';
import { useT, stampDay } from '../i18n/index.js';
import { normalizePhone } from '../../../core/notify-prefs.js';
import { PhotoPicker } from './ProfilePhoto.jsx';
import { TotpSetup, RecoveryCodesView } from './TwoStep.jsx';
import { rememberDemoPhoto } from '../photo.js';
import '../auth.css';

export default function Account() {
  return (
    <div style={{ maxWidth: 720 }} className="col">
      <ProfileCard />
      <SecurityCard />
    </div>
  );
}

function ProfileCard() {
  const t = useT();
  const { me, call, refresh } = useApp();
  const [run, busy] = useAction();
  const [name, setName] = useState(me.name || '');
  const [phone, setPhone] = useState(me.phone || '');
  const badPhone = phone.trim() && !normalizePhone(phone);
  const savePhoto = async (dataUrl) => {
    const r = await run(() => call('profile.setPhoto', { dataUrl }), t('security.photoSaved'));
    if (r) rememberDemoPhoto(r.photoId, dataUrl);
  };
  return (
    <div className="card card-pad col section" style={{ gap: 12 }}>
      <h2>{t('security.myProfile')}</h2>
      <PhotoPicker user={me} busy={busy} onSave={savePhoto} onRemove={() => run(() => call('profile.removePhoto'), t('security.photoRemoved'))} />
      <form className="col" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); run(() => call('profile.update', { name, phone }), t('common.saved')).then((r) => r && setPhone(r.phone)); }}>
        <label className="field"><span>{t('common.name')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>
        <label className="field"><span>{t('security.mobilePhone')}</span>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(303) 555-0142" />
          <div className="help">{badPhone ? t('security.phoneLooksWrong') : t('security.phoneHelp')}</div>
        </label>
        <div><button className="btn primary" disabled={busy || !name.trim() || badPhone}>{t('common.save')}</button></div>
      </form>
    </div>
  );
}

const SAMPLE = { twoStep: { on: true, totp: true, passkeys: 1, recoveryLeft: 9 }, factors: [
  { id: 'f1', type: 'totp', createdAt: '2026-09-20T15:00:00Z', lastUsedAt: '2026-09-26T21:10:00Z' },
  { id: 'f2', type: 'passkey', name: 'iPhone', createdAt: '2026-09-20T15:02:00Z', lastUsedAt: '2026-09-27T11:40:00Z' },
] };

function SecurityCard() {
  const t = useT();
  const { call, toast, tenant } = useApp();
  const support = !!tenant?.support;
  const [info, setInfo] = useState(IS_DEMO ? SAMPLE : null);
  const [mode, setMode] = useState(null); // null | 'totp' | 'codes'
  const [codes, setCodes] = useState([]);
  const [editing, setEditing] = useState(null); // { id, name }
  const [sure, setSure] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => (IS_DEMO ? Promise.resolve() : securityInfo().then(setInfo, (e) => toast(e.message, 'bad')));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn, ok) => {
    if (IS_DEMO) { toast(t('security.demoOnly')); return null; }
    setBusy(true);
    try { const r = await fn(); if (r?.twoStep) setInfo(r); else await load(); if (ok) toast(ok); return r || true; }
    catch (e) { if (!passkeyCancelled(e)) toast(e.message, 'bad'); return null; } finally { setBusy(false); setSure(null); }
  };
  const showCodes = (list) => { if (list?.length) { setCodes(list); setMode('codes'); } else setMode(null); };

  if (!info) return <div className="card card-pad section"><h2>{t('security.signInSecurity')}</h2><div className="small muted">{t('common.loading')}</div></div>;
  const totp = info.factors.find((f) => f.type === 'totp');
  const passkeys = info.factors.filter((f) => f.type === 'passkey');
  const secondSteps = (totp ? 1 : 0) + passkeys.length;
  const dates = (f) => [t('security.added', { date: stampDay(f.createdAt) }), f.lastUsedAt ? t('security.lastUsed', { date: stampDay(f.lastUsedAt) }) : null].filter(Boolean).join(' · ');

  return (
    <div className="card card-pad col section" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 8 }}><h2 style={{ flex: 1 }}>{t('security.signInSecurity')}</h2>
        <span className={`badge ${info.twoStep.on ? 'ok' : 'warn'}`}><Icon name="shield" size={12} />{info.twoStep.on ? t('security.twoStepOn') : t('security.twoStepOff')}</span></div>
      {IS_DEMO && <div className="help">{t('security.demoNote')}</div>}
      {support && <div className="alert warn"><Icon name="alert" size={16} />{t('security.notInSupport')}</div>}

      {mode === 'codes' && (
        <div className="sec-block">
          <h3>{t('security.saveRecoveryCodes')}</h3>
          <RecoveryCodesView codes={codes} onContinue={() => setMode(null)} continueLabel={t('common.done')} />
        </div>
      )}

      <div className="sec-block">
        <div className="sec-head"><Icon name="phone" size={18} /><b>{t('security.authenticatorApp')}</b>
          <span className={`badge ${totp ? 'ok' : ''}`}>{totp ? t('security.on') : t('security.notSetUp')}</span></div>
        <div className="small muted">{totp ? dates(totp) : t('security.authenticatorHelp')}</div>
        {mode === 'totp' ? (
          <TotpSetup start={() => totpSetup()} confirm={(code) => totpConfirm(null, code)} onBack={() => setMode(null)}
            onConfirmed={(r) => { load(); toast(t('security.appSaved')); showCodes(r.recoveryCodes); }} />
        ) : !support && (
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => (IS_DEMO ? toast(t('security.demoOnly')) : setMode('totp'))}>{totp ? t('security.replaceApp') : t('security.setUpApp')}</button>
            {totp && (sure === 'totp'
              ? <><button type="button" className="btn sm danger solid" disabled={busy} onClick={() => act(removeTotp, t('security.appRemoved'))}>{t('security.yesRemove')}</button>
                <button type="button" className="btn sm ghost" onClick={() => setSure(null)}>{t('common.cancel')}</button></>
              : <button type="button" className="btn sm ghost" disabled={busy || secondSteps < 2} title={secondSteps < 2 ? t('security.addAnotherFirst') : undefined} onClick={() => setSure('totp')}>{t('common.remove')}</button>)}
          </div>
        )}
      </div>

      <div className="sec-block">
        <div className="sec-head"><Icon name="key" size={18} /><b>{t('security.passkeys')}</b><span className="badge">{passkeys.length}</span></div>
        <div className="small muted">{t('security.passkeysHelp')}</div>
        {passkeys.length > 0 && (
          <div className="list card">
            {passkeys.map((p) => (
              <div key={p.id} className="list-item passkey-row">
                {editing?.id === p.id ? (
                  <form className="row wrap grow" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act(() => renamePasskey(p.id, editing.name), t('common.saved')).then(() => setEditing(null)); }}>
                    <input className="input grow" value={editing.name} maxLength={40} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label={t('security.passkeyName')} />
                    <button className="btn sm primary" disabled={busy || !editing.name.trim()}>{t('common.save')}</button>
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                  </form>
                ) : (
                  <>
                    <div className="grow" style={{ minWidth: 0 }}><div className="passkey-name">{p.name || t('security.passkey')}</div><div className="tiny muted">{dates(p)}</div></div>
                    {!support && <div className="row" style={{ gap: 4 }}>
                      <button type="button" className="btn sm ghost" onClick={() => setEditing({ id: p.id, name: p.name || '' })}>{t('security.rename')}</button>
                      {sure === p.id
                        ? <button type="button" className="btn sm danger solid" disabled={busy} onClick={() => act(() => removePasskey(p.id), t('security.passkeyRemoved'))}>{t('security.yesRemove')}</button>
                        : <button type="button" className="btn sm ghost" disabled={busy || secondSteps < 2} title={secondSteps < 2 ? t('security.addAnotherFirst') : undefined} onClick={() => setSure(p.id)}>{t('common.remove')}</button>}
                    </div>}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {!support && (passkeysSupported() || IS_DEMO
          ? <div><button type="button" className="btn sm" disabled={busy} onClick={() => act(() => addPasskey(null), t('security.passkeyAdded')).then((r) => r && showCodes(r.recoveryCodes))}><Icon name="plus" />{t('security.addPasskey')}</button></div>
          : <div className="help">{t('security.noPasskeysHere')}</div>)}
      </div>

      <div className="sec-block">
        <div className="sec-head"><Icon name="lock" size={18} /><b>{t('security.recoveryCodes')}</b>
          <span className={`badge ${info.twoStep.recoveryLeft > 2 ? '' : 'warn'}`}>{t('security.codesLeft', { count: info.twoStep.recoveryLeft })}</span></div>
        <div className="small muted">{t('security.recoveryHelp')}</div>
        {!support && info.twoStep.on && (sure === 'codes'
          ? <div className="row wrap" style={{ gap: 8 }}><span className="small">{t('security.newCodesWarning')}</span>
            <button type="button" className="btn sm danger solid" disabled={busy} onClick={() => act(newRecoveryCodes).then((r) => r && showCodes(r.recoveryCodes))}>{t('security.getNewCodes')}</button>
            <button type="button" className="btn sm ghost" onClick={() => setSure(null)}>{t('common.cancel')}</button></div>
          : <div><button type="button" className="btn sm" disabled={busy} onClick={() => setSure('codes')}>{t('security.getNewCodes')}</button></div>)}
      </div>

      {!IS_DEMO && !support && <PasswordBlock />}
    </div>
  );
}

function PasswordBlock() {
  const t = useT();
  const { call } = useApp();
  const [pw, setPw] = useState('');
  const [run, busy] = useAction();
  return (
    <form className="sec-block" onSubmit={(e) => { e.preventDefault(); run(() => call('employees.changePassword', { password: pw }), t('myShifts.passwordChanged')).then((r) => r && setPw('')); }}>
      <div className="sec-head"><Icon name="lock" size={18} /><b>{t('myShifts.changeMyPassword')}</b></div>
      <div className="small muted">{t('signin.passwordRules')} {t('security.passwordSignsOut')}</div>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input grow" type="password" placeholder={t('main.newPassword')} aria-label={t('main.newPassword')} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        <button className="btn" disabled={busy || pw.length < 10}>{t('common.save')}</button>
      </div>
    </form>
  );
}

