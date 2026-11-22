// The app's root: language, session and toasts, the theme in the restaurant's colors, and the
// top-level stack. Signed-out screens live in (auth), signed-in screens in (app).
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components/ui';
import { I18nProvider, useI18n } from '@/i18n';
import { setBadge, setChannelName, useTappedNotificationLink } from '@/lib/push';
import { routeForLink } from '@/lib/schedule';
import { SessionProvider, useSession } from '@/lib/session';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const { ready, colors, boot } = useSession();
  const { t } = useI18n();
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  useEffect(() => { setChannelName(t('push.channel')); }, [t]);
  useEffect(() => { if (boot) setBadge(boot.unread); }, [boot?.unread]); // eslint-disable-line react-hooks/exhaustive-deps
  const theme = useMemo(() => {
    const base = colors.dark ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: colors.brand, background: colors.bg, card: colors.surface, text: colors.text, border: colors.border } };
  }, [colors]);
  if (!ready) return null;
  return (
    <ThemeProvider value={theme}>
      <StatusBar style={colors.dark ? 'light' : 'dark'} />
      <OpenTappedNotification />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
        <Stack.Screen name="join" />
      </Stack>
    </ThemeProvider>
  );
}

/** Tapping a push notification opens the matching screen (once signed in). */
function OpenTappedNotification() {
  const tapped = useTappedNotificationLink();
  const { boot } = useSession();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!tapped || !boot || handled.current === tapped.id) return;
    handled.current = tapped.id;
    router.push(routeForLink(tapped.link));
  }, [tapped, boot]);
  return null;
}
