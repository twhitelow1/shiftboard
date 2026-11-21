// The bottom tabs (see src/navigation.ts for the list and where Training slots in).
import { Tabs } from 'expo-router/tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { TABS } from '@/navigation';

export default function TabsLayout() {
  const { t } = useI18n();
  const { colors, boot, canApprove } = useSession();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.text3,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 64 + insets.bottom, paddingTop: 4, paddingBottom: insets.bottom + 4 },
        tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
        tabBarAllowFontScaling: true,
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      {TABS.map((tab) => {
        const badge = boot && tab.badge ? tab.badge(boot, canApprove) : 0;
        return (
          <Tabs.Screen key={tab.name} name={tab.name} options={{
            title: t(tab.title),
            tabBarLabel: t(tab.title),
            tabBarAccessibilityLabel: t(tab.title),
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
