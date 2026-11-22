// "Bar: 3 out · Kitchen: 1 out" on My Shifts, opening the 86 List. Nothing when nothing's out or low.
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { useI18n } from '@/i18n';
import { barFirst, nameIn } from '@/lib/eightySix';
import { useRpc } from '@/lib/hooks';
import type { EightySixSummary } from '@/lib/types';
import { Icon } from './Icon';
import { Txt, useColors } from './ui';

export function EightySixBanner() {
  const { t, tn, lang } = useI18n();
  const c = useColors();
  const { data } = useRpc<EightySixSummary>('eightySix.summary');
  const lists = (data?.lists || []).filter((l) => l.out || l.low).sort(barFirst);
  if (!lists.length) return null;
  const text = lists.map((l) => `${nameIn(l, lang)}: ${[l.out ? tn('eightySix.nOut', l.out) : '', l.low ? tn('eightySix.nLow', l.low) : ''].filter(Boolean).join(', ')}`).join(' · ');
  return (
    <Pressable onPress={() => router.push('/eighty-six')} accessibilityRole="button" accessibilityLabel={`${t('eightySix.title')}: ${text}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.bad, backgroundColor: c.badSoft, opacity: pressed ? 0.8 : 1 })}>
      <View style={{ backgroundColor: c.bad, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3 }}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>86</Text></View>
      <Txt v="small" style={{ flex: 1 }}>{text}</Txt>
      <Icon name="right" size={18} color={c.text3} />
    </Pressable>
  );
}
