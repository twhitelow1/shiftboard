// Forgot password: the server emails a one-time link. The link opens the website's reset page
// (the web reset flow), where the new password is set; then the person signs in here.
import * as WebBrowser from 'expo-web-browser';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Screen } from '@/components/Screen';
import { Button, Card, Field, Notice, Txt } from '@/components/ui';
import { useI18n } from '@/i18n';
import { forgotPassword } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function Forgot() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const { server, config } = useSession();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email || '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!server) return <Redirect href="/welcome" />;
  const emailOn = config?.email !== false;

  const go = async () => {
    setError('');
    if (!email.trim()) return;
    setBusy(true);
    try {
      await forgotPassword(server, email);
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('forgot.title')} back bell={false} bottomInset>
      {sent ? (
        <Card style={{ gap: 12 }}>
          <Txt v="h2">{t('forgot.sentTitle')}</Txt>
          <Txt tone="muted">{t('forgot.sentBody', { email: email.trim() })}</Txt>
          <Button kind="primary" title={t('forgot.backToSignIn')} onPress={() => router.replace('/sign-in')} />
        </Card>
      ) : !emailOn ? (
        <Card style={{ gap: 12 }}>
          <Notice tone="warn" text={t('forgot.noEmail')} />
          <Button title={t('forgot.backToSignIn')} onPress={() => router.replace('/sign-in')} />
        </Card>
      ) : (
        <Card style={{ gap: 14 }}>
          <Txt tone="muted">{t('forgot.lead')}</Txt>
          <Field label={t('signIn.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            textContentType="username" autoComplete="email" returnKeyType="send" onSubmitEditing={go} testID="forgot-email" />
          {error ? <Notice tone="bad" text={error} /> : null}
          <Button kind="primary" title={busy ? t('forgot.busy') : t('forgot.submit')} busy={busy} disabled={!email.trim()} onPress={go} />
          <Button kind="ghost" icon="external" title={t('forgot.openWeb')} onPress={() => WebBrowser.openBrowserAsync(`${server}/`)} />
        </Card>
      )}
    </Screen>
  );
}
