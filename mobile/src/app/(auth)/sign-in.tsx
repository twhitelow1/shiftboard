// Sign in with the same email and password as the website.
import { Image } from 'expo-image';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Button, Card, Field, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { displayServer } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function SignIn() {
  const { t } = useI18n();
  const c = useColors();
  const errorText = useErrorText();
  const { server, config, logoUrl, expired, signIn, startAdding } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!server) return <Redirect href="/welcome" />;
  const name = config?.brand?.name || displayServer(server);

  const go = async () => {
    setError('');
    if (!email.trim() || !password) return setError(t('signIn.missing'));
    setBusy(true);
    try {
      await signIn(email, password);
      router.replace('/shifts');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('signIn.title')} bell={false} bottomInset>
      <View style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
        {logoUrl ? (
          <Image source={{ uri: logoUrl }} style={{ width: 88, height: 88, borderRadius: 18 }} contentFit="contain" />
        ) : (
          <View style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="calendar" size={32} color={c.onBrand} />
          </View>
        )}
        <Txt v="title" style={{ textAlign: 'center' }}>{name}</Txt>
        <Txt v="small" tone="faint">{displayServer(server)}</Txt>
      </View>
      {expired ? <Notice tone="warn" icon="clock" text={t('signIn.expired')} /> : null}
      {config?.paused ? <Notice tone="bad" text={t('welcome.paused')} /> : null}
      <Card style={{ gap: 14 }}>
        <Field label={t('signIn.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
          textContentType="username" autoComplete="email" returnKeyType="next" testID="email" />
        <Field label={t('signIn.password')} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password"
          returnKeyType="go" onSubmitEditing={go} testID="password" />
        {error ? <Notice tone="bad" text={error} /> : null}
        <Button kind="primary" title={busy ? t('signIn.busy') : t('signIn.submit')} busy={busy} onPress={go} />
        <Button kind="ghost" title={t('signIn.forgot')} onPress={() => router.push({ pathname: '/forgot', params: { email } })} />
      </Card>
      <Row style={{ justifyContent: 'center', flexWrap: 'wrap', gap: 4 }}>
        <Txt v="small" tone="muted">{t('signIn.notYou')}</Txt>
        <Button kind="ghost" small title={t('signIn.change')} onPress={() => { startAdding(); router.replace('/welcome'); }} />
      </Row>
    </Screen>
  );
}
