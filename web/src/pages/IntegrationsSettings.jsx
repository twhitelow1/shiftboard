// Settings → Integrations: one panel per integration in the restaurant's plan (ADP, Toast, Tripleseat,
// the text sender, the email From). Each has its status, the fields to paste its credentials into (the
// restaurant's admins save them; secrets are encrypted and only ever shown as "set, ends in 1234"), plain
// help on where to find them, and then the integration's own panel (Sync now, matching, its rules…).
// On a single-restaurant install everything comes from env vars, so the fields are read-only.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { IS_DEMO, getConfig, sendTestEmail, sendTestText } from '../api.js';
import { getIntegrations, saveIntegrations } from '../integrations-api.js';
import { AdpPanel } from './AdpSettings.jsx';
import { ToastPanel } from './ToastSettings.jsx';
import { TripleseatPanel } from './TripleseatSettings.jsx';
import { normalizePhone } from '../../../core/notify-prefs.js';
import '../labor.css';
import { useT, translateError } from '../i18n/index.js';

// Settings most restaurants never need: under "More options".
const ADVANCED = new Set(['TOAST_API_HOST', 'ADP_MANAGER_AOID', 'TRIPLESEAT_SITE_ID', 'TRIPLESEAT_API_HOST', 'TRIPLESEAT_PUBLIC_KEY', 'TRIPLESEAT_SECRET_KEY', 'EMAIL_REPLY_TO']);
const STATUS_BADGE = { connected: 'ok', partial: 'warn', notSetUp: '', noAccount: 'warn', demo: '' };

/** The restaurant's integration settings; reloads when the app's version changes. */
export function useIntegrations() {
  const { version } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { getIntegrations().then(setData).catch((e) => setError(e.message)); }, [version]);
  return { data, setData, error };
}

export function IntegrationsCard() {
  const t = useT();
  const { has } = useApp();
  const { data, setData, error } = useIntegrations();
  const show = (key) => key !== 'tripleseat' || !has || has('events'); // Tripleseat feeds Events & BEOs
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('toastSettings.integrations')}</h2>
      <div className="help">{t('integrations.intro')}</div>
      {error && !data && <div className="alert bad">{translateError(error)}</div>}
      {!data && !error && <div className="small faint">{t('common.loading')}</div>}
      {data?.mode === 'env' && <div className="alert info"><Icon name="settings" size={16} /><div>{t('integrations.envMode')}</div></div>}
      {data?.mode === 'platform' && !data.encryption && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('integrations.noEncryption')}</div></div>}
      {data?.envFallback && <div className="help">{t('integrations.envFallback')}</div>}
      {data?.groups.filter((g) => show(g.key)).map((g) => <IntegrationPanel key={g.key} group={g} data={data} onSaved={setData} />)}
    </div>
  );
}

function StatusBadge({ group }) {
  const t = useT();
  const label = group.status === 'demo' ? t('integrations.status_demo')
    : group.status === 'partial' ? t('integrations.status_partial', { names: group.missing.map((k) => t(`integrations.field_${k}`)).join(', ') })
      : group.status === 'noAccount' ? t(`integrations.noAccount_${group.key}`) : t(`integrations.status_${group.status}`);
  return <span className={`badge ${STATUS_BADGE[group.status] ?? ''}`}>{group.status === 'connected' && <Icon name="check" size={12} />}{label}</span>;
}

function IntegrationPanel({ group, data, onSaved }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const connect = data.editable; // fields to paste into, instead of "add it in Vercel"
  return (
    <details className="int-panel" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="int-title">{t(`integrations.title_${group.key}`)}</span>
        <StatusBadge group={group} />
      </summary>
      {open && (
        <div className="col" style={{ gap: 12, paddingTop: 10 }}>
          {group.status !== 'demo' && <ConnectionForm group={group} data={data} onSaved={onSaved} />}
          {group.key === 'adp' && <AdpPanel embedded connect={connect} />}
          {group.key === 'toast' && <ToastPanel embedded connect={connect} />}
          {group.key === 'tripleseat' && <TripleseatPanel embedded connect={connect} />}
          {group.status === 'demo' && ['twilio', 'email'].includes(group.key) && <div className="help">{t('integrations.demo')}</div>}
          {group.key === 'twilio' && group.status !== 'demo' && <TextTest group={group} />}
          {group.key === 'email' && <EmailTest group={group} />}
        </div>
      )}
    </details>
  );
}

