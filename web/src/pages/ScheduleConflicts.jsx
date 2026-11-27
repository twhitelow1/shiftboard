// Blocked days on the schedule (core/schedule-conflicts.js, schedule.conflicts): a person × day they can't work —
// unavailable, a standing request off, approved time off — shows hatched with the reason; partial availability shows
// the window; a shift scheduled over a blocked day gets a red marker. Saving onto a blocked day asks first
// (useConflictConfirm): the server answers 409 with the reason, and on "Schedule anyway" the app sends it again with
// overrideConflict: true. Approved time off says who approved it (TimeOffApproved); a pending request has to be denied
// first (PendingRequest: "Deny request" when the reader decides it). Managers only (staff see the schedule as before). The publish dialog lists them (PublishSummary).
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, Modal, Icon } from '../ui.jsx';
import { useT, fmtTime, prettyDate } from '../i18n/index.js';
import { addDays } from '../../../core/time.js';
import '../conflicts.css';

/** The week's blocked cells and shifts over them: { cell(userId, date), shift(id), list, reload }. */
export function useScheduleConflicts(ws, enabled) {
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) { setData(null); return; }
    let live = true;
    call('schedule.conflicts', { start: ws, end: addDays(ws, 6) }).then((d) => live && setData(d), () => live && setData(null));
    return () => { live = false; };
  }, [ws, enabled, version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const cells = new Map((data?.cells || []).map((c) => [`${c.userId}|${c.date}`, c]));
    const shifts = new Map((data?.shifts || []).map((s) => [s.id, s]));
    return { on: !!data, cell: (userId, date) => (userId ? cells.get(`${userId}|${date}`) : undefined), shift: (id) => shifts.get(id), list: data?.shifts || [], reload: () => setTick((n) => n + 1) };
  }, [data]);
}

/** "REQ OFF (standing)" · "Unavailable" · "Time off", with its note in the tooltip. */
export function BlockedLabel({ block }) {
  const t = useT();
  const title = [t('conflicts.blockedTitle', { reason: t(`conflicts.reason_${block.kind}`) }), block.note].filter(Boolean).join('\n');
  return <span className={`cx-label cx-${block.kind}`} title={title}>{t(`conflicts.${block.kind}`)}</span>;
}

/** "Avail. 4:00 PM–close": partial availability (shifts outside it keep their warning). */
export function WindowNote({ w }) {
  const t = useT();
  return <span className="cx-window">{t('conflicts.window', { from: w.from ? fmtTime(w.from) : t('conflicts.opening'), to: w.to ? fmtTime(w.to) : t('conflicts.close') })}</span>;
}

/** The red marker on a shift over a blocked day. */
export function ConflictMark({ info }) {
  const t = useT();
  if (!info) return null;
  return <span className="cx-mark" role="img" aria-label={t('conflicts.marker', { reason: t(`conflicts.over_${info.kind}`) })} title={t('conflicts.marker', { reason: t(`conflicts.over_${info.kind}`) })}>!</span>;
}

/** The confirm pop-up's question, in the reader's language. */
export function conflictQuestion(t, name, c) {
  if (c.kind === 'timeOff') return t('conflicts.confirm_timeOff', { name, date: prettyDate(c.date) });
  const days = Number.isInteger(c.weekday) ? t(`conflicts.wd${c.weekday}`) : prettyDate(c.date);
  return t(`conflicts.confirm_${c.kind === 'standing' ? 'standing' : 'unavailable'}`, { name, days });
}

/** "Sat, Oct 3" or "Sat, Oct 3 – Mon, Oct 5". */
const datesOf = (t, r) => (r.endDate && r.endDate !== r.startDate ? t('conflicts.dateRange', { from: prettyDate(r.startDate), to: prettyDate(r.endDate) }) : prettyDate(r.startDate));
const dayOf = (iso) => (iso ? prettyDate(String(iso).slice(0, 10)) : '');

