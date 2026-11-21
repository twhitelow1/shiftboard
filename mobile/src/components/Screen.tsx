// Every screen's frame: a header (restaurant logo or back button, title, notifications bell,
// language button) inside the safe area, and a scrolling body with pull to refresh.
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { Icon } from './Icon';
import { LanguageButton } from './LanguageButton';
import { Txt, useColors } from './ui';

export function Screen({ title, back, bell = !back, children, onRefresh, scroll = true, bottomInset = false, contentStyle }: {
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
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { t, tn } = useI18n();
  const { logoUrl, boot, token } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const unread = boot?.unread || 0;
  const pull = onRefresh ? async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  } : undefined;

  const body = <View style={[styles.content, bottomInset && { paddingBottom: 24 + insets.bottom }, contentStyle]}>{children}</View>;
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top, backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.headerRow}>
          {back ? (
            <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="button" accessibilityLabel={t('common.back')} style={styles.iconBtn} hitSlop={4}>
              <Icon name="left" size={24} color={c.text} />
            </Pressable>
          ) : logoUrl ? (
            <Image source={{ uri: logoUrl }} style={styles.logo} contentFit="contain" accessibilityIgnoresInvertColors />
          ) : (
            <View style={[styles.logo, styles.mark, { backgroundColor: c.brand }]}><Icon name="calendar" size={16} color={c.onBrand} /></View>
          )}
          {/* Long titles (often in Spanish) get two smaller lines instead of being cut off. */}
          <Txt v="h2" lines={2} style={[styles.title, title.length > 20 && { fontSize: 16, lineHeight: 19 }]}>{title}</Txt>
          {bell && token ? (
            <Pressable onPress={() => router.push('/notifications')} style={styles.iconBtn} hitSlop={4} accessibilityRole="button"
              accessibilityLabel={unread ? `${t('header.notifications')}, ${tn('header.unread', unread)}` : t('header.notifications')} testID="bell">
              <Icon name="bell" size={22} color={c.text} />
              {unread > 0 ? <View style={[styles.dot, { backgroundColor: c.bad, borderColor: c.surface }]}><Text style={styles.dotText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
            </Pressable>
          ) : null}
          <LanguageButton />
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerRow: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 6 },
  title: { flex: 1, marginLeft: 4 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  mark: { alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  dot: { position: 'absolute', top: 6, right: 4, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  dotText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  content: { padding: 16, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
});
