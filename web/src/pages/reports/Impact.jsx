// Positive impact, the managers' report (a self-contained page: the Reports hub registers it, and until then
// it's #/impact). Who guests single out, per person, for a season (default: this one), a month or dates,
// against the same dates last year:
//   Leaderboard   5-star mentions, all mentions by stars, reservation requests, kudos; tap a person for the
//                 reviews and requests behind the numbers (confirm, reassign or dismiss each match); CSV export
//   Needs review  matches the app didn't guess: two people with the name, or someone not on shift that day
//   Reviews       every review in the period, any source, with the names marked and whether it was answered
//   Kudos         shout-outs a manager adds (Google, Yelp, in person, a card…) and review-site exports
//   Names         also-known-as names per person, and the settings
// headline({ call, t }): one line for the hub ("14 five-star mentions this season").
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Avatar, Modal, Field, Empty, useAction } from '../../ui.jsx';
import { useT, prettyDate } from '../../i18n/index.js';
import { PeriodPicker, periodArgs, ImpactItem, Stat, Trend, Stars, SourceBadge, Highlighted, ImpactSettingsCard } from '../ImpactShared.jsx';
import { GuestImportDialog } from '../OpenTableSettings.jsx';
import MyKudos from '../Kudos.jsx';
import '../../impact.css';

const TABS = ['board', 'queue', 'reviews', 'kudos', 'names'];
const KUDOS_SOURCES = ['google', 'yelp', 'tripadvisor', 'opentable', 'facebook', 'inPerson', 'card', 'phone', 'email', 'other'];

/** One line for the Reports hub: this season's 5-star mentions. Resolves to null when there's nothing to say. */
export async function headline({ call, t }) {
  const r = await call('impact.summary', {});
  if (!r.totals.fiveStar && !r.totals.requests && !r.totals.kudos) return null;
  return t('impact.headline', { count: r.totals.fiveStar, season: r.range.label });
}

export default function ImpactReport({ parts = [] }) {
  const t = useT();
  const { call, version, today, has, isMgr } = useApp();
  if (!isMgr) return <MyKudos />; // the team's report is for managers; everyone else gets their own
  return <Report parts={parts} call={call} version={version} today={today} has={has} />;
}

function Report({ parts, call, version, today, has }) {
  const t = useT();
  const tab = TABS.includes(parts[1]) ? parts[1] : parts[1] === 'review' ? 'queue' : 'board';
  const [period, setPeriod] = useState({ period: 'season' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const args = periodArgs(period);
  useEffect(() => { call('impact.summary', args).then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message)); }, [version, JSON.stringify(args)]);
  if (!has('impact')) return <Empty icon="star" title={t('impact.notInPlan')} />;
  const go = (k) => { location.hash = `#/impact${k === 'board' ? '' : `/${k}`}`; };

  return (
    <div className="col imp-page" style={{ maxWidth: 980 }}>
      <div className="toolbar">
        <PeriodPicker value={{ ...period, seasonId: period.seasonId || data?.range?.seasonId }} onChange={setPeriod} seasons={data?.seasons || []} today={today} />
        {data && <span className="small muted">{prettyDate(data.range.from)} – {prettyDate(data.range.to)}</span>}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {t(`impact.tab_${k}`)}{k === 'queue' && data?.pending > 0 && <span className="count">{data.pending}</span>}
          </button>
        ))}
      </div>
      {error && <div className="alert bad">{error}</div>}
      {!data && !error && <div className="empty">{t('common.loading')}</div>}
      {data && tab === 'board' && <Board data={data} args={args} />}
      {tab === 'queue' && <Queue />}
      {tab === 'reviews' && data && <Reviews args={args} />}
      {tab === 'kudos' && data && <Kudos args={args} />}
      {tab === 'names' && <Names />}
    </div>
  );
}

