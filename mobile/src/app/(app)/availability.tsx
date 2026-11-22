// My availability: for each weekday (in the restaurant's week order), any time, some hours (from / until), or
// unavailable. Saved with employees.setAvailability, like the website's Time Off → My availability; the schedule
// flags shifts outside it for managers.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { TimeField } from '@/components/TimeField';
import { Button, Card, Notice, Segmented, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { addDays } from '@/lib/time';
import type { DayAvailability } from '@/lib/types';

type Mode = 'any' | 'some' | 'off';
const modeOf = (a?: DayAvailability): Mode => (a?.available === false ? 'off' : a?.from || a?.to ? 'some' : 'any');
// A Sunday (2023-01-01) plus n days, for the weekday's name in the person's language.
const dayName = (dow: number) => addDays('2023-01-01', dow);

export default function Availability() {
  const { t, date } = useI18n();
  const c = useColors();
  const { me, settings, client } = useApp();
  const [av, setAv] = useState<Record<string, DayAvailability>>(() => ({ ...(me.availability || {}) }));
  const [saved, setSaved] = useState(() => JSON.stringify(me.availability || {}));
  const [run, busy] = useAction();
  useEffect(() => { setSaved(JSON.stringify(me.availability || {})); }, [me.availability]);
  const dirty = JSON.stringify(av) !== saved;
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + settings.weekStartDow) % 7);
  const set = (d: number, patch: DayAvailability) => setAv({ ...av, [d]: { ...(av[d] || { available: true }), ...patch } });
  const setMode = (d: number, m: Mode) => {
    const a = av[d] || {};
    if (m === 'any') set(d, { available: true, from: '', to: '' });
    else if (m === 'some') set(d, { available: true, from: a.from || '16:00', to: a.to || '' });
    else set(d, { available: false });
  };
  const save = async () => {
    const r = await run(() => client.call('employees.setAvailability', { availability: av }), t('availability.saved'));
    if (r !== undefined) { setSaved(JSON.stringify(av)); router.back(); }
  };

  return (
    <Screen title={t('availability.title')} back bottomInset>
      <Txt v="small" tone="muted">{t('availability.help')}</Txt>
      <Card pad={false} style={{ overflow: 'hidden' }}>
        {order.map((d) => {
          const a = av[d] || {};
          const m = modeOf(a);
          const name = date(dayName(d), 'weekdayLong');
          return (
            <View key={d} style={[styles.day, { borderColor: c.border }]} accessibilityLabel={name}>
              <Txt v="h3" style={{ textTransform: 'capitalize' }}>{name}</Txt>
              <Segmented value={m} onChange={(v) => setMode(d, v)} options={[
                { value: 'any', label: t('availability.anyTime') },
                { value: 'some', label: t('availability.someHours') },
                { value: 'off', label: t('availability.unavailable') },
              ]} />
              {m === 'some' ? (
                <View style={styles.times}>
                  <TimeField label={t('availability.from')} value={a.from || ''} onChange={(v) => set(d, { from: v })}
                    empty={t('availability.opening')} clearLabel={t('availability.clearTime')} />
                  <TimeField label={t('availability.to')} value={a.to || ''} onChange={(v) => set(d, { to: v })}
                    empty={t('availability.closing')} clearLabel={t('availability.clearTime')} />
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>
      {dirty ? <Notice tone="warn" icon="clock" text={t('availability.unsaved')} /> : null}
      <Button kind="primary" icon="check" title={t('availability.save')} busy={busy} disabled={!dirty} onPress={save} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  day: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  times: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
