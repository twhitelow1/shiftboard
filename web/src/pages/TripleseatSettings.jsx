// Tripleseat in the web app.
//   TripleseatPanel     Settings → Integrations → Tripleseat: status (which settings are present), the account
//                       and location, Sync now and the last sync, room matching, the status rules, the
//                       webhook link (admins) and events deleted here.
//   TripleseatBadge     "Tripleseat" on synced events in the Events list.
//   TripleseatEventCard on a synced event's BEO: "From Tripleseat: edit it there", the link to open it in
//                       Tripleseat, flags for the events team, and "Suggest staffing" when it has none yet.
//   TripleseatEditorNote  the same reminder at the top of the BEO editor.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Field, useAction } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { tripleseatStatus, tripleseatSyncAll } from '../tripleseat-api.js';
import { useVenueRooms } from './Sections.jsx';
import '../labor.css';
import { useT, prettyDate, stamp, translateError } from '../i18n/index.js';

export const TRIPLESEAT_DOCS = 'docs/integrations/TRIPLESEAT.md';
const RULES = ['tentative', 'prospect', 'closed', 'lost'];
const when = (iso) => (iso ? stamp(iso) : '');
const n = (counts, k) => counts?.[k] || 0;

/** Tripleseat status (env names only) + what's been synced. Reloads when `version` changes. */
export function useTripleseat() {
  const { call, version, has } = useApp();
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (has && !has('tripleseat')) { setStatus({ configured: false, missing: [], off: true }); return; } // not in the plan
    tripleseatStatus().then(setStatus).catch((e) => setError(e.message));
    if (!IS_DEMO) call('tripleseat.get').then(setInfo).catch((e) => setError(e.message));
  }, [version]);
  return { status, info, error };
}

