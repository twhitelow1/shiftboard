// Skill mix on the schedule's day view (core/ratings.js skillMix.week), read-only: for managers with the ratingsView
// role feature, each skill-mix rule that applies to the day, red with the reason when it fails. Ratings themselves
// aren't shown here; fixing a rule (suggestions, add or swap) is on the website. Staff never get this (no request is made).
import { StyleSheet, View } from 'react-native';

import { Badge, Card, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';

type Rule = { id: string; jobCodeId: string; type: 'atLeast' | 'atMost' | 'minAvg'; count: number | null; rating: number | null; avg: number | null; daypart: string; room: string };
type Result = { ruleId: string; status: 'ok' | 'fail' | 'na'; have: number | null; avg: number | null; scheduled: number };
type Week = { rules: Rule[]; days: { date: string; results: Result[]; failing: number }[]; failing: number };

export function SkillMixDay({ ws, day }: { ws: string; day: string }) {
  const { t, tn, num } = useI18n();
  const c = useColors();
  const { jobs, has } = useApp();
  const { data } = useRpc<Week>('skillMix.week', { weekStart: ws }, [ws], has('ratingsView'));
  const d = data?.days?.find((x) => x.date === day);
  if (!data || !d || !d.results.length) return null;
  const rules = Object.fromEntries(data.rules.map((r) => [r.id, r]));
  const what = (r: Rule) => (r.type === 'atLeast' ? t('skillMix.atLeast', { count: r.count ?? 0, rating: r.rating ?? 0 })
    : r.type === 'atMost' ? t('skillMix.atMost', { count: r.count ?? 0, rating: r.rating ?? 0 }) : t('skillMix.minAvg', { avg: num(r.avg ?? 0) }));
  const now = (r: Rule, x: Result) => (r.type === 'minAvg' ? (x.avg == null ? t('skillMix.noneRated') : t('skillMix.avgNow', { avg: num(x.avg) })) : t('skillMix.haveNow', { have: x.have ?? 0 }));
  return (
    <Card pad={false} style={{ overflow: 'hidden' }}>
      <Row style={styles.head}>
        <Txt v="small" bold tone="muted" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('skillMix.title')}</Txt>
        {d.failing ? <Badge tone="bad" text={tn('skillMix.failing', d.failing)} /> : <Badge tone="ok" text={t('skillMix.allMet')} />}
      </Row>
      {d.results.map((x) => {
        const r = rules[x.ruleId];
        if (!r) return null;
        const bad = x.status === 'fail';
        return (
          <View key={x.ruleId} style={[styles.item, { borderColor: c.border, borderLeftColor: bad ? c.bad : c.border }]}
            accessible accessibilityLabel={`${jobs[r.jobCodeId]?.name || ''}: ${what(r)}. ${now(r, x)}`}>
            <Txt style={{ fontWeight: '700' }}>{jobs[r.jobCodeId]?.name || '—'}{r.daypart ? ` · ${r.daypart}` : ''}{r.room ? ` · ${r.room}` : ''}</Txt>
            <Txt v="small" tone="muted">{what(r)}</Txt>
            <Txt v="small" style={bad ? { color: c.bad, fontWeight: '600' } : undefined}>{now(r, x)}</Txt>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, gap: 8 },
  item: { borderTopWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
});
