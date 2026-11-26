// "Sort by: Room | Position | Time | Name" over a day list (the schedule's day view, Today on the floor).
// The choice is remembered per screen (useDaySort in lib/schedule.ts).
import { View } from 'react-native';

import { Segmented, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import type { DaySort } from '@/lib/dayList';

export function DaySortPicker({ value, onChange }: { value: DaySort; onChange: (v: DaySort) => void }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 4 }} accessibilityLabel={t('schedule.sortBy')}>
      <Txt v="tiny" tone="muted" bold style={{ paddingHorizontal: 4 }}>{t('schedule.sortBy')}</Txt>
      <Segmented value={value} onChange={onChange} options={[
        { value: 'room', label: t('schedule.sortRoom') },
        { value: 'position', label: t('schedule.sortPosition') },
        { value: 'time', label: t('schedule.sortTime') },
        { value: 'name', label: t('schedule.sortName') },
      ]} />
    </View>
  );
}
