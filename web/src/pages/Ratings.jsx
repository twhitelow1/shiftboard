import React, { useEffect, useMemo, useState } from 'react';
import { useApp, Icon, Modal, Field, useAction, JobDot } from '../ui.jsx';
import { useT, dowShort, stampDay } from '../i18n/index.js';
import '../ratings.css';

// Ratings and skill-mix rules (core/ratings.js): Settings → Ratings (the scale, the rules, the bulk grid) and the Ratings
// box in Team → person. Managers only (the ratingsView role feature); the server refuses everyone else, and none of this
// reaches staff anywhere. Level names, positions and rooms are the restaurant's and stay as typed.

const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "5 · Lead", "3", or "Unrated". */
export function ratingText(v, scale, t) {
  if (v == null) return t('ratings.unrated');
  const name = scale?.labels?.[v];
  return name ? `${v} · ${name}` : String(v);
}
const levels = (scale) => Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.max - i);

/** A rule in words: "Server · Fri, Sat · Dinner: at least 2 rated 5+". */
export function ruleLabel(r, { t, jobs, programming = [] }) {
  const when = [r.days?.length ? r.days.map((d) => dowShort(d)).join(', ') : '', r.daypart, r.room, programming.find((p) => p.id === r.programmingId)?.name].filter(Boolean).join(' · ');
  const what = r.type === 'atLeast' ? t('ratings.ruleAtLeast', { count: r.count, rating: r.rating }) : r.type === 'atMost' ? t('ratings.ruleAtMost', { count: r.count, rating: r.rating }) : t('ratings.ruleMinAvg', { avg: r.avg });
  return `${jobs[r.jobCodeId]?.name || ''}${when ? ` · ${when}` : ''}: ${what}`;
}

export function RatingsCard() {
  const t = useT();
  const { has } = useApp();
  if (!has('ratingsView')) return null;
  return (
    <div className="card card-pad col" style={{ gap: 8 }}>
      <h2>{t('ratings.title')}</h2>
      <div className="help" style={{ margin: 0 }}>{t('ratings.cardHelp')}</div>
      <div><a className="btn sm" href="#/settings/ratings"><Icon name="star" />{t('ratings.open')}</a></div>
    </div>
  );
}

/** Settings → Ratings. */
export default function Ratings() {
  const t = useT();
  const { call, version } = useApp();
  const [grid, setGrid] = useState(null);
  const [rules, setRules] = useState(null);
  const load = () => {
    call('ratings.get').then(setGrid).catch(() => setGrid(false));
    call('skillRules.list').then(setRules).catch(() => setRules(false));
  };
  useEffect(load, [version]);
  if (grid === null || rules === null) return <div className="empty">{t('common.loading')}</div>;
  if (!grid) return <div className="empty">{t('roles.notForRole')}</div>;
  return (
    <div style={{ maxWidth: 1000 }} className="col ratings-page">
      <div className="alert info"><Icon name="lock" size={16} /><span>{t('ratings.confidential')}</span></div>
      <ScaleCard data={grid} onSaved={load} />
      <RulesCard data={rules} onSaved={load} />
      <RatingsGrid scale={grid.scale} canEdit={grid.canEdit} />
    </div>
  );
}

