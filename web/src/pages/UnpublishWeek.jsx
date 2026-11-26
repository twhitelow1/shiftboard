// "Unpublish…" next to Publish on the schedule (managers): moves the week's posted shifts back to draft,
// after a confirmation that says how many shifts, how many people are told, and which open trade and
// pickup requests are cancelled (counts from the server: shifts.unpublish with dryRun, core/unpublish.js).
// Shifts that already started stay posted. Once nothing in the week is posted, a "Draft" badge shows instead.
import { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Field, useAction } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import { useT } from '../i18n/index.js';
import { weekLabel } from './Schedule.jsx';

export default function UnpublishWeek({ ws, shifts, rooms = [], room = '' }) {
  const t = useT();
  const { isMgr, today } = useApp();
  const [open, setOpen] = useState(false);
  if (!isMgr) return null;
  const posted = shifts.some((s) => s.published && s.date >= today);
  if (!posted) return shifts.some((s) => !s.published) ? <span className="badge warn" title={t('unpublish.draftBadgeTitle')}>{t('unpublish.draftBadge')}</span> : null;
  return (
    <>
      <button className="btn sm ghost" onClick={() => setOpen(true)} title={t('unpublish.buttonTitle')}><Icon name="edit" />{t('unpublish.button')}</button>
      {open && <UnpublishDialog ws={ws} rooms={rooms} room={room} onClose={() => setOpen(false)} />}
    </>
  );
}

function UnpublishDialog({ ws, rooms, room, onClose }) {
  const t = useT();
  const { call } = useApp();
  const [scope, setScope] = useState(rooms.includes(room) ? room : '');
  const [keepEvents, setKeepEvents] = useState(false);
  const [notify, setNotify] = useState(true); // "Notify staff": on by default
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState(null);
  const [run, busy] = useAction();
  const args = { start: ws, end: addDays(ws, 6), scope: scope ? { area: scope } : {}, keepEvents, notify };
  useEffect(() => {
    let live = true;
    setPlan(null);
    call('shifts.unpublish', { ...args, dryRun: true }).then((r) => live && setPlan(r)).catch(() => live && setPlan({ error: true }));
    return () => { live = false; };
  }, [ws, scope, keepEvents]); // notify doesn't change what's pulled back

  const go = async () => {
    const r = await run(() => call('shifts.unpublish', { ...args, note: notify ? note : '' }),
      (r) => [t('unpublish.done', { count: r.unpublished }), r.notify ? t('unpublish.doneNotified', { count: r.notified }) : t('unpublish.doneQuiet'), r.requestsCancelled && t('unpublish.doneRequests', { count: r.requestsCancelled })].filter(Boolean).join(' · '));
    if (r) onClose();
  };
  const n = plan?.unpublished || 0;
  return (
    <Modal title={t('unpublish.title', { week: weekLabel(ws) })} sub={t('unpublish.sub')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !n} onClick={go}><Icon name="edit" />{n ? t('unpublish.confirm', { count: n }) : t('unpublish.button')}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        {rooms.length > 1 && (
          <Field label={t('unpublish.which')}>
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">{t('unpublish.wholeWeek')}</option>
              {rooms.map((r) => <option key={r} value={r}>{t('unpublish.onlyRoom', { room: r })}</option>)}
            </select>
          </Field>
        )}
        {!plan ? <div className="muted small">{t('common.loading')}</div> : plan.error ? null : (
          <ul className="col" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
            <li>{n ? t('unpublish.shifts', { count: n }) : t('unpublish.nothing')}</li>
            {n > 0 && plan.people > 0 && <li>{notify ? t('unpublish.people', { count: plan.people }) : t('unpublish.peopleQuiet', { count: plan.people })}</li>}
            {plan.requestsCancelled > 0 && <li>{t('unpublish.requests', { count: plan.requestsCancelled })}</li>}
            {plan.kept > 0 && <li className="muted">{t('unpublish.kept', { count: plan.kept })}</li>}
          </ul>
        )}
        {plan?.eventShifts > 0 && (
          <label className="check"><input type="checkbox" checked={keepEvents} onChange={(e) => setKeepEvents(e.target.checked)} />
            <span>{t('unpublish.keepEvents', { count: plan.eventShifts })}</span></label>
        )}
        <div className="col" style={{ gap: 4 }}>
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>{t('unpublish.notify')}</span></label>
          {!notify && <div className="help">{t('unpublish.notifyOffHelp')}</div>}
        </div>
        {notify && (
          <Field label={t('unpublish.note')} help={t('unpublish.noteHelp')}>
            <textarea className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('unpublish.notePlaceholder')} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
