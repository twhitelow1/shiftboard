// Settings → Integrations → Google Business Profile and Yelp (the plan's `reviews` feature), like OpenTable's card.
//   GooglePanel  Connect (Google's consent screen; admins), pick the location, last sync, Sync now, Disconnect
//   YelpPanel    find the business (by name and city, or its Yelp page), last sync, Sync now; what Yelp's API gives
// The demo shows a sample connection and never calls Google or Yelp.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { IS_DEMO } from '../api.js';
import { useT, stamp, translateError } from '../i18n/index.js';
import { saveIntegrations } from '../integrations-api.js';
import { googleStatus, googleConnect, googleLocations, googlePickLocation, googleDisconnect, googleSyncAll, yelpStatus, yelpLookup, yelpSync } from '../reviews-api.js';
import '../reviews.css';

const n = (c, k) => c?.[k] || 0;

/** "Synced 2:30 PM: 2 new, 1 changed" or the error. */
function LastSync({ last, kind }) {
  const t = useT();
  if (!last) return <div className="small muted">{t('reviews.neverSynced')}</div>;
  if (!last.ok) return <div className="alert bad"><Icon name="alert" size={16} /><div>{t('reviews.lastSyncFailed', { when: stamp(last.at), error: translateError(last.error || '') })}</div></div>;
  return (
    <div className="alert ok"><Icon name="check" size={16} />
      <div>{kind === 'yelp' ? t('reviews.lastSyncYelp', { when: stamp(last.at), count: n(last.counts, 'excerpts'), fresh: n(last.counts, 'new') })
        : t('reviews.lastSyncGoogle', { when: stamp(last.at), fresh: n(last.counts, 'new'), updated: n(last.counts, 'updated'), replies: n(last.counts, 'replies') })}</div>
    </div>
  );
}

