// Settings → Claude connector (admins): on or off for the restaurant, read-only for staff, the URL to paste in
// Claude and how to connect. Shown when the plan includes it (the 'mcp' feature). The demo shows a note.
import React, { useEffect, useState } from 'react';
import { useApp, Icon } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { connectorSettings, saveConnectorSettings } from '../mcp-api.js';
import { useT } from '../i18n/index.js';
import '../claude.css';

export default function ClaudeConnectorCard() {
  const t = useT();
  const { has, toast } = useApp();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (IS_DEMO || !has('mcp')) return;
    connectorSettings().then(setS, (e) => toast(e.message, 'bad'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!has('mcp')) return null;
  if (IS_DEMO) {
    return (
      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('claude.title')}</h2>
        <div className="help">{t('claude.intro')}</div>
        <div className="alert info"><Icon name="sparkle" size={16} /><span>{t('claude.demoSettings')}</span></div>
      </div>
    );
  }
  if (!s) return null;
  const save = async (patch) => {
    setBusy(true);
    try { setS(await saveConnectorSettings(patch)); toast(t('claude.saved')); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const copy = (text, what) => { navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 2000); }, () => {}); };
  const cmd = `claude mcp add --transport http shiftboard ${s.url}`;
  return (
    <div className="card card-pad col" style={{ gap: 12 }} id="claude-connector">
      <h2>{t('claude.title')}</h2>
      <div className="help">{t('claude.intro')}</div>
      <label className="check"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />{t('claude.on')}</label>
      {!s.enabled && <div className="alert warn"><Icon name="alert" size={16} /><span>{t('claude.offNote')}</span></div>}
      <label className="check"><input type="checkbox" checked={s.staffReadOnly} disabled={busy || !s.enabled} onChange={(e) => save({ staffReadOnly: e.target.checked })} /><span>{t('claude.staffReadOnly')}</span></label>
      <div className="field">
        <span>{t('claude.url')}</span>
        <div className="claude-url">
          <input className="input" readOnly value={s.url} onFocus={(e) => e.target.select()} aria-label={t('claude.url')} />
          <button type="button" className="btn" onClick={() => copy(s.url, 'url')}><Icon name="copy" />{copied === 'url' ? t('claude.copied') : t('claude.copy')}</button>
        </div>
        <div className="help">{t('claude.connections', { count: s.connections })}</div>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <b>{t('claude.howTo')}</b>
        <ol className="claude-steps">
          <li>{t('claude.step1')}</li>
          <li>{t('claude.step2')}</li>
          <li>{t('claude.step3')}</li>
          <li>{t('claude.step4')}</li>
        </ol>
        <div className="small">{t('claude.claudeCode')}</div>
        <div className="claude-url">
          <code className="claude-code" style={{ flex: 1 }}>{cmd}</code>
          <button type="button" className="btn sm icon" aria-label={t('claude.copy')} title={t('claude.copy')} onClick={() => copy(cmd, 'cmd')}><Icon name={copied === 'cmd' ? 'check' : 'copy'} /></button>
        </div>
      </div>
    </div>
  );
}
