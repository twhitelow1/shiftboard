// Quizzes: the list (assigned first), taking one on a phone, the results with the right answers, your
// history, and (managers) the quiz and question editors. Answers are checked on the server; the app never
// gets them before you answer. UI words are in training-strings.js.
import React, { useEffect, useState } from 'react';
import { useApp, Icon, Modal, Field, Empty, useAction } from '../ui.jsx';
import { localize, localizeItem, categoryLabel, QUESTION_TYPES } from '../../../core/training.js';
import { Photo, TIcon, Chips, LangTabs, useT, useLang, fmtDay, pct } from './TrainingShared.jsx';

export function QuizList() {
  const { call, version, isMgr, jobs, today } = useApp();
  const t = useT();
  const lang = useLang();
  const [list, setList] = useState(null);
  const [history, setHistory] = useState(null);
  const [editing, setEditing] = useState(null);
  const [questions, setQuestions] = useState(false);
  const [run, busy] = useAction();
  const load = () => { call('quiz.list').then(setList); call('quiz.attempts.list').then(setHistory); };
  useEffect(load, [version]);
  const start = async (q, fresh) => {
    const att = await run(() => call('quiz.start', { quizId: q.id, fresh }));
    if (att) location.hash = `#/training/quiz/${att.id}`;
  };
  if (!list) return <div className="empty">{t.loading}</div>;
  const shown = list.map((q) => ({ ...q, ...localize(q, lang) }));
  return (
    <div>
      {isMgr && (
        <div className="tr-toolbar">
          <span className="spacer" />
          <button className="btn" onClick={() => setQuestions(true)}><TIcon name="quiz" />{t.ownQuestions}</button>
          <button className="btn primary" onClick={() => setEditing({})}><Icon name="plus" />{t.newQuiz}</button>
        </div>
      )}
      {!shown.length && <div className="card"><Empty icon="star" title={t.noQuizzes}>{isMgr ? t.noQuizzesMgr : ''}</Empty></div>}
      <div className="tr-quizzes">
        {shown.map((q) => (
          <div key={q.id} className={`card tr-quiz ${q.assigned && !q.my.passed ? 'todo' : ''} ${q.active ? '' : 'off'}`}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="tr-quiz-title">{q.title}</div>
                {q.description && <div className="small muted">{q.description}</div>}
              </div>
              {q.my.passed ? <span className="badge ok"><Icon name="check" size={12} />{t.passed}</span>
                : q.dueDate && q.assigned ? <span className={`badge ${q.dueDate < today ? 'bad' : 'warn'}`}>{t.due(fmtDay(q.dueDate, lang))}</span> : null}
            </div>
            <div className="tr-quiz-meta small muted">
              <span>{t.nQuestions(q.count)}</span>
              {q.passingScore != null && <span>{t.passAt(q.passingScore)}</span>}
              {q.assigned && <span>{t.assignedToYou}</span>}
              {q.my.attempts > 0 && <span>{t.yourBest(pct(q.my.best))}</span>}
              {!q.active && <span className="badge">{t.hidden}</span>}
            </div>
            {isMgr && q.stats && (
              <div className="tr-quiz-meta small">
                <span>{q.jobCodeIds.length ? q.jobCodeIds.map((id) => jobs[id]?.name).filter(Boolean).join(', ') : t.everyone}</span>
                {q.stats.assigned > 0 && <span><b>{q.stats.assignedPassed}/{q.stats.assigned}</b> {t.assignedPassed}</span>}
                <span>{t.nTook(q.stats.takers)}</span>
              </div>
            )}
            <div className="row wrap" style={{ gap: 8 }}>
              {q.my.openAttemptId
                ? <a className="btn primary" href={`#/training/quiz/${q.my.openAttemptId}`}>{t.continueQuiz}</a>
                : <button className="btn primary" disabled={busy} onClick={() => start(q)}>{q.my.attempts ? t.tryAgain : t.startQuiz}</button>}
              {q.my.openAttemptId && <button className="btn ghost sm" disabled={busy} onClick={() => start(q, true)}>{t.startOver}</button>}
              <span className="spacer" />
              {isMgr && <button className="btn sm ghost" onClick={() => call('quiz.get', { id: q.id }).then(setEditing)}><Icon name="edit" />{t.edit}</button>}
            </div>
          </div>
        ))}
      </div>

      {history?.length > 0 && (
        <div className="section">
          <div className="section-title"><h2>{t.myResults}</h2></div>
          <div className="card list">
            {history.map((h) => (
              <a key={h.id} className="list-item click tr-plainlink" href={`#/training/quiz/${h.id}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{h.title}</div>
                  <div className="small muted">{fmtDay(h.submittedAt, lang)} · {t.nRight(h.score, h.total)}</div>
                </div>
                <span className={`badge ${h.passed ? 'ok' : 'bad'} num`}>{pct(h.pct)}</span>
                <Icon name="right" size={16} style={{ color: 'var(--text-3)' }} />
              </a>
            ))}
          </div>
        </div>
      )}
      {editing && <QuizEditor quiz={editing} onClose={(c) => { setEditing(null); if (c) load(); }} />}
      {questions && <QuestionsManager onClose={() => setQuestions(false)} />}
    </div>
  );
}

/** Taking a quiz (or reviewing one that's handed in). */
export function QuizTake({ attemptId }) {
  const { call, refresh } = useApp();
  const t = useT();
  const [att, setAtt] = useState(null);
  const [err, setErr] = useState('');
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState({}); // "end" mode: answers chosen here, saved as you go
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('quiz.attempt.get', { id: attemptId }).then((a) => {
      setAtt(a);
      setPicked(Object.fromEntries(a.questions.filter((q) => q.answerId).map((q) => [q.key, q.answerId])));
      const first = a.questions.findIndex((q) => !q.answerId);
      setI(first < 0 ? a.questions.length - 1 : first);
    }).catch((e) => setErr(e.message));
  }, [attemptId]);
  if (err) return <div className="card"><Empty icon="alert" title={err}><a href="#/training/quizzes">{t.backToQuizzes}</a></Empty></div>;
  if (!att) return <div className="empty">{t.loading}</div>;
  if (att.submittedAt) return <QuizResult att={att} />;

  const q = att.questions[i];
  const each = att.feedback === 'each';
  const answered = each ? !!q.answerId : !!picked[q.key];
  const last = i === att.questions.length - 1;
  const doneCount = att.questions.filter((x) => (each ? x.answerId : picked[x.key])).length;

  const choose = async (choiceId) => {
    if (busy || (each && q.answerId)) return;
    if (!each) {
      setPicked({ ...picked, [q.key]: choiceId });
      call('quiz.answer', { attemptId: att.id, key: q.key, choiceId }).catch(() => {}); // saved for later; checked when handed in
      return;
    }
    setBusy(true);
    try {
      const r = await call('quiz.answer', { attemptId: att.id, key: q.key, choiceId });
      setAtt({ ...att, questions: att.questions.map((x) => (x.key === q.key ? { ...x, answerId: choiceId, correctId: r.correctId, correct: r.correct, explain: r.explain, itemName: r.itemName } : x)) });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await call('quiz.submit', { attemptId: att.id, answers: picked });
      setAtt(r);
      refresh();
      window.scrollTo(0, 0);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const go = (n) => { setI(n); window.scrollTo(0, 0); };

  return (
    <div className="tr-take">
      <div className="tr-take-head">
        <a className="btn sm ghost icon" href="#/training/quizzes" aria-label={t.backToQuizzes}><Icon name="x" /></a>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tr-take-title">{att.title}</div>
          <div className="small muted num">{t.questionOf(i + 1, att.total)}</div>
        </div>
      </div>
      <div className="progress tr-progress"><div style={{ width: `${(doneCount / att.total) * 100}%` }} /></div>

      <div className="card tr-q">
        {q.photo && <Photo attemptId={att.id} qKey={q.key} alt="" className="tr-q-photo" />}
        <div className="tr-q-prompt">{q.prompt}</div>
        <div className="tr-choices">
          {q.choices.map((c) => {
            const mine = (each ? q.answerId : picked[q.key]) === c.id;
            const state = each && q.answerId ? (c.id === q.correctId ? 'right' : mine ? 'wrong' : 'dim') : mine ? 'picked' : '';
            return (
              <button key={c.id} type="button" className={`tr-choice ${state}`} disabled={busy || (each && !!q.answerId)} onClick={() => choose(c.id)} aria-pressed={mine}>
                <span className="tr-choice-mark">{state === 'right' ? <Icon name="check" size={16} /> : state === 'wrong' ? <Icon name="x" size={16} /> : c.id.toUpperCase()}</span>
                <span>{c.text}</span>
              </button>
            );
          })}
        </div>
        {each && q.answerId && (
          <div className={`alert ${q.correct ? 'ok' : 'bad'}`}>
            <Icon name={q.correct ? 'check' : 'x'} size={16} />
            <span><b>{q.correct ? t.right : t.notQuite}</b>{!q.correct && <> {t.answerWas(q.choices.find((c) => c.id === q.correctId)?.text)}</>}{q.explain ? <> {q.explain}</> : null}</span>
          </div>
        )}
      </div>

      <div className="tr-take-nav">
        {!each && <button className="btn" disabled={i === 0} onClick={() => go(i - 1)}><Icon name="left" />{t.back}</button>}
        <span className="spacer" />
        {!last && <button className="btn primary" disabled={each && !answered} onClick={() => go(i + 1)}>{t.next}<Icon name="right" /></button>}
        {last && <button className="btn primary" disabled={busy || (each && !answered)} onClick={submit}><Icon name="check" />{each ? t.seeScore : t.handIn}</button>}
      </div>
      {!each && last && doneCount < att.total && <div className="help" style={{ textAlign: 'right' }}>{t.unanswered(att.total - doneCount)}</div>}
      {err && <div className="alert bad">{err}</div>}
    </div>
  );
}

function QuizResult({ att }) {
  const { call, me, people } = useApp();
  const t = useT();
  const lang = useLang();
  const [run, busy] = useAction();
  const again = async () => {
    const r = await run(() => call('quiz.start', { quizId: att.quizId }));
    if (r) location.hash = `#/training/quiz/${r.id}`;
  };
  const mine = att.userId === me.id;
  return (
    <div className="tr-take">
      <div className="row" style={{ marginBottom: 10 }}><a className="btn sm ghost" href="#/training/quizzes"><Icon name="left" />{t.backToQuizzes}</a></div>
      <div className={`card tr-score ${att.passed ? 'pass' : 'fail'}`}>
        <div className="tr-kicker">{att.title}{!mine && people[att.userId] ? ` · ${people[att.userId].name}` : ''}</div>
        <div className="tr-score-big num">{att.pct}%</div>
        <div>{t.nRight(att.score, att.total)}{att.passingScore != null && <> · {att.passed ? <b>{t.youPassed}</b> : t.needed(att.passingScore)}</>}</div>
        <div className="small" style={{ opacity: 0.8 }}>{fmtDay(att.submittedAt, lang)}</div>
        {mine && <div className="row wrap" style={{ justifyContent: 'center', gap: 8, marginTop: 8 }}>
          <button className="btn" disabled={busy} onClick={again}>{t.tryAgain}</button>
          <a className="btn" href="#/training/menu">{t.studyMenu}</a>
        </div>}
      </div>
      <div className="section-title" style={{ marginTop: 16 }}><h2>{t.review}</h2></div>
      <div className="col" style={{ gap: 10 }}>
        {att.questions.map((q, k) => (
          <div key={q.key} className={`card tr-review ${q.correct ? 'right' : 'wrong'}`}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className={`tr-review-mark ${q.correct ? 'right' : 'wrong'}`}><Icon name={q.correct ? 'check' : 'x'} size={14} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small faint">{k + 1}.</div>
                {q.photo && <Photo attemptId={att.id} qKey={q.key} alt="" className="tr-review-photo" />}
                <div style={{ fontWeight: 600 }}>{q.prompt}</div>
                {!q.correct && <div className="small tr-wrong-text">{q.answerId ? t.yourAnswer(q.choices.find((c) => c.id === q.answerId)?.text) : t.noAnswer}</div>}
                <div className="small tr-right-text">{t.rightAnswer(q.choices.find((c) => c.id === q.correctId)?.text)}</div>
                {q.explain && <div className="small muted">{q.explain}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- managers: quiz editor ----------
function QuizEditor({ quiz, onClose }) {
  const { call, jobCodes } = useApp();
  const t = useT();
  const lang = useLang();
  const [menu, setMenu] = useState(null);
  const [custom, setCustom] = useState([]);
  const [edLang, setEdLang] = useState('en');
  const [f, setF] = useState(() => ({
    id: quiz.id, title: quiz.title || '', description: quiz.description || '', es: { title: quiz.es?.title || '', description: quiz.es?.description || '' },
    categories: quiz.categories || [], itemIds: quiz.itemIds || [], questionIds: quiz.questionIds || [], types: quiz.types || [...QUESTION_TYPES],
    count: quiz.count ?? 10, passingScore: quiz.passingScore ?? 80, jobCodeIds: quiz.jobCodeIds || [], dueDate: quiz.dueDate || '', feedback: quiz.feedback || 'each', active: quiz.active !== false,
  }));
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  useEffect(() => { call('menu.list').then(setMenu); call('quiz.questions.list').then(setCustom); }, []);
  const side = edLang === 'es' ? f.es : f;
  const setSide = (patch) => setF((x) => (edLang === 'es' ? { ...x, es: { ...x.es, ...patch } } : { ...x, ...patch }));
  const save = async () => {
    const r = await run(() => call('quiz.save', { ...f, passingScore: f.passingScore === '' ? null : f.passingScore, dueDate: f.dueDate || null }), t.saved);
    if (r) onClose(true);
  };
  const del = async () => {
    if (!sure) return setSure(true);
    if (await run(() => call('quiz.delete', { id: f.id }), t.deleted)) onClose(true);
  };
  const general = custom.filter((q) => !q.itemId);
  const items = menu ? menu.items.map((it) => ({ id: it.id, label: localizeItem(it, lang).name })) : [];
  return (
    <Modal wide title={f.id ? t.editQuiz : t.newQuiz} onClose={() => onClose(false)}
      footer={<>
        {f.id && <button className={`btn danger ${sure ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{sure ? t.tapAgainToDelete : t.delete}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t.cancel}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{t.save}</button>
      </>}>
      <div className="row wrap tr-ed-lang"><LangTabs value={edLang} onChange={setEdLang} /><span className="help">{edLang === 'es' ? t.spanishHelp : t.englishHelp}</span></div>
      <Field label={t.quizName}><input className="input" value={side.title} onChange={(e) => setSide({ title: e.target.value })} placeholder={edLang === 'es' ? f.title : ''} /></Field>
      <Field label={t.descriptionOptional}><input className="input" value={side.description} onChange={(e) => setSide({ description: e.target.value })} /></Field>
      <Field label={t.sectionsToCover} help={t.sectionsHelp}>
        {menu ? <Chips options={menu.categories.map((c) => ({ id: c, label: categoryLabel(c, lang, menu.categoryEs) }))} value={f.categories} onChange={(v) => setF({ ...f, categories: v })} /> : t.loading}
      </Field>
      <Field label={t.orTheseItems}>
        {menu ? <Chips options={items} value={f.itemIds} onChange={(v) => setF({ ...f, itemIds: v })} /> : null}
      </Field>
      <Field label={t.questionTypes}>
        <Chips options={QUESTION_TYPES.map((k) => ({ id: k, label: t.qType[k] }))} value={f.types} onChange={(v) => setF({ ...f, types: v })} />
      </Field>
      {general.length > 0 && (
        <Field label={t.includeQuestions} help={t.includeQuestionsHelp}>
          <Chips options={general.map((q) => ({ id: q.id, label: localize(q, lang).text }))} value={f.questionIds} onChange={(v) => setF({ ...f, questionIds: v })} />
        </Field>
      )}
      <div className="grid3">
        <Field label={t.howManyQuestions}><input className="input" type="number" min="1" max="50" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} /></Field>
        <Field label={t.passingScore} help={t.passingHelp}><input className="input" type="number" min="1" max="100" value={f.passingScore} onChange={(e) => setF({ ...f, passingScore: e.target.value })} placeholder="—" /></Field>
        <Field label={t.dueDate}><input className="input" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
      </div>
      <Field label={t.showAnswers}>
        <div className="seg tr-seg-wrap">
          <button type="button" className={f.feedback === 'each' ? 'on' : ''} onClick={() => setF({ ...f, feedback: 'each' })}>{t.afterEach}</button>
          <button type="button" className={f.feedback === 'end' ? 'on' : ''} onClick={() => setF({ ...f, feedback: 'end' })}>{t.atTheEnd}</button>
        </div>
      </Field>
      <Field label={t.assignTo} help={t.assignHelp}>
        <Chips options={jobCodes.filter((j) => !j.archived).map((j) => ({ id: j.id, label: j.name }))} value={f.jobCodeIds} onChange={(v) => setF({ ...f, jobCodeIds: v })} />
      </Field>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t.quizActive}</label>
    </Modal>
  );
}

// ---------- managers: their own questions ----------
function QuestionsManager({ onClose }) {
  const { call } = useApp();
  const t = useT();
  const lang = useLang();
  const [list, setList] = useState(null);
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => call('quiz.questions.list').then(setList);
  useEffect(() => { load(); call('menu.list').then(setMenu); }, []);
  const itemName = (id) => { const it = menu?.items.find((x) => x.id === id); return it ? localizeItem(it, lang).name : ''; };
  return (
    <Modal wide title={t.ownQuestions} sub={t.ownQuestionsHelp} onClose={onClose}
      footer={<><button className="btn primary" onClick={() => setEditing({ kind: 'mc' })}><Icon name="plus" />{t.addQuestion}</button><span className="spacer" /><button className="btn" onClick={onClose}>{t.close}</button></>}>
      {!list ? t.loading : !list.length ? <Empty icon="star" title={t.noOwnQuestions} /> : (
        <div className="list card" style={{ boxShadow: 'none' }}>
          {list.map((q) => {
            const v = localize(q, lang);
            return (
              <button key={q.id} type="button" className="list-item click tr-rowbtn" onClick={() => setEditing(q)}>
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontWeight: 600 }}>{v.text}</div>
                  <div className="small muted">{q.kind === 'tf' ? (q.correct ? t.trueLabel : t.falseLabel) : v.choices[q.correct]}{q.itemId ? ` · ${itemName(q.itemId)}` : q.category ? ` · ${q.category}` : ''}{q.audience === 'recipe' ? ` · ${t.recipePeopleOnly}` : ''}</div>
                </div>
                <Icon name="edit" size={16} />
              </button>
            );
          })}
        </div>
      )}
      {editing && <QuestionEditor q={editing} menu={menu} onClose={(c) => { setEditing(null); if (c) load(); }} />}
    </Modal>
  );
}

function QuestionEditor({ q, menu, onClose }) {
  const { call } = useApp();
  const t = useT();
  const lang = useLang();
  const [edLang, setEdLang] = useState('en');
  const [f, setF] = useState(() => ({
    id: q.id, kind: q.kind || 'mc', text: q.text || '', choices: q.choices?.length ? [...q.choices] : ['', '', '', ''], correct: q.correct ?? 0,
    itemId: q.itemId || '', category: q.category || '', audience: q.audience || 'all', explain: q.explain || '',
    es: { text: q.es?.text || '', choices: (q.choices?.length ? q.choices : ['', '', '', '']).map((_, i) => q.es?.choices?.[i] || ''), explain: q.es?.explain || '' },
  }));
  const [run, busy] = useAction();
  const [sure, setSure] = useState(false);
  const es = edLang === 'es';
  const save = async () => {
    const r = await run(() => call('quiz.saveQuestion', { ...f, correct: f.kind === 'tf' ? f.correct === true : Number(f.correct) }), t.saved);
    if (r) onClose(true);
  };
  const del = async () => {
    if (!sure) return setSure(true);
    if (await run(() => call('quiz.deleteQuestion', { id: f.id }), t.deleted)) onClose(true);
  };
  const setChoice = (i, v) => (es ? setF({ ...f, es: { ...f.es, choices: f.es.choices.map((c, j) => (j === i ? v : c)) } }) : setF({ ...f, choices: f.choices.map((c, j) => (j === i ? v : c)) }));
  return (
    <Modal title={f.id ? t.editQuestion : t.addQuestion} onClose={() => onClose(false)}
      footer={<>
        {f.id && <button className={`btn danger ${sure ? 'solid' : ''}`} onClick={del} disabled={busy}><Icon name="trash" />{sure ? t.tapAgainToDelete : t.delete}</button>}
        <span className="spacer" />
        <button className="btn" onClick={() => onClose(false)}>{t.cancel}</button>
        <button className="btn primary" onClick={save} disabled={busy}>{t.save}</button>
      </>}>
      <div className="seg">
        <button type="button" className={f.kind === 'mc' ? 'on' : ''} onClick={() => setF({ ...f, kind: 'mc', correct: 0 })}>{t.multipleChoice}</button>
        <button type="button" className={f.kind === 'tf' ? 'on' : ''} onClick={() => setF({ ...f, kind: 'tf', correct: true })}>{t.trueFalse}</button>
      </div>
      <div className="row wrap tr-ed-lang"><LangTabs value={edLang} onChange={setEdLang} /></div>
      <Field label={t.question}><textarea className="input" rows="2" value={es ? f.es.text : f.text} placeholder={es ? f.text : ''} onChange={(e) => (es ? setF({ ...f, es: { ...f.es, text: e.target.value } }) : setF({ ...f, text: e.target.value }))} /></Field>
      {f.kind === 'mc' ? (
        <Field label={t.answers} help={es ? t.answersEsHelp : t.answersHelp}>
          <div className="col" style={{ gap: 6 }}>
            {f.choices.map((c, i) => (
              <label key={i} className="row tr-answer-row">
                <input type="radio" name="right" checked={Number(f.correct) === i} onChange={() => setF({ ...f, correct: i })} aria-label={t.rightOne} />
                <input className="input sm" value={es ? f.es.choices[i] : c} placeholder={es ? c : `${t.answer} ${i + 1}`} onChange={(e) => setChoice(i, e.target.value)} />
              </label>
            ))}
            {f.choices.length < 6 && !es && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, choices: [...f.choices, ''], es: { ...f.es, choices: [...f.es.choices, ''] } })}><Icon name="plus" />{t.addAnswer}</button>}
          </div>
        </Field>
      ) : (
        <Field label={t.rightAnswerIs}>
          <div className="seg">
            <button type="button" className={f.correct === true ? 'on' : ''} onClick={() => setF({ ...f, correct: true })}>{t.trueLabel}</button>
            <button type="button" className={f.correct === false ? 'on' : ''} onClick={() => setF({ ...f, correct: false })}>{t.falseLabel}</button>
          </div>
        </Field>
      )}
      <Field label={t.explanation}><input className="input" value={es ? f.es.explain : f.explain} placeholder={es ? f.explain : t.explanationPlaceholder} onChange={(e) => (es ? setF({ ...f, es: { ...f.es, explain: e.target.value } }) : setF({ ...f, explain: e.target.value }))} /></Field>
      <div className="grid2">
        <Field label={t.aboutItem}>
          <select className="input" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}>
            <option value="">{t.noItem}</option>
            {(menu?.items || []).map((it) => <option key={it.id} value={it.id}>{localizeItem(it, lang).name}</option>)}
          </select>
        </Field>
        {!f.itemId && (
          <Field label={t.orSection}>
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">{t.anySection}</option>
              {(menu?.categories || []).map((c) => <option key={c} value={c}>{categoryLabel(c, lang, menu.categoryEs)}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label={t.whoGetsIt}>
        <select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
          <option value="all">{t.everyone}</option>
          <option value="recipe">{t.recipePeopleOnly}</option>
        </select>
      </Field>
      <div className="help">{t.whereQuestionsGo}</div>
    </Modal>
  );
}
