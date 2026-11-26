// Settings → Seasons (admins): the months of each season reports count by (core/seasons.js). Every month has to
// be in exactly one season; the server checks it again (seasons.save, validated through seasonsOf).
import React, { useState } from 'react';
import { useApp, Icon, useAction } from '../ui.jsx';
import { seasonsOf, seasonOf, DEFAULT_SEASONS } from '../../../core/seasons.js';
import { validSeasons } from '../../../core/trade-stats.js';
import { useT, monthLong, prettyDate } from '../i18n/index.js';
import '../reports.css';

const KEYS = ['winter', 'spring', 'summer', 'fall'];

export default function SeasonsCard() {
  const t = useT();
  const { settings, call, today, isAdmin } = useApp();
  const [list, setList] = useState(() => seasonsOf(settings).map((s) => ({ ...s })));
  const [run, busy] = useAction();
  if (!isAdmin) return null;
  const set = (i, k, v) => setList(list.map((s, j) => (j === i ? { ...s, [k]: k.endsWith('Month') ? Number(v) : v } : s)));
  const clean = validSeasons(list);
  const now = clean ? seasonOf(today, { seasons: clean }, t.lang) : null;
  const free = KEYS.filter((k) => !list.some((s) => s.key === k));
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  return (
    <div className="card card-pad col" style={{ gap: 12 }}>
      <h2>{t('seasons.title')}</h2>
      <div className="help">{t('seasons.help')}</div>
      <div>
        {list.map((s, i) => (
          <div key={i} className="season-row">
            <label className="field"><span>{t('seasons.season')}</span>
              <select className="input" value={s.key} onChange={(e) => set(i, 'key', e.target.value)}>
                {KEYS.filter((k) => k === s.key || !list.some((x) => x.key === k)).map((k) => <option key={k} value={k}>{t(`seasons.key_${k}`)}</option>)}
              </select>
            </label>
            <label className="field season-label"><span>{t('seasons.label')}</span>
              <input className="input" value={s.label || ''} maxLength={40} placeholder={t(`seasons.key_${s.key}`)} onChange={(e) => set(i, 'label', e.target.value)} />
            </label>
            <label className="field"><span>{t('seasons.starts')}</span>
              <select className="input" value={s.startMonth} onChange={(e) => set(i, 'startMonth', e.target.value)}>{months.map((m) => <option key={m} value={m}>{monthLong(m - 1)}</option>)}</select>
            </label>
            <label className="field"><span>{t('seasons.ends')}</span>
              <select className="input" value={s.endMonth} onChange={(e) => set(i, 'endMonth', e.target.value)}>{months.map((m) => <option key={m} value={m}>{monthLong(m - 1)}</option>)}</select>
            </label>
            <button className="btn sm ghost season-x" disabled={list.length <= 1} onClick={() => setList(list.filter((_, j) => j !== i))} aria-label={t('seasons.remove')}><Icon name="trash" /><span className="mobile-only">{t('seasons.remove')}</span></button>
          </div>
        ))}
      </div>
      {clean ? <div className="alert ok"><Icon name="check" size={16} />{t('seasons.now', { label: now.label, start: prettyDate(now.start, { dow: false }), end: prettyDate(now.end, { dow: false }) })}</div>
        : <div className="alert warn"><Icon name="alert" size={16} />{t('seasons.invalid')}</div>}
      <div className="row wrap">
        {free.length > 0 && list.length < 4 && <button className="btn sm" onClick={() => setList([...list, { key: free[0], label: '', startMonth: 1, endMonth: 1 }])}><Icon name="plus" />{t('seasons.add')}</button>}
        <button className="btn sm ghost" onClick={() => setList(DEFAULT_SEASONS.map((s) => ({ ...s, label: '' })))}>{t('seasons.reset')}</button>
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !clean} onClick={() => run(() => call('seasons.save', { seasons: list }), t('seasons.saved'))}>{t('seasons.save')}</button>
      </div>
    </div>
  );
}
