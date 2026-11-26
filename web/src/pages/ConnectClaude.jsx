// Connecting Claude (#/authorize?r=…): /oauth/authorize sends people here with a signed request. They sign in with
// ShiftBoard's own sign-in (password and the second step, or a passkey; a fresh one, even if they were signed in),
// agree to the terms if they never did, then see what Claude will be able to do as them and Allow or Deny.
// The server (server/mcp/index.js) checks everything again and sends them back to Claude with a code.
import React, { useCallback, useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';
import { call, logout, getConfig, IS_DEMO } from '../api.js';
import { authRequest, decide } from '../mcp-api.js';
import { useT } from '../i18n/index.js';
import { AuthCard } from './AuthCard.jsx';
import { SignIn } from './SignIn.jsx';
import { ConsentGate } from './Onboarding.jsx';
import '../claude.css';

export default function ConnectClaude({ r }) {
  const t = useT();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null); // { code, message }
  const [me, setMe] = useState(null); // for the terms screen
  const [legal, setLegal] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const i = await authRequest(r);
      setInfo(i); setErr(null);
      if (i.person?.fresh && i.person.needsTerms) {
        const [b, c] = await Promise.all([call('app.bootstrap'), getConfig()]);
        setMe(b.me); setLegal(c?.legal || null);
      }
    } catch (e) { setErr({ code: e.code || 'expired', message: e.message }); }
  }, [r]);
  useEffect(() => { if (!IS_DEMO) load(); }, [load]);

  if (IS_DEMO) return <AuthCard><div className="alert info"><Icon name="sparkle" size={16} />{t('claude.demo')}</div></AuthCard>;
  if (err) {
    const known = ['expired', 'notInPlan', 'turnedOff', 'paused'].includes(err.code);
    return <AuthCard><div className="alert warn"><Icon name="alert" size={16} /><span>{known ? t(`claude.err_${err.code}`) : err.message}</span></div></AuthCard>;
  }
  if (!info) return <AuthCard><div className="small muted">{t('common.loading')}</div></AuthCard>;

  const client = info.client.name;
  const p = info.person;
  const switchAccount = async () => { await logout(); setMe(null); await load(); };
  if (p?.support) {
    return (
      <AuthCard>
        <div className="alert warn"><Icon name="alert" size={16} /><span>{t('claude.support')}</span></div>
        <button type="button" className="btn block" onClick={switchAccount}>{t('main.signOut')}</button>
      </AuthCard>
    );
  }
  if (!p || !p.fresh) {
    const intro = <div className="claude-intro"><Icon name="link" size={18} /><span>{t(p ? 'claude.confirmToConnect' : 'claude.signInToConnect', { client })}</span></div>;
    return <SignIn emailEnabled={false} intro={intro} onDone={load} />;
  }
  if (p.needsTerms) {
    if (!me) return <AuthCard><div className="small muted">{t('common.loading')}</div></AuthCard>;
    return <ConsentGate me={me} sms={false} legal={legal} call={call} onDone={() => { setMe(null); load(); }} onSignOut={switchAccount} />;
  }

  const forced = info.readOnlyForced || !info.scopes.includes('shiftboard.write');
  const ro = forced || readOnly;
  const go = async (allow) => {
    setBusy(true);
    try {
      const out = await decide(r, allow, ro);
      setLeaving(true);
      window.location.assign(out.redirect);
    } catch (e) {
      if (e.code === 'signIn' || e.status === 401) { await load(); } else setErr({ code: e.code, message: e.message });
    } finally { setBusy(false); }
  };
  if (leaving) return <AuthCard><div className="small muted">{t('claude.takingYouBack', { client })}</div></AuthCard>;

  return (
    <AuthCard wide>
      <div className="claude-head">
        <div className="claude-mark" aria-hidden="true"><Icon name="sparkle" size={22} /></div>
        <div style={{ minWidth: 0 }}>
          <b className="auth-title">{t('claude.wantsToUse', { client })}</b>
          <div className="small">{t('claude.asYou', { name: p.name, role: p.role, restaurant: info.restaurant })}</div>
        </div>
      </div>
      {info.client.kind === 'loopback' && <div className="alert warn"><Icon name="alert" size={16} /><span>{t('claude.localWarning', { host: info.client.redirectHost })}</span></div>}
      <div>
        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t('claude.itCan')}</div>
        <ul className="claude-can">
          {info.capabilities.map((c) => (
            <li key={c.key} className={c.write && ro ? 'off' : ''}>
              <Icon name={c.write && ro ? 'x' : 'check'} size={16} />
              <span>{t(`claude.can_${c.key}`)}{c.write && <span className={`claude-tag ${ro ? '' : 'write'}`}>{ro ? t('claude.notAllowed') : t('claude.changesTag')}</span>}</span>
            </li>
          ))}
        </ul>
      </div>
      {info.readOnlyForced ? <div className="alert info"><Icon name="lock" size={16} /><span>{t('claude.readOnlyForced')}</span></div>
        : !info.scopes.includes('shiftboard.write') ? <div className="help">{t('claude.readOnlyRequested')}</div>
          : <label className="consent-box"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /><span>{t('claude.readOnly')}</span></label>}
      <div className="help">{t('claude.howItWorks')}</div>
      <div className="claude-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => go(true)}>{t('claude.allow')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => go(false)}>{t('claude.deny')}</button>
      </div>
      <div className="tiny muted" style={{ textAlign: 'center' }}>{t('claude.sendsBackTo', { host: info.client.redirectHost })}</div>
      <button type="button" className="btn ghost sm" onClick={switchAccount}>{t('claude.notYou', { name: p.name })}</button>
    </AuthCard>
  );
}
