// A time picker that works the same on iPhone, Android and the web preview: a button showing the time, and a
// sheet listing the day's times every 15 minutes (the current one is scrolled into view), plus "no time".
import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { pad } from '@/lib/time';
import { Icon } from './Icon';
import { Txt, useColors } from './ui';

const TIMES = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);
const ROW = 52;

export function TimeField({ label, value, onChange, empty, clearLabel }: {
  label: string; value: string; onChange: (v: string) => void; empty: string; clearLabel: string;
}) {
  const c = useColors();
  const { t, time } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const start = Math.max(0, TIMES.indexOf(value || '16:00') - 3);
  const pick = (v: string) => { onChange(v); setOpen(false); };
  return (
    <View style={{ flex: 1, gap: 4, minWidth: 120 }}>
      <Txt v="tiny" tone="muted" bold>{label}</Txt>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}: ${value ? time(value) : empty}`}
        style={({ pressed }) => [styles.btn, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
        <Text style={{ color: value ? c.text : c.text3, fontSize: 16, fontWeight: '600', flex: 1 }}>{value ? time(value) : empty}</Text>
        <Icon name="down" size={16} color={c.text3} />
      </Pressable>
      {open ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setOpen(false)}>
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={t('common.close')} />
          <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + 8 }]}>
            <View style={[styles.head, { borderColor: c.border }]}>
              <Txt v="h3" style={{ flex: 1 }}>{label}</Txt>
              <Pressable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={t('common.close')} style={styles.x}>
                <Icon name="x" size={22} color={c.text} />
              </Pressable>
            </View>
            <Pressable onPress={() => pick('')} accessibilityRole="button" style={({ pressed }) => [styles.opt, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : 'transparent' }]}>
              <Text style={{ color: c.text2, fontSize: 16 }}>{clearLabel}</Text>
            </Pressable>
            <FlatList data={TIMES} keyExtractor={(x) => x} initialScrollIndex={start} getItemLayout={(_, i) => ({ length: ROW, offset: ROW * i, index: i })}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => {
                const on = item === value;
                return (
                  <Pressable onPress={() => pick(item)} accessibilityRole="button" accessibilityState={{ selected: on }}
                    style={({ pressed }) => [styles.opt, { height: ROW, borderColor: c.border, backgroundColor: on ? c.brandSoft : pressed ? c.surface2 : 'transparent' }]}>
                    <Text style={{ color: on ? c.brand : c.text, fontSize: 17, fontWeight: on ? '800' : '500', flex: 1 }}>{time(item)}</Text>
                    {on ? <Icon name="check" size={18} color={c.brand} /> : null}
                  </Pressable>
                );
              }} />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, maxWidth: 720, width: '100%', alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  x: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  opt: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth },
});
