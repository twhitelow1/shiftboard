import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, useAction, JobDot } from '../ui.jsx';
import { useT, dowShort, prettyDate, fmtTime, num } from '../i18n/index.js';
import { dow } from '../../../core/time.js';
import { ruleLabel, ratingText } from './Ratings.jsx';
import '../ratings.css';

// The schedule's Skill mix panel and the publish warning (core/ratings.js skillMix.*): each day's skill-mix rules,
// red when one fails and why, and for a failing rule the people who could be added as a draft shift or swapped into
// a draft (never published from here). Managers only (the ratingsView role feature); nothing here renders for staff.

/** skillMix.week for a week: null until loaded or when the person can't see ratings. */
export function useSkillMix(ws, enabled = true) {
  const { call, version, has } = useApp();
  const [data, setData] = useState(null);
  const on = enabled && has('ratingsView');
  const reload = () => (on && ws ? call('skillMix.week', { weekStart: ws }).then(setData).catch(() => setData(null)) : Promise.resolve(setData(null)));
  useEffect(() => { reload(); }, [ws, version, on]);
  return { data, reload };
}

/** Why a result fails (or how it stands), in words. */
function resultText(res, rule, t) {
  if (rule.type === 'minAvg') return res.avg == null ? (res.scheduled ? t('ratings.nobodyRated') : t('ratings.nobodyScheduled')) : t('ratings.haveAvg', { avg: num(res.avg), need: num(rule.avg) });
  if (rule.type === 'atLeast') return t('ratings.haveAtLeast', { have: res.have, rating: rule.rating, count: rule.count });
  return t('ratings.haveAtMost', { have: res.have, rating: rule.rating, count: rule.count });
}

