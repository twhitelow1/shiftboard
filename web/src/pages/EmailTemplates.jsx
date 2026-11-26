import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../email-templates.css';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { IS_DEMO, ApiError } from '../api.js';
import { useT, getLang, translateError } from '../i18n/index.js';
import { checkTemplate, renderTemplate, sampleVars } from '../../../core/email-templates.js';

// Settings → Email notifications (admins): every automatic email ShiftBoard sends. Notification emails can be
// turned off per type, or rewritten in English and Spanish with placeholders, with a live preview, "Send me a
// test" and "Reset to default". Account and security emails are listed as fixed. Rules: core/email-templates.js.

async function sendTest(body) {
  const res = await fetch('/api/email/template-test', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ShiftBoard-Language': getLang() }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || translateError(`Request failed (${res.status})`));
  return data.result;
}

export default function EmailTemplates() {
  const t = useT();
  const { call, emailEnabled } = useApp();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // the type being edited
  const [run, busy] = useAction();
  useEffect(() => { call('emailTemplates.get').then(setData).catch(() => setData(false)); }, []);
  const name = (id) => t(`emailTemplates.types.${id}`);
  const toggle = async (type, on) => {
    const r = await run(() => call('emailTemplates.save', { type: type.id, on }), on ? t('emailTemplates.turnedOn', { name: name(type.id) }) : t('emailTemplates.turnedOff', { name: name(type.id) }));
    if (r) setData(r);
  };
  if (data === false) return null;
  return (
    <div style={{ maxWidth: 820 }} className="col email-tpl">
      <a href="#/settings" className="small"><Icon name="left" size={14} /> {t('emailTemplates.back')}</a>
      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2>{t('emailTemplates.title')}</h2>
        <div className="help">{t('emailTemplates.intro')}</div>
        {data && !data.emailNotifications && <div className="alert warn"><Icon name="alert" size={16} />{t('emailTemplates.emailOff')}</div>}
        {!emailEnabled && !IS_DEMO && <div className="alert info"><Icon name="mail" size={16} />{t('emailTemplates.notSetUp')}</div>}
      </div>
      {!data ? <div className="empty">{t('common.loading')}</div> : (
        <div className="card email-tpl-list">
          {data.types.map((type) => (
            <div key={type.id} className={`email-tpl-item ${open === type.id ? 'open' : ''}`}>
              <div className="email-tpl-row">
                <label className="switch" title={type.on ? t('emailTemplates.on') : t('emailTemplates.off')}>
                  <input type="checkbox" checked={type.on} disabled={busy} onChange={(e) => toggle(type, e.target.checked)} aria-label={name(type.id)} />
                  <span />
                </label>
                <div className="email-tpl-name">
                  <div className={type.on ? '' : 'muted'}>{name(type.id)}</div>
                  <div className="tiny faint">{type.on ? t('emailTemplates.on') : t('emailTemplates.off')}
                    {(type.en.custom || type.es.custom) && <> · {t('emailTemplates.custom')} ({[type.en.custom && 'EN', type.es.custom && 'ES'].filter(Boolean).join(', ')})</>}</div>
                </div>
                <button className="btn sm" onClick={() => setOpen(open === type.id ? null : type.id)} aria-expanded={open === type.id}>
                  <Icon name={open === type.id ? 'up' : 'edit'} size={14} />{t('emailTemplates.edit')}</button>
              </div>
              {open === type.id && <TemplateEditor type={type} onSaved={setData} />}
            </div>
          ))}
        </div>
      )}
      <div className="card card-pad col" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}><Icon name="lock" size={15} /> {t('emailTemplates.fixedTitle')}</h3>
        <div className="help">{t('emailTemplates.fixedHelp')}</div>
        <ul className="email-tpl-fixed">
          {(data?.fixed || ['invite', 'passwordReset', 'signInLink', 'securityNotice', 'testEmail']).map((id) => <li key={id}>{t(`emailTemplates.fixed.${id}`)}</li>)}
        </ul>
      </div>
    </div>
  );
}

