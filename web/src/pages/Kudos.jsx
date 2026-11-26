// My kudos (#/kudos, linked from My Shifts): the reviews that name me, guests who asked for me, and kudos a
// manager added, for a season, a month or dates. Only my own: the server sends nobody else's (impact.get),
// and a reservation shows just the words around my name.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Empty } from '../ui.jsx';
import { useT, prettyDate } from '../i18n/index.js';
import { PeriodPicker, periodArgs, ImpactItem, Stat } from './ImpactShared.jsx';
import '../impact.css';

export default function Kudos() {
  const t = useT();
  const { call, version, today, has, isMgr } = useApp();
  const [period, setPeriod] = useState({ period: 'season' });
  const [data, setData] = useState(null);
  const args = periodArgs(period);
  useEffect(() => { if (has('impact')) call('impact.get', args).then(setData).catch(() => setData(null)); }, [version, JSON.stringify(args)]);
  if (!has('impact')) return <Empty icon="star" title={t('impact.notInPlan')} />;
  const c = data?.counts;
  return (
    <div className="col imp-page" style={{ maxWidth: 760 }}>
      <div className="toolbar">
        <PeriodPicker value={{ ...period, seasonId: period.seasonId || data?.range?.seasonId }} onChange={setPeriod} seasons={data?.seasons || []} today={today} />
        {isMgr && <a className="btn sm ghost" href="#/impact"><Icon name="users" />{t('impact.teamReport')}</a>}
      </div>
      <div className="help">{t('impact.myKudosIntro')}</div>
      {!data && <div className="empty">{t('common.loading')}</div>}
      {c && (
        <div className="imp-stats">
          <Stat icon="star" value={c.fiveStar} label={t('impact.stat_fiveStar')} prev={data.prev?.fiveStar ?? undefined} />
          <Stat value={c.mentions} label={t('impact.stat_mentions')} />
          <Stat icon="hand" value={c.requests} label={t('impact.stat_requests')} prev={data.prev?.requests ?? undefined} />
          <Stat icon="sparkle" value={c.kudos} label={t('impact.stat_kudos')} prev={data.prev?.kudos ?? undefined} />
        </div>
      )}
      {data && !data.items.length && <Empty icon="star" title={t('impact.myNothingYet')}>{t('impact.myNothingYetHelp')}</Empty>}
      {data?.items.map((it) => <ImpactItem key={`${it.kind}-${it.id}`} item={it} />)}
      {data?.range && <div className="help">{t('impact.periodLine', { from: prettyDate(data.range.from), to: prettyDate(data.range.to) })}</div>}
    </div>
  );
}

/** On My Shifts: this season's count and a link to My kudos. */
export function KudosCard() {
  const t = useT();
  const { call, version, has } = useApp();
  const [data, setData] = useState(null);
  useEffect(() => { if (has('impact')) call('impact.get', {}).then(setData).catch(() => {}); }, [version]);
  if (!has('impact') || !data) return null;
  const c = data.counts;
  const any = c.fiveStar + c.mentions + c.requests + c.kudos > 0;
  return (
    <a className="card card-pad imp-card" href="#/kudos">
      <Icon name="star" size={20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>{t('impact.myKudos')}</div>
        <div className="small muted">{any ? t('impact.cardLine', { five: c.fiveStar, requests: c.requests, kudos: c.kudos, season: data.range.label }) : t('impact.cardEmpty', { season: data.range.label })}</div>
      </div>
      <Icon name="right" size={16} />
    </a>
  );
}
