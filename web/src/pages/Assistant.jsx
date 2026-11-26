// Ask ShiftBoard (#/ask): a chat with Claude that answers from ShiftBoard as the signed-in person. Answers stream in;
// a change it proposes is a card with Confirm and Cancel, and only the tap runs it (server/assistant/). Suggested
// questions by role, recent chats, Clear history, and "AI can make mistakes". Phone first (360px): the composer
// sits above the bottom bar, its text is 16px (no zoom on iPhones).
// Settings → Ask ShiftBoard (admins) is AssistantSettingsCard below.
import React, { useEffect, useRef, useState } from 'react';
import { useApp, Icon, Modal } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { status as getStatus, conversation, ask, decide, clearHistory, assistantSettings, saveAssistantSettings } from '../assistant-api.js';
import { Markdown } from './TrainingShared.jsx';
import { useT, stamp } from '../i18n/index.js';
import '../assistant.css';

/** The suggested questions for this person: their own week for staff, the team's for managers. */
function starters({ isMgr, has, canApprove }) {
  const keys = isMgr
    ? ['tonight', 'over40', 'drafts', canApprove && 'approvals', has('eightySix') && 'eightySix']
    : ['whenNext', 'tonight', has('eightySix') && 'eightySix', 'openShifts'];
  return keys.filter(Boolean).slice(0, 4).map((k) => ({ whenNext: 's_whenNext', tonight: 's_tonight', eightySix: 's_eightySix', openShifts: 's_openShifts', over40: 's_over40', drafts: 's_drafts', approvals: 's_approvals' }[k]));
}

