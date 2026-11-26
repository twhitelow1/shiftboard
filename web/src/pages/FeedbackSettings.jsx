// Settings → Feedback box (admins, #/settings/feedback): whether supervisors read it, the kinds (rename, add, turn
// off, Admins only, the safety note), the topics, and the safety note's words. Rules: core/feedback.js cleanConfig.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { HowAnonymous } from './Feedback.jsx';
import '../feedback.css';

/** The card on the Settings page. */
export function FeedbackSettingsCard() {
  const t = useT();
  const { has } = useApp();
  if (!has('feedback') && !has('feedbackInbox')) return null;
  return (
    <div className="card card-pad col" style={{ gap: 8 }}>
      <h2>{t('feedback.settingsTitle')}</h2>
      <div className="help">{t('feedback.settingsHelp')}</div>
      <div><a className="btn sm" href="#/settings/feedback"><Icon name="mail" />{t('feedback.settingsOpen')}</a></div>
    </div>
  );
}

export default function FeedbackSettings() {
  const t = useT();
  const { call, viewAs } = useApp();
  const [c, setC] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('feedback.settings.get').then(setC).catch(() => setC(false)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (c === null) return <div className="empty">{t('common.loading')}</div>;
  if (!c) return null;
  const setKind = (i, patch) => setC({ ...c, kinds: c.kinds.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const setTopic = (i, patch) => setC({ ...c, topics: c.topics.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const save = async () => { const r = await run(() => call('feedback.settings.save', c), t('feedback.saved')); if (r) setC(r); };
  return (
    <div className="col fb-page" style={{ maxWidth: 820 }}>
      <div><a className="btn ghost sm" href="#/settings"><Icon name="left" />{t('feedback.back')}</a></div>
      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('feedback.readersTitle')}</h2>
        <div className="help">{t('feedback.readersHelp')} <a href="#/settings/roles">{t('roles.open')}</a></div>
        <label className="check"><input type="checkbox" checked={!!c.supervisorsCanRead} onChange={(e) => setC({ ...c, supervisorsCanRead: e.target.checked })} />{t('feedback.supervisorsRead')}</label>
        <HowAnonymous />
      </div>

      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('feedback.kindsTitle')}</h2>
        <div className="help">{t('feedback.kindsHelp')}</div>
        {c.kinds.map((k, i) => (
          <div key={k.id || `new${i}`} className="fb-set-row">
            <label className="field"><span>{t('feedback.kindEn')}</span><input className="input" maxLength={40} value={k.en} onChange={(e) => setKind(i, { en: e.target.value })} /></label>
            <label className="field"><span>{t('feedback.kindEs')}</span><input className="input" maxLength={40} value={k.es || ''} onChange={(e) => setKind(i, { es: e.target.value })} /></label>
            <div className="fb-set-checks">
              <label className="check small"><input type="checkbox" checked={k.on !== false} onChange={(e) => setKind(i, { on: e.target.checked })} />{t('feedback.kindOn')}</label>
              <label className="check small"><input type="checkbox" checked={!!k.adminsOnly} onChange={(e) => setKind(i, { adminsOnly: e.target.checked })} />{t('feedback.adminsOnly')}</label>
              <label className="check small"><input type="checkbox" checked={!!k.safety} onChange={(e) => setKind(i, { safety: e.target.checked })} />{t('feedback.kindSafety')}</label>
            </div>
          </div>
        ))}
        {c.kinds.length < 12 && <div><button className="btn sm" onClick={() => setC({ ...c, kinds: [...c.kinds, { id: '', en: '', es: '', on: true, adminsOnly: false, safety: false }] })}><Icon name="plus" />{t('feedback.addKind')}</button></div>}
      </div>

      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('feedback.topicsTitle')}</h2>
        <div className="help">{t('feedback.topicsHelp')}</div>
        {c.topics.map((x, i) => (
          <div key={x.id || `new${i}`} className="fb-set-row">
            <label className="field"><span>{t('feedback.kindEn')}</span><input className="input" maxLength={40} value={x.en} onChange={(e) => setTopic(i, { en: e.target.value })} /></label>
            <label className="field"><span>{t('feedback.kindEs')}</span><input className="input" maxLength={40} value={x.es || ''} onChange={(e) => setTopic(i, { es: e.target.value })} /></label>
            <div className="fb-set-checks"><button className="btn ghost sm" onClick={() => setC({ ...c, topics: c.topics.filter((_, j) => j !== i) })}><Icon name="trash" />{t('feedback.remove')}</button></div>
          </div>
        ))}
        {c.topics.length < 20 && <div><button className="btn sm" onClick={() => setC({ ...c, topics: [...c.topics, { id: '', en: '', es: '' }] })}><Icon name="plus" />{t('feedback.addTopic')}</button></div>}
      </div>

      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('feedback.safetyNoteTitle')}</h2>
        <div className="help">{t('feedback.safetyNoteHelp')}</div>
        <label className="field"><span>{t('feedback.english')}</span><textarea className="input" rows={3} maxLength={600} value={c.safetyNote.en} onChange={(e) => setC({ ...c, safetyNote: { ...c.safetyNote, en: e.target.value } })} /></label>
        <label className="field"><span>{t('feedback.spanish')}</span><textarea className="input" rows={3} maxLength={600} value={c.safetyNote.es} onChange={(e) => setC({ ...c, safetyNote: { ...c.safetyNote, es: e.target.value } })} /></label>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={busy || !!viewAs} onClick={save}>{t('feedback.save')}</button>
      </div>
    </div>
  );
}
