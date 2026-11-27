import React, { useState } from 'react';
import { useApp, Modal, Field, Icon, useAction } from '../ui.jsx';
import { useT } from '../i18n/index.js';
import { addDays } from '../../../core/time.js';
import { PUBLISH_PDF_DEFAULT } from '../../../core/publish-notify.js';
import { StaffingCheck } from './ProgrammingParts.jsx'; // understaffed days vs par: a warning, never a block
import { SkillMixCheck } from './SkillMix.jsx'; // failing skill-mix rules: a warning, never a block

// Publish the week: notify staff or publish silently, and (with notify on) email the week's schedule as a PDF
// attachment with the paper options. The PDF choice is remembered for the restaurant (settings.publishPdf);
// the server does the rest (core/publish-notify.js, server/notify-email.js).
export default function PublishDialog({ ws, label, drafts, onClose }) {
  const t = useT();
  const { call, settings, emailEnabled } = useApp();
  const saved = { ...PUBLISH_PDF_DEFAULT, ...(settings.publishPdf || {}) };
  const [notify, setNotify] = useState(true);
  const [attach, setAttach] = useState(!!saved.attach);
  const [pdf, setPdf] = useState({ paper: saved.paper, orientation: saved.orientation, fit: saved.fit });
  const [run, busy] = useAction();
  const canAttach = notify && emailEnabled;
  const publish = async () => {
    const r = await run(() => call('shifts.publish', { start: ws, end: addDays(ws, 6), notify, ...(emailEnabled ? { attachPdf: attach, pdf } : {}) }),
      (r) => (r.silent ? t('publish.doneSilent', { published: r.published }) : t('schedule.publishedPublishedShiftsNotifiedPeople', { published: r.published, notified: r.notified })));
    if (r) onClose(true);
  };
  const set = (k) => (e) => setPdf({ ...pdf, [k]: e.target.value });
  return (
    <Modal title={t('publish.title', { week: label })} sub={t('publish.drafts', { count: drafts })} onClose={() => onClose(false)}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !drafts} onClick={publish}><Icon name="send" />{notify ? t('publish.publish') : t('publish.publishSilently')}</button>
      </>}>
      <div className="col" style={{ gap: 14 }}>
        <StaffingCheck start={ws} end={addDays(ws, 6)} />
        <SkillMixCheck ws={ws} />
        <div>
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{t('publish.notify')}</label>
          <div className="help">{notify ? t('publish.notifyHelp') : t('publish.silentHelp')}</div>
        </div>
        <div>
          <label className="check"><input type="checkbox" checked={canAttach && attach} disabled={!canAttach} onChange={(e) => setAttach(e.target.checked)} />{t('publish.attach')}</label>
          <div className="help">{!emailEnabled ? t('publish.attachNeedsEmail') : !notify ? t('publish.attachNeedsNotify') : t('publish.attachHelp')}</div>
        </div>
        {canAttach && attach && (
          <div className="grid3 publish-pdf-opts">
            <Field label={t('schedulePdf.paper')}>
              <select className="input" value={pdf.paper} onChange={set('paper')}>
                <option value="letter">{t('schedulePdf.letter')}</option>
                <option value="legal">{t('schedulePdf.legal')}</option>
                <option value="tabloid">{t('schedulePdf.tabloid')}</option>
              </select>
            </Field>
            <Field label={t('schedulePdf.orientation')}>
              <select className="input" value={pdf.orientation} onChange={set('orientation')}>
                <option value="portrait">{t('schedulePdf.portrait')}</option>
                <option value="landscape">{t('schedulePdf.landscape')}</option>
              </select>
            </Field>
            <Field label={t('schedulePdf.pages')}>
              <select className="input" value={pdf.fit} onChange={set('fit')}>
                <option value="fit">{t('schedulePdf.fitOne')}</option>
                <option value="split">{t('schedulePdf.split')}</option>
              </select>
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
