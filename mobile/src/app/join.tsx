// Invite links and QR codes: <scheme>://join?server=https://yourrestaurant.vercel.app (scheme: mobile/brand.js).
// The app checks the address is a ShiftBoard server and shows the restaurant's name before
// opening it, so a link can't quietly point the app somewhere else. Restaurants already on the
// phone stay signed in: the new one is added to the list (More → Restaurants).
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, Loading, Notice, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ApiError, displayServer, fetchConfig, parseServerInput } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { ServerConfig } from '@/lib/types';

export default function Join() {
  const { t } = useI18n();
  const { accounts, openRestaurant } = useSession();
  const params = useLocalSearchParams<{ server?: string }>();
  const origin = parseServerInput(params.server || '');
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!origin) return setError(t('welcome.joinBad'));
    if (accounts.some((a) => a.server === origin && a.signedIn)) { // already signed in there
      openRestaurant(origin).then(() => router.replace('/shifts'));
      return;
    }
    fetchConfig(origin).then(setCfg).catch((e) => setError(e instanceof ApiError && e.code === 'network' ? t('common.networkError') : t('welcome.joinBad')));
  }, [origin]); // eslint-disable-line react-hooks/exhaustive-deps

  const yes = async () => {
    if (!origin) return;
    await openRestaurant(origin, cfg);
    router.replace('/sign-in');
  };

  return (
    <Screen title={t('welcome.joinTitle')} bell={false} bottomInset>
      {error ? (
        <Card style={{ gap: 12 }}>
          <Notice tone="bad" text={error} />
          <Button kind="primary" title={t('welcome.joinNo')} onPress={() => router.replace('/welcome')} />
        </Card>
      ) : !cfg || !origin ? (
        <Loading label={t('welcome.checking')} />
      ) : (
        <Card style={{ gap: 12 }}>
          <Txt v="h2">{cfg.brand?.name || displayServer(origin)}</Txt>
          <Txt tone="muted">{t('welcome.joinBody', { name: cfg.brand?.name || displayServer(origin) })}</Txt>
          <Txt v="small" tone="faint">{t('welcome.joinAddress', { address: displayServer(origin) })}</Txt>
          <View style={{ gap: 8, marginTop: 4 }}>
            <Button kind="primary" title={t('welcome.joinYes')} onPress={yes} />
            <Button kind="ghost" title={t('welcome.joinNo')} onPress={() => router.replace('/welcome')} />
          </View>
        </Card>
      )}
    </Screen>
  );
}
