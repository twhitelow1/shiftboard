// Events & BEOs, read only: upcoming (or past) events with their time, room, guests and how staffed they are.
// Only what events.list returns: tentative events are for the events team, who build and edit BEOs on the website.
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, Loading, Segmented, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { isStatus, STATUS_TONE } from '@/lib/events';
import { useErrorText, useRpc } from '@/lib/hooks';
import { useApp } from '@/lib/session';
import { addDays } from '@/lib/time';
import type { EventRow } from '@/lib/types';


export default function Events() {
  const { t, tn, date, time } = useI18n();
  const c = useColors();
  const errorText = useErrorText();
  const { today } = useApp();
  const [past, setPast] = useState(false);
  const args = past ? { start: addDays(today, -120), end: addDays(today, -1) } : { start: today };
  const { data, error, reload } = useRpc<EventRow[]>('events.list', args, [past]);
  const list = data ? (past ? [...data].reverse() : data) : null;
  return (
    <Screen title={t('events.title')} back bottomInset onRefresh={reload}>
      <Segmented value={past ? 'past' : 'upcoming'} onChange={(v) => setPast(v === 'past')}
        options={[{ value: 'upcoming', label: t('events.upcoming') }, { value: 'past', label: t('events.past') }]} />
      {!list && !error ? <Loading /> : null}
      {error && !list ? <Empty icon="alert" title={errorText(error)}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}
      {list && !list.length ? <Card><Empty icon="glass" title={t('events.none')} body={t('events.noneBody')} /></Card> : null}
      {list?.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {list.map((e) => {
            const pct = e.needed ? e.filled / e.needed : 1;
            const line = [`${time(e.start)}${e.end ? `–${time(e.end)}` : ''}`, e.room || t('events.tbd'), e.guestCount ? tn('events.guests', e.guestCount) : ''].filter(Boolean).join(' · ');
            return (
              <Pressable key={e.id} onPress={() => router.push({ pathname: '/events/[id]', params: { id: e.id } })} accessibilityRole="button"
                accessibilityLabel={`${e.name}, ${date(e.date, 'long')}, ${line}${isStatus(e.status) ? `, ${t(`events.status.${e.status}`)}` : ''}`}
                style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : 'transparent' }]}>
                <View style={[styles.date, { backgroundColor: c.surface2 }]}>
                  <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase' }}>{date(e.date, 'weekday')}</Txt>
                  <Txt v="h2" style={{ lineHeight: 22 }}>{date(e.date, 'day')}</Txt>
                  <Txt v="tiny" tone="muted">{date(e.date, 'dayMonth').replace(/\d+/, '').trim()}</Txt>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Txt bold>{e.name}</Txt>
                  <Txt v="small" tone="muted">{line}</Txt>
                  <View style={styles.badges}>
                    {isStatus(e.status) ? <Badge tone={STATUS_TONE[e.status]} text={t(`events.status.${e.status}`)} /> : null}
                    {e.needed > 0 ? <Badge tone={pct < 1 ? 'warn' : 'ok'} text={t('events.staffed', { filled: e.filled, needed: e.needed })} /> : null}
                  </View>
                </View>
                <Icon name="right" size={16} color={c.text3} />
              </Pressable>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 72 },
  date: { width: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
