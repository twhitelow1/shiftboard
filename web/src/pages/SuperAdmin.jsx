// An Admin making themselves Super Admin (core/super-admin.js), on the web only:
//   - BecomeSuperAdminCard: My settings → Become Super Admin. Admins only, while the restaurant allows it, never in
//     View as or a DubLow support session. Explain → confirm → the second step (a code from the authenticator app,
//     or a passkey, sent with the request: server/auth.js stepUp) → done. The demo walks through it, changing nothing.
//   - SelfPromotionSetting: Settings → Roles & features → "Admins can make themselves Super Admin". Admins see it
//     read-only; Super Admins switch it.
import React, { useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { securityInfo, stepUpPasskey, passkeysSupported, passkeyCancelled } from '../auth-api.js';
import { roleOf } from '../../../core/roles.js';
import { useT } from '../i18n/index.js';
import { CodeInput, codeReady } from './TwoStep.jsx';
import '../auth.css';
import '../view-as.css';

const on = (settings) => settings?.adminsCanBecomeSuperAdmin !== false;

export function BecomeSuperAdminCard() {
  const t = useT();
  const { me, settings, call, refresh, toast, tenant, viewAs } = useApp();
  const [stage, setStage] = useState('intro'); // intro | confirm | verify | done
  const [factors, setFactors] = useState(null); // { totp, passkeys }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  if (stage !== 'done' && (viewAs || tenant?.support || roleOf(me) !== 'admin' || me.active === false || !on(settings))) return null;

  const verify = async () => {
    setStage('verify');
    if (IS_DEMO) { setFactors({ totp: true, passkeys: 1 }); return; }
    try { const s = await securityInfo(); setFactors({ totp: !!s.twoStep.totp, passkeys: s.twoStep.passkeys || 0 }); } catch (e) { toast(e.message, 'bad'); setFactors({ totp: true, passkeys: 0 }); }
  };
  const become = async (how) => {
    if (IS_DEMO) { toast(t('security.demoOnly')); return; }
    setBusy(true);
    try {
      const proof = how === 'passkey' ? { passkey: await stepUpPasskey() } : { code };
      await call('account.becomeSuperAdmin', proof);
      setStage('done');
      refresh();
    } catch (e) {
      if (!passkeyCancelled(e)) toast(e.message, 'bad');
      setCode('');
    } finally { setBusy(false); }
  };

  return (
    <div className="card card-pad col section sa-card" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}><h2 style={{ flex: 1 }}>{t('superAdmin.cardTitle')}</h2><Icon name="shield" size={20} /></div>
      {stage === 'done' ? (
        <div className="alert ok" role="status"><Icon name="check" size={16} /><div><b>{t('superAdmin.doneTitle')}</b><div>{t('superAdmin.doneBody')}</div></div></div>
      ) : (
        <>
          <div className="help">{t('superAdmin.cardHelp')}</div>
          {IS_DEMO && <div className="help">{t('superAdmin.demoNote')}</div>}
          <div className="sec-block">
            <b>{t('superAdmin.effectTitle')}</b>
            <ul className="small sa-effects">
              <li>{t('superAdmin.effectControl')}</li>
              <li>{t('superAdmin.effectSignedIn')}</li>
              <li>{t('superAdmin.effectTold')}</li>
              <li>{t('superAdmin.effectUndo')}</li>
            </ul>
          </div>
          {stage === 'intro' && <div><button type="button" className="btn" onClick={() => setStage('confirm')}><Icon name="shield" />{t('superAdmin.start')}</button></div>}
          {stage === 'confirm' && (
            <div className="sec-block">
              <b>{t('superAdmin.confirmTitle')}</b>
              <div className="small muted">{t('superAdmin.confirmBody')}</div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button type="button" className="btn primary" onClick={verify}>{t('superAdmin.yesContinue')}</button>
                <button type="button" className="btn ghost" onClick={() => setStage('intro')}>{t('common.cancel')}</button>
              </div>
            </div>
          )}
          {stage === 'verify' && (
            <div className="sec-block">
              <b>{t('superAdmin.verifyTitle')}</b>
              <div className="small muted">{t('superAdmin.verifyHelp')}</div>
              {!factors ? <div className="small muted">{t('common.loading')}</div> : (
                <>
                  {factors.totp && (
                    <form className="col" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (codeReady(code)) become('totp'); }}>
                      <CodeInput value={code} onChange={setCode} label={t('superAdmin.code')} />
                      <div><button className="btn primary" disabled={busy || !codeReady(code)}><Icon name="shield" />{t('superAdmin.confirm')}</button></div>
                    </form>
                  )}
                  {factors.totp && factors.passkeys > 0 && <div className="small muted">{t('superAdmin.or')}</div>}
                  {factors.passkeys > 0 && (passkeysSupported() || IS_DEMO
                    ? <div><button type="button" className="btn" disabled={busy} onClick={() => become('passkey')}><Icon name="key" />{t('superAdmin.usePasskey')}</button></div>
                    : <div className="help">{t('superAdmin.noPasskeyHere')}</div>)}
                  <div><button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setStage('intro'); setCode(''); }}>{t('common.cancel')}</button></div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function SelfPromotionSetting() {
  const t = useT();
  const { me, settings, call, refresh, toast, tenant, viewAs } = useApp();
  const [busy, setBusy] = useState(false);
  const value = on(settings);
  const support = !!tenant?.support;
  const canChange = roleOf(me) === 'super_admin' && !viewAs && !support;
  const change = async (next) => {
    setBusy(true);
    try {
      await call('settings.adminsCanBecomeSuperAdmin', { on: next });
      toast(next ? t('superAdmin.turnedOn') : t('superAdmin.turnedOff'));
      refresh();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad col sa-setting" style={{ gap: 10 }}>
      <div className="row sa-setting-row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 id="sa-setting-title">{t('superAdmin.settingTitle')}</h2>
          <div className="help">{t('superAdmin.settingHelp')}</div>
        </div>
        <div className="col" style={{ alignItems: 'center', gap: 4, flex: 'none' }}>
          <label className="rf-switch">
            <input type="checkbox" role="switch" checked={value} disabled={busy || !canChange} aria-labelledby="sa-setting-title" onChange={(e) => change(e.target.checked)} />
            <span />
          </label>
          <span className="tiny muted">{value ? t('superAdmin.on') : t('superAdmin.off')}</span>
        </div>
      </div>
      <div className="help">{t('superAdmin.settingOffHelp')}</div>
      {!canChange && <div className="help"><Icon name="lock" size={12} /> {support ? t('superAdmin.notInSupport') : t('superAdmin.superOnly')}</div>}
    </div>
  );
}
