// "Report a problem" (the user menu, and "Report this" when a screen crashes): what happened, the page they were
// on (optional), and a screenshot (optional: a file, or pasted). The screenshot is shrunk in the browser like
// other photos (TrainingShared.jsx photoFromFile). The app version, the page, the device, the app's last errors
// and its last calls to the server (method names and status only) go along by themselves (web/src/errors.js).
// Works signed in or out; DubLow Digital gets it in the console's Errors & reports.
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Icon } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { sendReport } from '../errors.js';
import { photoFromFile } from './TrainingShared.jsx';
import '../report.css';

/**
 * @param {object} p
 * @param {Function} p.onClose
 * @param {Function} [p.onSent]   after it was sent
 * @param {string} [p.page]    the page's name, filled in (they can change it)
 * @param {Error} [p.error]    the error on screen, from a crash
 * @param {string} [p.componentStack]
 */
export default function ReportProblem({ onClose, onSent, page: startPage = '', error = null, componentStack = '' }) {
  const t = useT();
  const [text, setText] = useState('');
  const [page, setPage] = useState(startPage);
  const [shot, setShot] = useState(null); // { dataUrl, w, h }
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);
  const fileRef = useRef(null);

  const addFile = async (file) => {
    if (!file) return;
    setProblem('');
    if (!/^image\//.test(file.type || '')) { setProblem(t('report.notImage')); return; }
    try { setShot(await photoFromFile(file, { max: 1400, limit: 700 * 1024 })); } catch { setProblem(t('report.notImage')); }
  };
  // Pasting a picture anywhere while the form is open adds it (text still pastes into the box).
  useEffect(() => {
    if (done) return undefined;
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && /^image\//.test(i.type));
      if (!item) return;
      e.preventDefault();
      addFile(item.getAsFile());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e?.preventDefault();
    if (text.trim().length < 3) { setProblem(t('report.needText')); return; }
    setBusy(true); setProblem('');
    try {
      await sendReport({ text: text.trim(), page: page.trim(), screenshot: shot?.dataUrl, error, componentStack });
      setDone(true);
      onSent?.();
    } catch (x) {
      setProblem(x.status && x.status < 500 && x.message ? x.message : t('report.failed'));
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Modal title={t('report.title')} onClose={onClose} footer={<button className="btn primary" onClick={onClose} autoFocus>{t('common.done')}</button>}>
        <div className="report-done" role="status">
          <span className="report-done-icon"><Icon name="check" size={26} /></span>
          <div className="report-done-title">{t('report.thanks')}</div>
          <div className="small muted">{t('report.thanksHelp')}</div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('report.title')} onClose={busy ? undefined : onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn primary" type="submit" form="report-problem" disabled={busy}>{busy ? t('report.sending') : t('report.send')}</button>
      </>}>
      <form id="report-problem" className="report-form" onSubmit={submit}>
        <label className="field">
          <span>{t('report.what')}</span>
          <textarea className="input" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('report.whatPlaceholder')} autoFocus />
        </label>
        <label className="field">
          <span>{t('report.page')}</span>
          <input className="input" value={page} maxLength={100} onChange={(e) => setPage(e.target.value)} placeholder={t('report.pagePlaceholder')} />
        </label>
        <div className="field">
          <span>{t('report.screenshot')}</span>
          {shot ? (
            <div className="report-shot">
              <img src={shot.dataUrl} alt={t('report.screenshotAlt')} />
              <div className="report-shot-actions">
                <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>{t('report.changeScreenshot')}</button>
                <button type="button" className="btn sm ghost" onClick={() => setShot(null)} aria-label={t('report.removeScreenshot')}><Icon name="trash" size={16} />{t('common.remove')}</button>
              </div>
            </div>
          ) : (
            <div className="report-add">
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon name="camera" size={16} />{t('report.addScreenshot')}</button>
              <span className="small muted">{t('report.pasteHint')}</span>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        {error && <div className="small muted"><Icon name="alert" size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />{t('report.withError')}</div>}
        <div className="tiny muted">{t('report.attached')}</div>
        {problem && <div className="alert bad" role="alert"><Icon name="alert" size={16} />{problem}</div>}
      </form>
    </Modal>
  );
}
