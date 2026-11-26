// Stock lists' shared pieces: a list's progress bar, a list's card, and My Shifts' "Stock lists for you" card.
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import type { StockCounts, StockLists, StockListSummary } from '@/lib/stock';
import { Icon } from './Icon';
import { Badge, Txt, useColors } from './ui';

export function Progress({ counts }: { counts: StockCounts }) {
  const { t, tn } = useI18n();
  const c = useColors();
  const pct = counts.lines ? counts.done / counts.lines : 0;
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.bar, { backgroundColor: c.surface2, borderColor: c.border }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: counts.lines, now: counts.done }}>
        <View style={{ width: `${Math.round(pct * 100)}%`, height: '100%', backgroundColor: c.ok, borderRadius: 99 }} />
      </View>
      <View style={styles.badges}>
        <Txt v="small" tone="muted">{t('stock.progress', { done: counts.done, total: counts.lines })}</Txt>
        {counts.short ? <Badge tone="warn" text={tn('stock.nShort', counts.short)} /> : null}
        {counts.out ? <Badge tone="bad" text={tn('stock.nOut', counts.out)} /> : null}
      </View>
    </View>
  );
}

const open = (id: string) => router.push({ pathname: '/stock-list', params: { id } });

export function ListCard({ l }: { l: StockListSummary }) {
  const { t, date, time, stamp } = useI18n();
  const c = useColors();
  const when = [l.date ? date(l.date) : '', l.due ? t('stock.dueAt', { time: time(l.due) }) : ''].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={() => open(l.id)} accessibilityRole="button" accessibilityLabel={l.name}
      style={({ pressed }) => [styles.card, { borderColor: l.overdue ? c.bad : c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
      <View style={styles.badges}>
        <Txt v="h3" style={{ flexShrink: 1 }}>{l.name}</Txt>
        {l.status === 'done' ? <Badge tone="ok" text={t('stock.done')} /> : null}
        {l.overdue ? <Badge tone="bad" text={t('stock.late')} /> : null}
      </View>
      {l.assignLabel || when ? <Txt v="small" tone="muted">{[l.assignLabel ? t('stock.forWho', { who: l.assignLabel }) : '', when].filter(Boolean).join(' · ')}</Txt> : null}
      <Progress counts={l.counts} />
      {l.doneBy && l.doneAt ? <Txt v="tiny" tone="faint">{t('stock.doneBy', { name: l.doneBy.name, when: stamp(l.doneAt) })}</Txt> : null}
    </Pressable>
  );
}

/** My Shifts: the stock lists assigned to me for today, when there are any. */
export function StockCard() {
  const { t, time } = useI18n();
  const c = useColors();
  const r = useRpc<Pick<StockLists, 'lists'>>('stock.mine.list');
  const lists = r.data?.lists || [];
  if (!lists.length) return null;
  return (
    <View style={[styles.mine, { borderColor: c.brand, backgroundColor: c.brandSoft }]}>
      <View style={styles.badges}><Icon name="cards" size={18} color={c.brand} /><Txt bold tone="brand">{t('stock.forYouToday')}</Txt></View>
      {lists.map((l) => (
        <Pressable key={l.id} onPress={() => open(l.id)} accessibilityRole="button" accessibilityLabel={l.name}
          style={({ pressed }) => [styles.mineRow, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt bold>{l.name}</Txt>
            <Txt v="small" tone="muted">{[l.due ? t('stock.dueAt', { time: time(l.due) }) : '', t('stock.progress', { done: l.counts.done, total: l.counts.lines })].filter(Boolean).join(' · ')}</Txt>
          </View>
          {l.overdue ? <Badge tone="bad" text={t('stock.late')} /> : null}
          <Icon name="right" size={18} color={c.text3} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: 10, borderRadius: 99, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
  mine: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  mineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
});
