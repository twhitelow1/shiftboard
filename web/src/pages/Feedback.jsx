// Feedback box (#/feedback, for everyone): write an entry (anonymous unless they sign it), My feedback (the anonymous
// entries' codes kept on this device, open with a code, the signed ones) and "You said, we did". The rules and what's
// stored are in core/feedback.js; readers work in pages/FeedbackInbox.jsx.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Empty, Modal, useAction } from '../ui.jsx';
import { useT, prettyDate, stamp } from '../i18n/index.js';
import { IS_DEMO } from '../api.js';
import { savedCodes, keepCode, forgetCode, markSeen, signedSeen, markSignedSeen } from '../feedback-codes.js';
import '../feedback.css';

const MAX = 2000;
const TABS = ['write', 'mine', 'board'];

export default function Feedback({ parts = [] }) {
  const t = useT();
  const tab = TABS.includes(parts[1]) ? parts[1] : 'write';
  const go = (k) => { location.hash = k === 'write' ? '#/feedback' : `#/feedback/${k}`; };
  return (
    <div className="col fb-page" style={{ maxWidth: 760 }}>
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {t(k === 'write' ? 'feedback.tabWrite' : k === 'mine' ? 'feedback.tabMine' : 'feedback.tabBoard')}
          </button>
        ))}
      </div>
      {tab === 'write' && <WriteForm onMine={() => go('mine')} />}
      {tab === 'mine' && <MyFeedback />}
      {tab === 'board' && <Board />}
    </div>
  );
}