/** Approved time off: "Time off approved by <name> on <date> · requested <date> · reason". Managers only (the server sends it to them). */
export function TimeOffApproved({ info, className = 'alert info' }) {
  const t = useT();
  if (!info) return null;
  const head = info.decidedByName ? t('conflicts.approvedBy', { name: info.decidedByName, date: dayOf(info.decidedAt) })
    : info.decidedAt ? t('conflicts.approvedOn', { date: dayOf(info.decidedAt) }) : t('conflicts.approvedUnknown');
  const more = [datesOf(t, info), info.requestedAt && t(info.approx ? 'conflicts.requestedAbout' : 'conflicts.requestedOn', { date: dayOf(info.requestedAt) }),
    info.reason && t('conflicts.reasonIs', { text: info.reason }), info.decisionNote && t('conflicts.noteIs', { text: info.decisionNote })].filter(Boolean);
  return <div className={`${className} cx-approved`} data-testid="cx-approved"><Icon name="sun" size={16} /><div><b>{head}</b><div className="small">{more.join(' · ')}</div></div></div>;
}

/**
 * A pending request on the day: "<Name> requested off <dates> (requested <date>). Deny the request before scheduling
 * them." With "Deny request" (an optional reason, then timeOff.decide) when the reader decides it, else who does.
 */