function TemplateEditor({ type, onSaved }) {
  const t = useT();
  const { call, emailEnabled, settings, me } = useApp();
  const [lang, setLang] = useState(getLang() === 'es' ? 'es' : 'en');
  const [draft, setDraft] = useState({ en: { subject: type.en.subject, body: type.en.body }, es: { subject: type.es.subject, body: type.es.body } });
  const [run, busy] = useAction();
  const subjectRef = useRef(null);
  const bodyRef = useRef(null);
  const last = useRef('body');
  const cur = draft[lang];
  const saved = type[lang];
  const dirty = cur.subject !== saved.subject || cur.body !== saved.body;
  const problems = checkTemplate(type.id, cur);
  const problemText = (p) => (p.code === 'unknown' ? t('emailTemplates.unknown', { list: p.values.map((v) => `{${v}}`).join(', ') })
    : p.code === 'buttonLink' ? t('emailTemplates.buttonLink') : p.code === 'required' ? t('emailTemplates.required') : translateError(p.code === 'newline' ? 'Keep the subject on one line' : 'That email is too long'));
  const preview = useMemo(() => {
    const restaurant = settings.restaurantName || 'ShiftBoard';
    try {
      return renderTemplate({ template: cur, vars: sampleVars(type.id, lang, { restaurant, name: me?.name, appUrl: location.origin }), restaurant, brand: { color: settings.brandColor || '' }, lang });
    } catch { return null; }
  }, [cur.subject, cur.body, lang]);

  const setField = (k, v) => setDraft({ ...draft, [lang]: { ...cur, [k]: v } });
  const insert = (v) => {
    const k = last.current;
    const el = k === 'subject' ? subjectRef.current : bodyRef.current;
    const text = cur[k];
    const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
    const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : at;
    setField(k, `${text.slice(0, at)}{${v}}${text.slice(end)}`);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + v.length + 2, at + v.length + 2); } });
  };
  const save = async () => {
    const r = await run(() => call('emailTemplates.save', { type: type.id, lang, subject: cur.subject, body: cur.body }), t('emailTemplates.saved'));
    if (r) onSaved(r);
  };
  const reset = async () => {
    const r = await run(() => call('emailTemplates.reset', { type: type.id, lang }), t('emailTemplates.resetDone'));
    if (r) {
      const next = r.types.find((x) => x.id === type.id)[lang];
      setDraft({ ...draft, [lang]: { subject: next.subject, body: next.body } });
      onSaved(r);
    }
  };
  const test = () => run(() => sendTest({ type: type.id, lang, subject: cur.subject, body: cur.body }), (r) => t('emailTemplates.testSent', { to: r.to }));
  const isDefault = cur.subject === type.defaults[lang].subject && cur.body === type.defaults[lang].body;

  return (
    <div className="email-tpl-editor col" style={{ gap: 10 }}>
      <div className="seg seg-wrap" role="radiogroup">
        <button type="button" className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en">{t('emailTemplates.english')}</button>
        <button type="button" className={lang === 'es' ? 'on' : ''} aria-pressed={lang === 'es'} onClick={() => setLang('es')} lang="es">{t('emailTemplates.spanish')}</button>
      </div>
      <Field label={t('emailTemplates.subject')}>
        <input ref={subjectRef} className="input" value={cur.subject} lang={lang} onFocus={() => { last.current = 'subject'; }} onChange={(e) => setField('subject', e.target.value)} maxLength={200} />
      </Field>
      <Field label={t('emailTemplates.body')} help={t('emailTemplates.bodyHelp')}>
        <textarea ref={bodyRef} className="input" style={{ minHeight: 150 }} value={cur.body} lang={lang} onFocus={() => { last.current = 'body'; }} onChange={(e) => setField('body', e.target.value)} maxLength={5000} />
      </Field>
      <div>
        <div className="small" style={{ fontWeight: 600 }}>{t('emailTemplates.placeholders')}</div>
        <div className="tiny faint" style={{ marginBottom: 6 }}>{t('emailTemplates.placeholdersHelp')}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {type.vars.map((v) => (
            <button key={v} type="button" className="chip email-tpl-ph" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v)} title={t(`emailTemplates.vars.${v}`)}>
              <code>{`{${v}}`}</code><span className="tiny faint">{t(`emailTemplates.vars.${v}`)}</span>
            </button>
          ))}
        </div>
      </div>
      {problems.length > 0 && <div className="alert warn" role="status"><Icon name="alert" size={16} /><div>{problems.map((p, i) => <div key={i}>{problemText(p)}</div>)}</div></div>}
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn primary sm" disabled={busy || !dirty || problems.length > 0} onClick={save}><Icon name="check" />{t('emailTemplates.save')}</button>
        {emailEnabled && !IS_DEMO && <button className="btn sm" disabled={busy || problems.length > 0} onClick={test}><Icon name="send" />{t('emailTemplates.test')}</button>}
        {(saved.custom || !isDefault) && <button className="btn sm ghost" disabled={busy} onClick={reset}><Icon name="copy" />{t('emailTemplates.reset')}</button>}
      </div>
      {preview && (
        <div>
          <div className="small" style={{ fontWeight: 600 }}>{t('emailTemplates.preview')}</div>
          <div className="tiny faint" style={{ marginBottom: 6 }}>{t('emailTemplates.previewHelp', { lang: lang === 'es' ? t('emailTemplates.spanish') : t('emailTemplates.english') })}</div>
          <div className="email-tpl-subject"><span className="tiny faint">{t('emailTemplates.subject')}:</span> {preview.subject}</div>
          {/* The email exactly as it's built, in a sandboxed frame (no scripts; everything in it is escaped). */}
          <iframe className="email-tpl-preview" title={t('emailTemplates.preview')} sandbox="" srcDoc={preview.html} />
        </div>
      )}
    </div>
  );
}
