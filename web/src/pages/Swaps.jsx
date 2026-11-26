import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, shiftTime, Empty, useAction, Warnings, JobDot } from '../ui.jsx';
import { addDays } from '../../../core/time.js';
import ShiftDialog from './ShiftDialog.jsx';
import { useT, prettyDate, stamp } from '../i18n/index.js';

// Catalog keys (web/src/i18n).
const TYPE = { swap: 'swaps.typeSwap', drop: 'swaps.typeDrop', pickup: 'swaps.typePickup' };
const STATUS = {
  open: ['swaps.statusOpen', 'warn'], pending_approval: ['swaps.statusPending', 'brand'], approved: ['swaps.statusApproved', 'ok'],
  denied: ['swaps.statusDenied', 'bad'], declined: ['swaps.statusDeclined', 'bad'], cancelled: ['swaps.statusCancelled', ''],
};
// Notes the app itself writes on a request (core/service.js), shown in the reader's language.
const SYSTEM_NOTES = { 'Auto-approved': 'swaps.noteAutoApproved', 'Shift was given to someone else': 'swaps.noteGivenToSomeoneElse',
  'the shift was changed by a manager': 'swaps.noteChangedByManager', 'the shift was removed': 'swaps.noteShiftRemoved', 'the event was removed': 'swaps.noteEventRemoved',
  'the schedule was pulled back for changes': 'swaps.noteSchedulePulledBack' };

export default function Swaps() {
  const t = useT();
  const { call, version, canApprove, settings } = useApp();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(null);
  const load = () => call('swaps.list').then(setData);
  useEffect(() => { load(); }, [version]);
  if (!data) return <div className="empty">{t('common.loading')}</div>;

  const tabs = [
    ...(canApprove ? [{ key: 'approvals', label: t('swaps.needsApproval'), n: data.approvals.length }] : []),
    { key: 'offers', label: t('swaps.upForGrabs'), n: data.offers.length },
    { key: 'mine', label: t('swaps.myRequests'), n: data.mine.filter((r) => ['open', 'pending_approval'].includes(r.status)).length },
    ...(canApprove ? [{ key: 'open', label: t('swaps.waitingOnStaff'), n: data.openPending.length }, { key: 'history', label: t('swaps.history') }] : []),
  ];
  const cur = tab || tabs[0].key;
  const list = { approvals: data.approvals, offers: data.offers, mine: data.mine, open: data.openPending, history: data.history }[cur];

  return (
    <div style={{ maxWidth: 860 }}>
      <StartTrade onDone={load} />
      <div className="tabs">
        {tabs.map((t) => <button key={t.key} className={cur === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}{t.n > 0 && <span className="count" style={{ background: cur === t.key ? 'var(--brand)' : 'var(--text-3)' }}>{t.n}</span>}</button>)}
      </div>
      {cur === 'offers' && <p className="small muted" style={{ marginTop: -4 }}>{t('swaps.shiftsCoworkersAreGivingAway')}{settings.requireSwapApproval ? t('swaps.aManagerApprovesBeforeIts') : ''}</p>}
      <div className="card">
        {!list.length && <Empty icon="swap" title={cur === 'approvals' ? t('swaps.nothingToApprove') : cur === 'offers' ? t('swaps.nothingUpForGrabsRight') : t('swaps.noRequests')}>
          {cur === 'mine' && t('swaps.pickOneOfYourShifts')}
        </Empty>}
        {list.map((r) => <RequestCard key={r.id} r={r} mode={cur} onDone={load} />)}
      </div>
    </div>
  );
}

/** The obvious way in: your upcoming posted shifts, each with Trade and Give away. */
function StartTrade({ onDone }) {
  const t = useT();
  const { call, me, today, jobs, settings, version } = useApp();
  const [shifts, setShifts] = useState(null);
  const [all, setAll] = useState(false);
  const [dialog, setDialog] = useState(null);
  const load = () => call('shifts.list', { start: today, end: addDays(today, 28) })
    .then((r) => setShifts(r.shifts.filter((s) => s.userId === me.id && s.published && s.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))));
  useEffect(() => { load(); }, [version]);
  const approval = settings.requireSwapApproval !== false;
  const list = shifts ? (all ? shifts : shifts.slice(0, 4)) : [];
  return (
    <div className="card card-pad section col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 style={{ flex: 1 }}>{t('swaps.tradeOrGiveAwayA')}</h3>
        <span className="small muted">{t('swaps.n1PickYourShift2')}{approval ? t('swaps.n4AManagerApproves') : ''}</span>
      </div>
      {!shifts && <div className="small muted">{t('swaps.loadingYourShifts')}</div>}
      {shifts?.length === 0 && <div className="small muted">{t('swaps.youDontHaveAnyPosted')}</div>}
      {list.map((s) => (
        <div key={s.id} className="row wrap trade-row">
          <div style={{ flex: 1, minWidth: 180 }}>
            <b>{prettyDate(s.date)} · {shiftTime(s)}</b>
            <div className="small muted row" style={{ gap: 5 }}><JobDot job={jobs[s.jobCodeId]} />{jobs[s.jobCodeId]?.name}{s.area ? ` · ${s.area}` : ''}</div>
          </div>
          {s.pending ? <span className="badge warn">{t('swaps.requestInProgress')}</span> : <>
            <button className="btn sm primary" onClick={() => setDialog({ shift: s, startIn: 'swap' })}><Icon name="swap" />{t('common.trade')}</button>
            <button className="btn sm" onClick={() => setDialog({ shift: s, startIn: 'drop' })}><Icon name="hand" />{t('swaps.giveAway')}</button>
          </>}
        </div>
      ))}
      {shifts?.length > 4 && <button className="btn sm ghost" onClick={() => setAll(!all)}>{all ? t('swaps.showFewer') : t('swaps.showAllShiftscount', { shiftsCount: shifts.length })}</button>}
      {dialog && <ShiftDialog shift={dialog.shift} startIn={dialog.startIn} onClose={(c) => { setDialog(null); if (c) { load(); onDone?.(); } }} />}
    </div>
  );
}

