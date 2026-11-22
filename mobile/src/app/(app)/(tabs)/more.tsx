// More: the 86 List (first: the tab bar has no room for it at 360 px), profile, language, notifications, calendar, Training (coming soon), the full website,
// change restaurant, privacy and help, delete my account, sign out.
import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Linking, Share, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Icon } from '@/components/Icon';
import { Badge, Card, ListRow, Txt, useToast } from '@/components/ui';
import { useI18n, type Lang } from '@/i18n';
import { displayServer } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { useAction, useErrorText, useRpc } from '@/lib/hooks';
import { pushStatus, registerForPush, type PushStatus } from '@/lib/push';
import { useApp } from '@/lib/session';
import type { EightySixSummary } from '@/lib/types';

export default function More() {
  const { t, chosen, setLang, date } = useI18n();
  const { me, settings, server, client, signOut, setServer, colors } = useApp();
  const toast = useToast();
  const errorText = useErrorText();
  const [run, busy] = useAction();
  const [push, setPush] = useState<PushStatus>('unavailable');
  useEffect(() => { pushStatus().then(setPush).catch(() => {}); }, []);
  const origin = server!;
  const open = (path: string) => WebBrowser.openBrowserAsync(`${origin}${path}`).catch(() => Linking.openURL(`${origin}${path}`));

  const calendar = async () => {
    try {
      const path = await client.post<string>('/api/rpc-ical-link');
      const https = `${origin}${path}`;
      const webcal = https.replace(/^https?:/, 'webcal:');
      if (await Linking.canOpenURL(webcal).catch(() => false)) await Linking.openURL(webcal);
      else await Share.share({ message: https, url: https });
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };
  const notifications = async () => {
    if (push === 'ask') { await registerForPush(client).catch(() => {}); setPush(await pushStatus()); } else Linking.openSettings();
  };
  const changeRestaurant = async () => {
    if (!(await confirm(t('more.changeRestaurant'), t('more.changeRestaurantConfirm', { name: settings.restaurantName }), t('common.continue'), t('common.cancel')))) return;
    await setServer(null);
    router.replace('/welcome');
  };
  const deleteAccount = async () => {
    if (me.deletionRequestedAt) return toast(t('more.deleteAlready', { date: date(me.deletionRequestedAt.slice(0, 10)) }));
    if (!(await confirm(t('more.deleteTitle'), t('more.deleteBody'), t('more.deleteConfirm'), t('common.cancel'), true))) return;
    await run(() => client.call('account.requestDeletion'), t('more.deleteSent'));
  };
  const out = async () => {
    await signOut();
    router.replace('/sign-in');
  };
  const langValue: Lang | 'phone' = chosen ?? 'phone';
  const out86 = useRpc<EightySixSummary>('eightySix.summary').data?.out || 0;

  return (
    <Screen title={t('more.title')}>
      <Card pad={false} style={{ overflow: 'hidden' }}>
        <ListRow icon="ban" title={t('more.eightySix')} sub={t('more.eightySixHelp')} onPress={() => router.push('/eighty-six')}
          right={out86 ? <Badge tone="bad" text={String(out86)} /> : null} />
      </Card>

      <Card style={{ gap: 4 }}>
        <Txt v="h2">{me.name}</Txt>
        <View style={{ flexDirection: 'row' }}><Badge tone="brand" text={t(`more.role.${me.role}` as const)} /></View>
        {me.email ? <Txt v="small" tone="muted">{me.email}</Txt> : null}
        {me.phone ? <Txt v="small" tone="muted">{me.phone}</Txt> : null}
        <Txt v="small" tone="faint" style={{ marginTop: 6 }}>{t('more.restaurant')}: {settings.restaurantName} · {displayServer(origin)}</Txt>
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 2 }}>
          <Txt v="h3">{t('lang.title')}</Txt>
          <Txt v="small" tone="faint">{t('lang.help')}</Txt>
        </View>
        {([['es', 'Español'], ['en', 'English'], ['phone', t('lang.phone')]] as [Lang | 'phone', string][]).map(([v, label]) => (
          <ListRow key={v} title={label} chevron={false} label={label} onPress={() => setLang(v === 'phone' ? null : v)}
            right={langValue === v ? <Icon name="check" size={20} color={colors.brand} /> : null} />
        ))}
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        {push !== 'unavailable' ? (
          <ListRow icon="bell" title={t('more.notifications')} sub={push === 'on' ? undefined : t('more.notificationsSettings')} onPress={notifications}
            right={<Badge tone={push === 'on' ? 'ok' : 'warn'} text={push === 'on' ? t('more.notificationsOn') : t('more.notificationsOff')} />} />
        ) : null}
        <ListRow icon="calendar" title={t('more.calendar')} sub={t('more.calendarHelp')} onPress={calendar} />
        <ListRow icon="book" title={t('more.training')} right={<Badge text={t('more.soon')} />} onPress={() => router.push('/training')} />
        <ListRow icon="external" title={t('more.web')} sub={displayServer(origin)} onPress={() => open('/')} />
      </Card>

      <Card pad={false} style={{ overflow: 'hidden' }}>
        <ListRow icon="store" title={t('more.changeRestaurant')} onPress={changeRestaurant} />
        <ListRow icon="shield" title={t('more.privacy')} onPress={() => open('/privacy')} />
        <ListRow icon="help" title={t('more.help')} onPress={() => open('/support')} />
        <ListRow icon="trash" title={t('more.delete')} danger onPress={busy ? undefined : deleteAccount} />
        <ListRow icon="logout" title={t('more.signOut')} danger onPress={out} chevron={false} />
      </Card>
      <Txt v="tiny" tone="faint" style={{ textAlign: 'center' }}>{t('more.version', { version: Constants.expoConfig?.version || '1.0.0' })}</Txt>
    </Screen>
  );
}
