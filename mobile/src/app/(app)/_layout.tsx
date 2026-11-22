// Signed-in screens. If the session ends (expired, or a password change elsewhere), every
// screen here sends the person back to sign in.
import { Redirect, Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { Button, Empty, Loading } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useErrorText } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function AppLayout() {
  const { token, server, boot, bootError, refresh, colors } = useSession();
  const { t } = useI18n();
  const errorText = useErrorText();
  if (!token || !server) return <Redirect href="/" />;
  if (!boot) {
    return (
      <Screen title="ShiftBoard" bell={false}>
        {bootError ? (
          <Empty icon="alert" title={errorText(bootError)}><Button kind="primary" title={t('common.retry')} onPress={refresh} /></Empty>
        ) : <Loading label={t('common.loading')} />}
      </Screen>
    );
  }
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