/** On the schedule, under the week: a compact panel per day, red where a rule fails. */
export default function SkillMixPanel({ ws }) {
  const t = useT();
  const { jobs } = useApp();
  const { data } = useSkillMix(ws);
  const [fix, setFix] = useState(null);
  if (!data) return null;
  const rules = Object.fromEntries(data.rules.map((r) => [r.id, r]));
  if (!data.rules.length) {
    return <div className="card section rt-panel no-print"><div className="card-head row wrap"><h2 style={{ flex: 1 }}>{t('ratings.skillMix')}</h2><a className="small" href="#/settings/ratings">{t('ratings.setUp')}</a></div>
      <div className="card-pad muted small" style={{ paddingTop: 0 }}>{t('ratings.noRulesYet')}</div></div>;
  }
  const days = data.days.filter((d) => d.results.length);
  return (
    <div className="card section rt-panel no-print" data-testid="skill-mix">
      <div className="card-head row wrap">
        <h2 style={{ flex: 1 }}><Icon name="star" size={16} /> {t('ratings.skillMix')}</h2>
        {data.failing > 0 ? <span className="badge bad">{t('ratings.failing', { count: data.failing })}</span> : <span className="badge ok">{t('ratings.allMet')}</span>}
        <a className="small" href="#/settings/ratings">{t('ratings.title')}</a>
      </div>
      <div className="rt-days">
        {days.map((d) => (
          <div key={d.date} className={`rt-day ${d.failing ? 'bad' : 'ok'}`}>
            <div className="row" style={{ gap: 6 }}><b>{dowShort(dow(d.date))} {prettyDate(d.date).replace(/^[^,]*, /, '')}</b>
              {d.failing ? <span className="badge bad">{t('ratings.failing', { count: d.failing })}</span> : <Icon name="check" size={14} />}</div>
            {d.results.map((res) => {
              const r = rules[res.ruleId];
              return (
                <div key={res.ruleId} className={`rt-res ${res.status}`}>
                  <div className="small"><JobDot job={jobs[r.jobCodeId]} /> {ruleLabel({ ...r, days: [] }, { t, jobs })}</div>
                  <div className="small rt-why">{res.status === 'fail' && <Icon name="alert" size={12} />} {resultText(res, r, t)}</div>
                  {res.people.length > 0 && <div className="rt-chips">{res.people.map((p) => <span key={p.userId} className="rt-chip">{p.name}{p.hidden ? '' : <b> {p.rating == null ? '—' : p.rating}</b>}</span>)}</div>}
                  {res.status === 'fail' && data.canEdit && <button className="btn sm" onClick={() => setFix({ date: d.date, rule: r, res })}><Icon name="sparkle" size={14} />{t('ratings.suggestions')}</button>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {fix && <Suggestions fix={fix} scale={data.scale} onClose={() => setFix(null)} />}
    </div>
  );
}

function Suggestions({ fix, scale, onClose }) {
  const t = useT();
  const { call, jobs } = useApp();
  const [run, busy] = useAction();
  const [list, setList] = useState(null);
  useEffect(() => { call('skillMix.suggestions.list', { date: fix.date, ruleId: fix.rule.id }).then(setList).catch(() => setList({ candidates: [] })); }, []);
  const add = (c) => run(() => call('shifts.save', { ...c.add, userId: c.userId, tag: '', notes: '', published: false }), t('ratings.added', { name: c.name })).then((r) => r && onClose());
  const swap = (c) => run(() => call('shifts.save', { ...c.swap.shift, userId: c.userId }), t('ratings.swapped', { name: c.name })).then((r) => r && onClose());
  return (
    <Modal title={t('ratings.suggestTitle')} sub={`${prettyDate(fix.date)} · ${ruleLabel(fix.rule, { t, jobs })}`} onClose={onClose}
      footer={<><span className="small muted" style={{ flex: 1 }}>{t('ratings.draftsOnly')}</span><button className="btn" onClick={onClose}>{t('common.done')}</button></>}>
      <div className="small rt-why" style={{ marginBottom: 8 }}><Icon name="alert" size={12} /> {resultText(fix.res, fix.rule, t)}</div>
      {!list ? <div className="muted">{t('common.loading')}</div> : !list.candidates.length ? <div className="muted">{t('ratings.noCandidates')}</div> : (
        <div className="list">
          {list.candidates.map((c) => (
            <div key={c.userId} className="list-item rt-cand">
              <div style={{ flex: 1, minWidth: 140 }}>
                <b>{c.name}</b> <span className="badge ok">{ratingText(c.rating, scale, t)}</span>
                <div className="small muted">{t('ratings.weekHours', { hours: num(c.weekHours) })}{c.add ? ` · ${fmtTime(c.add.start)}${c.add.end ? `–${fmtTime(c.add.end)}` : ''}${c.add.area ? ` · ${c.add.area}` : ''}` : ''}
                  {c.warnings.map((w) => <span key={w} className="badge warn" style={{ marginLeft: 6 }}>{t(`ratings.warn_${w}`)}</span>)}</div>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {c.add && <button className="btn sm primary" disabled={busy} onClick={() => add(c)}><Icon name="plus" size={14} />{t('ratings.addDraft')}</button>}
                {c.swap && <button className="btn sm" disabled={busy} onClick={() => swap(c)}><Icon name="swap" size={14} />{t('ratings.swapWith', { name: c.swap.name })}</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** In the Publish dialog, next to the staffing check: failing rules as a warning (never blocks publishing). */
export function SkillMixCheck({ ws }) {
  const t = useT();
  const { jobs } = useApp();
  const { data } = useSkillMix(ws);
  if (!data?.failing) return null;
  const rules = Object.fromEntries(data.rules.map((r) => [r.id, r]));
  return (
    <div className="alert warn rt-publish">
      <Icon name="alert" size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{t('ratings.publishWarn', { count: data.failing })}</b>
        <ul className="small">
          {data.days.filter((d) => d.failing).map((d) => (
            <li key={d.date}>{prettyDate(d.date)}: {d.results.filter((x) => x.status === 'fail').map((x) => `${ruleLabel({ ...rules[x.ruleId], days: [] }, { t, jobs })} (${resultText(x, rules[x.ruleId], t)})`).join('; ')}</li>
          ))}
        </ul>
        <div className="small">{t('ratings.publishWarnHelp')}</div>
      </div>
    </div>
  );
}