/** The credentials for one integration: paste, Save; a secret shows only "set, ends in 1234". */
function ConnectionForm({ group, data, onSaved }) {
  const t = useT();
  const { toast, refresh } = useApp();
  const [vals, setVals] = useState({});
  const [editing, setEditing] = useState({});
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = data.editable && data.encryption;
  const changed = Object.entries(vals).filter(([k, v]) => {
    const f = group.fields.find((x) => x.key === k);
    return f && (f.secret ? v !== undefined && (v !== '' || f.set) : v !== (f.value || ''));
  });
  const save = async () => {
    setBusy(true);
    try {
      const r = await saveIntegrations(Object.fromEntries(changed));
      onSaved(r);
      setVals({}); setEditing({});
      toast(r.changed?.length ? t('integrations.saved') : t('integrations.nothingChanged'));
      refresh(); // the integration's own panel reads its status again, from the new settings
    } catch (e) {
      toast(translateError(e.message), 'bad');
    } finally { setBusy(false); }
  };
  const field = (f) => {
    const label = t(`integrations.field_${f.key}`);
    const note = f.fromEnv ? t('integrations.fromEnv') : '';
    if (!editable) {
      const state = f.secret ? (f.set ? t('integrations.setEnds', { last4: f.last4 || '••••' }) : f.fromEnv ? note : t('integrations.notSet')) : (f.value || note || t('integrations.notSet'));
      return <Field key={f.key} label={label}><div className="int-readonly"><span>{state}</span>{data.mode === 'env' && <code>{f.key}</code>}</div></Field>;
    }
    if (f.secret) {
      const typing = editing[f.key] || (!f.set && vals[f.key] !== '');
      return (
        <Field key={f.key} label={label} help={note || (f.set ? '' : t('integrations.secretHelp'))}>
          {typing ? (f.multiline
            ? <textarea className="input mono" rows={4} autoComplete="off" spellCheck={false} value={vals[f.key] ?? ''} placeholder={t('integrations.pasteFile')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            : <input className="input mono" type="password" autoComplete="off" value={vals[f.key] ?? ''} placeholder={f.set ? t('integrations.newValue') : t('integrations.paste')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />)
            : (
              <div className="int-secret">
                <span className="mono">{vals[f.key] === '' ? t('integrations.willClear') : t('integrations.setEnds', { last4: f.last4 || '••••' })}</span>
                <button type="button" className="btn sm" onClick={() => setEditing({ ...editing, [f.key]: true })}>{t('integrations.replace')}</button>
                {vals[f.key] !== '' && <button type="button" className="btn sm ghost" onClick={() => setVals({ ...vals, [f.key]: '' })}>{t('integrations.clear')}</button>}
              </div>
            )}
        </Field>
      );
    }
    return (
      <Field key={f.key} label={label} help={note}>
        <input className="input mono" value={vals[f.key] ?? f.value ?? ''} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
      </Field>
    );
  };
  const basic = group.fields.filter((f) => !ADVANCED.has(f.key));
  const extra = group.fields.filter((f) => ADVANCED.has(f.key));
  return (
    <div className="adp-block">
      <b>{t('integrations.connection')}</b>
      <div className="small muted">{t(`integrations.help_${group.key}`)}</div>
      {group.from && <div className="small">{t('integrations.emailsGoOutAs', { from: group.from })}</div>}
      <div className="grid2">{basic.map(field)}</div>
      {extra.length > 0 && (
        <>
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(!more)}><Icon name={more ? 'up' : 'down'} size={14} />{t('integrations.moreOptions')}</button>
          {more && <div className="grid2">{extra.map(field)}</div>}
        </>
      )}
      {editable && (
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary sm" disabled={busy || !changed.length} onClick={save}><Icon name="check" />{t('integrations.save')}</button>
          {changed.length > 0 && <button className="btn ghost sm" disabled={busy} onClick={() => { setVals({}); setEditing({}); }}>{t('common.undo')}</button>}
          <span className="help">{t('integrations.secretsNote')}</span>
        </div>
      )}
    </div>
  );
}

function TextTest({ group }) {
  const t = useT();
  const { me } = useApp();
  const [phone, setPhone] = useState(me.phone || '');
  const [run, busy] = useAction();
  if (group.status !== 'connected') return <div className="help">{t('integrations.textsAfter')}</div>;
  return (
    <form className="row wrap phone-row" onSubmit={(e) => { e.preventDefault(); run(() => sendTestText(phone), (r) => t('phoneCards.testTextSentToTo', { to: r.to })); }}>
      <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('phoneCards.yourMobileNumber')} aria-label={t('phoneCards.yourMobileNumber')} value={phone} onChange={(e) => setPhone(e.target.value)} />
      <button className="btn sm" disabled={busy || !normalizePhone(phone)}><Icon name="send" />{t('phoneCards.sendMeATestText')}</button>
    </form>
  );
}

function EmailTest({ group }) {
  const t = useT();
  const [run, busy] = useAction();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { if (!IS_DEMO) getConfig().then((c) => setEnabled(!!c?.email)); }, [group]);
  if (group.status !== 'connected' || !enabled) return null;
  return <div><button className="btn sm" disabled={busy} onClick={() => run(() => sendTestEmail(), (r) => t('settings.testEmailSentToTo', { to: r.to }))}><Icon name="send" />{t('settings.sendMeATestEmail')}</button></div>;
}
