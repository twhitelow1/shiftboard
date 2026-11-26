// Pieces Positive impact shares (the managers' report in pages/reports/Impact.jsx, "My kudos" in Kudos.jsx,
// Settings): review text with the matched names highlighted, stars, where a review came from, the period
// picker (a season, a month or dates), one review / request / kudos card, and the settings card.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { useT, prettyDate, fmtTime } from '../i18n/index.js';
import '../impact.css';

/** Text with spans ([[start, end]]) marked: the words that matched someone. */
export function Highlighted({ text, spans = [] }) {
  const src = String(text || '');
  const list = [...spans].filter((s) => Array.isArray(s) && s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  for (const [s, e] of list) {
    if (s < at) continue;
    if (s > at) out.push(src.slice(at, s));
    out.push(<mark key={s} className="imp-mark">{src.slice(s, e)}</mark>);
    at = e;
  }
  out.push(src.slice(at));
  return <span className="imp-text">{out}</span>;
}

export function Stars({ n, small }) {
  const t = useT();
  if (n == null) return null;
  const full = Math.round(n);
  return <span className={`imp-stars${small ? ' sm' : ''}`} role="img" aria-label={t('impact.starsLabel', { count: full })}>{'★'.repeat(full)}<span className="imp-stars-off">{'★'.repeat(Math.max(0, 5 - full))}</span></span>;
}

export function SourceBadge({ source }) {
  const t = useT();
  return <span className={`badge imp-src imp-src-${source}`}>{t(`impact.source_${source}`)}</span>;
}

/** { period: 'season', seasonId } | { period: 'month', month } | { period: 'range', from, to } → RPC args. */
export const periodArgs = (p) => (p.period === 'month' ? { period: 'month', month: p.month } : p.period === 'range' ? { period: 'range', from: p.from, to: p.to } : { period: 'season', seasonId: p.seasonId || undefined });

/** A season from the list, a month, or a custom range. seasons: [{ id, label }] from the server. */
export function PeriodPicker({ value, onChange, seasons = [], today }) {
  const t = useT();
  const kind = value.period || 'season';
  const sel = kind === 'season' ? (value.seasonId || seasons[0]?.id || '') : kind;
  return (
    <div className="imp-period">
      <select className="input sm" aria-label={t('impact.period')} value={sel} onChange={(e) => {
        const v = e.target.value;
        if (v === 'month') onChange({ period: 'month', month: (today || '').slice(0, 7) });
        else if (v === 'range') onChange({ period: 'range', from: value.from || `${(today || '').slice(0, 7)}-01`, to: value.to || today });
        else onChange({ period: 'season', seasonId: v });
      }}>
        {seasons.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        <option value="month">{t('impact.pickMonth')}</option>
        <option value="range">{t('impact.pickRange')}</option>
      </select>
      {kind === 'month' && <input className="input sm" type="month" aria-label={t('impact.month')} value={value.month || ''} onChange={(e) => e.target.value && onChange({ ...value, month: e.target.value })} />}
      {kind === 'range' && (
        <span className="imp-range">
          <input className="input sm" type="date" aria-label={t('impact.from')} value={value.from || ''} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
          <span className="faint">–</span>
          <input className="input sm" type="date" aria-label={t('impact.to')} value={value.to || ''} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}

/** "+3 vs. last year" / "same as last year" / "new this year". */
export function Trend({ now, before }) {
  const t = useT();
  if (before == null) return now ? <span className="imp-trend up">{t('impact.trendNew')}</span> : null;
  const d = now - before;
  if (!d) return <span className="imp-trend">{t('impact.trendSame')}</span>;
  return <span className={`imp-trend ${d > 0 ? 'up' : 'down'}`}>{t(d > 0 ? 'impact.trendUp' : 'impact.trendDown', { n: Math.abs(d) })}</span>;
}

/** A stat: big number, label, and last year's for comparison. */
export function Stat({ value, label, prev, icon }) {
  return (
    <div className="imp-stat">
      <div className="imp-stat-v">{icon && <Icon name={icon} size={16} />}{value}</div>
      <div className="imp-stat-l">{label}</div>
      {prev !== undefined && <Trend now={value} before={prev} />}
    </div>
  );
}

/**
 * One item: a review (stars, text with the names marked), a reservation request, or kudos.
 * manage: the item's matches can be confirmed, reassigned or dismissed (managers), with people to pick from.
 */
export function ImpactItem({ item, manage, people = [], onChanged }) {
  const t = useT();
  const { call } = useApp();
  const [run, busy] = useAction();
  const [pick, setPick] = useState('');
  const decide = async (m, action, userId) => { const r = await run(() => call('impact.decide', { id: m.id, action, userId }), t(`impact.done_${action}`)); if (r) onChanged?.(); };
  const head = item.kind === 'review'
    ? <><SourceBadge source={item.source} /><Stars n={item.rating} small /></>
    : item.kind === 'request'
      ? <><span className="badge brand"><Icon name="hand" size={12} />{t(item.requestedServer ? 'impact.requestedField' : 'impact.request')}</span><span className="small muted">{t('impact.partyOf', { count: item.partySize })}{item.time ? ` · ${fmtTime(item.time)}` : ''}</span></>
      : <><span className="badge ok"><Icon name="sparkle" size={12} />{t('impact.kudos')}</span><SourceBadge source={item.source} />{item.rating ? <Stars n={item.rating} small /> : null}</>;
  return (
    <div className="imp-item">
      <div className="imp-item-head">{head}<span className="spacer" /><span className="tiny faint">{prettyDate(item.date)}</span></div>
      {item.text ? <div className="imp-quote"><Highlighted text={item.text} spans={item.spans} /></div> : item.kind === 'request' && <div className="small muted">{t('impact.requestNoNote')}</div>}
      {(item.reviewer || item.guest || item.createdBy) && manage && <div className="tiny faint">{[item.reviewer || item.guest, item.server && t('impact.serverOnReview', { name: item.server }), item.createdBy && t('impact.addedBy', { name: item.createdBy })].filter(Boolean).join(' · ')}</div>}
      {manage && (item.mentions || []).map((m) => (
        <div key={m.id} className="imp-decide">
          <span className={`badge ${m.status === 'confirmed' ? 'ok' : 'warn'}`}>{t(m.status === 'confirmed' ? (m.auto ? 'impact.autoConfirmed' : 'impact.confirmedByManager') : 'impact.needsReview')}</span>
          <span className="tiny faint">{t(`impact.reason_${m.reason}`)}</span>
          <span className="spacer" />
          <select className="input sm" aria-label={t('impact.reassign')} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
            <option value="">{t('impact.reassignTo')}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {pick && <button className="btn sm" disabled={busy} onClick={() => decide(m, 'confirm', pick)}><Icon name="check" />{t('impact.reassign')}</button>}
          {m.status !== 'confirmed' && !pick && <button className="btn sm" disabled={busy} onClick={() => decide(m, 'confirm')}><Icon name="check" />{t('impact.confirm')}</button>}
          <button className="btn sm ghost" disabled={busy} onClick={() => decide(m, 'dismiss')}><Icon name="x" />{t('impact.dismiss')}</button>
        </div>
      ))}
    </div>
  );
}

/** Settings → Positive impact (admins): the "you were mentioned" notifications, low-rating alerts, words that are never names. */
export function ImpactSettingsCard() {
  const t = useT();
  const { call, has, isAdmin } = useApp();
  const [s, setS] = useState(null);
  const [words, setWords] = useState('');
  const [run, busy] = useAction();
  useEffect(() => { if (has('impact')) call('impact.list', { what: 'names' }).then((r) => { setS(r.settings); setWords(r.settings.ignoreWords.join(', ')); }).catch(() => {}); }, []);
  if (!has('impact') || !s) return null;
  const save = (patch) => run(() => call('impact.saveSettings', patch), t('impact.settingsSaved')).then((r) => { if (r) { setS(r); setWords(r.ignoreWords.join(', ')); } });
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('impact.settingsTitle')}</h2>
      <div className="help">{t('impact.settingsIntro')}</div>
      <label className="check"><input type="checkbox" checked={s.notify} disabled={!isAdmin || busy} onChange={(e) => save({ notify: e.target.checked })} />{t('impact.notifyToggle')}</label>
      <label className="check"><input type="checkbox" checked={s.alertLow} disabled={!isAdmin || busy} onChange={(e) => save({ alertLow: e.target.checked })} />{t('impact.alertLowToggle')}</label>
      <Field label={t('impact.ignoreWords')} help={t('impact.ignoreWordsHelp')}>
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input" style={{ flex: '1 1 200px' }} value={words} disabled={!isAdmin} onChange={(e) => setWords(e.target.value)} placeholder={t('impact.ignoreWordsPlaceholder')} />
          {isAdmin && <button className="btn sm" disabled={busy || words === s.ignoreWords.join(', ')} onClick={() => save({ ignoreWords: words.split(',').map((w) => w.trim()).filter(Boolean) })}><Icon name="check" />{t('common.save')}</button>}
        </div>
      </Field>
    </div>
  );
}
