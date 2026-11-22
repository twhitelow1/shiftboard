// Notifications: the same list as the website's bell. Opening it marks everything read.
// The texts come from the server as they are (the server will localize them in a later pass).
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Button, Card, Empty, Loading, Notice, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { pushStatus, registerForPush, type PushStatus } from '@/lib/push';
import { routeForLink } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import type { AppNotification } from '@/lib/types';

export default function Notifications() {
  const { t, stamp } = useI18n();
  const c = useColors();
  const { client, refresh, boot } = useApp();
  const { data, error, reload } = useRpc<AppNotification[]>('notifications.list');
  const [push, setPush] = useState<PushStatus>('unavailable');
  useEffect(() => { pushStatus().then(setPush).catch(() => {}); }, []);
  useEffect(() => {
    if (data && data.some((n) => !n.read) && boot.unread) client.call('notifications.readAll').then(refresh).catch(() => {});
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const turnOn = async () => {
    if (push === 'ask') { await registerForPush(client).catch(() => {}); setPush(await pushStatus()); } else Linking.openSettings();
  };

  return (
    <Screen title={t('notifications.title')} back bottomInset onRefresh={reload}>
      {push === 'off' || push === 'ask' ? (
        <Notice tone="warn" icon="bell" text={t('notifications.pushOff')}>
          <Button small kind="primary" title={t('notifications.pushTurnOn')} onPress={turnOn} style={{ alignSelf: 'flex-start' }} />
        </Notice>
      ) : null}
      {!data && !error ? <Loading /> : null}
      {error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}
      {data && !data.length ? <Card><Empty icon="bell" title={t('notifications.empty')} body={t('notifications.emptyBody')} /></Card> : null}
      {data?.length ? (
        <Card pad={false} style={{ overflow: 'hidden' }}>
          {data.map((n) => (
            <Pressable key={n.id} onPress={() => router.push(routeForLink(n.link))} accessibilityRole="button"
              style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : !n.read ? c.brandSoft : 'transparent' }]}>
              <View style={[styles.dot, { backgroundColor: n.read ? 'transparent' : c.brand }]} />
              <View style={{ flex: 1, gap: 3 }}>
                <Txt style={{ fontWeight: n.read ? '400' : '600' }}>{n.text}</Txt>
                <Txt v="tiny" tone="faint">{stamp(n.at)}</Txt>
              </View>
              <Icon name="right" size={16} color={c.text3} />
            </Pressable>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 56 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
