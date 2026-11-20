import React, { useEffect, useState } from 'react';
import { useApp, Icon, Avatar, shiftTime, Empty, useAction, Warnings, JobDot } from '../ui.jsx';
import { prettyDate } from '../../../core/time.js';

const TYPE = { swap: 'Trade', drop: 'Giveaway', pickup: 'Open shift pickup' };
const STATUS = {
  open: ['Waiting on coworker', 'warn'], pending_approval: ['Waiting on manager', 'brand'], approved: ['Approved', 'ok'],
  denied: ['Denied', 'bad'], declined: ['Declined', 'bad'], cancelled: ['Cancelled', ''],
};

export default function Swaps() {
  const { call, version, canApprove, settings } = useApp();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(null);
  const load = () => call('swaps.list').then(setData);
  useEffect(() => { load(); }, [version]);
  if (!data) return <div className="empty">Loading…</div>;

  const tabs = [
    ...(canApprove ? [{ key: 'approvals', label: 'Needs approval', n: data.approvals.length }] : []),
    { key: 'offers', label: 'Up for grabs', n: data.offers.length },
    { key: 'mine', label: 'My requests', n: data.mine.filter((r) => ['open', 'pending_approval'].includes(r.status)).length },
    ...(canApprove ? [{ key: 'open', label: 'Waiting on staff', n: data.openPending.length }, { key: 'history', label: 'History' }] : []),
  ];
  const cur = tab || tabs[0].key;
  const list = { approvals: data.approvals, offers: data.offers, mine: data.mine, open: data.openPending, history: data.history }[cur];

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="tabs">
        {tabs.map((t) => <button key={t.key} className={cur === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}{t.n > 0 && <span className="count" style={{ background: cur === t.key ? 'var(--brand)' : 'var(--text-3)' }}>{t.n}</span>}</button>)}
      </div>
      {cur === 'offers' && <p className="small muted" style={{ marginTop: -4 }}>Shifts coworkers are giving away that you're trained for, plus trades offered directly to you.{settings.requireSwapApproval ? ' A manager approves before it’s final.' : ''}</p>}
      <div className="card">
        {!list.length && <Empty icon="swap" title={cur === 'approvals' ? 'Nothing to approve' : cur === 'offers' ? 'Nothing up for grabs right now' : 'No requests'}>
          {cur === 'mine' && 'Open any of your shifts to give it away or trade it.'}
        </Empty>}
        {list.map((r) => <RequestCard key={r.id} r={r} mode={cur} onDone={load} />)}
      </div>
    </div>
  );
}

function MiniShift({ s, who }) {
  const { jobs, people } = useApp();
  if (!s) return <div className="mini-shift">Shift removed</div>;
  const j = jobs[s.jobCodeId];
  return (
    <div className="mini-shift" style={{ '--jc': j?.color }}>
      <div className="row" style={{ gap: 6 }}><Avatar user={people[who]} size="sm" /><b>{who ? people[who]?.name : 'Open shift'}</b></div>
      <div className="small" style={{ marginTop: 4 }}><b>{prettyDate(s.date)}</b> · {shiftTime(s)}</div>
      <div className="small muted row" style={{ gap: 5 }}><JobDot job={j} />{j?.name}{s.area ? ` · ${s.area}` : ''}{s.tag ? ` · ${s.tag}` : ''}</div>
    </div>
  );
}

function RequestCard({ r, mode, onDone }) {
  const { call, people, me } = useApp();
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const act = (method, msg) => run(() => call(method, { requestId: r.id, note }), msg).then(onDone);
  const [label, kind] = STATUS[r.status] || [r.status, ''];
  const receiver = r.type === 'swap' ? r.targetUserId : r.pickupUserId;

  return (
    <div className="swap-card">
      <div className="row wrap">
        <span className="badge">{TYPE[r.type]}</span>
        <span className={`badge ${kind}`}>{label}</span>
        <span className="spacer" />
        <span className="tiny faint">{new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div className="swap-flow">
        <MiniShift s={r.shift} who={r.type === 'pickup' ? null : r.requesterId} />
        <div className="arrow faint"><Icon name={r.type === 'swap' ? 'swap' : 'right'} size={22} /></div>
        {r.type === 'swap'
          ? <MiniShift s={r.targetShift} who={r.targetUserId} />
          : <div className="mini-shift" style={{ '--jc': 'var(--border-strong)' }}>
              {receiver ? <div className="row" style={{ gap: 6 }}><Avatar user={people[receiver]} size="sm" /><b>{people[receiver]?.name}</b> {r.type === 'pickup' ? 'wants it' : 'takes it'}</div>
                : <div className="muted small">Anyone trained can pick it up</div>}
            </div>}
      </div>
      {r.note && <div className="small">“{r.note}” <span className="faint">— {people[r.requesterId]?.name}</span></div>}
      {r.resolution && <div className="small muted">Note: {r.resolution}</div>}
      {mode === 'approvals' && <Warnings items={r.warnings} />}
      {mode === 'offers' && <Warnings items={r.myConflicts?.map((w) => `You: ${w}`)} />}

      {mode === 'approvals' && (
        <div className="row wrap">
          <input className="input sm" style={{ flex: 1, minWidth: 160 }} placeholder="Optional note to staff" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm danger" disabled={busy} onClick={() => act('swaps.deny', 'Request denied')}><Icon name="x" />Deny</button>
          <button className="btn sm ok" disabled={busy} onClick={() => act('swaps.approve', 'Approved — schedule updated')}><Icon name="check" />Approve</button>
        </div>
      )}
      {mode === 'offers' && (
        <div className="row">
          <span className="spacer" />
          {r.type === 'swap' && <button className="btn sm" disabled={busy} onClick={() => act('swaps.decline', 'Trade declined')}>Decline</button>}
          <button className="btn sm primary" disabled={busy} onClick={() => act('swaps.accept', r.type === 'swap' ? 'Trade accepted' : 'You picked it up')}>
            <Icon name="check" />{r.type === 'swap' ? 'Accept trade' : 'Pick up shift'}
          </button>
        </div>
      )}
      {(mode === 'mine' || mode === 'open') && ['open', 'pending_approval'].includes(r.status) && (r.requesterId === me.id || mode === 'open') && (
        <div className="row"><span className="spacer" /><button className="btn sm danger" disabled={busy} onClick={() => act('swaps.cancel', 'Request cancelled')}>Cancel request</button></div>
      )}
    </div>
  );
}
