// Announcements (plan feature `announcements`; core/announcements.js has the rules, server/announcements.js sends).
//   Managers and up: write one (title, message, optional Spanish version, a link to a page, who gets it, email
//   and/or text on top of in-app + push, now or later), see who each channel reaches before sending, confirm,
//   then follow it in Sent & scheduled: counts, who read it, and each person's delivery (sent, failed, not sent
//   and why). Scheduled ones can be cancelled until they go out.
//   Everyone: the announcements they got (also in their notifications); opening one is the read receipt.
// Also here: the admins' card in Settings (texts per person per day, quiet hours) and the My Shifts card.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Empty, Field, useAction } from '../ui.jsx';
import { ROLES, roleLabelPlural, canChangeSettings } from '../../../core/roles.js';
import { LINKS, TITLE_MAX, BODY_MAX, announceSettings } from '../../../core/announcements.js';
import { nowDate, IS_DEMO } from '../api.js';
import { useT, prettyDate, stamp, fmtTime, num } from '../i18n/index.js';
import '../reports.css';

const AUDIENCE_KINDS = ['everyone', 'roles', 'positions', 'rooms', 'today', 'week', 'date', 'people'];
const LINK_KEY = { '#/my': 'my', '#/schedule': 'schedule', '#/calendar': 'calendar', '#/swaps': 'swaps', '#/timeoff': 'timeoff', '#/training': 'training', '#/86': 'eightySix', '#/events': 'events', '#/tips': 'tips' };
const LINK_FEATURE = { '#/training': 'training', '#/86': 'eightySix', '#/events': 'events', '#/tips': 'tips' };
const CHANNELS = ['push', 'email', 'sms'];
const STATUS_BADGE = { scheduled: 'brand', queued: 'warn', sending: 'warn', sent: 'ok', cancelled: '' };
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const blank = (today) => ({ title: '', body: '', titleEs: '', bodyEs: '', link: '', kind: 'everyone', roles: [], jobCodeIds: [], areas: [], date: today, userIds: [],
  email: false, sms: false, scheduleRelated: false, urgent: false, when: 'now', sendAt: '', spanish: false });
const audienceOf = (d) => ({ kind: d.kind, ...({ roles: { roles: d.roles }, positions: { jobCodeIds: d.jobCodeIds }, rooms: { areas: d.areas }, date: { date: d.date }, people: { userIds: d.userIds } }[d.kind] || {}) });
const payload = (d) => ({
  title: d.title, body: d.body, titleEs: d.spanish ? d.titleEs : '', bodyEs: d.spanish ? d.bodyEs : '', link: d.link, audience: audienceOf(d),
  email: d.email, sms: d.sms, scheduleRelated: d.scheduleRelated, urgent: d.urgent,
  ...(d.when === 'later' && d.sendAt ? { sendAt: new Date(d.sendAt).toISOString() } : {}),
});
/** A channel's "why not" key: no consent reads differently for email and texts. */
const whyKey = (ch, r) => (r === 'noConsent' ? (ch === 'email' ? 'noConsentEmail' : 'noConsentSms') : r);
const KNOWN_REASONS = new Set(['noDevice', 'noConsentEmail', 'noConsentSms', 'noEmail', 'noPhone', 'stopped', 'dailyCap', 'restaurantOff', 'notSetUp',
  'consentWithdrawn', 'inactive', 'interrupted', 'rateLimited', 'expired', 'outOfTime', 'demo', 'error', 'notChosen']);

/** "Everyone" · "Managers, Supervisors" · "Bartender" · "Working Tue, Sep 29" · "3 people". */
function useAudienceLabel() {
  const t = useT();
  const { jobs, settings } = useApp();
  return (a) => {
    if (!a) return '';
    switch (a.kind) {
      case 'roles': return (a.roles || []).map((r) => roleLabelPlural(r, t.lang)).join(', ');
      case 'positions': return (a.jobCodeIds || []).map((id) => jobs[id]?.name || '?').join(', ');
      case 'rooms': return (a.areas || []).join(', ');
      case 'date': return t('announcements.workingOn', { date: prettyDate(a.date) });
      case 'people': return t('announcements.nPeople', { count: (a.userIds || []).length });
      default: return t(`announcements.aud_${a.kind}`);
    }
  };
}

