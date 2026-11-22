// Taking a quiz (one attempt), or its results once handed in. The server makes and grades the questions: the
// app gets an answer only when it can be shown (right after answering, in "after each question" quizzes, or
// after handing it in), never before. Answers are saved as you go, so closing the quiz loses nothing.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { TrainingPhoto } from '@/components/TrainingPhoto';
import { Badge, Button, Card, Empty, Loading, Notice, Row, SectionTitle, Txt, useColors, useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction, useErrorText } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { Attempt, AttemptQuestion } from '@/lib/types';

export default function QuizScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const { client } = useApp();
  const errorText = useErrorText();
  const [att, setAtt] = useState<Attempt | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => client.call<Attempt>('quiz.attempt.get', { id }).then((a) => { setAtt(a); setErr(null); }).catch(setErr);
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!att) {
    return (
      <Screen title={t('training.tabs.quizzes')} back bottomInset>
        {err ? <Empty icon="alert" title={errorText(err)}><Button title={t('common.retry')} onPress={load} /></Empty> : <Loading />}
      </Screen>
    );
  }
  return att.submittedAt ? <Result att={att} /> : <Take att={att} setAtt={setAtt} />;
}

function Take({ att, setAtt }: { att: Attempt; setAtt: (a: Attempt) => void }) {
  const { t, tn } = useI18n();
  const c = useColors();
  const { client, bump } = useApp();
  const toast = useToast();
  const errorText = useErrorText();
  const each = att.feedback === 'each';
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(att.questions.filter((q) => q.answerId).map((q) => [q.key, q.answerId!])));
  const [i, setI] = useState(() => { const first = att.questions.findIndex((q) => !q.answerId); return first < 0 ? att.questions.length - 1 : first; });
  const [busy, setBusy] = useState(false);
  const q = att.questions[i];
  const mine = each ? q.answerId : picked[q.key];
  const answered = !!mine;
  const last = i === att.questions.length - 1;
  const doneCount = att.questions.filter((x) => (each ? x.answerId : picked[x.key])).length;

  const choose = async (choiceId: string) => {
    if (busy || (each && q.answerId)) return;
    if (!each) {
      setPicked({ ...picked, [q.key]: choiceId });
      client.call('quiz.answer', { attemptId: att.id, key: q.key, choiceId }).catch(() => {}); // saved for later; graded when handed in
      return;
    }
    setBusy(true);
    try {
      const r = await client.call<{ correct: boolean; correctId: string; explain: string; itemName: string }>('quiz.answer', { attemptId: att.id, key: q.key, choiceId });
      setAtt({ ...att, questions: att.questions.map((x) => (x.key === q.key ? { ...x, answerId: choiceId, correctId: r.correctId, correct: r.correct, explain: r.explain, itemName: r.itemName } : x)) });
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    try {
      setAtt(await client.call<Attempt>('quiz.submit', { attemptId: att.id, answers: picked }));
      bump();
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const close = () => { if (doneCount) toast(t('quiz.saved')); router.back(); };

  return (
    <Screen title={att.title} back bottomInset>
      <View style={{ gap: 6 }}>
        <Row>
          <Txt v="small" tone="muted" bold style={{ flex: 1 }}>{t('quiz.questionOf', { n: i + 1, count: att.total })}</Txt>
          <Button kind="ghost" small icon="x" title={t('quiz.leave')} onPress={close} />
        </Row>
        <View style={[styles.bar, { backgroundColor: c.surface2 }]} accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: att.total, now: doneCount }}>
          <View style={{ width: `${(doneCount / att.total) * 100}%`, height: '100%', backgroundColor: c.brand, borderRadius: 4 }} />
        </View>
      </View>
      <Card style={{ gap: 12 }}>
        {q.photo ? <TrainingPhoto attemptId={att.id} qKey={q.key} style={styles.photo} label={t('quiz.photo')} /> : null}
        <Txt v="h2" style={{ lineHeight: 25 }}>{q.prompt}</Txt>
        <View style={{ gap: 8 }} accessibilityRole="radiogroup">
          {q.choices.map((ch) => {
            const on = mine === ch.id;
            const state = each && q.answerId ? (ch.id === q.correctId ? 'right' : on ? 'wrong' : 'dim') : on ? 'picked' : '';
            const border = state === 'right' ? c.ok : state === 'wrong' ? c.bad : state === 'picked' ? c.brand : c.border;
            const bg = state === 'right' ? c.okSoft : state === 'wrong' ? c.badSoft : state === 'picked' ? c.brandSoft : c.surface;
            return (
              <Pressable key={ch.id} onPress={() => choose(ch.id)} disabled={busy || (each && !!q.answerId)} accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: each && !!q.answerId }} accessibilityLabel={t('quiz.choice', { letter: ch.id.toUpperCase(), text: ch.text })}
                style={({ pressed }) => [styles.choice, { borderColor: border, backgroundColor: pressed && !state ? c.surface2 : bg, opacity: state === 'dim' ? 0.6 : 1 }]}>
                <View style={[styles.mark, { backgroundColor: state === 'right' ? c.ok : state === 'wrong' ? c.bad : state === 'picked' ? c.brand : c.surface2 }]}>
                  {state === 'right' ? <Icon name="check" size={16} color="#fff" /> : state === 'wrong' ? <Icon name="x" size={16} color="#fff" />
                    : <Text style={{ color: state === 'picked' ? c.onBrand : c.text2, fontWeight: '800' }}>{ch.id.toUpperCase()}</Text>}
                </View>
                <Txt style={{ flex: 1 }}>{ch.text}</Txt>
              </Pressable>
            );
          })}
        </View>
        {each && q.answerId ? (
          <Notice tone={q.correct ? 'ok' : 'bad'} icon={q.correct ? 'check' : 'x'}
            text={[q.correct ? t('quiz.right') : t('quiz.notQuite'), !q.correct ? t('quiz.answerWas', { answer: q.choices.find((x) => x.id === q.correctId)?.text || '' }) : '', q.explain || ''].filter(Boolean).join(' ')} />
        ) : null}
      </Card>
      <Row>
        {!each ? <Button icon="left" title={t('common.back')} disabled={i === 0} onPress={() => setI(i - 1)} style={{ flex: 1 }} /> : null}
        {!last ? <Button kind="primary" title={t('common.next')} disabled={each && !answered} onPress={() => setI(i + 1)} style={{ flex: 1 }} /> : null}
        {last ? <Button kind="primary" icon="check" title={each ? t('quiz.seeScore') : t('quiz.handIn')} busy={busy} disabled={each && !answered} onPress={submit} style={{ flex: 1 }} /> : null}
      </Row>
      {!each && last && doneCount < att.total ? <Txt v="small" tone="warn">{tn('quiz.unanswered', att.total - doneCount)}</Txt> : null}
    </Screen>
  );
}

