// Signed-in screens. If the session ends (expired, or a password change elsewhere), every
// screen here sends the person back to sign in.
import { Redirect, Stack } from 'expo-router';

import { APP_NAME } from '@/brand';
import { Screen } from '@/components/Screen';
import { Button, Empty, Loading } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText } from '@/lib/hooks';
import { useSession } from '@/lib/session';

// A crash in a signed-in screen: "Something went wrong" with Reload and Report this (components/CrashScreen.tsx).
export { CrashScreen as ErrorBoundary } from '@/components/CrashScreen';

export default function AppLayout() {
  const { token, server, boot, bootError, refresh, colors } = useSession();
  const { t } = useI18n();
  const errorText = useErrorText();
  if (!token || !server) return <Redirect href="/" />;
  if (!boot) {
    return (
      <Screen title={APP_NAME} bell={false}>
        {bootError ? (
          <Empty icon="alert" title={errorText(bootError)}><Button kind="primary" title={t('common.retry')} onPress={refresh} /></Empty>
        ) : <Loading label={t('common.loading')} />}
      </Screen>
    );
  }
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