export function PendingRequest({ userId, request, onDenied, denyLabel }) {
  const t = useT();
  const { call, people, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const name = people?.[userId]?.name || '';
  const requested = request.requestedAt ? t('conflicts.pendingRequested', { date: dayOf(request.requestedAt) }) : '';
  const deny = async () => {
    setBusy(true);
    try {
      await call('timeOff.decide', { id: request.id, status: 'denied', note: note.trim() });
      toast(t('conflicts.denied', { name }));
      onDenied?.();
    } catch (e) {
      toast(e.message, 'bad');
    } finally { setBusy(false); }
  };
  const who = request.deciders?.length ? t('conflicts.whoCanDeny', { names: request.deciders.join(', ') })
    : request.position ? t('conflicts.managerFor', { position: request.position }) : t('conflicts.managerAny');
  return (
    <div className="alert bad cx-pending" role="alert" data-testid="cx-pending"><Icon name="alert" size={16} /><div style={{ flex: 1, minWidth: 0 }}>
      <b>{t('conflicts.pendingMsg', { name, dates: datesOf(t, request), requested })} {t('conflicts.pendingMust')}</b>
      {request.reason && <div className="small">{t('conflicts.reasonIs', { text: request.reason })}</div>}
      {!request.canDeny && <div className="small">{who}</div>}
      {open && (
        <label className="cx-deny-note">
          <span className="small">{t('conflicts.denyReason', { name })}</span>
          <textarea className="input" rows="2" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </label>
      )}
      <div className="row wrap cx-pending-actions">
        {request.canDeny && (open
          ? <button type="button" className="btn danger solid sm" disabled={busy} onClick={deny}>{denyLabel || t('conflicts.denyGo')}</button>
          : <button type="button" className="btn danger sm" onClick={() => setOpen(true)}>{t('conflicts.deny')}</button>)}
        <a className="btn ghost sm" href="#/timeoff">{t('conflicts.viewRequest')}</a>
      </div>
    </div></div>
  );
}

/**
 * Ask before scheduling over a blocked day. send(extra) does the save; on a 409 with a conflict it asks, and on
 * "Schedule anyway" sends again with { overrideConflict: true }. A pending request (kind pending_request) can't be
 * scheduled over: it says so, and after "Deny and schedule" sends it again. Returns the answer, or null when they said no.
 *   const confirm = useConflictConfirm();  …  await run(() => confirm.save((x) => call('shifts.save', { ...payload, ...x })));  …  {confirm.element}
 */
export function useConflictConfirm() {
  const [ask, setAsk] = useState(null); // { conflict, resolve }
  const save = async (send, extra = {}) => {
    try {
      return await send(extra);
    } catch (e) {
      if (e?.status !== 409 || !e.conflict) throw e;
      const answer = await new Promise((resolve) => setAsk({ conflict: e.conflict, resolve }));
      setAsk(null);
      if (e.conflict.kind === 'pending_request') return answer === 'denied' ? save(send, extra) : null; // denied: try again (another conflict still asks)
      return answer ? send({ ...extra, overrideConflict: true }) : null;
    }
  };
  const element = !ask ? null : ask.conflict.kind === 'pending_request'
    ? createPortal(<PendingModal conflict={ask.conflict} onAnswer={ask.resolve} />, document.body)
    : createPortal(<ConflictConfirm conflict={ask.conflict} onAnswer={ask.resolve} />, document.body);
  return { save, element };
}

function PendingModal({ conflict, onAnswer }) {
  const t = useT();
  return (
    <Modal title={t('conflicts.pendingModalTitle')} onClose={() => onAnswer(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onAnswer(false)} autoFocus>{t('common.cancel')}</button></>}>
      <PendingRequest userId={conflict.userId} request={conflict.request} onDenied={() => onAnswer('denied')} denyLabel={t('conflicts.denyAndSave')} />
    </Modal>
  );
}

function ConflictConfirm({ conflict, onAnswer }) {
  const t = useT();
  const { people } = useApp();
  const name = people?.[conflict.userId]?.name || '';
  return (
    <Modal title={t('conflicts.confirmTitle')} onClose={() => onAnswer(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onAnswer(false)}>{t('common.cancel')}</button>
        <button className="btn danger" onClick={() => onAnswer(true)} autoFocus><Icon name="alert" />{t('conflicts.confirmYes')}</button></>}>
      <div className="alert warn cx-confirm"><Icon name="alert" size={16} /><div><b>{conflictQuestion(t, name, conflict)}</b>{conflict.note && !conflict.timeOff ? <div className="small">{conflict.note}</div> : null}</div></div>
      {conflict.timeOff && <TimeOffApproved info={conflict.timeOff} />}
      <div className="help">{t('conflicts.confirmHelp', { name })}</div>
    </Modal>
  );
}

/** Publish dialog: the drafts scheduled over a blocked day (a warning: publishing is still allowed). */
export function PublishSummary({ ws, notify }) {
  const t = useT();
  const { call, people, jobs } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => { call('schedule.conflicts', { start: ws, end: addDays(ws, 6) }).then(setD, () => setD(null)); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!d) return;
    call('shifts.list', { start: ws, end: addDays(ws, 6) }).then((r) => {
      const cells = new Set(d.cells.filter((c) => c.pending).map((c) => `${c.userId}|${c.date}`));
      setPending(r.shifts.filter((s) => !s.published && cells.has(`${s.userId}|${s.date}`)).length);
    }, () => setPending(0));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const drafts = (d?.shifts || []).filter((s) => !s.published);
  if (!drafts.length && !pending) return null;
  return (
    <div className="col" style={{ gap: 6 }}>
      {drafts.length > 0 && (
        <div className="alert bad cx-publish"><Icon name="alert" size={16} /><div>
          <b>{t('conflicts.publishTitle', { count: drafts.length })}</b>
          <ul className="cx-publish-list">
            {drafts.map((s) => <li key={s.id}>{people?.[s.userId]?.name || ''} · {prettyDate(s.date)} · {fmtTime(s.start)} {jobs?.[s.jobCodeId]?.name || ''} — {t(`conflicts.reason_${s.kind}`)}</li>)}
          </ul>
          <div className="small">{notify ? t('conflicts.publishHelp') : t('conflicts.publishSilent')}</div>
        </div></div>
      )}
      {pending > 0 && <div className="small muted"><Icon name="sun" size={13} /> {t('conflicts.publishPending', { count: pending })}</div>}
    </div>
  );
}