function Result({ att }: { att: Attempt }) {
  const { t, date } = useI18n();
  const c = useColors();
  const { client, me, people } = useApp();
  const [run, busy] = useAction();
  const mine = att.userId === me.id;
  const again = async () => {
    const r = await run(() => client.call<Attempt>('quiz.start', { quizId: att.quizId }));
    if (r) router.replace({ pathname: '/quiz/[id]', params: { id: r.id } });
  };
  const text = (q: AttemptQuestion, id?: string | null) => q.choices.find((x) => x.id === id)?.text || '';
  return (
    <Screen title={att.title} back bottomInset>
      <View style={[styles.score, { backgroundColor: att.passed ? '#15803d' : '#b91c1c' }]} accessible
        accessibilityLabel={`${att.title}: ${att.pct}%, ${t('quiz.nRight', { score: att.score ?? 0, total: att.total })}, ${att.passed ? t('quiz.passed') : t('quiz.notPassed')}`}>
        <Text style={styles.scoreKicker}>{att.title}{!mine && people[att.userId] ? ` · ${people[att.userId].name}` : ''}</Text>
        <Text style={styles.scoreBig}>{att.pct}%</Text>
        <Text style={styles.scoreLine}>
          {t('quiz.nRight', { score: att.score ?? 0, total: att.total })}
          {att.passingScore != null ? ` · ${att.passed ? t('quiz.youPassed') : t('quiz.needed', { pct: att.passingScore })}` : ''}
        </Text>
        <Text style={[styles.scoreLine, { opacity: 0.85 }]}>{date(att.submittedAt!.slice(0, 10))}</Text>
      </View>
      {mine ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button icon="quiz" title={t('quiz.tryAgain')} busy={busy} onPress={again} style={{ flexGrow: 1 }} />
          <Button icon="book" title={t('quiz.studyMenu')} onPress={() => router.replace({ pathname: '/training', params: { tab: 'menu' } })} style={{ flexGrow: 1 }} />
        </Row>
      ) : null}
      <SectionTitle title={t('quiz.review')} />
      {att.questions.map((q, k) => (
        <Card key={q.key} style={[{ gap: 6, borderLeftWidth: 4, borderLeftColor: q.correct ? c.ok : c.bad }]}>
          <Row>
            <Txt v="small" tone="faint" style={{ flex: 1 }}>{k + 1}.</Txt>
            <Badge tone={q.correct ? 'ok' : 'bad'} text={q.correct ? t('quiz.right') : t('quiz.notQuite')} />
          </Row>
          {q.photo ? <TrainingPhoto attemptId={att.id} qKey={q.key} style={styles.reviewPhoto} label={t('quiz.photo')} /> : null}
          <Txt bold>{q.prompt}</Txt>
          {!q.correct ? <Txt v="small" tone="bad">{q.answerId ? t('quiz.yourAnswer', { answer: text(q, q.answerId) }) : t('quiz.noAnswer')}</Txt> : null}
          <Txt v="small" tone="ok">{t('quiz.rightAnswer', { answer: text(q, q.correctId) })}</Txt>
          {q.explain ? <Txt v="small" tone="muted">{q.explain}</Txt> : null}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12 },
  reviewPhoto: { width: 140, aspectRatio: 4 / 3, borderRadius: 10 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, minHeight: 56 },
  mark: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  score: { borderRadius: 18, padding: 20, alignItems: 'center', gap: 4 },
  scoreKicker: { color: '#fff', fontWeight: '700', fontSize: 13, opacity: 0.9, textAlign: 'center' },
  scoreBig: { color: '#fff', fontWeight: '800', fontSize: 48 },
  scoreLine: { color: '#fff', fontSize: 15, textAlign: 'center' },
});
