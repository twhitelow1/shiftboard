// A month calendar for picking a range of days: tap the first day, then the last.
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { addDays, monthGrid, range } from '@/lib/time';
import { Icon } from './Icon';
import { Txt, useColors } from './ui';

// "diciembre de 2026" → "Diciembre de 2026" (only the first letter: not "De").
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function DateRangePicker({ start, end, min, onChange, weekStartDow = 0 }: {
  start: string | null; end: string | null; min: string; onChange: (start: string, end: string) => void; weekStartDow?: number;
}) {
  const c = useColors();
  const { t, date } = useI18n();
  const [month, setMonth] = useState((start || min).slice(0, 7));
  const days = monthGrid(month, weekStartDow);
  const heads = range(days[0], 7);
  const pick = (d: string) => {
    if (d < min) return;
    if (!start || (start && end && start !== end) || d < start) onChange(d, d);
    else onChange(start, d);
  };
  const shiftMonth = (n: number) => setMonth(addDays(`${month}-15`, n * 30).slice(0, 7));
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => shiftMonth(-1)} disabled={month <= min.slice(0, 7)} style={[styles.arrow, { opacity: month <= min.slice(0, 7) ? 0.3 : 1 }]}
          accessibilityRole="button" accessibilityLabel={t('timeOff.prevMonth')}><Icon name="left" color={c.text} /></Pressable>
        <Txt v="h3" style={{ flex: 1, textAlign: 'center' }}>{upperFirst(date(`${month}-01`, 'monthYear'))}</Txt>
        <Pressable onPress={() => shiftMonth(1)} style={styles.arrow} accessibilityRole="button" accessibilityLabel={t('timeOff.nextMonth')}><Icon name="right" color={c.text} /></Pressable>
      </View>
      <View style={styles.row}>
        {heads.map((d) => <Txt key={d} v="tiny" tone="faint" bold style={styles.dow}>{date(d, 'weekday')}</Txt>)}
      </View>
      <View style={styles.grid}>
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const past = d < min;
          const sel = !!start && !!end && d >= start && d <= end;
          const edge = d === start || d === end;
          return (
            <Pressable key={d} onPress={() => pick(d)} disabled={past || !inMonth} accessibilityRole="button" accessibilityState={{ selected: sel, disabled: past }}
              accessibilityLabel={date(d, 'long')} style={styles.cell}>
              <View style={[styles.dayBox, sel && { backgroundColor: edge ? c.brand : c.brandSoft }]}>
                <Txt v="small" tone={edge ? 'onBrand' : past || !inMonth ? 'faint' : 'text'} style={{ fontWeight: edge ? '800' : '500', opacity: inMonth ? 1 : 0 }}>
                  {Number(d.slice(8))}
                </Txt>
              </View>
            </Pressable>
          );
        })}
      </View>
      <Txt v="small" tone="faint">{t('timeOff.pickDates')}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row' },
  dow: { flex: 1, textAlign: 'center', textTransform: 'capitalize' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: 44, padding: 2 },
  dayBox: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