function Board({ data, args }) {
  const t = useT();
  const [open, setOpen] = useState(null);
  const tot = data.totals;
  const csv = () => {
    const head = [t('common.name'), t('impact.col_fiveStar'), t('impact.col_mentions'), '5★', '4★', '3★', '2★', '1★', t('impact.col_requests'), t('impact.col_kudos'), t('impact.col_score'), t('impact.col_lastYear')];
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [head, ...data.rows.map((r) => [r.person.name, r.fiveStar, r.mentions, r.byRating[5], r.byRating[4], r.byRating[3], r.byRating[2], r.byRating[1], r.requests, r.kudos, r.score, r.prev ? r.prev.score : ''])];
    const blob = new Blob([`﻿${lines.map((l) => l.map(esc).join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `positive-impact-${data.range.from}-${data.range.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="imp-stats">
        <Stat icon="star" value={tot.fiveStar} label={t('impact.stat_fiveStar')} prev={tot.prev.fiveStar} />
        <Stat icon="hand" value={tot.requests} label={t('impact.stat_requests')} prev={tot.prev.requests} />
        <Stat icon="sparkle" value={tot.kudos} label={t('impact.stat_kudos')} prev={tot.prev.kudos} />
        <Stat value={tot.fiveStarReviews ? `${Math.round((tot.fiveStarWithNames / tot.fiveStarReviews) * 100)}%` : '—'} label={t('impact.stat_named', { count: tot.fiveStarReviews })} />
      </div>
      {data.pending > 0 && <a className="alert warn" href="#/impact/queue"><Icon name="alert" size={16} /><div>{t('impact.pendingLine', { count: data.pending })}</div></a>}
      <div className="card">
        <div className="row card-pad" style={{ gap: 8, paddingBottom: 6 }}>
          <h2 style={{ flex: 1 }}>{t('impact.leaderboard')}</h2>
          <button className="btn sm" disabled={!data.rows.length} onClick={csv}><Icon name="download" />{t('impact.exportCsv')}</button>
        </div>
        {!data.rows.length ? <Empty icon="star" title={t('impact.nothingYet')}>{t('impact.nothingYetHelp')}</Empty> : (
          <div className="list">
            {data.rows.map((r, i) => (
              <button key={r.userId} className="list-item click imp-row" onClick={() => setOpen(r.userId)}>
                <span className="imp-rank">{i + 1}</span>
                <Avatar user={r.person} size="sm" />
                <span className="imp-who"><b>{r.person.name}</b><Trend now={r.score} before={r.prev?.score ?? null} /></span>
                <span className="imp-nums">
                  <span title={t('impact.col_fiveStar')}><b>{r.fiveStar}</b><span className="tiny">★5</span></span>
                  <span title={t('impact.col_mentions')}><b>{r.mentions}</b><span className="tiny">{t('impact.short_mentions')}</span></span>
                  <span title={t('impact.col_requests')}><b>{r.requests}</b><span className="tiny">{t('impact.short_requests')}</span></span>
                  <span title={t('impact.col_kudos')}><b>{r.kudos}</b><span className="tiny">{t('impact.short_kudos')}</span></span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="help card-pad" style={{ paddingTop: 6 }}>{t('impact.scoreHelp', { from: prettyDate(data.range.prev.from), to: prettyDate(data.range.prev.to) })}</div>
      </div>
      {open && <PersonModal userId={open} args={args} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One person's reviews, requests and kudos for the period: the numbers and what's behind them. */
export function PersonModal({ userId, args, onClose }) {
  const t = useT();
  const { call, employees } = useApp();
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { call('impact.get', { ...args, userId }).then(setData).catch(() => setData({ items: [], counts: null })); }, [tick]);
  const people = useMemo(() => employees.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)), [employees]);
  const c = data?.counts;
  return (
    <Modal wide title={data?.person?.name || t('common.loading')} sub={data?.range ? `${prettyDate(data.range.from)} – ${prettyDate(data.range.to)}` : ''} onClose={onClose}>
      {!data ? <div className="empty">{t('common.loading')}</div> : (
        <div className="col" style={{ gap: 12 }}>
          {c && (
            <div className="imp-stats">
              <Stat value={c.fiveStar} label={t('impact.stat_fiveStar')} prev={data.prev?.fiveStar ?? undefined} />
              <Stat value={c.requests} label={t('impact.stat_requests')} prev={data.prev?.requests ?? undefined} />
              <Stat value={c.kudos} label={t('impact.stat_kudos')} prev={data.prev?.kudos ?? undefined} />
            </div>
          )}
          {c && <div className="row wrap imp-byrating">{[5, 4, 3, 2, 1].map((s) => <span key={s} className="badge">{'★'.repeat(s)} {c.byRating[s] || 0}</span>)}</div>}
          {!data.items.length && <div className="empty">{t('impact.nothingForPerson')}</div>}
          {data.items.map((it) => <ImpactItem key={`${it.kind}-${it.id}`} item={it} manage people={people} onChanged={() => setTick((x) => x + 1)} />)}
        </div>
      )}
    </Modal>
  );
}

function Queue() {
  const t = useT();
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const [run, busy] = useAction();
  useEffect(() => { call('impact.list', { what: 'queue' }).then(setData); }, [version, tick]);
  const decide = async (id, action, userId) => { const r = await run(() => call('impact.decide', { id, action, userId }), t(`impact.done_${action}`)); if (r) setTick((x) => x + 1); };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="help" style={{ flex: '1 1 240px' }}>{t('impact.queueHelp')}</div>
        <button className="btn sm" disabled={busy} onClick={() => run(() => call('impact.rescan'), (r) => t('impact.rescanned', { count: r.changed }))}><Icon name="search" />{t('impact.lookAgain')}</button>
      </div>
      {!data && <div className="empty">{t('common.loading')}</div>}
      {data && !data.items.length && <Empty icon="check" title={t('impact.queueEmpty')} />}
      {data?.items.map((m) => (
        <div key={m.id} className="card card-pad imp-item">
          <div className="imp-item-head">
            {m.kind === 'review' ? <><SourceBadge source={m.source} /><Stars n={m.rating} small /></> : <span className="badge brand"><Icon name="hand" size={12} />{t('impact.request')}</span>}
            <span className="spacer" /><span className="tiny faint">{prettyDate(m.date)}</span>
          </div>
          <div className="imp-quote"><Highlighted text={m.text} spans={m.spans} /></div>
          <div className="small"><b>{t('impact.whoIs', { name: m.token })}</b> <span className="muted">{t(`impact.reason_${m.reason}`)}</span></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {m.candidates.map((c) => (
              <button key={c.id} className="chip" disabled={busy} onClick={() => decide(m.id, 'confirm', c.id)}>
                <Icon name="check" size={12} />{c.name}{c.worked === true && <span className="badge ok">{t('impact.workedThatDay')}</span>}{c.worked === false && <span className="badge">{t('impact.offThatDay')}</span>}
              </button>
            ))}
            <OtherPerson busy={busy} onPick={(id) => decide(m.id, 'confirm', id)} />
            <button className="btn sm ghost" disabled={busy} onClick={() => decide(m.id, 'dismiss')}><Icon name="x" />{t('impact.notAPerson')}</button>
          </div>
        </div>
      ))}
      {data?.total > data?.items.length && <div className="help">{t('impact.queueMore', { count: data.total - data.items.length })}</div>}
    </div>
  );
}

function OtherPerson({ busy, onPick }) {
  const t = useT();
  const { employees } = useApp();
  return (
    <select className="input sm imp-other" aria-label={t('impact.someoneElse')} disabled={busy} value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
      <option value="">{t('impact.someoneElse')}</option>
      {employees.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

function Reviews({ args }) {
  const t = useT();
  const { call, version } = useApp();
  const [filter, setFilter] = useState({ source: '', stars: '' });
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  const [run, busy] = useAction();
  useEffect(() => { call('impact.list', { what: 'reviews', ...args, source: filter.source || undefined, stars: filter.stars === '' ? undefined : Number(filter.stars) }).then(setData); }, [version, tick, JSON.stringify(args), filter.source, filter.stars]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="input sm" aria-label={t('impact.source')} value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })}>
          <option value="">{t('impact.allSources')}</option>
          {['opentable', 'google', 'yelp', 'tripadvisor', 'facebook', 'other'].map((s) => <option key={s} value={s}>{t(`impact.source_${s}`)}</option>)}
        </select>
        <select className="input sm" aria-label={t('impact.stars')} value={filter.stars} onChange={(e) => setFilter({ ...filter, stars: e.target.value })}>
          <option value="">{t('impact.allStars')}</option>
          {[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{'★'.repeat(s)}</option>)}
        </select>
        {data && <span className="small muted">{t('impact.reviewsCount', { count: data.total })}</span>}
      </div>
      {data && !data.items.length && <Empty icon="star" title={t('impact.noReviews')} />}
      {data?.items.map((r) => (
        <div key={r.id} className="card card-pad imp-item">
          <div className="imp-item-head"><SourceBadge source={r.source} /><Stars n={r.rating} small />
            {r.replied ? <span className="badge ok"><Icon name="check" size={12} />{t('impact.replied')}</span> : r.rating <= 2 ? <span className="badge bad">{t('impact.needsReply')}</span> : null}
            <span className="spacer" /><span className="tiny faint">{prettyDate(r.diningDate || r.date)}</span></div>
          <div className="imp-quote"><Highlighted text={r.text} spans={r.spans} /></div>
          <div className="row wrap" style={{ gap: 6 }}>
            {r.reviewer && <span className="tiny faint">{r.reviewer}</span>}
            {r.people.map((p) => <span key={p.id} className={`badge ${p.status === 'confirmed' ? 'brand' : 'warn'}`}>{p.name}</span>)}
            <span className="spacer" />
            <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('impact.saveReply', { id: r.id, replied: !r.replied }), t(r.replied ? 'impact.markedNotReplied' : 'impact.markedReplied')).then((x) => x && setTick((n) => n + 1))}>
              <Icon name={r.replied ? 'x' : 'check'} />{t(r.replied ? 'impact.markNotReplied' : 'impact.markReplied')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Kudos({ args }) {
  const t = useT();
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const [tick, setTick] = useState(0);
  const [run, busy] = useAction();
  useEffect(() => { call('impact.list', { what: 'kudos', ...args }).then(setData); }, [version, tick, JSON.stringify(args)]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary sm" onClick={() => setEdit({})}><Icon name="plus" />{t('impact.addKudos')}</button>
        <button className="btn sm" onClick={() => setImporting(true)}><Icon name="upload" />{t('impact.importSiteReviews')}</button>
      </div>
      <div className="help">{t('impact.kudosHelp')}</div>
      {data && !data.items.length && <Empty icon="sparkle" title={t('impact.noKudos')} />}
      {data?.items.map((k) => (
        <div key={k.id} className="card card-pad imp-item">
          <div className="imp-item-head"><b>{k.person.name}</b><SourceBadge source={k.source} />{k.stars ? <Stars n={k.stars} small /> : null}<span className="spacer" /><span className="tiny faint">{prettyDate(k.date)}</span></div>
          {k.text && <div className="imp-quote">{k.text}</div>}
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="tiny faint">{t('impact.addedBy', { name: k.createdByName || '—' })}</span><span className="spacer" />
            <button className="btn sm ghost" onClick={() => setEdit(k)}><Icon name="edit" />{t('common.edit')}</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('impact.removeKudos', { id: k.id }), t('impact.kudosRemoved')).then((x) => x && setTick((n) => n + 1))}><Icon name="trash" />{t('common.delete')}</button>
          </div>
        </div>
      ))}
      {edit && <KudosDialog kudos={edit} onClose={(saved) => { setEdit(null); if (saved) setTick((n) => n + 1); }} />}
      {importing && <GuestImportDialog kind="reviews" source="google" pickSource onClose={() => { setImporting(false); setTick((n) => n + 1); }} />}
    </div>
  );
}

function KudosDialog({ kudos, onClose }) {
  const t = useT();
  const { call, employees, today } = useApp();
  const [f, setF] = useState({ userId: kudos.userId || '', source: kudos.source || 'google', stars: kudos.stars ?? 5, date: kudos.date || today, text: kudos.text || '' });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const r = await run(() => call('impact.saveKudos', { ...f, id: kudos.id, stars: f.stars === '' ? null : Number(f.stars) }), t('impact.kudosSaved')); if (r) onClose(true); };
  return (
    <Modal title={kudos.id ? t('impact.editKudos') : t('impact.addKudos')} onClose={() => onClose(false)}
      footer={<><span className="spacer" /><button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || !f.userId} onClick={save}><Icon name="check" />{t('common.save')}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Field label={t('impact.who')}>
          <select className="input" value={f.userId} onChange={set('userId')}>
            <option value="">{t('impact.pickPerson')}</option>
            {employees.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="grid2">
          <Field label={t('impact.source')}><select className="input" value={f.source} onChange={set('source')}>{KUDOS_SOURCES.map((s) => <option key={s} value={s}>{t(`impact.source_${s}`)}</option>)}</select></Field>
          <Field label={t('impact.stars')}><select className="input" value={f.stars ?? ''} onChange={set('stars')}><option value="">{t('impact.noStars')}</option>{[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{'★'.repeat(s)}</option>)}</select></Field>
        </div>
        <Field label={t('common.date')}><input className="input" type="date" max={today} value={f.date} onChange={set('date')} /></Field>
        <Field label={t('impact.whatTheySaid')} help={t('impact.whatTheySaidHelp')}><textarea className="input" rows={4} value={f.text} onChange={set('text')} /></Field>
      </div>
    </Modal>
  );
}

function Names() {
  const t = useT();
  const { call, version } = useApp();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [vals, setVals] = useState({});
  const [run, busy] = useAction();
  useEffect(() => { call('impact.list', { what: 'names' }).then(setData); }, [version]);
  const shown = (data?.people || []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.aka.some((a) => a.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="help">{t('impact.namesHelp')}</div>
      <input className="input" type="search" placeholder={t('impact.searchPeople')} aria-label={t('impact.searchPeople')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card list">
        {shown.map((p) => {
          const v = vals[p.id] ?? p.aka.join(', ');
          return (
            <div key={p.id} className="list-item imp-name">
              <div className="imp-name-who">
                <b>{p.name}</b>
                <div className="tiny faint">{[t('impact.matches', { names: [p.first, ...p.nicknames].filter(Boolean).join(', ') }), p.common && t('impact.commonWord')].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row imp-name-aka">
                <input className="input sm" aria-label={t('impact.akaFor', { name: p.name })} placeholder={t('impact.akaPlaceholder')} value={v} onChange={(e) => setVals({ ...vals, [p.id]: e.target.value })} />
                <button className="btn sm" disabled={busy || v === p.aka.join(', ')} onClick={() => run(() => call('impact.setAka', { userId: p.id, aka: v.split(',').map((x) => x.trim()).filter(Boolean) }), t('impact.akaSaved'))}>{t('common.save')}</button>
              </div>
            </div>
          );
        })}
      </div>
      <ImpactSettingsCard />
    </div>
  );
}
