// Quizzes: the ones for my position first (with their due dates), start / continue / try again, and my results.
// Questions are made and graded on the server; the app never gets an answer before it's locked in.
import { router } from 'expo-router';
import { View } from 'react-native';

import { Badge, Button, Card, Empty, ListRow, Loading, Row, SectionTitle, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { localize } from '@/lib/training';
import type { Attempt, AttemptSummary, QuizRow } from '@/lib/types';

const fmtPct = (v: number | null | undefined) => (v == null ? '—' : String(v));

export function QuizList() {
  const { t, tn, lang, date } = useI18n();
  const c = useColors();
  const { client, today } = useApp();
  const list = useRpc<QuizRow[]>('quiz.list');
  const history = useRpc<AttemptSummary[]>('quiz.attempts.list');
  const [run, busy] = useAction();
  const start = async (q: QuizRow, fresh = false) => {
    const att = await run(() => client.call<Attempt>('quiz.start', { quizId: q.id, fresh }));
    if (att) router.push({ pathname: '/quiz/[id]', params: { id: att.id } });
  };
  if (!list.data) return list.error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={list.reload} /></Empty> : <Loading />;
  const shown = list.data.map((q) => ({ ...q, ...localize(q, lang) }));

  return (
    <View style={{ gap: 12 }}>
      {!shown.length ? <Card><Empty icon="quiz" title={t('quiz.none')} body={t('quiz.noneBody')} /></Card> : null}
      {shown.map((q) => {
        const todo = q.assigned && !q.my.passed;
        return (
          <Card key={q.id} style={[{ gap: 8 }, todo && { borderColor: c.warn, borderWidth: 1 }]}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="h3">{q.title}</Txt>
                {q.description ? <Txt v="small" tone="muted">{q.description}</Txt> : null}
              </View>
              {q.my.passed ? <Badge tone="ok" text={t('quiz.passed')} />
                : q.dueDate && q.assigned ? <Badge tone={q.dueDate < today ? 'bad' : 'warn'} text={t('quiz.due', { date: date(q.dueDate) })} /> : null}
            </Row>
            <Txt v="small" tone="muted">
              {[tn('quiz.questions', q.count), q.passingScore != null ? t('quiz.passAt', { pct: q.passingScore }) : '', q.assigned ? t('quiz.forYou') : '',
                q.my.attempts ? t('quiz.best', { pct: fmtPct(q.my.best) }) : ''].filter(Boolean).join(' · ')}
            </Txt>
            <Row style={{ flexWrap: 'wrap' }}>
              {q.my.openAttemptId ? (
                <>
                  <Button kind="primary" icon="right" title={t('quiz.continue')} onPress={() => router.push({ pathname: '/quiz/[id]', params: { id: q.my.openAttemptId! } })} style={{ flexGrow: 1 }} />
                  <Button kind="ghost" title={t('quiz.startOver')} busy={busy} onPress={() => start(q, true)} />
                </>
              ) : (
                <Button kind={todo ? 'primary' : 'secondary'} icon="quiz" title={q.my.attempts ? t('quiz.tryAgain') : t('quiz.start')} busy={busy} onPress={() => start(q)} style={{ flexGrow: 1 }} />
              )}
            </Row>
          </Card>
        );
      })}
      {history.data?.length ? (
        <>
          <SectionTitle title={t('quiz.history')} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {history.data.map((h) => (
              <ListRow key={h.id} title={h.title} sub={`${date(h.submittedAt.slice(0, 10))} · ${t('quiz.nRight', { score: h.score, total: h.total })}`}
                label={`${h.title}, ${h.pct}%, ${h.passed ? t('quiz.passed') : t('quiz.notPassed')}`}
                onPress={() => router.push({ pathname: '/quiz/[id]', params: { id: h.id } })}
                right={<Badge tone={h.passed ? 'ok' : 'bad'} text={`${h.pct}%`} />} />
            ))}
          </Card>
        </>
      ) : null}
    </View>
  );
}