function MiniShift({ s, who }) {
  const t = useT();
  const { jobs, people } = useApp();
  if (!s) return <div className="mini-shift">{t('swaps.shiftRemoved')}</div>;
  const j = jobs[s.jobCodeId];
  return (
    <div className="mini-shift" style={{ '--jc': j?.color }}>
      <div className="row" style={{ gap: 6 }}><Avatar user={people[who]} size="sm" /><b>{who ? people[who]?.name : t('common.openShift')}</b></div>
      <div className="small" style={{ marginTop: 4 }}><b>{prettyDate(s.date)}</b> · {shiftTime(s)}</div>
      <div className="small muted row" style={{ gap: 5 }}><JobDot job={j} />{j?.name}{s.area ? ` · ${s.area}` : ''}{s.tag ? ` · ${s.tag}` : ''}</div>
    </div>
  );
}

function RequestCard({ r, mode, onDone }) {
  const t = useT();
  const { call, people, me } = useApp();
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const act = (method, msg) => run(() => call(method, { requestId: r.id, note }), msg).then(onDone);
  const [labelKey, kind] = STATUS[r.status] || ['', ''];
  const label = labelKey ? t(labelKey) : r.status;
  const receiver = r.type === 'swap' ? r.targetUserId : r.pickupUserId;

  return (
    <div className="swap-card">
      <div className="row wrap">
        <span className="badge">{TYPE[r.type] ? t(TYPE[r.type]) : r.type}</span>
        <span className={`badge ${kind}`}>{label}</span>
        <span className="spacer" />
        <span className="tiny faint">{stamp(r.createdAt)}</span>
      </div>
      <div className="swap-flow">
        <MiniShift s={r.shift} who={r.type === 'pickup' ? null : r.requesterId} />
        <div className="arrow faint"><Icon name={r.type === 'swap' ? 'swap' : 'right'} size={22} /></div>
        {r.type === 'swap'
          ? <MiniShift s={r.targetShift} who={r.targetUserId} />
          : <div className="mini-shift" style={{ '--jc': 'var(--border-strong)' }}>
              {receiver ? <div className="row" style={{ gap: 6 }}><Avatar user={people[receiver]} size="sm" /><b>{people[receiver]?.name}</b> {r.type === 'pickup' ? t('swaps.wantsIt') : t('swaps.takesIt')}</div>
                : <div className="muted small">{t('swaps.anyoneTrainedCanPickIt')}</div>}
            </div>}
      </div>
      {r.note && <div className="small">“{r.note}” <span className="faint">— {people[r.requesterId]?.name}</span></div>}
      {r.resolution && <div className="small muted">{t('swaps.noteResolution', { resolution: SYSTEM_NOTES[r.resolution] ? t(SYSTEM_NOTES[r.resolution]) : r.resolution })}</div>}
      {mode === 'approvals' && <Warnings items={r.warnings} />}
      {mode === 'offers' && <Warnings items={r.myConflicts?.map((w) => t('swaps.youWarning', { warning: w }))} />}

      {mode === 'approvals' && (
        <div className="row wrap">
          <input className="input sm" style={{ flex: 1, minWidth: 160 }} placeholder={t('swaps.optionalNoteToStaff')} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm danger" disabled={busy} onClick={() => act('swaps.deny', t('swaps.requestDenied'))}><Icon name="x" />{t('swaps.deny')}</button>
          <button className="btn sm ok" disabled={busy} onClick={() => act('swaps.approve', t('swaps.approvedScheduleUpdated'))}><Icon name="check" />{t('swaps.approve')}</button>
        </div>
      )}
      {mode === 'offers' && (
        <div className="row">
          <span className="spacer" />
          {r.type === 'swap' && <button className="btn sm" disabled={busy} onClick={() => act('swaps.decline', t('swaps.tradeDeclined'))}>{t('swaps.decline')}</button>}
          <button className="btn sm primary" disabled={busy} onClick={() => act('swaps.accept', r.type === 'swap' ? t('swaps.tradeAccepted') : t('swaps.youPickedItUp'))}>
            <Icon name="check" />{r.type === 'swap' ? t('swaps.acceptTrade') : t('swaps.pickUpShift')}
          </button>
        </div>
      )}
      {(mode === 'mine' || mode === 'open') && ['open', 'pending_approval'].includes(r.status) && (r.requesterId === me.id || mode === 'open') && (
        <div className="row"><span className="spacer" /><button className="btn sm danger" disabled={busy} onClick={() => act('swaps.cancel', t('swaps.requestCancelled'))}>{t('swaps.cancelRequest')}</button></div>
      )}
    </div>
  );
}