export function TripleseatPanel() {
  const t = useT();
  const { managed, isAdmin, toast, refresh } = useApp();
  const { status, info, error } = useTripleseat();
  const [progress, setProgress] = useState(null);

  const head = (badge) => <div className="row wrap" style={{ gap: 8 }}><h3 style={{ flex: 1 }}>{t('tripleseat.title')}</h3>{badge}</div>;
  const intro = <div className="small muted" style={{ marginTop: -4 }}>{t('tripleseat.intro')}</div>;

  if (IS_DEMO || status?.demo) {
    return <div className="col" style={{ gap: 8 }}>{head(<span className="badge">{t('tripleseat.notInDemo')}</span>)}{intro}<div className="help">{t('tripleseat.demoHelp')}</div></div>;
  }
  if (error && !status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="alert bad">{error}</div></div>;
  if (!status) return <div className="col" style={{ gap: 8 }}>{head(null)}<div className="small faint">{t('common.loading')}</div></div>;
  if (!status.configured) {
    return (
      <div className="col" style={{ gap: 10 }}>
        {head(<span className="badge warn">{t('tripleseat.notSetUp')}</span>)}{intro}
        {managed
          ? <div className="alert warn"><Icon name="alert" size={16} /><div>{t('tripleseat.askDublow')}</div></div>
          : <><div className="alert warn"><Icon name="alert" size={16} /><div>{t('tripleseat.addEnv', { names: status.missing.join(', ') })}</div></div><SetupHelp open /></>}
      </div>
    );
  }

  const sync = async () => {
    setProgress({ step: 0, of: 4 });
    try {
      const r = await tripleseatSyncAll({ onProgress: setProgress });
      toast(t('tripleseat.syncedToast', { added: n(r.counts, 'added'), updated: n(r.counts, 'updated'), cancelled: n(r.counts, 'cancelled') + n(r.counts, 'flagged') + n(r.counts, 'removed') }));
    } catch (e) {
      toast(translateError(e.message), 'bad');
    } finally {
      setProgress(null);
      refresh();
    }
  };
  const last = info?.lastSync;
  const where = info?.location?.name || (status.locationId ? `#${status.locationId}` : t('tripleseat.allLocations'));

  return (
    <div className="col" style={{ gap: 12 }}>
      {head(<span className="badge ok"><Icon name="check" size={12} />{t('tripleseat.connected')}</span>)}
      {intro}
      {status.auth === 'oauth1' && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('tripleseat.legacyKeys')}</div></div>}
      <div className="tp-facts">
        <div><span>{t('tripleseat.account')}</span><b>{info?.site?.name || t('tripleseat.showsAfterSync')}</b></div>
        <div><span>{t('tripleseat.location')}</span><b>{where}</b></div>
        <div><span>{t('tripleseat.lastSync')}</span><b>{last ? `${when(last.at)}${last.by === 'cron' ? t('tripleseat.daily') : ''}` : t('tripleseat.never')}</b></div>
        <div><span>{t('tripleseat.dailySync')}</span><b>{status.cron ? t('tripleseat.dailyOn') : t('tripleseat.dailyOff')}</b></div>
      </div>
      {last && (last.ok
        ? <div className="alert ok"><Icon name="check" size={16} /><div>{t('tripleseat.lastSyncLine', { added: n(last.counts, 'added'), updated: n(last.counts, 'updated'), cancelled: n(last.counts, 'cancelled') + n(last.counts, 'flagged') + n(last.counts, 'removed'), same: n(last.counts, 'same') })}{!last.finished && t('tripleseat.notFinished')}</div></div>
        : <div className="alert bad"><Icon name="alert" size={16} /><div>{t('tripleseat.lastSyncFailed', { error: translateError(last.error) })}</div></div>)}
      {(last?.warnings || []).map((w) => <div key={w.code} className="help">{t(`tripleseat.warn_${w.code}`)} {translateError(w.error)}</div>)}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!!progress} onClick={sync}><Icon name="download" />{t('tripleseat.syncNow')}</button>
        {progress && <span className="small muted">{t('tripleseat.syncing', { step: Math.min(progress.step + 1, progress.of), of: progress.of })}</span>}
      </div>
      <div className="help">{t('tripleseat.window', { back: info?.window?.back ?? 7, ahead: info?.window?.ahead ?? 120 })}</div>

      {info && <EventsSummary info={info} />}
      {info && <RoomMatching info={info} />}
      {info && <RulesCard info={info} />}
      {info && isAdmin && <WebhookCard info={info} status={status} managed={managed} />}
      {info?.skipped?.length > 0 && <SkippedCard info={info} />}
      {!managed && <SetupHelp />}
    </div>
  );
}

function EventsSummary({ info }) {
  const t = useT();
  return (
    <div className="adp-block">
      <div className="row wrap" style={{ gap: 8 }}>
        <div style={{ flex: '1 1 220px' }}>{t('tripleseat.eventsLine', { events: info.totals.events, upcoming: info.totals.upcoming, needStaffing: info.totals.needStaffing })}</div>
        <a className="btn sm" href="#/events"><Icon name="glass" />{t('tripleseat.openEvents')}</a>
      </div>
      {info.review.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <b className="small">{t('tripleseat.review')}</b>
          <div className="help">{t('tripleseat.reviewHelp')}</div>
          {info.review.map((e) => <a key={e.id} className="small" href={`#/events/${e.id}`}><Icon name="alert" size={12} /> {e.name} · {prettyDate(e.date)}</a>)}
        </div>
      )}
    </div>
  );
}

