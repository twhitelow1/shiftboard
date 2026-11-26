// The app's root: language, session and toasts, the theme in the restaurant's colors, and the
// top-level stack. Signed-out screens live in (auth), signed-in screens in (app).
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CrashScreen } from '@/components/CrashScreen';
import { ToastProvider } from '@/components/ui';
import { I18nProvider, useI18n } from '@/i18n';
import { routeForLink } from '@/lib/links';
import { installErrorHandlers, notePage, setErrorTarget } from '@/lib/errors';
import { setBadge, setChannelName, useTappedNotificationLink } from '@/lib/push';
import { SessionProvider, useSession } from '@/lib/session';

SplashScreen.preventAutoHideAsync().catch(() => {});
installErrorHandlers(); // crashes go to DubLow Digital (src/lib/errors.ts)

// A crash anywhere shows "Something went wrong" with Reload and Report this, not a blank screen.
export { CrashScreen as ErrorBoundary };

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
      <ErrorReporting />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
        <Stack.Screen name="join" />
      </Stack>
    </ThemeProvider>
  );
}

/** Crash reports and Report a problem go to the restaurant open now, with its session; the screen goes along. */
function ErrorReporting() {
  const { server, token } = useSession();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const path = usePathname();
  useEffect(() => { setErrorTarget(server, () => tokenRef.current); }, [server]);
  useEffect(() => { notePage(path); }, [path]);
  return null;
}

/**
 * Tapping a push notification opens the matching screen (once signed in). Its title is the restaurant's name:
 * when it's from another restaurant this phone is signed in to, that one opens first.
 */
function OpenTappedNotification() {
  const tapped = useTappedNotificationLink();
  const { boot, accounts, server, openRestaurant, has } = useSession();
  const handled = useRef<string | null>(null);
  const switched = useRef<string | null>(null);
  useEffect(() => {
    if (!tapped || handled.current === tapped.id) return;
    const from = tapped.title && accounts.find((a) => a.signedIn && a.name === tapped.title);
    if (from && from.server !== server && switched.current !== tapped.id) {
      switched.current = tapped.id;
      openRestaurant(from.server).catch(() => {});
      return;
    }
    if (!boot) return;
    handled.current = tapped.id;
    router.push(routeForLink(tapped.link, has));
  }, [tapped, boot, accounts, server]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
