// Training: the menu study guide, quizzes, the leaderboard and the employee manual, with the manager on duty
// at the top. Routes: #/training/menu | study | quizzes | quiz/<attemptId> | board | manual | manual/<pageId>
import React, { useEffect, useState } from 'react';
import { useApp } from '../ui.jsx';
import { ModCard, TIcon, useT } from './TrainingShared.jsx';
import { MenuGuide, StudyMode } from './TrainingMenu.jsx';
import { QuizList, QuizTake } from './TrainingQuiz.jsx';
import { Leaderboard } from './TrainingBoard.jsx';
import { Manual, ManualPage } from './TrainingManual.jsx';

const TABS = [
  { key: 'menu', icon: 'book' },
  { key: 'quizzes', icon: 'quiz' },
  { key: 'board', icon: 'trophy' },
  { key: 'manual', icon: 'cards' },
];

export default function Training({ parts = [] }) {
  const t = useT();
  const tab = parts[1] || 'menu';
  if (tab === 'quiz' && parts[2]) return <div className="tr"><QuizTake attemptId={parts[2]} /></div>;
  if (tab === 'study') return <div className="tr"><StudyMode /></div>;
  if (tab === 'manual' && parts[2]) return <div className="tr"><ManualPage id={parts[2]} /></div>;
  const current = TABS.some((x) => x.key === tab) ? tab : 'menu';
  return (
    <div className="tr">
      <div className="tr-top">
        <ModCard />
        <ToDo />
      </div>
      <div className="tabs tr-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.key} role="tab" aria-selected={current === x.key} className={current === x.key ? 'on' : ''} onClick={() => { location.hash = `#/training/${x.key}`; }}>
            <TIcon name={x.icon} />{t.tabs[x.key]}
          </button>
        ))}
      </div>
      {current === 'menu' && <MenuGuide />}
      {current === 'quizzes' && <QuizList />}
      {current === 'board' && <Leaderboard />}
      {current === 'manual' && <Manual />}
    </div>
  );
}

/** What's waiting for me: quizzes assigned to my position that I haven't passed, manual pages to read. */
function ToDo() {
  const { call, version } = useApp();
  const t = useT();
  const [s, setS] = useState(null);
  useEffect(() => { call('training.summary').then(setS).catch(() => {}); }, [version]);
  if (!s || (!s.quizzes.length && !s.pages.length)) return null;
  const overdue = s.quizzes.filter((q) => q.overdue).length;
  return (
    <div className="card tr-todo">
      <div className="tr-kicker">{t.toDo}</div>
      <div className="row wrap" style={{ gap: 6 }}>
        {s.quizzes.length > 0 && <a className={`badge ${overdue ? 'bad' : 'warn'}`} href="#/training/quizzes"><TIcon name="quiz" size={13} />{t.quizzesToDo(s.quizzes.length)}{overdue ? ` · ${t.overdueN(overdue)}` : ''}</a>}
        {s.pages.length > 0 && <a className="badge brand" href={s.pages.length === 1 ? `#/training/manual/${s.pages[0].id}` : '#/training/manual'}><TIcon name="cards" size={13} />{t.pagesToRead(s.pages.length)}</a>}
      </div>
    </div>
  );
}
