// The leaderboard: who knows the menu, by best score, average, quizzes passed or items mastered. When the
// restaurant keeps it for managers, staff see only their own numbers.
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chips, Empty, Loading, Notice, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import type { BoardRow, Leaderboard as Board } from '@/lib/types';

type Sort = 'best' | 'avg' | 'passed' | 'mastered';
const SORTS: Sort[] = ['best', 'avg', 'passed', 'mastered'];
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const main = (r: BoardRow, s: Sort) => (s === 'passed' ? String(r.passed) : s === 'mastered' ? String(r.mastered) : pct(s === 'avg' ? r.avg : r.best));

export function Leaderboard() {
  const { t } = useI18n();
  const c = useColors();
  const { me, jobs } = useApp();
  const [sort, setSort] = useState<Sort>('best');
  const [all, setAll] = useState(false);
  const { data, error, reload } = useRpc<Board>('leaderboard.get', { sort }, [sort]);
  if (!data) return error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />;
  const positions = (ids: string[]) => ids.map((id) => jobs[id]?.name).filter(Boolean).join(', ');

  if (!data.visible) {
    return (
      <View style={{ gap: 12 }}>
        <Notice tone="brand" icon="lock" text={t('board.managersOnly')} />
        <MyStats row={data.me} />
      </View>
    );
  }
  const rows = data.rows || [];
  const mine = rows.find((r) => r.userId === me.id);
  const shown = all ? rows : rows.slice(0, 50);
  return (
    <View style={{ gap: 12 }}>
      <Txt v="small" tone="muted" bold>{t('board.sortBy')}</Txt>
      <Chips single label={t('board.sortBy')} value={[sort]} onChange={(v) => v[0] && setSort(v[0] as Sort)} options={SORTS.map((s) => ({ value: s, label: t(`board.sort.${s}`) }))} />
      {mine ? <MyStats row={mine} /> : null}
      {!rows.length ? <Card><Empty icon="trophy" title={t('board.noScores')} body={t('board.noScoresBody')} /></Card> : (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {shown.map((r) => {
            const isMe = r.userId === me.id;
            return (
              <View key={r.userId} style={[styles.row, { borderColor: c.border, backgroundColor: isMe ? c.brandSoft : 'transparent' }]} accessible
                accessibilityLabel={`${t('board.rank', { rank: r.rank ?? '' })}, ${r.name}, ${t(`board.sort.${sort}`)} ${main(r, sort)}`}>
                <View style={[styles.rank, { backgroundColor: r.rank && r.rank <= 3 ? ['#f5b301', '#9aa4b2', '#c47a3a'][r.rank - 1] : c.surface2 }]}>
                  <Text style={{ color: r.rank && r.rank <= 3 ? '#fff' : c.text2, fontWeight: '800', fontSize: 13 }}>{r.rank}</Text>
                </View>
                <View style={[styles.dot, { backgroundColor: r.color || c.text3 }]}><Text style={styles.initial}>{r.name.slice(0, 1)}</Text></View>
                <View style={{ flex: 1, gap: 1 }}>
                  <Txt bold lines={1}>{r.name}</Txt>
                  <Txt v="tiny" tone="muted" lines={1}>{positions(r.positions)}</Txt>
                </View>
                <Txt v="h3">{main(r, sort)}</Txt>
              </View>
            );
          })}
        </Card>
      )}
      {rows.length > 50 && !all ? <Button kind="ghost" small title={t('board.showAll', { count: rows.length })} onPress={() => setAll(true)} /> : null}
      <Txt v="small" tone="faint">{t('board.help', { answers: data.mastery.answers, pct: data.mastery.pct })}</Txt>
    </View>
  );
}

function MyStats({ row }: { row: BoardRow }) {
  const { t } = useI18n();
  const c = useColors();
  return (
    <Card style={{ gap: 10 }}>
      <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{row.rank ? t('board.youRank', { rank: row.rank }) : t('board.you')}</Txt>
      <View style={styles.tiles}>
        {SORTS.map((s) => (
          <View key={s} style={[styles.tile, { backgroundColor: c.surface2 }]} accessible accessibilityLabel={`${t(`board.sort.${s}`)}: ${main(row, s)}`}>
            <Txt v="h2">{main(row, s)}</Txt>
            <Txt v="tiny" tone="muted" style={{ textAlign: 'center' }}>{t(`board.sort.${s}`)}</Txt>
          </View>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#fff', fontWeight: '800', fontSize: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexGrow: 1, flexBasis: '45%', borderRadius: 12, padding: 10, alignItems: 'center', gap: 2 },
});
