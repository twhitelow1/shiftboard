import React, { useState } from 'react';
import '../email-templates.css';
import { useApp, Modal, Field, Icon, useAction } from '../ui.jsx';
import { call as rpc, IS_DEMO, ApiError } from '../api.js';
import { useT, getLang, translateError, LANGUAGE_NAMES } from '../i18n/index.js';

// Download the week as a PDF laid out like the printed house sheet (core/schedule-pdf.js): the whole week or
// some rooms, Letter / Legal / Tabloid, portrait or landscape, one page or split across pages, in English or
// Spanish. The server makes it (GET /api/schedule/pdf); the demo makes it in the browser with the same code.
// Managers get the week as it stands (DRAFT when it has drafts); everyone else the published week.

const PREF_KEY = 'sb_pdf_opts';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; } };

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export default function SchedulePdfDialog({ ws, banners, drafts, onClose }) {
  const t = useT();
  const { isMgr, settings } = useApp();
  const prefs = loadPrefs();
  const defaultLang = settings.language === 'en' || settings.language === 'es' ? settings.language : getLang();
  const [o, setO] = useState({ paper: prefs.paper || 'letter', orientation: prefs.orientation || 'portrait', fit: prefs.fit || 'fit', lang: prefs.lang || defaultLang });
  const [scope, setScope] = useState('all');
  const [rooms, setRooms] = useState([]);
  const [run, busy] = useAction();
  const set = (k) => (e) => setO({ ...o, [k]: e.target.value });
  const picked = scope === 'some' ? rooms : [];

  const download = async () => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(o)); } catch { /* ignore */ }
    const r = await run(async () => {
      if (IS_DEMO) {
        // No server in the demo: the same PDF code runs here.
        const { loadSheetModel, schedulePdf, pdfFileName } = await import('../../../core/schedule-pdf.js');
        const model = await loadSheetModel(rpc, { weekStart: ws, lang: o.lang, rooms: picked, isMgr });
        const { bytes } = await schedulePdf(model, o);
        save(new Blob([bytes], { type: 'application/pdf' }), pdfFileName(model));
        return true;
      }
      const q = new URLSearchParams({ week: ws, paper: o.paper, orientation: o.orientation, fit: o.fit, lang: o.lang, ...(picked.length ? { rooms: picked.join(',') } : {}) });
      const res = await fetch(`/api/schedule/pdf?${q}`, { credentials: 'same-origin', headers: { 'X-ShiftBoard-Language': getLang() } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error || translateError(`Request failed (${res.status})`));
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `schedule-${ws}.pdf`;
      save(await res.blob(), name);
      return true;
    }, t('schedulePdf.downloaded'));
    if (r) onClose();
  };

  return (
    <Modal title={t('schedulePdf.title')} sub={t('schedulePdf.sub')} onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || (scope === 'some' && !rooms.length)} onClick={download}><Icon name="download" />{t('schedulePdf.download')}</button>
      </>}>
      <div className="col" style={{ gap: 12 }}>
        {isMgr && drafts > 0 && <div className="alert warn"><Icon name="alert" size={16} />{t('schedulePdf.draftNote')}</div>}
        {!isMgr && <div className="help">{t('schedulePdf.publishedOnly')}</div>}
        {banners.length > 1 && (
          <Field label={t('schedulePdf.whatToPrint')}>
            <div className="seg seg-wrap" role="radiogroup">
              <button type="button" className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('schedulePdf.wholeWeek')}</button>
              <button type="button" className={scope === 'some' ? 'on' : ''} aria-pressed={scope === 'some'} onClick={() => setScope('some')}>{t('schedulePdf.someRooms')}</button>
            </div>
          </Field>
        )}
        {scope === 'some' && (
          <div>
            <div className="row wrap" style={{ gap: 6 }}>
              {banners.map((b) => {
                const on = rooms.includes(b);
                return <button key={b} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setRooms(on ? rooms.filter((x) => x !== b) : [...rooms, b])}>{b}</button>;
              })}
            </div>
            {!rooms.length && <div className="help">{t('schedulePdf.pickARoom')}</div>}
          </div>
        )}
        <div className="grid2">
          <Field label={t('schedulePdf.paper')}>
            <select className="input" value={o.paper} onChange={set('paper')}>
              <option value="letter">{t('schedulePdf.letter')}</option>
              <option value="legal">{t('schedulePdf.legal')}</option>
              <option value="tabloid">{t('schedulePdf.tabloid')}</option>
            </select>
          </Field>
          <Field label={t('schedulePdf.orientation')}>
            <select className="input" value={o.orientation} onChange={set('orientation')}>
              <option value="portrait">{t('schedulePdf.portrait')}</option>
              <option value="landscape">{t('schedulePdf.landscape')}</option>
            </select>
          </Field>
        </div>
        <Field label={t('schedulePdf.pages')} help={o.fit === 'fit' ? t('schedulePdf.fitHelp') : t('schedulePdf.splitHelp')}>
          <div className="seg seg-wrap" role="radiogroup">
            <button type="button" className={o.fit === 'fit' ? 'on' : ''} aria-pressed={o.fit === 'fit'} onClick={() => setO({ ...o, fit: 'fit' })}>{t('schedulePdf.fitOne')}</button>
            <button type="button" className={o.fit === 'split' ? 'on' : ''} aria-pressed={o.fit === 'split'} onClick={() => setO({ ...o, fit: 'split' })}>{t('schedulePdf.split')}</button>
          </div>
        </Field>
        <Field label={t('schedulePdf.language')}>
          <select className="input" value={o.lang} onChange={set('lang')}>
            <option value="en" lang="en">{LANGUAGE_NAMES.en}</option>
            <option value="es" lang="es">{LANGUAGE_NAMES.es}</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}