function ScaleCard({ data, onSaved }) {
  const t = useT();
  const { call } = useApp();
  const [run, busy] = useAction();
  const [s, setS] = useState(data.scale);
  useEffect(() => setS(data.scale), [data.scale.min, data.scale.max, JSON.stringify(data.scale.labels)]);
  const min = Number(s.min), max = Number(s.max);
  const ok = Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max <= 10 && max > min;
  const save = async () => {
    if ((min !== data.scale.min || max !== data.scale.max) && !window.confirm(t('ratings.confirmRemap', { from: `${data.scale.min}–${data.scale.max}`, to: `${min}–${max}` }))) return;
    const r = await run(() => call('ratings.scale.save', { min, max, labels: s.labels }), (x) => (x.remapped ? t('ratings.scaleRemapped', { count: x.remapped }) : t('ratings.scaleSaved')));
    if (r) onSaved();
  };
  return (
    <div className="card card-pad col" style={{ gap: 10 }}>
      <h2>{t('ratings.scale')}</h2>
      <div className="help" style={{ margin: 0 }}>{t('ratings.scaleHelp')}</div>
      <fieldset disabled={!data.canScale} style={{ border: 0, padding: 0, margin: 0 }} className="col">
        <div className="row wrap" style={{ gap: 10 }}>
          <Field label={t('ratings.min')}><input className="input" type="number" min={0} max={9} value={s.min} onChange={(e) => setS({ ...s, min: e.target.value })} style={{ width: 90 }} /></Field>
          <Field label={t('ratings.max')}><input className="input" type="number" min={1} max={10} value={s.max} onChange={(e) => setS({ ...s, max: e.target.value })} style={{ width: 90 }} /></Field>
        </div>
        {ok && (
          <Field label={t('ratings.levelNames')}>
            <div className="rt-levels">
              {levels({ min, max }).map((v) => (
                <label key={v} className="row" style={{ gap: 6 }}><b className="rt-num">{v}</b>
                  <input className="input sm" maxLength={24} placeholder={v === max ? t('ratings.levelPlaceholder') : ''} value={s.labels?.[v] || ''}
                    onChange={(e) => setS({ ...s, labels: { ...(s.labels || {}), [v]: e.target.value } })} /></label>
              ))}
            </div>
          </Field>
        )}
        {data.canScale && <div><button className="btn primary sm" disabled={busy || !ok} onClick={save}>{t('ratings.saveScale')}</button></div>}
      </fieldset>
      {!data.canScale && <div className="help"><Icon name="lock" size={12} /> {t('ratings.scaleAdmins')}</div>}
    </div>
  );
}

function RulesCard({ data, onSaved }) {
  const t = useT();
  const { call, jobs } = useApp();
  const [run, busy] = useAction();
  const [edit, setEdit] = useState(null);
  if (!data) return null;
  const toggle = (r) => run(() => call('skillRules.save', { ...r, active: r.active === false }), t('ratings.ruleSaved')).then((x) => x && onSaved());
  return (
    <div className="card section">
      <div className="card-head row wrap">
        <h2 style={{ flex: 1 }}>{t('ratings.rules')}</h2>
        {data.canEdit && <button className="btn sm primary" onClick={() => setEdit({ jobCodeId: '', type: 'atLeast', count: 2, rating: data.scale.max, avg: data.scale.max - 1, days: [], daypart: '', room: '', programmingId: '', active: true })}><Icon name="plus" />{t('ratings.addRule')}</button>}
      </div>
      <div className="card-pad help" style={{ paddingTop: 0 }}>{t('ratings.rulesHelp')}</div>
      {!data.rules.length ? <div className="card-pad muted small">{t('ratings.noRules')}</div> : (
        <div className="list">
          {data.rules.map((r) => (
            <div key={r.id} className={`list-item rt-rule ${r.active === false ? 'off' : ''}`}>
              <JobDot job={jobs[r.jobCodeId]} />
              <span style={{ flex: 1, minWidth: 0 }}>{ruleLabel(r, { t, jobs, programming: data.programming })}{r.note ? <span className="muted small"> · {r.note}</span> : null}</span>
              {data.canEdit && <>
                <label className="check small"><input type="checkbox" role="switch" checked={r.active !== false} disabled={busy} onChange={() => toggle(r)} />{r.active === false ? t('ratings.off') : t('ratings.on')}</label>
                <button className="btn sm ghost" aria-label={t('ratings.editRule')} onClick={() => setEdit(r)}><Icon name="edit" size={14} /></button>
              </>}
            </div>
          ))}
        </div>
      )}
      {edit && <RuleDialog rule={edit} data={data} onClose={(changed) => { setEdit(null); if (changed) onSaved(); }} />}
    </div>
  );
}

