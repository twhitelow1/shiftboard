// Invite links and QR codes: shiftboard://join?server=https://yourrestaurant.vercel.app
// The app checks the address is a ShiftBoard server and shows the restaurant's name before
// switching to it, so a link can't quietly point the app somewhere else.
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
  const { server: current, token, setServer } = useSession();
  const params = useLocalSearchParams<{ server?: string }>();
  const origin = parseServerInput(params.server || '');
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!origin) return setError(t('welcome.joinBad'));
    if (origin === current && token) return router.replace('/shifts'); // already here
    fetchConfig(origin).then(setCfg).catch((e) => setError(e instanceof ApiError && e.code === 'network' ? t('common.networkError') : t('welcome.joinBad')));
  }, [origin]); // eslint-disable-line react-hooks/exhaustive-deps

  const yes = async () => {
    if (!origin) return;
    await setServer(origin, cfg);
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
