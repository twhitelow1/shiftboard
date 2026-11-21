// First screen: which restaurant? People type their restaurant's ShiftBoard address (or paste
// the invite link). Opening an invite link or QR code (shiftboard://join?server=…) skips this.
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Button, Card, Field, Notice, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ApiError, fetchConfig, parseServerInput } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function Welcome() {
  const { t } = useI18n();
  const c = useColors();
  const { server, setServer } = useSession();
  const [address, setAddress] = useState(server ? server.replace(/^https:\/\//, '') : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setError('');
    const origin = parseServerInput(address);
    if (!origin) return setError(t('welcome.badAddress'));
    setBusy(true);
    try {
      const cfg = await fetchConfig(origin);
      await setServer(origin, cfg);
      router.replace('/sign-in');
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'network' ? t('common.networkError') : t('welcome.notShiftBoard'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="ShiftBoard" bell={false} bottomInset>
      <View style={{ alignItems: 'center', gap: 10, marginTop: 12, marginBottom: 8 }}>
        <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="calendar" size={38} color={c.onBrand} />
        </View>
        <Txt v="title" style={{ textAlign: 'center' }}>{t('welcome.title')}</Txt>
        <Txt tone="muted" style={{ textAlign: 'center' }}>{t('welcome.lead')}</Txt>
      </View>
      <Card style={{ gap: 14 }}>
        <Field label={t('welcome.addressLabel')} help={t('welcome.addressHelp')} value={address} onChangeText={setAddress}
          placeholder={t('welcome.addressPlaceholder')} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL"
          returnKeyType="go" onSubmitEditing={go} testID="address" />
        {error ? <Notice tone="bad" text={error} /> : null}
        <Button kind="primary" title={busy ? t('welcome.checking') : t('welcome.next')} busy={busy} onPress={go} disabled={!address.trim()} />
      </Card>
    </Screen>
  );
}