export function GooglePanel() {
  const t = useT();
  const { version, toast, refresh, isMgr, managed } = useApp();
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [locs, setLocs] = useState(null);
  const [pick, setPick] = useState('');
  const [sure, setSure] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => { googleStatus().then((x) => { setS(x); setError(''); }).catch((e) => setError(e.message)); }, [version]);
  // Back from Google's consent screen: ?google=connected|pick|error&why=… (then the address is tidied).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const g = q.get('google');
    if (!g) return;
    if (g === 'connected') toast(t('reviews.googleConnected'));
    else if (g === 'pick') toast(t('reviews.googlePickNow'));
    else toast(t(`reviews.googleError_${['state', 'browser', 'user', 'denied', 'noRefresh', 'scope'].includes(q.get('why')) ? q.get('why') : 'other'}`), 'bad');
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }, []);

  const connect = () => run(async () => { const r = await googleConnect(); location.href = r.url; });
  const loadLocations = () => run(async () => { const r = await googleLocations(); setLocs(r.locations); setPick(r.locations[0] ? `${r.locations[0].account}|${r.locations[0].location}` : ''); });
  const saveLocation = () => run(async () => { const [a, l] = pick.split('|'); const r = await googlePickLocation(a, l); setS({ ...s, ...r }); setLocs(null); }, t('reviews.locationSaved'));
  const disconnect = () => run(async () => { const r = await googleDisconnect(); setS({ ...s, ...r }); setSure(false); }, t('reviews.googleDisconnected'));
  const sync = async () => {
    setSyncing(true);
    try { const r = await googleSyncAll(); toast(t('reviews.syncedGoogle', { fresh: n(r.counts, 'new'), updated: n(r.counts, 'updated') })); } catch (e) { toast(translateError(e.message), 'bad'); } finally { setSyncing(false); refresh(); }
  };

  if (error && !s) return <div className="alert bad">{translateError(error)}</div>;
  if (!s) return <div className="small faint">{t('common.loading')}</div>;
  const admin = s.canEdit;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">{t('reviews.googleIntro')}</div>
      {s.demo && <div className="help">{t('reviews.googleDemo')}</div>}
      {!s.configured ? <div className="help">{managed ? t('reviews.googleNoClient') : t('reviews.googleNoClientEnv', { names: (s.missing || []).join(', ') })}</div> : (
        <div className="adp-block">
          {s.needsReconnect && <div className="alert warn"><Icon name="alert" size={16} /><div>{t('reviews.googleReconnect')}</div></div>}
          {!s.connected ? (
            <>
              <b>{t('reviews.googleNotConnected')}</b>
              <div className="small muted">{t('reviews.googleConnectHelp')}</div>
              {admin ? <div><button className="btn primary sm" disabled={busy || s.demo} onClick={connect}><Icon name="link" />{t('reviews.connectGoogle')}</button></div>
                : <div className="help">{t('reviews.adminConnects')}</div>}
            </>
          ) : (
            <>
              {s.location ? (
                <div className="col" style={{ gap: 2 }}>
                  <b>{s.location.title}</b>
                  {s.location.address && <span className="small muted">{s.location.address}</span>}
                  <span className="tiny faint">{t('reviews.connectedBy', { name: s.connectedBy || '—', when: s.connectedAt ? stamp(s.connectedAt) : '—' })}</span>
                </div>
              ) : <div className="alert warn"><Icon name="alert" size={16} /><div>{t('reviews.googlePickLocation')}</div></div>}
              {s.location && <LastSync last={s.lastSync} kind="google" />}
              <div className="row wrap" style={{ gap: 8 }}>
                {s.location && isMgr && <button className="btn sm" disabled={syncing || s.demo} onClick={sync}><Icon name="download" />{syncing ? t('reviews.syncing') : t('reviews.syncNow')}</button>}
                {admin && !locs && <button className="btn sm" disabled={busy || s.demo} onClick={loadLocations}><Icon name="map" />{s.location ? t('reviews.changeLocation') : t('reviews.pickLocation')}</button>}
                {admin && (s.needsReconnect ? <button className="btn sm" disabled={busy || s.demo} onClick={connect}><Icon name="link" />{t('reviews.connectAgain')}</button>
                  : !sure && <button className="btn sm ghost" disabled={busy || s.demo} onClick={() => setSure(true)}><Icon name="x" />{t('reviews.disconnect')}</button>)}
                {sure && <><span className="small">{t('reviews.disconnectSure')}</span><button className="btn sm danger" disabled={busy} onClick={disconnect}>{t('reviews.disconnect')}</button><button className="btn sm ghost" onClick={() => setSure(false)}>{t('common.cancel')}</button></>}
              </div>
              {s.location && <span className="help">{s.cron ? t('reviews.dailyOn') : t('reviews.dailyOff')}</span>}
              {locs && (
                <div className="col" style={{ gap: 8 }}>
                  {!locs.length ? <div className="help">{t('reviews.noLocations')}</div> : (
                    <div className="rv-loc" role="radiogroup" aria-label={t('reviews.pickLocation')}>
                      {locs.map((l) => {
                        const v = `${l.account}|${l.location}`;
                        return <label key={v}><input type="radio" name="gbp-location" checked={pick === v} onChange={() => setPick(v)} /><span><b>{l.title}</b><br /><span className="small muted">{[l.address, l.accountName].filter(Boolean).join(' · ')}</span></span></label>;
                      })}
                    </div>
                  )}
                  <div className="row wrap" style={{ gap: 8 }}>
                    {locs.length > 0 && <button className="btn primary sm" disabled={busy || !pick} onClick={saveLocation}><Icon name="check" />{t('common.save')}</button>}
                    <button className="btn sm ghost" onClick={() => setLocs(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <details className="tp-help">
        <summary>{t('reviews.googleWhat')}</summary>
        <ul><li>{t('reviews.googleWhat1')}</li><li>{t('reviews.googleWhat2')}</li><li>{t('reviews.googleWhat3')}</li></ul>
      </details>
    </div>
  );
}

export function YelpPanel({ editable, onSaved }) {
  const t = useT();
  const { version, toast, refresh, isMgr, managed } = useApp();
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState({ term: '', location: '', id: '' });
  const [found, setFound] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => { yelpStatus().then((x) => { setS(x); setError(''); }).catch((e) => setError(e.message)); }, [version]);
  const search = (e) => { e.preventDefault(); run(async () => { const r = await yelpLookup(q.id.trim() ? { id: q.id.trim() } : { term: q.term, location: q.location }); setFound(r.businesses); }); };
  const use = (b) => run(async () => { const r = await saveIntegrations({ YELP_BUSINESS_ID: b.id }); onSaved?.(r); setFound(null); }, t('reviews.yelpBusinessSaved', { name: b.name }));
  const sync = async () => {
    setSyncing(true);
    try { const r = await yelpSync(); toast(t('reviews.syncedYelp', { count: n(r.counts, 'excerpts'), fresh: n(r.counts, 'new') })); } catch (e) { toast(translateError(e.message), 'bad'); } finally { setSyncing(false); refresh(); }
  };
  if (error && !s) return <div className="alert bad">{translateError(error)}</div>;
  if (!s) return <div className="small faint">{t('common.loading')}</div>;
  const canFind = s.canEdit && s.hasKey && editable && !s.demo;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">{t('reviews.yelpIntro')}</div>
      {s.demo && <div className="help">{t('reviews.yelpDemo')}</div>}
      <div className="adp-block">
        {s.businessId ? <div className="small">{t('reviews.yelpBusiness', { id: s.businessId })}</div> : <b>{t('reviews.yelpNoBusiness')}</b>}
        {!s.hasKey && <div className="help">{managed ? t('reviews.yelpNoKeyManaged') : t('reviews.yelpNoKey')}</div>}
        {canFind && (
          <form className="col" style={{ gap: 8 }} onSubmit={search}>
            <div className="rv-search">
              <input className="input" aria-label={t('reviews.yelpName')} placeholder={t('reviews.yelpName')} value={q.term} onChange={(e) => setQ({ ...q, term: e.target.value, id: '' })} />
              <input className="input" aria-label={t('reviews.yelpCity')} placeholder={t('reviews.yelpCity')} value={q.location} onChange={(e) => setQ({ ...q, location: e.target.value, id: '' })} />
              <button className="btn sm" disabled={busy || !(q.id.trim() || (q.term.trim() && q.location.trim()))}><Icon name="search" />{t('reviews.find')}</button>
            </div>
            <input className="input" aria-label={t('reviews.yelpPage')} placeholder={t('reviews.yelpPage')} value={q.id} onChange={(e) => setQ({ ...q, id: e.target.value })} />
          </form>
        )}
        {found && (
          <div className="rv-biz">
            {!found.length && <div className="help">{t('reviews.yelpNothingFound')}</div>}
            {found.map((b) => <button key={b.id} className="btn sm" disabled={busy} onClick={() => use(b)}><Icon name="check" /><span><b>{b.name}</b>{b.address ? ` · ${b.address}` : ''}</span></button>)}
          </div>
        )}
        {s.configured && <LastSync last={s.lastSync} kind="yelp" />}
        {s.configured && isMgr && (
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn sm" disabled={syncing || s.demo} onClick={sync}><Icon name="download" />{syncing ? t('reviews.syncing') : t('reviews.syncNow')}</button>
            <span className="help">{s.cron ? t('reviews.dailyOn') : t('reviews.dailyOff')}</span>
          </div>
        )}
      </div>
      <details className="tp-help">
        <summary>{t('reviews.yelpWhat')}</summary>
        <ul><li>{t('reviews.yelpWhat1')}</li><li>{t('reviews.yelpWhat2')}</li><li>{t('reviews.yelpWhat3')}</li><li>{t('reviews.yelpWhat4')}</li></ul>
      </details>
    </div>
  );
}
