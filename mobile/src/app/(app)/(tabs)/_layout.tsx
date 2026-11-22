// The bottom tabs (see src/navigation.ts for the list, and why the fourth tab is Training or Time Off).
// A hidden tab (href: null) can still be opened, e.g. Time Off from My Shifts; back returns to where you were.
import { Tabs } from 'expo-router/tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { TABS } from '@/navigation';

export default function TabsLayout() {
  const { t, lang } = useI18n();
  const { colors, boot, canApprove, has } = useSession();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.text3,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 64 + insets.bottom, paddingTop: 4, paddingBottom: insets.bottom + 4 },
        // Spanish labels run longer ("Capacitación"): a point smaller so five fit at 360 px.
        tabBarLabelStyle: { fontSize: lang === 'es' ? 10 : 11, letterSpacing: lang === 'es' ? -0.2 : 0, lineHeight: 14, fontWeight: '600' },
        tabBarItemStyle: { paddingHorizontal: 0 },
        tabBarAllowFontScaling: true,
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      {TABS.map((tab) => {
        const shown = !tab.shown || tab.shown(has);
        const badge = boot && tab.badge ? tab.badge(boot, canApprove) : 0;
        return (
          <Tabs.Screen key={tab.name} name={tab.name} options={{
            href: shown ? undefined : null,
            title: t(tab.title),
            tabBarLabel: t(tab.title),
            tabBarAccessibilityLabel: badge > 0 ? `${t(tab.title)}, ${badge}` : t(tab.title),
            tabBarIcon: ({ color, size }) => <Icon name={tab.icon} color={String(color ?? colors.text3)} size={Math.min(size, 24)} />,
            tabBarBadge: badge > 0 ? badge : undefined,
            tabBarBadgeStyle: { backgroundColor: colors.bad, color: '#fff', fontSize: 11 },
            tabBarButtonTestID: `tab-${tab.name}`,
          }} />
        );
      })}
    </Tabs>
  );
}