export default function Assistant() {
  const t = useT();
  const app = useApp();
  const { viewAs, toast, me } = app;
  const [info, setInfo] = useState(null); // status: available, reason, message, conversations, today
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [live, setLive] = useState(null); // the answer being written: { text, tool }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  const load = () => getStatus().then(setInfo, (e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [messages, live]);

  const viewing = !!viewAs || info?.viewAs;
  const blocked = viewing || (info && !info.available && !['cap', 'daily'].includes(info.reason));

  const send = async (text) => {
    const message = String(text ?? draft).trim();
    if (!message || busy || blocked) return;
    setDraft('');
    setBusy(true);
    const tempId = `tmp_${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', text: message, at: new Date().toISOString() }]);
    setLive({ text: '', tool: null });
    try {
      await ask({ message, conversationId: chatId }, {
        start: (ev) => { setChatId(ev.conversationId); setMessages((m) => m.map((x) => (x.id === tempId ? ev.userMessage : x))); },
        status: (tool) => setLive((l) => ({ ...(l || { text: '' }), tool })),
        text: (d) => setLive((l) => ({ text: `${l?.text || ''}${d}`, tool: null })),
        done: (ev) => { setLive(null); setMessages((m) => [...m, ev.message]); },
      });
      getStatus().then(setInfo, () => {});
    } catch (e) {
      setLive(null);
      setMessages((m) => [...m, { id: `err_${Date.now()}`, role: 'assistant', text: e.viewAs ? t('assistant.viewAsNote') : e.message || t('assistant.failed'), notice: 'error', at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onDecide = async (msg, action, decision) => {
    const mark = (a) => setMessages((list) => list.map((m) => (m.id !== msg.id ? m : { ...m, actions: m.actions.map((x) => (x.id === action.id ? { ...x, ...a } : x)) })));
    mark({ status: 'running' });
    try {
      const r = await decide(action.id, chatId, decision);
      mark(r.action);
      if (r.ok && decision === 'confirm') app.refresh();
    } catch (e) {
      if (e.action) mark(e.action); else { mark({ status: 'proposed' }); toast(e.message, 'bad'); }
    }
  };

  const openChat = async (id) => {
    setHistoryOpen(false);
    try {
      const c = await conversation(id);
      if (!c) return;
      setChatId(c.id);
      setMessages(c.messages);
    } catch (e) { toast(e.message, 'bad'); }
  };
  const newChat = () => { setChatId(null); setMessages([]); setLive(null); setHistoryOpen(false); inputRef.current?.focus(); };
  const clear = async () => {
    if (!window.confirm(t('assistant.clearConfirm'))) return;
    try { await clearHistory(); newChat(); load(); toast(t('assistant.cleared')); } catch (e) { toast(e.message, 'bad'); }
  };

  const empty = !messages.length && !live;
  const suggestions = starters(app);
  return (
    <div className="ask">
      <div className="ask-bar">
        <span className="ask-mark" aria-hidden="true"><Icon name="sparkle" size={18} /></span>
        {info?.today?.limit && !IS_DEMO && !viewing ? <span className="tiny muted ask-count">{t('assistant.today', { used: info.today.messages, limit: info.today.limit })}</span> : null}
        <span className="spacer" />
        {!viewing && <button type="button" className="btn sm ghost" onClick={() => setHistoryOpen(true)}><Icon name="clock" size={16} /><span className="ask-btn-label">{t('assistant.history')}</span></button>}
        {!viewing && !empty && <button type="button" className="btn sm" onClick={newChat}><Icon name="plus" size={16} /><span className="ask-btn-label">{t('assistant.newChat')}</span></button>}
      </div>

      {viewing && <div className="alert warn"><Icon name="eye" size={16} /><span>{t('assistant.viewAsNote')}</span></div>}
      {!viewing && info && !info.available && <div className="alert warn"><Icon name="alert" size={16} /><span>{info.message || t('assistant.unavailable')}</span></div>}
      {IS_DEMO && <div className="alert info"><Icon name="sparkle" size={16} /><span>{t('assistant.demoNote')}</span></div>}

      <div className="ask-thread" aria-live="polite">
        {empty && (
          <div className="ask-empty">
            <p className="ask-intro">{t('assistant.intro')}</p>
            {!blocked && (
              <>
                <div className="small muted">{t('assistant.tryAsking')}</div>
                <div className="ask-starters">
                  {suggestions.map((k) => <button key={k} type="button" className="ask-chip" onClick={() => send(t(`assistant.${k}`))} disabled={busy}>{t(`assistant.${k}`)}</button>)}
                </div>
              </>
            )}
          </div>
        )}
        {messages.map((m) => <Bubble key={m.id} m={m} me={me} onDecide={onDecide} />)}
        {live && (
          <div className="ask-msg bot">
            <div className="ask-bubble">
              {live.text ? <Markdown text={live.text} className="ask-md" /> : <span className="ask-typing">{live.tool ? t(`assistant.tool_${live.tool}`) === `assistant.tool_${live.tool}` ? t('assistant.looking') : t(`assistant.tool_${live.tool}`) : t('assistant.thinking')}</span>}
            </div>
          </div>
        )}
        <div ref={endRef} className="ask-end" />
      </div>

      <div className="ask-dock">
      <form className="ask-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef} className="input ask-input" rows={1} maxLength={2000} value={draft} disabled={blocked}
          placeholder={t('assistant.placeholder')} aria-label={t('assistant.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        <button type="submit" className="btn primary icon ask-send" disabled={busy || blocked || !draft.trim()} aria-label={t('assistant.send')} title={t('assistant.send')}><Icon name="send" /></button>
      </form>
      <div className="ask-foot">{t('assistant.disclaimer')}</div>
      </div>

      {historyOpen && (
        <Modal title={t('assistant.history')} onClose={() => setHistoryOpen(false)}
          footer={<><button type="button" className="btn danger" disabled={!info?.conversations?.length} onClick={clear}><Icon name="trash" size={16} />{t('assistant.clear')}</button><span className="spacer" /><button type="button" className="btn primary" onClick={newChat}><Icon name="plus" size={16} />{t('assistant.newChat')}</button></>}>
          {!info?.conversations?.length ? <div className="muted">{t('assistant.noHistory')}</div> : (
            <div className="list" style={{ margin: '-8px -18px' }}>
              {info.conversations.map((c) => (
                <div key={c.id} role="button" tabIndex={0} className={`list-item click ask-hist ${c.id === chatId ? 'active' : ''}`} onClick={() => openChat(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') openChat(c.id); }}>
                  <span className="ask-hist-title">{c.title}</span>
                  <span className="tiny faint">{stamp(c.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function Bubble({ m, onDecide }) {
  const mine = m.role === 'user';
  return (
    <div className={`ask-msg ${mine ? 'me' : 'bot'}`}>
      <div className={`ask-bubble ${m.notice ? 'notice' : ''}`}>
        {mine ? <span className="ask-plain">{m.text}</span> : m.text ? <Markdown text={m.text} className="ask-md" /> : null}
      </div>
      {(m.actions || []).map((a) => <ActionCard key={a.id} a={a} onDecide={(d) => onDecide(m, a, d)} />)}
    </div>
  );
}

const STATUS_BADGE = { done: 'ok', failed: 'bad', cancelled: '', expired: '', running: 'brand' };
function ActionCard({ a, onDecide }) {
  const t = useT();
  const { lang } = useApp();
  const open = a.status === 'proposed';
  return (
    <div className={`ask-action ${a.status}`}>
      <div className="ask-action-head">
        <Icon name="edit" size={16} />
        <b>{a.title}</b>
        {!open && <span className={`badge ${STATUS_BADGE[a.status] ?? ''}`}>{a.status === 'done' && <Icon name="check" size={12} />}{t(`assistant.st_${a.status}`)}</span>}
      </div>
      {!!a.details?.length && (
        <dl className="ask-details">
          {a.details.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
      {a.status === 'failed' && a.result && <div className="small" style={{ color: 'var(--bad)' }}>{a.result}</div>}
      {a.status === 'done' && a.result && lang !== 'es' && <div className="small muted">{a.result}</div>}
      {open && (
        <>
          <div className="help">{t('assistant.actionNote')}</div>
          <div className="ask-action-buttons">
            <button type="button" className="btn" onClick={() => onDecide('cancel')}>{t('assistant.cancel')}</button>
            <button type="button" className="btn primary" onClick={() => onDecide('confirm')}><Icon name="check" size={16} />{t('assistant.confirm')}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Settings → Ask ShiftBoard (admins) ----------
const usd = (v) => (Number(v) > 0 && Number(v) < 0.01 ? '<$0.01' : `$${Number(v || 0).toFixed(2)}`);
export function AssistantSettingsCard() {
  const t = useT();
  const { has, toast, managed } = useApp();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (IS_DEMO || !has('assistant')) return;
    assistantSettings().then(setS, (e) => toast(e.message, 'bad'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!has('assistant')) return null;
  if (IS_DEMO) {
    return (
      <div className="card card-pad col" style={{ gap: 12 }}>
        <h2>{t('assistant.settingsTitle')}</h2>
        <div className="help">{t('assistant.settingsIntro')}</div>
        <div className="alert info"><Icon name="sparkle" size={16} /><span>{t('assistant.demoSettings')}</span></div>
      </div>
    );
  }
  if (!s) return null;
  const save = async (patch) => {
    setBusy(true);
    try { setS(await saveAssistantSettings(patch)); toast(t('assistant.saved')); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const u = s.usage;
  const pct = u.capUsd > 0 ? Math.min(100, Math.round((u.usedUsd / u.capUsd) * 100)) : u.usedUsd > 0 ? 100 : 0;
  return (
    <div className="card card-pad col ask-settings" style={{ gap: 12 }} id="ask-shiftboard">
      <h2>{t('assistant.settingsTitle')}</h2>
      <div className="help">{t('assistant.settingsIntro')}</div>
      {!s.ready && <div className="alert warn"><Icon name="alert" size={16} /><span>{t('assistant.notReady')}</span></div>}
      <label className="check"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} />{t('assistant.on')}</label>
      {!s.enabled && <div className="alert warn"><Icon name="alert" size={16} /><span>{t('assistant.offNote')}</span></div>}
      <label className="check"><input type="checkbox" checked={s.staff} disabled={busy || !s.enabled} onChange={(e) => save({ staff: e.target.checked })} /><span>{t('assistant.staff')}</span></label>
      <div className="help">{t('assistant.rolesNote')} {t('assistant.dailyLimit', { limit: s.dailyLimit })}</div>

      <div className="col" style={{ gap: 6 }}>
        <div className="ask-usage-head"><b>{t('assistant.usageTitle')}</b><span className="ask-usage-num">{t('assistant.usageOf', { used: usd(u.usedUsd), cap: usd(u.capUsd) })}</span></div>
        <div className="ask-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('assistant.usageTitle')}>
          <span style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''} />
        </div>
        <div className="help">{pct >= 100 ? t('assistant.usageCapped') : t('assistant.usageHelp', { cap: usd(u.capUsd) })} · {t('assistant.calls', { count: u.calls })}</div>
        {u.ownUsd > 0 && <div className="help">{t('assistant.usageOwn', { own: usd(u.ownUsd) })}</div>}
      </div>

      <div className="col" style={{ gap: 6 }}>
        <b>{t('assistant.topPeople')}</b>
        {!s.top.length ? <div className="help">{t('assistant.nobodyYet')}</div> : (
          <ol className="ask-top">
            {s.top.map((p) => <li key={p.id}><span className="ask-top-name">{p.name}</span><span className="tiny muted">{t('assistant.messages', { count: p.messages })} · {usd(p.usd)}</span></li>)}
          </ol>
        )}
      </div>
      <div className="alert info"><Icon name="key" size={16} /><span>{managed || s.platform ? t('assistant.byoKey') : t('assistant.byoKeySingle')}</span></div>
    </div>
  );
}