/** Tripleseat rooms → venue rooms. Only what's changed is saved. */
function RoomMatching({ info }) {
  const t = useT();
  const { call } = useApp();
  const venue = useVenueRooms();
  const [pick, setPick] = useState({});
  const [run, busy] = useAction();
  const changes = Object.keys(pick).length;
  const valueOf = (r) => (r.id in pick ? pick[r.id] : r.roomId) || '';
  const by = (m) => (m === 'name' ? t('tripleseat.byName') : m === 'manual' ? t('tripleseat.byHand') : '');
  const save = async () => {
    const r = await run(() => call('tripleseat.saveRooms', { rooms: Object.entries(pick).map(([id, roomId]) => ({ id, roomId: roomId || null })) }), (x) => t('tripleseat.roomsSaved', { count: x.events }));
    if (r) setPick({});
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <h3>{t('tripleseat.rooms')}</h3>
      <div className="help">{t('tripleseat.roomsHelp')}</div>
      {!info.rooms.length ? <div className="small faint">{t('tripleseat.noRooms')}</div> : (
        <div className="tp-list">
          {info.rooms.map((r) => (
            <div key={r.id} className="tp-row">
              <div className="tp-who">
                <div style={{ fontWeight: 600 }}>{r.name || '—'}</div>
                <div className="tiny faint">{[r.locationName, t('tripleseat.nEvents', { count: r.events }), by(r.matchedBy)].filter(Boolean).join(' · ')}</div>
              </div>
              <select className="input sm" value={valueOf(r)} disabled={!venue?.length} onChange={(x) => setPick({ ...pick, [r.id]: x.target.value })} aria-label={t('tripleseat.roomFor', { name: r.name })}>
                <option value="">{t('tripleseat.keepName')}</option>
                {(venue || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      {venue && !venue.length && info.rooms.length > 0 && <div className="help">{t('tripleseat.noVenueRooms')}</div>}
      {info.rooms.length > 0 && (
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary sm" disabled={!changes || busy} onClick={save}><Icon name="check" />{t('tripleseat.saveRooms')}</button>
          {changes > 0 && <button className="btn ghost sm" onClick={() => setPick({})}>{t('common.undo')}</button>}
        </div>
      )}
    </div>
  );
}

/** What each Tripleseat status does. Admins change it; managers see it. */
function RulesCard({ info }) {
  const t = useT();
  const { call, isAdmin } = useApp();
  const [rules, setRules] = useState(info.rules);
  const [run, busy] = useAction();
  useEffect(() => setRules(info.rules), [info]);
  const changed = RULES.some((k) => rules[k] !== info.rules[k]);
  return (
    <div className="col" style={{ gap: 8 }}>
      <h3>{t('tripleseat.rules')}</h3>
      <div className="help">{t('tripleseat.rulesHelp')}</div>
      <div className="grid2">
        <Field label={t('tripleseat.status_definite')}><input className="input sm" value={t('tripleseat.definiteRule')} disabled readOnly /></Field>
        {RULES.map((k) => (
          <Field key={k} label={t(`tripleseat.status_${k}`)}>
            <select className="input sm" value={rules[k]} disabled={!isAdmin || busy} onChange={(e) => setRules({ ...rules, [k]: e.target.value })}>
              {info.ruleOptions[k].map((o) => <option key={o} value={o}>{t(`tripleseat.rule_${k}_${o}`)}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <div className="help">{t('tripleseat.leaveOutHelp')}</div>
      {isAdmin && changed && <div><button className="btn primary sm" disabled={busy} onClick={() => run(() => call('tripleseat.saveRules', { rules }), t('tripleseat.rulesSaved'))}><Icon name="check" />{t('tripleseat.saveRules')}</button></div>}
    </div>
  );
}

/** The restaurant's own webhook link (admins only: it's what lets Tripleseat reach this restaurant). */
function WebhookCard({ info, status, managed }) {
  const t = useT();
  const { call, toast } = useApp();
  const [token, setToken] = useState(info.webhookToken || null);
  const [renew, setRenew] = useState(false);
  const [run, busy] = useAction();
  const link = token ? `${location.origin}/api/tripleseat/webhook/${token}` : '';
  const make = async (fresh) => {
    const r = await run(() => call('tripleseat.webhookLink', { renew: fresh }), fresh ? t('tripleseat.newLinkDone') : null);
    if (r) { setToken(r.token); setRenew(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast(t('tripleseat.copied')); } catch { /* the field can be selected by hand */ } };
  const lw = info.lastWebhook;
  return (
    <div className="adp-block">
      <b>{t('tripleseat.webhook')}</b>
      <div className="small muted">{t('tripleseat.webhookHelp')}</div>
      {!token ? <div><button className="btn sm" disabled={busy} onClick={() => make(false)}><Icon name="link" />{t('tripleseat.showLink')}</button></div> : (
        <>
          <Field label={t('tripleseat.webhookLink')} help={t('tripleseat.keepSecret')}>
            <div className="row" style={{ gap: 6 }}>
              <input className="input sm mono" readOnly value={link} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
              <button className="btn sm" onClick={copy} aria-label={t('tripleseat.copy')}><Icon name="copy" /></button>
            </div>
          </Field>
          <div><button className={`btn sm ${renew ? 'danger solid' : 'ghost'}`} disabled={busy} onClick={() => (renew ? make(true) : setRenew(true))}>{renew ? t('tripleseat.newLinkConfirm') : t('tripleseat.newLink')}</button></div>
        </>
      )}
      <div className="small">{status.webhookSecret ? t('tripleseat.signingOn') : managed ? t('tripleseat.signingOffManaged') : t('tripleseat.signingOff')}</div>
      <div className="small muted">{t('tripleseat.lastWebhook')}: {lw ? t('tripleseat.lastWebhookLine', { when: when(lw.at), id: lw.eventId, action: lw.ok ? t(`tripleseat.action_${lw.action || 'none'}`) : translateError(lw.error) }) : t('tripleseat.noWebhookYet')}</div>
    </div>
  );
}

function SkippedCard({ info }) {
  const t = useT();
  const { call, isAdmin } = useApp();
  const [run, busy] = useAction();
  const back = (id) => run(() => call('tripleseat.restoreSkipped', id ? { id } : {}), (r) => t('tripleseat.broughtBack', { count: r.restored }));
  return (
    <div className="col" style={{ gap: 6 }}>
      <h3>{t('tripleseat.skipped')}</h3>
      <div className="help">{t('tripleseat.skippedHelp')}</div>
      <div className="tp-list">
        {info.skipped.map((s) => (
          <div key={s.id} className="tp-row">
            <div className="tp-who"><div style={{ fontWeight: 600 }}>{s.name}</div><div className="tiny faint">{s.date ? prettyDate(s.date) : ''}</div></div>
            {isAdmin && <button className="btn sm" disabled={busy} onClick={() => back(s.id)}>{t('tripleseat.bringBack')}</button>}
          </div>
        ))}
      </div>
      {isAdmin && info.skipped.length > 1 && <div><button className="btn sm ghost" disabled={busy} onClick={() => back(null)}>{t('tripleseat.bringBackAll')}</button></div>}
    </div>
  );
}

function SetupHelp({ open }) {
  const t = useT();
  return (
    <details className="tp-help" open={open}>
      <summary>{t('tripleseat.howToConnect')}</summary>
      <ol>
        <li>{t('tripleseat.step1')}</li>
        <li>{t('tripleseat.step2')}</li>
        <li>{t('tripleseat.step3')}</li>
        <li>{t('tripleseat.step4')}</li>
        <li>{t('tripleseat.step5')}</li>
      </ol>
      <div className="help" style={{ marginTop: 6 }}>{t('tripleseat.docsLine')} <code>{TRIPLESEAT_DOCS}</code></div>
    </details>
  );
}

// ---------------------------------------------------------------- Events & BEOs

/** "Tripleseat" on a synced event in the Events list; amber when the events team should look at it. */
export function TripleseatBadge({ review = 0 }) {
  const t = useT();
  return <span className={`badge ${review ? 'warn' : ''}`} title={t('tripleseat.badgeTitle')}><Icon name={review ? 'alert' : 'link'} size={11} />{t('tripleseat.badge')}</span>;
}

/** The names of the fields Tripleseat owns on this event, in words: "name, date, guests…". */
const ownedWords = (t, owns) => (owns || []).map((f) => t(`tripleseat.field_${f}`)).join(', ');

/** On a synced event's BEO. Nothing for other events. */
export function TripleseatEventCard({ e, reload }) {
  const t = useT();
  const { call, isEvents, jobs } = useApp();
  const [run, busy] = useAction();
  const [lines, setLines] = useState(null);
  const ts = e?.tripleseat;
  const review = ts?.review || [];
  const canSuggest = isEvents && !e.staffing?.length && e.guestCount > 0 && !['cancelled', 'completed'].includes(e.status);
  const suggested = useMemo(() => (lines || []).map((l) => `${l.count} ${jobs[l.jobCodeId]?.name || '?'}`).join(' · '), [lines, jobs]);
  if (!ts) return null;
  const suggest = async () => { const r = await run(() => call('events.suggestStaffing', e)); if (r) setLines(r); };
  const addLines = async () => {
    const r = await run(() => call('events.save', { ...e, staffing: lines }), t('tripleseat.linesAdded'));
    if (r) { setLines(null); reload?.(); }
  };
  const clear = () => run(() => call('tripleseat.clearReview', { id: e.id })).then(() => reload?.());
  const reviewText = (r) => t(`tripleseat.review_${r.code}`, { count: r.staffed || 0, from: r.from ? prettyDate(r.from) : '', to: r.to ? prettyDate(r.to) : '' });

  return (
    <div className="card card-pad section col no-print" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <TripleseatBadge />
        <b style={{ flex: '1 1 200px' }}>{t('tripleseat.fromTripleseat')}</b>
        {isEvents && ts.url && <a className="btn sm" href={ts.url} target="_blank" rel="noreferrer noopener"><Icon name="link" />{t('tripleseat.openInTripleseat')}</a>}
      </div>
      <div className="small muted">{t('tripleseat.ownsLine', { fields: ownedWords(t, ts.owns) })}</div>
      <div className="small faint">{[ts.owner && `${t('tripleseat.salesManager')}: ${ts.owner}`, ts.status && t('tripleseat.tripleseatStatus', { status: ts.status.charAt(0).toUpperCase() + ts.status.slice(1) }), ts.syncedAt && t('tripleseat.syncedAt', { when: when(ts.syncedAt) })].filter(Boolean).join(' · ')}</div>
      {e.tsNotes && <div className="small"><b>{t('tripleseat.notesFromTripleseat')}:</b> {e.tsNotes}</div>}
      {isEvents && review.map((r) => <div key={r.code} className="alert warn"><Icon name="alert" size={16} /><div style={{ flex: 1 }}>{reviewText(r)}</div><button className="btn sm" disabled={busy} onClick={clear}>{t('tripleseat.gotIt')}</button></div>)}
      {canSuggest && (
        <div className="alert info">
          <Icon name="sparkle" size={16} />
          <div style={{ flex: 1 }} className="col">
            {!lines ? <span>{t('tripleseat.noStaffing', { count: e.guestCount })}</span>
              : lines.length ? <span>{t('tripleseat.suggestion', { count: e.guestCount })} <b>{suggested}</b></span> : <span>{t('tripleseat.noSuggestion')}</span>}
            <div className="row wrap" style={{ gap: 6 }}>
              {!lines && <button className="btn sm" disabled={busy} onClick={suggest}><Icon name="sparkle" />{t('tripleseat.suggest')}</button>}
              {lines?.length > 0 && <button className="btn sm primary" disabled={busy} onClick={addLines}><Icon name="check" />{t('tripleseat.addLines')}</button>}
              {lines && <a className="btn sm ghost" href={`#/events/${e.id}/edit`}>{t('tripleseat.editByHand')}</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** At the top of the BEO editor for a synced event. */
export function TripleseatEditorNote({ e }) {
  const t = useT();
  if (e?.source !== 'tripleseat' || !e.tripleseat) return null;
  return <div className="alert info"><Icon name="link" size={16} /><div><b>{t('tripleseat.fromTripleseat')}</b> {t('tripleseat.ownsLine', { fields: ownedWords(t, e.tripleseat.owns) })}</div></div>;
}

