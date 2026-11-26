// Every screen's frame: a header (restaurant logo or back button, title, notifications bell,
// language button) inside the safe area, and a scrolling body with pull to refresh.
// The header is the restaurant's nav color (Settings → Branding), like the website's sidebar and the browser
// bar on a phone; the signed-out screens can take the sign-in backdrop instead (the website's .login).
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { Icon } from './Icon';
import { LanguageButton } from './LanguageButton';
import { OfflineNote, Txt, useColors } from './ui';

export function Screen({ title, back, bell = !back, children, onRefresh, scroll = true, bottomInset = false, contentStyle, backdrop = false }: {
  title: string;
  /** Show a back button instead of the logo. */
  back?: boolean;
  /** Show the notifications bell (signed-in screens; not on screens with a back button). */
  bell?: boolean;
  children: ReactNode;
  onRefresh?: () => Promise<unknown> | void;
  scroll?: boolean;
  /** Pad the bottom for the home indicator (screens without the tab bar). */
  bottomInset?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** The sign-in backdrop (dark, with a glow of the restaurant's color) behind a see-through header. */
  backdrop?: boolean;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { t, tn, stamp } = useI18n();
  const { logoUrl, boot, token, offlineSince, refresh } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const unread = boot?.unread || 0;
  // Pulling down also retries the restaurant's data when the app opened without a connection.
  const pull = onRefresh || offlineSince ? async () => {
    setRefreshing(true);
    try { await Promise.all([onRefresh?.(), offlineSince ? refresh() : null]); } finally { setRefreshing(false); }
  } : undefined;

  const body = (
    <View style={[styles.content, bottomInset && { paddingBottom: 24 + insets.bottom }, contentStyle]}>
      {offlineSince && token ? <OfflineNote text={t('common.offline', { when: stamp(offlineSince) })} /> : null}
      {children}
    </View>
  );
  const fg = backdrop ? '#ffffff' : c.onNav;
  return (
    <View style={[styles.root, { backgroundColor: backdrop ? c.loginBg : c.bg }]}>
      {backdrop ? <LoginBackdrop /> : null}
      {backdrop ? <StatusBar style="light" /> : null}
      <View style={[styles.header, { paddingTop: insets.top },
        backdrop ? { backgroundColor: 'transparent', borderColor: 'transparent' } : { backgroundColor: c.nav, borderColor: c.navBorder }]}>
        <View style={styles.headerRow}>
          {back ? (
            <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="button" accessibilityLabel={t('common.back')} style={styles.iconBtn} hitSlop={4}>
              <Icon name="left" size={24} color={fg} />
            </Pressable>
          ) : backdrop ? null : logoUrl ? ( // on the sign-in backdrop, the screen shows the logo large instead
            <Image source={{ uri: logoUrl }} style={[styles.logo, styles.logoTile]} contentFit="contain" accessibilityIgnoresInvertColors />
          ) : (
            <View style={[styles.logo, styles.mark, { backgroundColor: c.mark }]}><Icon name="calendar" size={16} color={c.onMark} /></View>
          )}
          {/* Long titles (often in Spanish) get two smaller lines instead of being cut off. */}
          <Txt v="h2" lines={2} style={[styles.title, { color: fg }, title.length > 20 && { fontSize: 16, lineHeight: 19 }]}>{title}</Txt>
          {bell && token ? (
            <Pressable onPress={() => router.push('/notifications')} style={styles.iconBtn} hitSlop={4} accessibilityRole="button"
              accessibilityLabel={unread ? `${t('header.notifications')}, ${tn('header.unread', unread)}` : t('header.notifications')} testID="bell">
              <Icon name="bell" size={22} color={fg} />
              {unread > 0 ? <View style={[styles.dot, { backgroundColor: c.bad, borderColor: backdrop ? c.loginBg : c.nav }]}><Text style={styles.dotText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
            </Pressable>
          ) : null}
          <LanguageButton onDark={backdrop || !c.navLight} />
        </View>
      </View>
      {scroll ? (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="never"
            refreshControl={pull ? <RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.brand} colors={[c.brand]} /> : undefined}>
            {body}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : body}
    </View>
  );
}

/**
 * The website's sign-in background (web/src/styles.css .login, recolored by web/src/theme.js): a glow of the
 * restaurant's color from the top left, and without one ShiftBoard's teal from the bottom right.
 */
function LoginBackdrop() {
  const c = useColors();
  const { width, height } = useWindowDimensions();
  // CSS radial-gradient(1200px 600px at 20% -10%, glow 0, transparent 60%): an ellipse 720 × 360 px around that
  // point fading out. Drawn as ellipses filled with a round gradient (stretched to the ellipse), which works the
  // same on phones and in browsers (SVG's own radialGradient has no separate x and y radius).
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        <Defs>
          <RadialGradient id="sbGlow1" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={c.loginGlow} stopOpacity={1} />
            <Stop offset="1" stopColor={c.loginGlow} stopOpacity={0} />
          </RadialGradient>
          {c.loginGlow2 ? (
            <RadialGradient id="sbGlow2" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={c.loginGlow2} stopOpacity={1} />
              <Stop offset="1" stopColor={c.loginGlow2} stopOpacity={0} />
            </RadialGradient>
          ) : null}
        </Defs>
        {c.loginGlow2 ? <Ellipse cx={width * 1.1} cy={height * 1.1} rx={900 * 0.55} ry={500 * 0.55} fill="url(#sbGlow2)" /> : null}
        <Ellipse cx={width * 0.2} cy={height * -0.1} rx={1200 * 0.6} ry={600 * 0.6} fill="url(#sbGlow1)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerRow: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 6 },
  title: { flex: 1, marginLeft: 4 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  logoTile: { backgroundColor: '#ffffff', padding: 3 }, // like the website's logo: on a white tile, whatever the header color
  mark: { alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  dot: { position: 'absolute', top: 6, right: 4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  dotText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  content: { padding: 16, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
});
