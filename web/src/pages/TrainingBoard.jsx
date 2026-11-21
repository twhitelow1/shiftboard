// Leaderboard: who knows the menu, filtered by position, department and area. Managers (and each person, for
// themself) open a person to see their weak sections and items. UI words are in training-strings.js.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Avatar, Empty } from '../ui.jsx';
import { categoryLabel } from '../../../core/training.js';
import { TIcon, useT, useLang, fmtDay, pct } from './TrainingShared.jsx';

const SORTS = ['best', 'avg', 'passed', 'mastered'];

export function Leaderboard() {
  const { call, version, isMgr, jobs, me } = useApp();
  const t = useT();
  const [filters, setFilters] = useState({ jobCodeId: '', department: '', area: '', sort: 'best' });
  const [data, setData] = useState(null);
  const [person, setPerson] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [openFilters, setOpenFilters] = useState(false);
  useEffect(() => { call('leaderboard.get', filters).then(setData); }, [version, filters]);
  if (!data) return <div className="empty">{t.loading}</div>;
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const canOpen = (userId) => isMgr || userId === me.id;
  const positions = (ids) => ids.map((id) => jobs[id]?.name).filter(Boolean).join(', ');

  if (!data.visible) {
    return (
      <div className="col" style={{ gap: 12 }}>
        <div className="alert info"><TIcon name="lock" />{t.boardManagersOnly}</div>
        <MyStats row={data.me} onOpen={() => setPerson(me.id)} />
        {person && <PersonDetail userId={person} onClose={() => setPerson(null)} />}
      </div>
    );
  }
  const rows = showAll ? data.rows : data.rows.slice(0, 50);
  const active = ['jobCodeId', 'department', 'area'].filter((k) => filters[k]).length;
  return (
    <div>
      <div className="tr-board-bar">
        <select className="input" value={filters.sort} onChange={set('sort')} aria-label={t.sortBy}>
          {SORTS.map((k) => <option key={k} value={k}>{t.sortBy}: {t.sorts[k]}</option>)}
        </select>
        <button type="button" className={`btn ${active ? 'primary' : ''}`} onClick={() => setOpenFilters(!openFilters)} aria-expanded={openFilters || !!active}>
          <TIcon name="filter" />{t.filters}{active ? ` (${active})` : ''}
        </button>
      </div>
      {(openFilters || active > 0) && <div className="tr-board-filters">
        <select className="input" value={filters.jobCodeId} onChange={set('jobCodeId')} aria-label={t.position}>
          <option value="">{t.allPositions}</option>
          {data.filters.jobCodes.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
        <select className="input" value={filters.department} onChange={set('department')} aria-label={t.department}>
          <option value="">{t.allDepartments}</option>
          {data.filters.departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {data.filters.areas.length > 0 && (
          <select className="input" value={filters.area} onChange={set('area')} aria-label={t.area}>
            <option value="">{t.allAreas}</option>
            {data.filters.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>}

      {data.me && data.rows.some((r) => r.userId === me.id) && <MyStats row={data.rows.find((r) => r.userId === me.id)} onOpen={() => setPerson(me.id)} />}

      {!data.rows.length ? <div className="card"><Empty icon="star" title={t.noScoresYet}>{t.noScoresHelp}</Empty></div> : (
        <div className="card list tr-board">
          {rows.map((r) => (
            <button key={r.userId} type="button" className={`tr-board-row ${r.userId === me.id ? 'me' : ''}`} disabled={!canOpen(r.userId)} onClick={() => setPerson(r.userId)}>
              <span className={`tr-rank r${r.rank <= 3 ? r.rank : ''}`}>{r.rank}</span>
              <Avatar user={{ id: r.userId, name: r.name, color: r.color }} size="sm" />
              <span className="tr-board-who">
                <span className="tr-board-name">{r.name}</span>
                <span className="tiny muted">{positions(r.positions)}</span>
              </span>
              <span className="tr-board-main num">{filters.sort === 'passed' ? r.passed : filters.sort === 'mastered' ? r.mastered : pct(filters.sort === 'avg' ? r.avg : r.best)}</span>
              <span className="tr-board-rest tiny muted">
                {filters.sort !== 'best' && <span>{t.sortsShort.best} {pct(r.best)}</span>}
                {filters.sort !== 'avg' && <span>{t.sortsShort.avg} {pct(r.avg)}</span>}
                {filters.sort !== 'passed' && <span>{t.sortsShort.passed} {r.passed}</span>}
                {filters.sort !== 'mastered' && <span>{t.sortsShort.mastered} {r.mastered}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {data.rows.length > 50 && !showAll && <button className="btn sm ghost" onClick={() => setShowAll(true)}>{t.showAll(data.rows.length)}</button>}
      <div className="help" style={{ margin: '8px 2px' }}>{t.boardHelp(data.mastery.answers, data.mastery.pct)}</div>

      {isMgr && data.notStarted?.length > 0 && (
        <details className="card card-pad tr-notstarted">
          <summary><b>{t.notStarted(data.notStarted.length)}</b></summary>
          <div className="small muted" style={{ marginTop: 6 }}>{data.notStarted.map((p) => p.name).join(', ')}</div>
        </details>
      )}
      {person && <PersonDetail userId={person} onClose={() => setPerson(null)} />}
    </div>
  );
}

function MyStats({ row, onOpen }) {
  const t = useT();
  if (!row) return null;
  return (
    <button type="button" className="card tr-mystats" onClick={onOpen}>
      <div className="tr-kicker">{row.rank ? t.youRank(row.rank) : t.you}</div>
      <div className="tr-tiles">
        <Tile label={t.sorts.best} value={pct(row.best)} />
        <Tile label={t.sorts.avg} value={pct(row.avg)} />
        <Tile label={t.sorts.passed} value={row.passed} />
        <Tile label={t.sorts.mastered} value={row.mastered} />
      </div>
      <span className="small tr-link">{t.seeStrongWeak}<Icon name="right" size={14} /></span>
    </button>
  );
}
const Tile = ({ label, value }) => <div className="tr-tile"><div className="tr-tile-v num">{value}</div><div className="tr-tile-l">{label}</div></div>;

/** One person's numbers, weakest sections and items first, quiz history and assigned quizzes. */
function PersonDetail({ userId, onClose }) {
  const { call, jobs } = useApp();
  const t = useT();
  const lang = useLang();
  const [d, setD] = useState(null);
  const [cats, setCats] = useState({});
  useEffect(() => {
    call('leaderboard.person.get', { userId }).then(setD);
    call('menu.list').then((m) => setCats(m.categoryEs || {})).catch(() => {});
  }, [userId]);
  return (
    <Modal wide title={d?.user.name || t.loading} sub={d ? d.user.positions.map((id) => jobs[id]?.name).filter(Boolean).join(', ') : ''} onClose={onClose}>
      {!d ? <div className="empty">{t.loading}</div> : <>
        <div className="tr-tiles">
          <Tile label={t.sorts.best} value={pct(d.stats.best)} />
          <Tile label={t.sorts.avg} value={pct(d.stats.avg)} />
          <Tile label={t.sorts.passed} value={d.stats.passed} />
          <Tile label={t.sorts.mastered} value={d.stats.mastered} />
        </div>
        {!d.attempts.length && <div className="help">{t.noQuizzesTaken}</div>}
        {d.categories.length > 0 && (
          <div>
            <div className="tr-kicker">{t.bySection}</div>
            {d.categories.map((c) => <Bar key={c.category} label={categoryLabel(c.category, lang, cats)} value={c.pct} note={t.nRight(c.correct, c.answered)} />)}
          </div>
        )}
        {d.items.length > 0 && (
          <div>
            <div className="tr-kicker">{t.byItem}</div>
            {d.items.map((it) => <Bar key={it.itemId} label={it.name} value={it.pct} note={t.nRight(it.correct, it.answered)} badge={it.mastered ? t.masteredBadge : ''} />)}
          </div>
        )}
        {d.assigned.length > 0 && (
          <div>
            <div className="tr-kicker">{t.assignedQuizzes}</div>
            <ul className="tr-plain">{d.assigned.map((q) => <li key={q.id}>{q.passed ? <span className="badge ok">{t.passed}</span> : <span className="badge warn">{t.notYet}</span>} {q.title}{q.dueDate ? ` · ${t.due(fmtDay(q.dueDate, lang))}` : ''}</li>)}</ul>
          </div>
        )}
        {d.attempts.length > 0 && (
          <div>
            <div className="tr-kicker">{t.quizHistory}</div>
            <div className="list">
              {d.attempts.map((a) => (
                <a key={a.id} className="list-item click tr-plainlink" href={`#/training/quiz/${a.id}`} onClick={onClose}>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{a.title}</div><div className="small muted">{fmtDay(a.submittedAt, lang)}</div></div>
                  <span className={`badge ${a.passed ? 'ok' : 'bad'} num`}>{pct(a.pct)}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </>}
    </Modal>
  );
}

function Bar({ label, value, note, badge }) {
  return (
    <div className="tr-bar">
      <div className="tr-bar-top"><span className="tr-bar-label">{label}{badge && <span className="badge ok" style={{ marginLeft: 6 }}>{badge}</span>}</span><span className="small muted num">{note} · {value}%</span></div>
      <div className={`progress ${value < 70 ? 'low' : ''}`}><div style={{ width: `${Math.max(3, value)}%` }} /></div>
    </div>
  );
}
