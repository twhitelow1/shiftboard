// First screen: which restaurant? People type their restaurant's address (or paste the invite link). Opening an
// invite link or QR code (<scheme>://join?server=…) skips this. Restaurants this phone already uses are listed
// first: someone who works at two restaurants on the platform adds the second here (More → Add another restaurant)
// and stays signed in to both.
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Button, Card, Field, Notice, SectionTitle, Txt, useColors } from '@/components/ui';
import { APP_NAME } from '@/brand';
import { useI18n } from '@/i18n';
import { ApiError, displayServer, fetchConfig, parseServerInput } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { useSession, type Account } from '@/lib/session';

export default function Welcome() {
  const { t } = useI18n();
  const c = useColors();
  const { accounts, openRestaurant, forget } = useSession();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setError('');
    const origin = parseServerInput(address);
    if (!origin) return setError(t('welcome.badAddress'));
    setBusy(true);
    try {
      const cfg = await fetchConfig(origin);
      await openRestaurant(origin, cfg);
      router.replace('/'); // signed in there already → My Shifts; otherwise sign in
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'network' ? t('common.networkError') : t('welcome.notShiftBoard'));
    } finally {
      setBusy(false);
    }
  };
  const open = async (a: Account) => {
    await openRestaurant(a.server);
    router.replace('/');
  };
  const remove = async (a: Account) => {
    const name = a.name || displayServer(a.server);
    if (await confirm(t('welcome.removeTitle', { name }), t('welcome.removeBody'), t('common.remove'), t('common.cancel'), true)) await forget(a.server);
  };

  return (
    <Screen title={APP_NAME} bell={false} bottomInset>
      <View style={{ alignItems: 'center', gap: 10, marginTop: 12, marginBottom: 8 }}>
        <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="calendar" size={38} color={c.onBrand} />
        </View>
        <Txt v="title" style={{ textAlign: 'center' }}>{t('welcome.title')}</Txt>
        <Txt tone="muted" style={{ textAlign: 'center' }}>{t('welcome.lead')}</Txt>
      </View>
      {accounts.length ? (
        <>
          <SectionTitle title={t('welcome.yourRestaurants')} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {accounts.map((a) => {
              const name = a.name || displayServer(a.server);
              return (
                <View key={a.server} style={[styles.row, { borderColor: c.border }]}>
                  <Pressable onPress={() => open(a)} accessibilityRole="button" accessibilityLabel={`${name}, ${a.signedIn ? t('welcome.signedInAs', { name: a.userName || '' }) : t('welcome.signedOut')}`}
                    style={({ pressed }) => [styles.main, pressed && { backgroundColor: c.surface2 }]}>
                    <View style={[styles.dot, { backgroundColor: a.color || c.brand }]}><Icon name="store" size={18} color="#fff" /></View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt bold>{name}</Txt>
                      <Txt v="small" tone="muted">{a.signedIn ? (a.userName ? t('welcome.signedInAs', { name: a.userName }) : displayServer(a.server)) : t('welcome.signedOut')}</Txt>
                    </View>
                    <Icon name="right" size={18} color={c.text3} />
                  </Pressable>
                  <Pressable onPress={() => remove(a)} accessibilityRole="button" accessibilityLabel={`${t('common.remove')}: ${name}`} style={styles.x} hitSlop={2}>
                    <Icon name="x" size={18} color={c.text3} />
                  </Pressable>
                </View>
              );
            })}
          </Card>
          <SectionTitle title={t('welcome.orAdd')} />
        </>
      ) : null}
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 14, paddingRight: 8, minHeight: 60 },
  dot: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  x: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: 4 },
});