// ---------- write ----------
function WriteForm({ onMine }) {
  const t = useT();
  const { call, viewAs } = useApp();
  const [form, setForm] = useState(null);
  const [kind, setKind] = useState('');
  const [topic, setTopic] = useState('');
  const [message, setMessage] = useState('');
  const [signed, setSigned] = useState(false);
  const [done, setDone] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { call('feedback.form.get').then((f) => { setForm(f); setKind((k) => k || f.kinds[0]?.id || ''); }).catch(() => setForm(false)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (form === null) return <div className="empty">{t('common.loading')}</div>;
  if (!form) return <Empty icon="alert" title={t('feedback.inboxEmpty')} />;
  if (done) return <Sent done={done} onAgain={() => { setDone(null); setMessage(''); setSigned(false); }} onMine={onMine} />;
  const k = form.kinds.find((x) => x.id === kind);
  const send = async () => {
    const r = await run(() => call('feedback.submit', { kind, topic, message, signed }));
    if (!r) return;
    setDone({ ...r, kept: r.code ? keepCode(r.code) : false });
  };
  return (
    <div className="card card-pad col fb-form" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>{t('feedback.intro')}</p>
      {IS_DEMO && <div className="alert info"><Icon name="alert" size={16} />{t('feedback.demoLocal')}</div>}
      <div className="field">
        <span id="fb-kind">{t('feedback.kind')}</span>
        <div className="fb-chips" role="radiogroup" aria-labelledby="fb-kind">
          {form.kinds.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={kind === x.id} className={`chip ${kind === x.id ? 'on' : ''}`} onClick={() => setKind(x.id)}>{x.label}</button>
          ))}
        </div>
      </div>
      {k?.safety && <SafetyNote form={form} />}
      {form.topics.length > 0 && (
        <label className="field"><span>{t('feedback.topic')}</span>
          <select className="input" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">{t('feedback.topicNone')}</option>
            {form.topics.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>{t('feedback.message')}</span>
        <textarea className="input" rows={6} maxLength={MAX} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('feedback.messagePlaceholder')} />
        <span className="help" style={{ textAlign: 'right' }}>{t('feedback.chars', { count: message.length, max: MAX })}</span>
      </label>
      <label className="fb-switch">
        <input type="checkbox" role="switch" checked={signed} onChange={(e) => setSigned(e.target.checked)} />
        <span className="fb-switch-track" aria-hidden="true"><span /></span>
        <span><b>{t('feedback.signIt')}</b><span className="help" style={{ display: 'block' }}>{t('feedback.signItHelp')}</span></span>
      </label>
      <div className="fb-see">
        <div style={{ fontWeight: 700 }}>{t('feedback.seeTitle')}</div>
        <div>{t(signed ? 'feedback.seeSigned' : 'feedback.seeAnon')}</div>
        <div>{t(signed ? 'feedback.notSeeSigned' : 'feedback.notSeeAnon')}</div>
        <div className="help">{k?.adminsOnly ? t('feedback.readersAdmins') : t(form.supervisorsCanRead ? 'feedback.readersSup' : 'feedback.readersMgr')}</div>
      </div>
      <HowAnonymous />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={busy || !kind || !message.trim() || !!viewAs} onClick={send}><Icon name="send" />{t('feedback.send')}</button>
      </div>
    </div>
  );
}

/** For kinds with the safety note (Concern / report): the note, the call-out line and today's managers on duty. */
function SafetyNote({ form }) {
  const t = useT();
  const tel = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
  return (
    <div className="alert warn fb-safety" role="note">
      <Icon name="alert" size={16} />
      <div className="col" style={{ gap: 6, minWidth: 0 }}>
        <b>{t('feedback.safetyTitle')}</b>
        <span>{form.safetyNote}</span>
        {form.callOutPhone && <span>{t('feedback.callOut')}: <a href={tel(form.callOutPhone)}>{form.callOutPhone}</a></span>}
        {form.managers?.map((m) => (
          <span key={`${m.name}${m.phone}`}>{t('feedback.onDuty')}: {m.name}{m.phone && <> · <a href={tel(m.phone)}>{m.phone}</a></>}</span>
        ))}
      </div>
    </div>
  );
}

/** "How anonymous is this?": what's kept, what isn't, and what could still give someone away. */
export function HowAnonymous() {
  const t = useT();
  return (
    <details className="fb-how">
      <summary>{t('feedback.howAnon')}</summary>
      <p>{t('feedback.howAnon1')}</p>
      <p>{t('feedback.howAnon2')}</p>
      <p>{t('feedback.howAnon3')}</p>
      <p>{t('feedback.howAnon4')}</p>
    </details>
  );
}

function Sent({ done, onAgain, onMine }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(done.code); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2 className="row" style={{ margin: 0, gap: 8 }}><Icon name="check" size={20} />{t('feedback.sentTitle')}</h2>
      {done.signed ? <p style={{ margin: 0 }}>{t('feedback.sentSigned')}</p> : (
        <>
          <div style={{ fontWeight: 700 }}>{t('feedback.codeTitle')}</div>
          <div className="fb-code-row">
            <code className="fb-code" aria-label={t('feedback.codeTitle')}>{done.code}</code>
            <button className="btn" onClick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? t('feedback.copied') : t('feedback.copy')}</button>
          </div>
          <p className="small" style={{ margin: 0 }}>{t('feedback.codeHelp')}</p>
          <p className="help" style={{ margin: 0 }}>{done.kept ? t('feedback.codeKept') : t('feedback.codeNotKept')}</p>
        </>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn" onClick={onAgain}>{t('feedback.writeAnother')}</button>
        <button className="btn ghost" onClick={onMine}>{t('feedback.seeMine')}</button>
      </div>
    </div>
  );
}

// ---------- My feedback ----------
function MyFeedback() {
  const t = useT();
  const { call, viewAs, version } = useApp();
  const [codes, setCodes] = useState(() => (viewAs ? [] : savedCodes()));
  const [summary, setSummary] = useState([]);
  const [signed, setSigned] = useState(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(null); // { code } or { id }
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (codes.length) call('feedback.codes.summary', { codes: codes.map((c) => c.code) }).then(setSummary).catch(() => setSummary([]));
    else setSummary([]);
    call('feedback.mine.list').then(setSigned).catch(() => setSigned([]));
  }, [version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const refreshCodes = () => { setCodes(viewAs ? [] : savedCodes()); setTick((n) => n + 1); };
  const openTyped = async () => {
    setErr('');
    try {
      await call('feedback.byCode.get', { code: typed });
      const code = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g).join('-');
      if (!viewAs) keepCode(code); // opened here: kept on this device too, for the badge
      setTyped('');
      setOpen({ code });
    } catch (e) { setErr(e.message); }
  };
  const seenSigned = signedSeen();
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>{t('feedback.deviceTitle')}</h2>
        <div className="help">{viewAs ? t('feedback.viewingNote') : t('feedback.deviceHelp')}</div>
        {!viewAs && !codes.length && <div className="muted small">{t('feedback.deviceEmpty')}</div>}
        {codes.length > 0 && (
          <div className="list fb-list">
            {codes.map((c, i) => {
              const s = summary[i];
              const fresh = s?.found && s.replies > c.seen;
              return (
                <button key={c.code} className="list-item click fb-item" onClick={() => setOpen({ code: c.code })}>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600 }}>{s?.found ? [s.kindLabel, s.topicLabel].filter(Boolean).join(' · ') : <span className="muted">{t('feedback.notFound')}</span>}</div>
                    <div className="tiny faint fb-mono">{c.code}{s?.found ? ` · ${prettyDate(s.date)}` : ''}</div>
                  </div>
                  {fresh && <span className="badge brand">{t('feedback.newReply')}</span>}
                  {s?.found && <StatusBadge status={s.status} label={s.statusLabel} />}
                </button>
              );
            })}
          </div>
        )}
        <div className="field">
          <span>{t('feedback.openWithCode')}</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input fb-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label={t('feedback.openWithCode')} />
            <button className="btn" disabled={typed.replace(/[\s-]/g, '').length < 16} onClick={openTyped}>{t('feedback.open')}</button>
          </div>
          {err && <span className="help" style={{ color: 'var(--bad)' }}>{err}</span>}
        </div>
      </div>

      <div className="card card-pad col" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>{t('feedback.signedTitle')}</h2>
        {signed?.length === 0 && <div className="muted small">{t('feedback.signedEmpty')}</div>}
        {signed?.length > 0 && (
          <div className="list fb-list">
            {signed.map((e) => (
              <button key={e.id} className="list-item click fb-item" onClick={() => setOpen({ id: e.id })}>
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontWeight: 600 }}>{[e.kindLabel, e.topicLabel].filter(Boolean).join(' · ')}</div>
                  <div className="small muted ellipsis">{e.message}</div>
                  <div className="tiny faint">{prettyDate(e.date)}</div>
                </div>
                {e.replies > (seenSigned[e.id] || 0) && <span className="badge brand">{t('feedback.newReply')}</span>}
                <StatusBadge status={e.status} label={e.statusLabel} />
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <MineModal which={open} onClose={() => { setOpen(null); refreshCodes(); }} onForget={(code) => { forgetCode(code); setOpen(null); refreshCodes(); }} />}
    </div>
  );
}

export function StatusBadge({ status, label }) {
  const tone = { new: 'brand', seen: '', in_progress: 'warn', done: 'ok', wont_do: '' }[status] || '';
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** One of my entries: by its code (anonymous) or its id (signed). */
function MineModal({ which, onClose, onForget }) {
  const t = useT();
  const { call, viewAs } = useApp();
  const [e, setE] = useState(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  const load = () => (which.code ? call('feedback.byCode.get', { code: which.code }) : call('feedback.mine.get', { id: which.id }));
  useEffect(() => { load().then(setE).catch((x) => setErr(x.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!e || viewAs) return;
    if (which.code) markSeen(which.code, e.replies); else markSignedSeen(which.id, e.replies);
  }, [e]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    const r = await run(() => (which.code ? call('feedback.byCode.reply', { code: which.code, text }) : call('feedback.mine.reply', { id: which.id, text })), t('feedback.sent'));
    if (r) { setE(r); setText(''); }
  };
  const nameOk = async (ok) => { const r = await run(() => call('feedback.mine.nameOk', { id: which.id, ok })); if (r) setE(r); };
  return (
    <Modal title={e ? [e.kindLabel, e.topicLabel].filter(Boolean).join(' · ') : t('feedback.tabMine')} onClose={onClose}
      footer={which.code && !viewAs ? <button className="btn ghost" onClick={() => onForget(which.code)}><Icon name="trash" />{t('feedback.removeFromDevice')}</button> : null}>
      {err && <div className="alert bad"><Icon name="alert" size={16} />{err}</div>}
      {!e && !err && <div className="empty">{t('common.loading')}</div>}
      {e && (
        <>
          <div className="row wrap" style={{ gap: 6 }}>
            <StatusBadge status={e.status} label={e.statusLabel} />
            <span className="badge">{e.signed ? t('feedback.signedOnly') : t('feedback.anonymous')}</span>
            <span className="tiny faint">{prettyDate(e.date)}</span>
          </div>
          <div className="fb-message">{e.message}</div>
          <Thread items={e.thread} mineLabel={t('feedback.you')} />
          {e.shared && <div className="alert ok"><Icon name="megaphone" size={16} />{t('feedback.sharedOn', { date: prettyDate(e.shared.date) })}</div>}
          {e.signed && (
            <label className="check"><input type="checkbox" checked={!!e.nameOk} disabled={busy || !!viewAs} onChange={(x) => nameOk(x.target.checked)} />{t('feedback.nameOk')}</label>
          )}
          <label className="field"><span>{t('feedback.writeBack')}</span>
            <textarea className="input" rows={3} maxLength={MAX} value={text} onChange={(x) => setText(x.target.value)} />
            {!e.signed && <span className="help">{t('feedback.writeBackAnon')}</span>}
          </label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={busy || !text.trim() || !!viewAs} onClick={send}><Icon name="send" />{t('feedback.reply')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The conversation: readers' replies (name and time) and the writer's messages (the date only). */
export function Thread({ items = [], mineLabel }) {
  const t = useT();
  if (!items.length) return <div className="muted small">{t('feedback.noReplies')}</div>;
  return (
    <div className="col fb-thread" style={{ gap: 8 }} aria-label={t('feedback.thread')}>
      {items.map((m) => (
        <div key={m.id} className={`fb-bubble ${m.from === 'reader' ? 'reader' : 'writer'}`}>
          <div className="tiny faint">{m.from === 'reader' ? `${m.name} · ${stamp(m.at)}` : `${mineLabel} · ${prettyDate(m.date)}`}</div>
          <div className="fb-text">{m.text}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- You said, we did ----------
function Board() {
  const t = useT();
  const { call, version } = useApp();
  const [items, setItems] = useState(null);
  useEffect(() => { call('feedback.board.list').then(setItems).catch(() => setItems([])); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>{t('feedback.boardIntro')}</p>
      {items === null && <div className="empty">{t('common.loading')}</div>}
      {items?.length === 0 && <Empty icon="megaphone" title={t('feedback.boardEmpty')} />}
      {items?.map((b) => (
        <div key={b.id} className="card card-pad col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="badge brand">{b.kindLabel}</span>
            {b.topicLabel && <span className="badge">{b.topicLabel}</span>}
            <span className="tiny faint">{prettyDate(b.date)}</span>
          </div>
          <div className="fb-message">{b.text}</div>
          {b.name && <div className="small muted">— {b.name}</div>}
          {b.reply && <div className="fb-did"><b>{t('feedback.whatWeDid')}:</b> {b.reply}</div>}
        </div>
      ))}
    </div>
  );
}
