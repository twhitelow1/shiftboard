// One shift in a list: the day, the time, the position and area, and something on the right.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import type { Shift } from '@/lib/types';
import { Icon } from './Icon';
import { JobDot, Txt, useColors } from './ui';

/** "4p–10p", "4p–CL" (until close), or just "4p" when the restaurant posts start times only. */
export function useShiftTime() {
  const { time, t } = useI18n();
  const startOnly = !!useSession().boot?.settings.startTimesOnly;
  return (s: Pick<Shift, 'start' | 'end'>) => (startOnly ? time(s.start) : `${time(s.start)}–${s.end ? time(s.end) : t('common.untilClose')}`);
}

/** "Server · Restaurant · LIB · Event" */
export function useShiftWhat() {
  const { jobs } = useSession();
  const { t } = useI18n();
  return (s: Shift) => [jobs[s.jobCodeId]?.name, s.area, s.tag, s.eventId ? t('common.event') : ''].filter(Boolean).join(' · ');
}

export function ShiftRow({ s, onPress, right, past, who }: { s: Shift; onPress?: () => void; right?: ReactNode; past?: boolean; who?: string }) {
  const c = useColors();
  const { date, t, lang } = useI18n();
  const { jobs, boot } = useSession();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  // "4p–CL until close": the English sheet abbreviation gets a hint; Spanish already says "cierre".
  const untilClose = !s.end && !boot?.settings.startTimesOnly && lang === 'en';
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${date(s.date, 'long')}, ${shiftTime(s)}, ${what(s)}${who ? `, ${who}` : ''}`}
      style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : 'transparent', opacity: past ? 0.55 : 1 }]}>
      <View style={[styles.date, { backgroundColor: c.surface2 }]}>
        <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase' }}>{date(s.date, 'weekday')}</Txt>
        <Txt v="h2" style={{ lineHeight: 22 }}>{date(s.date, 'day')}</Txt>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Txt style={{ fontWeight: '700' }}>
          {shiftTime(s)}{untilClose ? <Txt v="small" tone="faint">{`  ${t('common.untilCloseLong')}`}</Txt> : null}
        </Txt>
        {who ? <Txt v="small" style={{ fontWeight: '600' }} lines={1}>{who}</Txt> : null}
        <View style={styles.what}>
          <JobDot color={jobs[s.jobCodeId]?.color} />
          <Txt v="small" tone="muted" style={{ flexShrink: 1 }}>{what(s)}</Txt>
        </View>
      </View>
      {right}
      {onPress ? <Icon name="right" size={16} color={c.text3} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 64 },
  date: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  what: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
