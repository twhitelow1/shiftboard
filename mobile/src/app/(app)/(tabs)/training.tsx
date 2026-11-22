// Training: the manager on duty at the top, what's waiting for me (quizzes for my position, manual pages to
// read), then Menu, Quizzes, Leaderboard and Manual. Content shows in Spanish where the restaurant wrote a
// Spanish version. Like the website's Training page (web/src/pages/Training.jsx); editing stays on the website.
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { ModCard } from '@/components/ModCard';
import { Screen } from '@/components/Screen';
import { Leaderboard } from '@/components/training/Leaderboard';
import { ManualList } from '@/components/training/ManualList';
import { MenuGuide } from '@/components/training/MenuGuide';
import { QuizList } from '@/components/training/QuizList';
import { Card, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import type { ModInfo, TrainingSummary } from '@/lib/types';

type Tab = 'menu' | 'quizzes' | 'board' | 'manual';
const TABS: Tab[] = ['menu', 'quizzes', 'board', 'manual'];

export default function Training() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ tab?: string }>();
  const pick = (v?: string): Tab => (TABS.includes(v as Tab) ? (v as Tab) : 'menu');
  const [tab, setTab] = useState<Tab>(() => pick(params.tab));
  useEffect(() => { if (params.tab) setTab(pick(params.tab)); }, [params.tab]);
  const summary = useRpc<TrainingSummary>('training.summary');
  const mod = useRpc<ModInfo>('mod.get');

  return (
    <Screen title={t('training.title')} onRefresh={() => Promise.all([summary.reload(), mod.reload()])}>
      <ModCard mod={mod.data} />
      <ToDo s={summary.data} onTab={setTab} />
      <GridTabs value={tab} onChange={setTab} tabs={[
        { value: 'menu', label: t('training.tabs.menu'), icon: 'book' },
        { value: 'quizzes', label: t('training.tabs.quizzes'), icon: 'quiz', count: summary.data?.quizzes.length },
        { value: 'board', label: t('training.tabs.board'), icon: 'trophy' },
        { value: 'manual', label: t('training.tabs.manual'), icon: 'cards', count: summary.data?.pages.length },
      ]} />
      {tab === 'menu' ? <MenuGuide /> : tab === 'quizzes' ? <QuizList /> : tab === 'board' ? <Leaderboard /> : <ManualList />}
    </Screen>
  );
}

/** Menu · Quizzes · Leaderboard · Manual as a 2 × 2 grid: every label fits at 360 px in both languages. */
function GridTabs({ tabs, value, onChange }: { tabs: { value: Tab; label: string; icon: IconName; count?: number }[]; value: Tab; onChange: (t: Tab) => void }) {
  const c = useColors();
  return (
    <View style={styles.grid} accessibilityRole="tablist">
      {tabs.map((tb) => {
        const on = tb.value === value;
        return (
          <Pressable key={tb.value} onPress={() => onChange(tb.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            accessibilityLabel={tb.count ? `${tb.label}, ${tb.count}` : tb.label}
            style={({ pressed }) => [styles.gridTab, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : pressed ? c.surface2 : c.surface }]}>
            <Icon name={tb.icon} size={18} color={on ? c.brand : c.text2} />
            <Text style={{ color: on ? c.brand : c.text2, fontWeight: '700', fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{tb.label}</Text>
            {tb.count ? <View style={[styles.count, { backgroundColor: on ? c.brand : c.warn }]}><Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{tb.count}</Text></View> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Quizzes for my position I haven't passed, and manual pages to read. Nothing when there's nothing to do. */
function ToDo({ s, onTab }: { s: TrainingSummary | null; onTab: (t: Tab) => void }) {
  const { t, tn } = useI18n();
  const c = useColors();
  if (!s || (!s.quizzes.length && !s.pages.length)) return null;
  const overdue = s.quizzes.filter((q) => q.overdue).length;
  const items = [
    s.quizzes.length ? { key: 'q', icon: 'quiz' as const, text: [tn('training.quizzesToDo', s.quizzes.length), overdue ? tn('training.overdue', overdue) : ''].filter(Boolean).join(' · '), tone: overdue ? c.bad : c.warn, go: () => onTab('quizzes') } : null,
    s.pages.length ? { key: 'p', icon: 'cards' as const, text: tn('training.pagesToRead', s.pages.length), tone: c.brand,
      go: () => (s.pages.length === 1 ? router.push({ pathname: '/manual/[id]', params: { id: s.pages[0].id } }) : onTab('manual')) } : null,
  ].filter(Boolean) as { key: string; icon: 'quiz' | 'cards'; text: string; tone: string; go: () => void }[];
  return (
    <Card style={{ gap: 8 }}>
      <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('training.toDo')}</Txt>
      {items.map((x) => (
        <Pressable key={x.key} onPress={x.go} accessibilityRole="button" style={({ pressed }) => [styles.todo, { borderColor: x.tone, backgroundColor: pressed ? c.surface2 : 'transparent' }]}>
          <Icon name={x.icon} size={18} color={x.tone} />
          <Txt bold style={{ flex: 1, color: x.tone }}>{x.text}</Txt>
          <Icon name="right" size={16} color={c.text3} />
        </Pressable>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridTab: { width: '48.7%', flexGrow: 1, minHeight: 48, borderWidth: 1, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 8 },
  count: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  todo: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
});
