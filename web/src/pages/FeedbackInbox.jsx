// Feedback inbox (#/feedback-inbox): the readers' side of the Feedback box (core/feedback.js). Filters (kind, topic,
// status, signed or anonymous, dates), an entry's status, the reply thread with the person who wrote it, internal
// notes, and sharing an edited version on "You said, we did". Anonymous entries have no author, for anyone.
// While viewing as someone (View as) it's read-only: the actions are hidden and the server refuses them anyway.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Empty, Modal, useAction } from '../ui.jsx';
import { useT, prettyDate, stamp } from '../i18n/index.js';
import { StatusBadge, Thread } from './Feedback.jsx';
import '../feedback.css';

const EMPTY = { kind: '', topic: '', status: '', signed: '', from: '', to: '' };

export default function FeedbackInbox() {
  const t = useT();
  const { call, version, viewAs } = useApp();
  const [filters, setFilters] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    call('feedback.inbox.list', filters).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, [version, tick, JSON.stringify(filters)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  if (err && !data) return <Empty icon="alert" title={err} />;
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const any = Object.values(filters).some(Boolean);
  return (
    <div className="col fb-page" style={{ maxWidth: 900 }}>
      <p className="muted" style={{ margin: 0 }}>{t('feedback.inboxIntro')}</p>
      {viewAs && <div className="alert info"><Icon name="eye" size={16} />{t('feedback.readOnly')}</div>}
      <div className="fb-status-chips" role="group" aria-label={t('feedback.status')}>
        {data.statuses.map((s) => (
          <button key={s.id} className={`chip ${filters.status === s.id ? 'on' : ''}`} onClick={() => setFilters({ ...filters, status: filters.status === s.id ? '' : s.id })}>
            {s.label} <span className="fb-count">{data.counts[s.id] || 0}</span>
          </button>
        ))}
      </div>
      <div className="card card-pad fb-filters">
        <select className="input" value={filters.kind} onChange={set('kind')} aria-label={t('feedback.kind')}>
          <option value="">{t('feedback.allKinds')}</option>
          {data.kinds.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <select className="input" value={filters.topic} onChange={set('topic')} aria-label={t('feedback.topic')}>
          <option value="">{t('feedback.allTopics')}</option>
          {data.topics.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <select className="input" value={filters.signed} onChange={set('signed')} aria-label={t('feedback.signedAll')}>
          <option value="">{t('feedback.signedAll')}</option>
          <option value="signed">{t('feedback.signedOnly')}</option>
          <option value="anonymous">{t('feedback.anonOnly')}</option>
        </select>
        <label className="fb-date"><span>{t('feedback.from')}</span><input className="input" type="date" value={filters.from} onChange={set('from')} /></label>
        <label className="fb-date"><span>{t('feedback.to')}</span><input className="input" type="date" value={filters.to} onChange={set('to')} /></label>
        {any && <button className="btn ghost sm" onClick={() => setFilters(EMPTY)}>{t('feedback.clear')}</button>}
      </div>
      {data.items.length === 0 && <Empty icon="mail" title={t('feedback.inboxEmpty')} />}
      {data.items.length > 0 && (
        <div className="card list fb-list">
          {data.items.map((e) => (
            <button key={e.id} className="list-item click fb-item" onClick={() => setOpenId(e.id)}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <b>{e.kindLabel}</b>{e.topicLabel && <span className="muted">· {e.topicLabel}</span>}
                  {e.adminsOnly && <span className="badge warn">{t('feedback.adminsOnly')}</span>}
                </div>
                <div className="small fb-preview">{e.message}</div>
                <div className="tiny faint">{prettyDate(e.date)} · {e.author ? t('feedback.signedBy', { name: e.author.name }) : t('feedback.anonymous')}{e.replies ? ` · ${t('feedback.replies', { count: e.replies })}` : ''}</div>
              </div>
              <StatusBadge status={e.status} label={e.statusLabel} />
            </button>
          ))}
        </div>
      )}
      {openId && <EntryModal id={openId} statuses={data.statuses} onClose={() => { setOpenId(null); setTick((n) => n + 1); }} />}
    </div>
  );
}

function EntryModal({ id, statuses, onClose }) {
  const t = useT();
  const { call, viewAs, toast } = useApp();
  const [e, setE] = useState(null);
  const [err, setErr] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [sharing, setSharing] = useState(false);
  const [asked, setAsked] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => {
    call('feedback.inbox.get', { id }).then((x) => {
      setE(x);
      // Opening a new entry marks it seen (not while viewing as someone: read-only).
      if (x.status === 'new' && !viewAs) call('feedback.setStatus', { id, status: 'seen' }).then(setE).catch(() => {});
    }).catch((x) => setErr(x.message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (method, args, ok) => { const r = await run(() => call(method, { id, ...args }), ok); if (r) setE(r); return r; };
  return (
    <Modal wide title={e ? [e.kindLabel, e.topicLabel].filter(Boolean).join(' · ') : t('feedback.inboxNav')} onClose={onClose}
      sub={e ? `${prettyDate(e.date)} · ${e.author ? t('feedback.signedBy', { name: e.author.name }) : t('feedback.anonymous')}` : ''}>
      {err && <div className="alert bad"><Icon name="alert" size={16} />{err}</div>}
      {!e && !err && <div className="empty">{t('common.loading')}</div>}
      {e && (
        <>
          <div className="fb-message">{e.message}</div>
          <div className="field">
            <span>{t('feedback.status')}</span>
            <div className="fb-chips" role="radiogroup" aria-label={t('feedback.status')}>
              {statuses.map((s) => (
                <button key={s.id} role="radio" aria-checked={e.status === s.id} className={`chip ${e.status === s.id ? 'on' : ''}`} disabled={busy || !!viewAs}
                  onClick={() => act('feedback.setStatus', { status: s.id })}>{s.label}</button>
              ))}
            </div>
          </div>

          <section className="col" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}>{t('feedback.thread')}</h3>
            <Thread items={e.thread} mineLabel={e.author ? e.author.name : t('feedback.anonymous')} />
            {!viewAs && (
              <>
                <textarea className="input" rows={3} maxLength={2000} value={reply} onChange={(x) => setReply(x.target.value)} aria-label={t('feedback.replyTo')} placeholder={t('feedback.replyTo')} />
                <div className="row wrap" style={{ gap: 8 }}>
                  <span className="help" style={{ flex: 1 }}>{e.signed ? t('feedback.replyHelpSigned') : t('feedback.replyHelpAnon')}</span>
                  <button className="btn primary" disabled={busy || !reply.trim()} onClick={async () => { if (await act('feedback.reply', { text: reply }, t('feedback.sent'))) setReply(''); }}><Icon name="send" />{t('feedback.reply')}</button>
                </div>
              </>
            )}
          </section>

          <section className="col fb-notes" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}><Icon name="lock" size={14} /> {t('feedback.notes')}</h3>
            <div className="help">{t('feedback.notesHelp')}</div>
            {e.notes.map((n) => (
              <div key={n.id} className="fb-bubble note"><div className="tiny faint">{n.name} · {stamp(n.at)}</div><div className="fb-text">{n.text}</div></div>
            ))}
            {!viewAs && (
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <textarea className="input" rows={2} maxLength={1000} value={note} onChange={(x) => setNote(x.target.value)} aria-label={t('feedback.addNote')} placeholder={t('feedback.notePlaceholder')} />
                <button className="btn" disabled={busy || !note.trim()} onClick={async () => { if (await act('feedback.note', { text: note })) setNote(''); }}>{t('feedback.addNote')}</button>
              </div>
            )}
          </section>

          <section className="col" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}><Icon name="megaphone" size={14} /> {t('feedback.share')}</h3>
            {e.shared ? (
              <div className="col" style={{ gap: 6 }}>
                <div className="alert ok"><Icon name="check" size={16} />{t('feedback.sharedOn', { date: prettyDate(e.shared.date) })}</div>
                <div className="fb-message">{e.shared.text}</div>
                {e.shared.reply && <div className="fb-did"><b>{t('feedback.whatWeDid')}:</b> {e.shared.reply}</div>}
                {!viewAs && <div><button className="btn ghost sm" disabled={busy} onClick={() => act('feedback.unshare', {})}>{t('feedback.unshare')}</button></div>}
              </div>
            ) : !viewAs && (sharing ? <ShareForm entry={e} busy={busy} onCancel={() => setSharing(false)}
              onShare={async (args) => { if (await act('feedback.share', args)) setSharing(false); }}
              onAsk={async () => { const r = await run(() => call('feedback.askName', { id })); if (r) { setAsked(true); toast(t('feedback.asked')); } }} asked={asked} />
              : <div><button className="btn" onClick={() => setSharing(true)}>{t('feedback.share')}</button></div>)}
          </section>
        </>
      )}
    </Modal>
  );
}

function ShareForm({ entry, busy, onCancel, onShare, onAsk, asked }) {
  const t = useT();
  const [text, setText] = useState(entry.message.slice(0, 1000));
  const lastReply = [...(entry.thread || [])].reverse().find((m) => m.from === 'reader')?.text || '';
  const [reply, setReply] = useState(lastReply.slice(0, 1000));
  const [showName, setShowName] = useState(false);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="help">{t('feedback.shareHelp')}</div>
      <label className="field"><span>{t('feedback.shareText')}</span><textarea className="input" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label className="field"><span>{t('feedback.shareReply')}</span><textarea className="input" rows={2} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} /></label>
      {entry.signed && (entry.nameOk
        ? <label className="check"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} />{t('feedback.showName')}</label>
        : <div className="row wrap" style={{ gap: 8 }}><span className="help">{t('feedback.showNameNo')}</span><button className="btn ghost sm" disabled={busy || asked} onClick={onAsk}>{asked ? t('feedback.asked') : t('feedback.askName')}</button></div>)}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => onShare({ text, reply, showName })}>{t('feedback.shareSave')}</button>
      </div>
    </div>
  );
}