export default function Announcements({ parts = [] }) {
  const t = useT();
  const { isMgr } = useApp();
  const id = parts[1] && parts[1] !== 'new' && parts[1] !== 'sent' ? decodeURIComponent(parts[1]) : null;
  const [tab, setTab] = useState(parts[1] === 'sent' ? 'sent' : isMgr ? 'new' : 'mine');
  if (id) return <AnnouncementView id={id} />;
  if (!isMgr) return <div style={{ maxWidth: 760 }}><Inbox /></div>;
  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="tabs">
        {[['new', t('announcements.tabNew')], ['sent', t('announcements.tabSent')], ['mine', t('announcements.tabMine')]].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'new' && <Composer onSent={() => setTab('sent')} />}
      {tab === 'sent' && <SentList />}
      {tab === 'mine' && <Inbox />}
    </div>
  );
}

// ---------- writing one ----------
function Composer({ onSent }) {
  const t = useT();
  const { call, today, me, jobCodes, layout, settings, employees, has, toast, refresh } = useApp();
  const [d, setD] = useState(() => blank(today));
  const [summary, setSummary] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  const [showNames, setShowNames] = useState(false);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const toggle = (k, v) => setD((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const admin = canChangeSettings(me);
  const body = useMemo(() => payload(d), [d]);
  const key = JSON.stringify(body);
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => call('announcements.summary', body).then((r) => live && setSummary(r), () => live && setSummary(null)), 300);
    return () => { live = false; clearTimeout(h); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rooms = (layout?.rooms || []).map((r) => r.room).filter(Boolean);
  const people = employees.filter((e) => e.active !== false && e.id !== me.id);
  const found = people.filter((e) => !who || e.name.toLowerCase().includes(who.trim().toLowerCase()));
  const cfg = summary?.cfg || announceSettings(settings);
  const minAt = localInput(new Date(nowDate().getTime() + 5 * 60000));
  const laterOk = d.when === 'now' || (d.sendAt && d.sendAt >= minAt);
  const ready = d.title.trim() && d.body.trim() && summary?.total > 0 && (!d.sms || d.scheduleRelated) && laterOk;
  const smsOn = summary?.channels?.sms;
  const emailOn = summary?.channels?.email;

  const send = async () => {
    setBusy(true);
    try {
      const r = await call('announcements.send', body);
      toast(r.status === 'scheduled' ? t('announcements.scheduledToast') : t('announcements.sentToast'));
      setD(blank(today));
      setConfirm(false);
      refresh();
      onSent?.();
    } catch (e) {
      toast(e.message, 'bad');
    } finally { setBusy(false); }
  };

  return (
    <div className="ann-grid">
      <div className="col" style={{ gap: 14 }}>
        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('announcements.compose')}</h2>
          <Field label={t('announcements.titleLabel')} help={`${d.title.length}/${TITLE_MAX}`}>
            <input className="input" value={d.title} maxLength={TITLE_MAX} placeholder={t('announcements.titlePh')} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label={t('announcements.bodyLabel')} help={`${d.body.length}/${BODY_MAX}`}>
            <textarea className="input" rows={5} value={d.body} maxLength={BODY_MAX} placeholder={t('announcements.bodyPh')} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          {!d.spanish
            ? <div><button className="btn sm" onClick={() => set({ spanish: true })}><Icon name="globe" />{t('announcements.addSpanish')}</button>
              <div className="help" style={{ marginTop: 4 }}>{t('announcements.spanishHelp')}</div></div>
            : <div className="col" style={{ gap: 10, padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
              <div className="row wrap"><b style={{ flex: 1 }}>{t('announcements.spanish')}</b>
                <button className="btn sm ghost" onClick={() => set({ titleEs: d.title, bodyEs: d.body })}><Icon name="copy" />{t('announcements.copyEnglish')}</button>
                <button className="btn sm ghost" onClick={() => set({ spanish: false, titleEs: '', bodyEs: '' })}><Icon name="x" />{t('announcements.removeSpanish')}</button></div>
              <Field label={t('announcements.titleEs')}><input className="input" lang="es" value={d.titleEs} maxLength={TITLE_MAX} onChange={(e) => set({ titleEs: e.target.value })} /></Field>
              <Field label={t('announcements.bodyEs')}><textarea className="input" lang="es" rows={4} value={d.bodyEs} maxLength={BODY_MAX} onChange={(e) => set({ bodyEs: e.target.value })} /></Field>
              <div className="help">{t('announcements.spanishHelp')}</div>
            </div>}
          <Field label={t('announcements.link')}>
            <select className="input" value={d.link} onChange={(e) => set({ link: e.target.value })}>
              <option value="">{t('announcements.linkNone')}</option>
              {LINKS.filter((l) => !LINK_FEATURE[l] || has(LINK_FEATURE[l])).map((l) => <option key={l} value={l}>{t(`announcements.link_${LINK_KEY[l]}`)}</option>)}
            </select>
          </Field>
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('announcements.audience')}</h2>
          <select className="input" value={d.kind} onChange={(e) => set({ kind: e.target.value })} aria-label={t('announcements.audience')}>
            {AUDIENCE_KINDS.map((k) => <option key={k} value={k}>{t(`announcements.aud_${k}`)}</option>)}
          </select>
          {d.kind === 'roles' && <div className="ann-chips">{ROLES.map((r) => <button key={r.id} className={`chip ${d.roles.includes(r.id) ? 'on' : ''}`} aria-pressed={d.roles.includes(r.id)} onClick={() => toggle('roles', r.id)}>{roleLabelPlural(r.id, t.lang)}</button>)}</div>}
          {d.kind === 'positions' && <div className="ann-chips">{jobCodes.filter((j) => !j.archived).map((j) => <button key={j.id} className={`chip ${d.jobCodeIds.includes(j.id) ? 'on' : ''}`} aria-pressed={d.jobCodeIds.includes(j.id)} onClick={() => toggle('jobCodeIds', j.id)}>{j.name}</button>)}</div>}
          {d.kind === 'rooms' && <div className="ann-chips">{(rooms.length ? rooms : settings.areas || []).map((r) => <button key={r} className={`chip ${d.areas.includes(r) ? 'on' : ''}`} aria-pressed={d.areas.includes(r)} onClick={() => toggle('areas', r)}>{r}</button>)}</div>}
          {d.kind === 'date' && <Field label={t('announcements.pickDate')}><input className="input" type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} /></Field>}
          {['today', 'week'].includes(d.kind) && <div className="help">{t('announcements.workingHelp')}</div>}
          {d.kind === 'people' && <>
            <input className="input" type="search" placeholder={t('announcements.searchPeople')} value={who} onChange={(e) => setWho(e.target.value)} />
            <div className="ann-people">
              {found.map((e) => <label key={e.id} className="check"><input type="checkbox" checked={d.userIds.includes(e.id)} onChange={() => toggle('userIds', e.id)} />{e.name}</label>)}
            </div>
            <div className="help">{t('announcements.picked', { count: d.userIds.length })}</div>
          </>}
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('announcements.channels')}</h2>
          <div className="row" style={{ gap: 8 }}><Icon name="check" size={16} style={{ color: 'var(--ok)' }} /><span>{t('announcements.inApp')}</span></div>
          <label className="check"><input type="checkbox" checked={d.email} disabled={summary && !emailOn} onChange={(e) => set({ email: e.target.checked })} />{t('announcements.email')}</label>
          {summary && !emailOn && <div className="help">{t('announcements.emailNotSetUp')}</div>}
          <label className="check"><input type="checkbox" checked={d.sms} disabled={summary && !smsOn} onChange={(e) => set({ sms: e.target.checked, ...(e.target.checked ? {} : { scheduleRelated: false, urgent: false }) })} />{t('announcements.sms')}</label>
          {summary && !smsOn && <div className="help">{t('announcements.smsNotSetUp')}</div>}
          {d.sms && <>
            <div className="alert warn"><Icon name="alert" size={16} /><span>{t('announcements.smsWarn')}</span></div>
            <label className="check"><input type="checkbox" checked={d.scheduleRelated} onChange={(e) => set({ scheduleRelated: e.target.checked })} /><b>{t('announcements.scheduleRelated')}</b></label>
            {summary && <SmsPreview summary={summary} spanish={summary.spanish > 0} />}
            {admin && <label className="check"><input type="checkbox" checked={d.urgent} onChange={(e) => set({ urgent: e.target.checked })} />
              <span>{t('announcements.urgent', { start: fmtTime(cfg.quietStart), end: fmtTime(cfg.quietEnd) })}<div className="help">{t('announcements.urgentHelp')}</div></span></label>}
          </>}
        </div>

        <div className="card card-pad col" style={{ gap: 12 }}>
          <h2>{t('announcements.when')}</h2>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            <button className={d.when === 'now' ? 'on' : ''} onClick={() => set({ when: 'now' })}>{t('announcements.now')}</button>
            <button className={d.when === 'later' ? 'on' : ''} onClick={() => set({ when: 'later', sendAt: d.sendAt || minAt })}>{t('announcements.later')}</button>
          </div>
          {d.when === 'later' && <Field label={t('announcements.sendAt')} help={t('announcements.laterHelp')}>
            <input className="input" type="datetime-local" value={d.sendAt} min={minAt} onChange={(e) => set({ sendAt: e.target.value })} />
          </Field>}
          {!laterOk && <div className="alert warn"><Icon name="clock" size={16} />{t('announcements.pickFuture')}</div>}
        </div>
      </div>

      <div className="col" style={{ gap: 14, position: 'sticky', top: 'calc(var(--topbar) + 12px)' }}>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <h2>{t('announcements.preview')}</h2>
          {!summary ? <div className="small muted">{t('common.loading')}</div> : <>
            <Reach summary={summary} email={d.email} sms={d.sms} />
            {summary.total > 0 && <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowNames(!showNames)}>{showNames ? t('announcements.hideNames') : t('announcements.showNames')}</button>}
            {showNames && <div className="ann-names">{summary.names.map((n) => n.name).join(', ')}{summary.total > summary.names.length ? '…' : ''}</div>}
          </>}
          <button className="btn primary" disabled={!ready} onClick={() => setConfirm(true)}><Icon name="send" />{d.when === 'later' ? t('announcements.reviewSchedule') : t('announcements.reviewSend')}</button>
          {d.sms && !d.scheduleRelated && <div className="help">{t('announcements.confirmScheduleFirst')}</div>}
        </div>
      </div>

      {confirm && summary && (
        <Modal title={d.when === 'later' ? t('announcements.confirmScheduleTitle') : t('announcements.confirmTitle')} onClose={() => setConfirm(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={send}><Icon name="send" />
              {d.when === 'later' ? t('announcements.confirmSchedule', { when: stamp(new Date(d.sendAt).toISOString(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : t('announcements.confirmSend', { count: summary.total })}</button>
          </>}>
          <div><b className="ann-body">{d.title}</b><div className="ann-body small muted" style={{ marginTop: 4 }}>{d.body}</div></div>
          <Reach summary={summary} email={d.email} sms={d.sms} />
          {d.when === 'later' && <div className="help">{t('announcements.laterHelp')}</div>}
        </Modal>
      )}
    </div>
  );
}

/** The texts as people will get them: characters and segments, in English and (when anyone reads Spanish) Spanish. */
function SmsPreview({ summary, spanish }) {
  const t = useT();
  const one = (s, label) => (
    <div className="col" style={{ gap: 4 }}>
      {label && <div className="small" style={{ fontWeight: 600 }}>{label}</div>}
      <div className="ann-sms">{s.text}</div>
      <div className={`small ${s.segments > 1 ? 'warn' : 'muted'}`} style={s.segments > 1 ? { color: 'var(--warn)' } : {}}>{t('announcements.smsCount', { chars: s.chars, count: s.segments })}</div>
      {s.trimmed && <div className="small" style={{ color: 'var(--warn)' }}>{t('announcements.smsTrimmed')}</div>}
    </div>
  );
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="small muted">{t('announcements.smsPreview')}</div>
      {one(summary.sms.text.en, spanish ? t('announcements.inEnglish') : '')}
      {spanish && one(summary.sms.text.es, t('announcements.inSpanish'))}
    </div>
  );
}

/** Who each channel reaches and why not the rest: "Texts: 23 of 41 (18 haven't agreed to texts)". */
function Reach({ summary, email, sms }) {
  const t = useT();
  const total = summary.total;
  const why = (ch, skipped) => Object.entries(skipped).map(([r, n]) => t(`announcements.why_${whyKey(ch, r)}`, { count: n, cap: summary.cfg.smsDailyCap })).join(' · ');
  const line = (icon, ch, reach, skipped = {}, extra = '') => (
    <div className="ann-reach-row">
      <Icon name={icon} />
      <span>{t(`announcements.ch_${ch}`)}</span>
      <b>{t('announcements.reachOf', { reach: num(reach), total: num(total) })}</b>
      {(Object.keys(skipped).length > 0 || extra) && <span className="why">{[why(ch, skipped), extra].filter(Boolean).join(' · ')}</span>}
    </div>
  );
  return (
    <div className="ann-reach">
      <div style={{ fontWeight: 700 }}>{t('announcements.reaches', { count: total })}</div>
      {summary.spanish > 0 && <div className="small muted">{t('announcements.spanishCount', { count: summary.spanish })}{summary.spanishVersion ? '' : ` ${t('announcements.spanishFallback')}`}</div>}
      {line('bell', 'inApp', total)}
      {line('phone', 'push', summary.push.reach, summary.push.skipped)}
      {email && line('mail', 'email', summary.email.reach, summary.email.skipped)}
      {sms && line('send', 'sms', summary.sms.reach, summary.sms.skipped,
        summary.sms.held ? t('announcements.held', { count: summary.sms.held, time: stamp(summary.quietUntil, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) }) : '')}
    </div>
  );
}

// ---------- history ----------
function SentList() {
  const t = useT();
  const { call, version, toast } = useApp();
  const [list, setList] = useState(null);
  const [run, busy] = useAction();
  const label = useAudienceLabel();
  const load = () => call('announcements.list', { scope: 'sent' }).then(setList, (e) => toast(e.message, 'bad'));
  useEffect(() => { load(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <div className="empty">{t('common.loading')}</div>;
  const cancel = (e, a) => {
    e.stopPropagation();
    if (!window.confirm(t('announcements.confirmCancel'))) return;
    run(() => call('announcements.cancel', { id: a.id }), t('announcements.cancelledToast')).then(load);
  };
  return (
    <div className="card">
      {!list.length && <Empty icon="send" title={t('announcements.nothingSent')} />}
      {list.map((a) => (
        <div key={a.id} className="ann-card" role="link" tabIndex={0} onClick={() => { location.hash = `#/announcements/${a.id}`; }} onKeyDown={(e) => e.key === 'Enter' && (location.hash = `#/announcements/${a.id}`)}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className={`badge ${STATUS_BADGE[a.status] || ''}`}>{t(`announcements.status_${a.status}`)}</span>
            {a.urgent && <span className="badge bad">{t('announcements.urgentBadge')}</span>}
            {a.sms && <span className="badge">{t('announcements.ch_sms')}</span>}
            {a.email && <span className="badge">{t('announcements.ch_email')}</span>}
            <span className="spacer" />
            <span className="tiny faint">{a.status === 'scheduled' || (a.status === 'cancelled' && a.sendAt) ? t('announcements.goesOut', { when: stamp(a.sendAt) }) : stamp(a.releasedAt || a.createdAt)}</span>
          </div>
          <h3>{a.title}</h3>
          <div className="small muted">{t('announcements.byTo', { name: a.createdByName, audience: label(a.audience) })}</div>
          {a.counts.recipients > 0 && <Counts c={a.counts} email={a.email} sms={a.sms} />}
          {a.status === 'scheduled' && <div><button className="btn sm danger" disabled={busy} onClick={(e) => cancel(e, a)}><Icon name="x" />{t('announcements.cancel')}</button></div>}
        </div>
      ))}
    </div>
  );
}

/** "41 people · read by 12 · push 30 · email 20 · texts 23 (2 failed)". */
function Counts({ c, email, sms }) {
  const t = useT();
  const part = (ch, on) => {
    if (!on) return null;
    const x = c[ch];
    const extra = [x.failed && t('announcements.nFailed', { count: x.failed }), (x.queued || x.held) && t('announcements.nWaiting', { count: x.queued + x.held })].filter(Boolean).join(', ');
    return `${t(`announcements.ch_${ch}`)} ${num(x.sent)}${extra ? ` (${extra})` : ''}`;
  };
  return (
    <div className="small">
      {[t('announcements.nPeople', { count: c.recipients }), t('announcements.readByShort', { count: c.read }), part('push', true), part('email', email), part('sms', sms)].filter(Boolean).join(' · ')}
    </div>
  );
}

function Inbox() {
  const t = useT();
  const { call, version } = useApp();
  const [list, setList] = useState(null);
  useEffect(() => { call('announcements.list', { scope: 'mine' }).then(setList, () => setList([])); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <div className="empty">{t('common.loading')}</div>;
  return (
    <div className="card">
      {!list.length && <Empty icon="bell" title={t('announcements.nothingReceived')}>{t('announcements.nothingReceivedHelp')}</Empty>}
      {list.map((a) => (
        <a key={a.id} className="ann-card" href={`#/announcements/${a.id}`} style={{ color: 'inherit' }}>
          <div className="row" style={{ gap: 8 }}>
            {!a.read && <span className="ann-unread" aria-label={t('announcements.unread')} />}
            <h3 style={{ flex: 1, minWidth: 0 }}>{a.title}</h3>
            <span className="tiny faint">{stamp(a.at)}</span>
          </div>
          <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.body}</div>
          <div className="tiny faint">{t('announcements.from', { name: a.from })}</div>
        </a>
      ))}
    </div>
  );
}

// ---------- one announcement ----------
function AnnouncementView({ id }) {
  const t = useT();
  const { call, has, toast, refresh } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [run, busy] = useAction();
  const label = useAudienceLabel();
  const load = () => call('announcements.open', { id }).then((r) => { setData(r); if (r.mine && !r.mine.read) refresh(); }, (e) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const back = <a className="btn sm ghost" href="#/announcements" style={{ alignSelf: 'flex-start' }}><Icon name="left" />{t('announcements.back')}</a>;
  if (error) return <div className="col" style={{ maxWidth: 760 }}>{back}<div className="card"><Empty icon="alert" title={error} /></div></div>;
  if (!data) return <div className="empty">{t('common.loading')}</div>;
  const { mine, manage } = data;
  const link = (mine || manage)?.link;
  const linkOk = link && (!LINK_FEATURE[link] || has(LINK_FEATURE[link]));
  return (
    <div className="col" style={{ maxWidth: 1000, gap: 14 }}>
      {back}
      {mine && (
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {mine.urgent && <span className="badge bad">{t('announcements.urgentBadge')}</span>}
            <span className="small muted">{t('announcements.from', { name: mine.from })} · {stamp(mine.at)}</span>
          </div>
          <h2 className="ann-body" lang={mine.lang}>{mine.title}</h2>
          <div className="ann-body" lang={mine.lang}>{mine.body}</div>
          {linkOk && <a className="btn primary" style={{ alignSelf: 'flex-start' }} href={link}><Icon name="right" />{t('announcements.goTo', { page: t(`announcements.link_${LINK_KEY[link]}`) })}</a>}
        </div>
      )}
      {manage && <>
        {!mine && (
          <div className="card card-pad col" style={{ gap: 8 }}>
            <h2 className="ann-body">{manage.title}</h2>
            <div className="ann-body">{manage.body}</div>
            {(manage.titleEs || manage.bodyEs) && <div className="col" style={{ gap: 4, paddingTop: 8, borderTop: '1px solid var(--border)' }} lang="es">
              <div className="small muted">{t('announcements.spanish')}</div><b className="ann-body">{manage.titleEs || manage.title}</b><div className="ann-body">{manage.bodyEs || manage.body}</div></div>}
            {linkOk && <div className="small">{t('announcements.linksTo', { page: t(`announcements.link_${LINK_KEY[link]}`) })}</div>}
          </div>
        )}
        <div className="card card-pad col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className={`badge ${STATUS_BADGE[manage.status] || ''}`}>{t(`announcements.status_${manage.status}`)}</span>
            {manage.urgent && <span className="badge bad">{t('announcements.urgentBadge')}</span>}
            <span className="small muted">{t('announcements.byTo', { name: manage.createdByName, audience: label(manage.audience) })}</span>
            <span className="spacer" />
            {manage.status === 'scheduled' && <button className="btn sm danger" disabled={busy}
              onClick={() => window.confirm(t('announcements.confirmCancel')) && run(() => call('announcements.cancel', { id }), t('announcements.cancelledToast')).then(load)}><Icon name="x" />{t('announcements.cancel')}</button>}
          </div>
          <div className="small muted">{manage.status === 'scheduled' ? t('announcements.goesOut', { when: stamp(manage.sendAt) })
            : manage.status === 'cancelled' ? t('announcements.cancelledBy', { name: manage.cancelledByName, when: stamp(manage.cancelledAt) })
              : manage.releasedAt ? t('announcements.wentOut', { when: stamp(manage.releasedAt) }) : ''}</div>
          {manage.counts.recipients > 0 && <Counts c={manage.counts} email={manage.email} sms={manage.sms} />}
          {IS_DEMO && manage.counts.recipients > 0 && <div className="help">{t('announcements.demoNote')}</div>}
        </div>
        {manage.rows.length > 0 && <Deliveries rows={manage.rows} email={manage.email} sms={manage.sms} />}
      </>}
    </div>
  );
}

/** Each person: read or not, and each channel's result with the reason. */
function Deliveries({ rows, email, sms }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [unread, setUnread] = useState(false);
  const list = rows.filter((r) => (!q || r.name.toLowerCase().includes(q.trim().toLowerCase())) && (!unread || !r.readAt));
  const cell = (ch, d) => {
    if (!d || d.r === 'notChosen') return <td key={ch} className="faint">—</td>;
    const held = d.s === 'queued' && d.notBefore;
    const kind = held ? 'waiting' : d.s === 'queued' || d.s === 'sending' ? 'waiting' : d.s;
    const why = d.r && d.r !== 'demo' ? (KNOWN_REASONS.has(whyKey(ch, d.r)) ? t(`announcements.reason_${whyKey(ch, d.r)}`) : d.r) : '';
    return (
      <td key={ch}>
        <span className={`ann-st ${kind}`}>{held ? t('announcements.st_held', { time: stamp(d.notBefore, { hour: 'numeric', minute: '2-digit' }) }) : t(`announcements.st_${d.s}`)}</span>
        {why && <span className="ann-why">{why}</span>}
      </td>
    );
  };
  const chans = CHANNELS.filter((c) => c === 'push' || (c === 'email' && email) || (c === 'sms' && sms));
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <h3 style={{ flex: 1 }}>{t('announcements.deliveries')}</h3>
        <input className="input sm" type="search" style={{ maxWidth: 200 }} placeholder={t('announcements.searchPeople')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check small"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />{t('announcements.onlyUnread')}</label>
      </div>
      <div className="card ts-scroll">
        <table className="table ts-table" style={{ minWidth: 520 }}>
          <thead><tr><th className="ts-stick">{t('announcements.col_person')}</th><th>{t('announcements.col_read')}</th>{chans.map((c) => <th key={c}>{t(`announcements.ch_${c}`)}</th>)}</tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.userId}>
                <td className="ts-stick"><b>{r.name}</b>{r.lang === 'es' && <span className="tiny faint"> · ES</span>}</td>
                <td>{r.readAt ? <span className="ann-st sent">{stamp(r.readAt)}</span> : <span className="ann-st skipped">{t('announcements.notRead')}</span>}</td>
                {chans.map((c) => cell(c, r[c]))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Settings → Announcements (admins) ----------
export function AnnouncementSettingsCard() {
  const t = useT();
  const { settings, call, isAdmin, has } = useApp();
  const [s, setS] = useState(() => announceSettings(settings));
  const [run, busy] = useAction();
  if (!isAdmin || !has('announcements')) return null;
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('announcements.settingsTitle')}</h2>
      <div className="help">{t('announcements.settingsHelp')}</div>
      <div className="grid3">
        <Field label={t('announcements.dailyCap')}><input className="input" type="number" min="0" max="10" value={s.smsDailyCap} onChange={(e) => setS({ ...s, smsDailyCap: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
        <Field label={t('announcements.quietFrom')}><input className="input" type="time" value={s.quietStart} onChange={(e) => setS({ ...s, quietStart: e.target.value })} /></Field>
        <Field label={t('announcements.quietTo')}><input className="input" type="time" value={s.quietEnd} onChange={(e) => setS({ ...s, quietEnd: e.target.value })} /></Field>
      </div>
      <div className="help">{t('announcements.quietHelp')}</div>
      <div className="row"><span className="spacer" /><button className="btn primary" disabled={busy} onClick={() => run(() => call('announcements.saveSettings', s), t('common.saved'))}>{t('common.save')}</button></div>
    </div>
  );
}

// ---------- My Shifts: the latest few ----------
export function MyAnnouncements() {
  const t = useT();
  const { call, version, has } = useApp();
  const [list, setList] = useState(null);
  const on = has('announcements');
  useEffect(() => { if (on) call('announcements.list', { scope: 'mine' }).then(setList, () => setList([])); }, [version, on]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on || !list?.length) return null;
  const unread = list.filter((a) => !a.read).length;
  return (
    <div className="section">
      <div className="section-title"><h2>{t('announcements.title')}</h2>{unread > 0 && <span className="badge brand">{t('announcements.nNew', { count: unread })}</span>}
        <span className="spacer" /><a className="btn sm ghost" href="#/announcements">{t('announcements.seeAll')}</a></div>
      <div className="card">
        {list.slice(0, 3).map((a) => (
          <a key={a.id} className="ann-card" href={`#/announcements/${a.id}`} style={{ color: 'inherit' }}>
            <div className="row" style={{ gap: 8 }}>
              {!a.read && <span className="ann-unread" aria-label={t('announcements.unread')} />}
              <b style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{a.title}</b>
              <span className="tiny faint">{stamp(a.at, { month: 'short', day: 'numeric' })}</span>
            </div>
            <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.body}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