function RuleDialog({ rule, data, onClose }) {
  const t = useT();
  const { call, jobCodes } = useApp();
  const [run, busy] = useAction();
  const [r, setR] = useState(rule);
  const set = (k) => (e) => setR({ ...r, [k]: e.target.value });
  const toggleDay = (d) => setR({ ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d] });
  const lv = levels(data.scale);
  const save = async () => {
    const out = await run(() => call('skillRules.save', { ...r, count: Number(r.count), rating: Number(r.rating), avg: Number(r.avg) }), t('ratings.ruleSaved'));
    if (out) onClose(true);
  };
  const del = async () => { if (await run(() => call('skillRules.delete', { id: r.id }), t('ratings.ruleDeleted'))) onClose(true); };
  return (
    <Modal title={r.id ? t('ratings.editRule') : t('ratings.addRule')} onClose={() => onClose(false)}
      footer={<>{r.id && <button className="btn danger" disabled={busy} onClick={del}><Icon name="trash" />{t('ratings.deleteRule')}</button>}<span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !r.jobCodeId} onClick={save}>{t('common.save')}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="grid2">
          <Field label={t('ratings.position')}>
            <select className="input" value={r.jobCodeId} onChange={set('jobCodeId')}>
              <option value="">—</option>
              {jobCodes.filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </Field>
          <Field label={t('ratings.kind')}>
            <select className="input" value={r.type} onChange={set('type')}>
              {['atLeast', 'atMost', 'minAvg'].map((k) => <option key={k} value={k}>{t(`ratings.type_${k}`)}</option>)}
            </select>
          </Field>
          {r.type !== 'minAvg' ? <>
            <Field label={t('ratings.count')}><input className="input" type="number" min={0} max={50} value={r.count ?? ''} onChange={set('count')} /></Field>
            <Field label={t('ratings.rating')}>
              <select className="input" value={r.rating ?? ''} onChange={set('rating')}>{lv.map((v) => <option key={v} value={v}>{ratingText(v, data.scale, t)}</option>)}</select>
            </Field>
          </> : <Field label={t('ratings.avg')}><input className="input" type="number" step="0.1" min={data.scale.min} max={data.scale.max} value={r.avg ?? ''} onChange={set('avg')} /></Field>}
        </div>
        <Field label={t('ratings.days')}>
          <div className="row wrap" style={{ gap: 6 }}>
            {ORDER.map((d) => <button key={d} type="button" className={`btn sm ${r.days.includes(d) ? 'primary' : ''}`} aria-pressed={r.days.includes(d)} onClick={() => toggleDay(d)}>{dowShort(d)}</button>)}
            {!r.days.length && <span className="muted small">{t('ratings.everyDay')}</span>}
          </div>
        </Field>
        <div className="grid2">
          <Field label={t('ratings.daypart')}>
            <select className="input" value={r.daypart || ''} onChange={set('daypart')}><option value="">{t('ratings.wholeDay')}</option>{data.dayparts.map((d) => <option key={d} value={d}>{d}</option>)}</select>
          </Field>
          <Field label={t('ratings.room')}>
            <select className="input" value={r.room || ''} onChange={set('room')}><option value="">{t('ratings.anyRoom')}</option>{data.rooms.map((x) => <option key={x} value={x}>{x}</option>)}</select>
          </Field>
        </div>
        {data.programming.length > 0 && (
          <Field label={t('ratings.programming')} help={t('ratings.programmingHelp')}>
            <select className="input" value={r.programmingId || ''} onChange={set('programmingId')}><option value="">{t('ratings.noProgramming')}</option>{data.programming.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
        )}
        <Field label={t('ratings.note')}><input className="input" maxLength={120} value={r.note || ''} onChange={set('note')} /></Field>
      </div>
    </Modal>
  );
}

/** The bulk grid: people × positions, filtered by position and room. */
function RatingsGrid({ scale, canEdit }) {
  const t = useT();
  const { call, jobs, version } = useApp();
  const [run, busy] = useAction();
  const [job, setJob] = useState('');
  const [room, setRoom] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [person, setPerson] = useState(null);
  useEffect(() => { call('ratings.get', { jobCodeId: job, room }).then(setData).catch(() => setData(null)); }, [job, room, version]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (!data) return null;
  const cols = data.positions;
  const changes = Object.entries(draft).filter(([k, v]) => { const [u, j] = k.split('|'); return (data.rows.find((r) => r.userId === u)?.ratings[j] ?? null) !== v; });
  const save = async () => {
    const r = await run(() => call('ratings.setMany', { changes: changes.map(([k, value]) => { const [userId, jobCodeId] = k.split('|'); return { userId, jobCodeId, value }; }) }), t('ratings.saved'));
    if (r) setDraft({});
  };
  return (
    <div className="card section">
      <div className="card-head row wrap">
        <h2 style={{ flex: 1 }}>{t('ratings.grid')}</h2>
        {canEdit && changes.length > 0 && <button className="btn sm primary" disabled={busy} onClick={save}><Icon name="check" />{t('ratings.saveChanges', { count: changes.length })}</button>}
      </div>
      <div className="card-pad col" style={{ gap: 8, paddingTop: 0 }}>
        <div className="help" style={{ margin: 0 }}>{t('ratings.gridHelp')}</div>
        <div className="toolbar" style={{ margin: 0 }}>
          <input className="input" style={{ maxWidth: 180 }} placeholder={t('ratings.searchName')} value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ maxWidth: 180 }} value={job} onChange={(e) => setJob(e.target.value)} aria-label={t('ratings.position')}>
            <option value="">{t('ratings.allPositions')}</option>
            {Object.values(jobs).filter((j) => !j.archived).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 180 }} value={room} onChange={(e) => setRoom(e.target.value)} aria-label={t('ratings.room')}>
            <option value="">{t('ratings.allRooms')}</option>
            {data.rooms.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      </div>
      {!rows.length ? <div className="card-pad muted small">{t('ratings.noPeople')}</div> : (
        <div className="table-wrap rt-grid">
          <table className="table">
            <thead><tr><th>{t('common.name')}</th>{cols.map((id) => <th key={id} style={{ textAlign: 'center' }}><span className="row" style={{ gap: 4, justifyContent: 'center' }}><JobDot job={jobs[id]} />{jobs[id]?.short || jobs[id]?.name}</span></th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td style={{ whiteSpace: 'nowrap' }}><button className="rt-name" onClick={() => setPerson(r)}>{r.name}</button></td>
                  {cols.map((id) => {
                    if (!r.jobCodeIds.includes(id)) return <td key={id} className="muted" style={{ textAlign: 'center' }}>·</td>;
                    const k = `${r.userId}|${id}`;
                    const v = k in draft ? draft[k] : r.ratings[id];
                    return (
                      <td key={id} style={{ textAlign: 'center' }}>
                        <select className={`input sm rt-cell ${v == null ? 'none' : ''} ${k in draft && draft[k] !== r.ratings[id] ? 'changed' : ''}`} disabled={!canEdit} value={v ?? ''}
                          aria-label={`${r.name} · ${jobs[id]?.name}`} onChange={(e) => setDraft({ ...draft, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                          <option value="">—</option>
                          {levels(scale).map((x) => <option key={x} value={x}>{scale.labels?.[x] ? `${x} ${scale.labels[x]}` : x}</option>)}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {person && (
        <Modal title={person.name} sub={t('ratings.personHelp')} onClose={() => setPerson(null)} footer={<><span className="spacer" /><button className="btn" onClick={() => setPerson(null)}>{t('common.done')}</button></>}>
          <PersonRatings person={{ id: person.userId, name: person.name }} bare />
        </Modal>
      )}
    </div>
  );
}

/** Team → person: their rating per position (managers only), with the history and, for reference, training scores and kudos. */
export function PersonRatings({ person, bare = false }) {
  const t = useT();
  const { call, has, me, jobs, version } = useApp();
  const [run, busy] = useAction();
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});
  const [open, setOpen] = useState(null);
  const ok = has('ratingsView') && person?.id && person.id !== me.id;
  useEffect(() => { if (ok) call('ratings.person.get', { userId: person.id }).then(setData).catch(() => setData(null)); }, [person?.id, version, ok]);
  if (!ok || !data) return null;
  const set = (jobCodeId, value) => run(() => call('ratings.set', { userId: person.id, jobCodeId, value, note: notes[jobCodeId] || '' }), t('ratings.saved'))
    .then((r) => r && setNotes({ ...notes, [jobCodeId]: '' }));
  const body = (
    <div className="col" style={{ gap: 8 }}>
      {!data.positions.length && <div className="muted small">{t('ratings.noPositions')}</div>}
      {data.positions.map((p) => (
        <div key={p.jobCodeId} className="rt-person-row">
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 6, flex: 1, minWidth: 120 }}><JobDot job={jobs[p.jobCodeId]} /><b>{jobs[p.jobCodeId]?.name}</b></span>
            <select className={`input sm rt-cell ${p.value == null ? 'none' : ''}`} disabled={!data.canEdit || busy} value={p.value ?? ''} aria-label={`${t('ratings.rating')} · ${jobs[p.jobCodeId]?.name}`}
              onChange={(e) => set(p.jobCodeId, e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">{t('ratings.unrated')}</option>
              {levels(data.scale).map((x) => <option key={x} value={x}>{ratingText(x, data.scale, t)}</option>)}
            </select>
            <button className="btn sm ghost" onClick={() => setOpen(open === p.jobCodeId ? null : p.jobCodeId)} aria-expanded={open === p.jobCodeId}><Icon name="clock" size={14} />{t('ratings.history')}</button>
          </div>
          {data.canEdit && <input className="input sm" style={{ marginTop: 6 }} maxLength={200} placeholder={t('ratings.notePlaceholder')} value={notes[p.jobCodeId] || ''} onChange={(e) => setNotes({ ...notes, [p.jobCodeId]: e.target.value })} />}
          <div className="small muted rt-ref">
            <b>{t('ratings.forReference')}:</b>{' '}
            {p.signals.quiz || p.signals.kudos ? [p.signals.quiz && t('ratings.quizRef', { pct: p.signals.quiz.avgPct, count: p.signals.quiz.attempts }), p.signals.kudos && t('ratings.kudosRef', { count: p.signals.kudos.count })].filter(Boolean).join(' · ') : t('ratings.noSignals')}
          </div>
          {open === p.jobCodeId && (
            <ul className="small rt-history">
              {!p.history.length && <li className="muted">{t('ratings.noHistory')}</li>}
              {p.history.map((h, i) => (
                <li key={i}>{stampDay(h.at)}: {ratingText(h.from, data.scale, t)} → <b>{ratingText(h.to, data.scale, t)}</b> {t('ratings.historyBy', { by: h.byName || '—' })}
                  {h.source === 'scale' ? ` (${t('ratings.scaleChange')})` : ''}{h.note && h.source !== 'scale' ? ` · “${h.note}”` : ''}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
  if (bare) return body;
  return (
    <div className="card card-pad col rt-person" style={{ gap: 8 }}>
      <div className="row"><b style={{ flex: 1 }}><Icon name="star" size={14} /> {t('ratings.title')}</b><span className="badge"><Icon name="lock" size={12} /></span></div>
      <div className="help" style={{ margin: 0 }}>{t('ratings.personHelp')}</div>
      {body}
    </div>
  );
}
