// The language switch at the top right of every screen: a globe and the current code (EN / ES).
// One tap switches between English and Español right away, on the same screen. It shares one
// setting with More → Language (saved on the phone, and on the server once signed in).
import { Pressable, StyleSheet, Text } from 'react-native';

import { translate, useI18n } from '@/i18n';
import { Icon } from './Icon';
import { useColors } from './ui';

export function LanguageButton({ onDark = false }: { onDark?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const c = useColors();
  const next = lang === 'en' ? 'es' : 'en';
  const fg = onDark ? '#ffffff' : c.text;
  return (
    <Pressable
      onPress={() => setLang(next)}
      accessibilityRole="button"
      accessibilityLabel={t('lang.change')}
      accessibilityHint={translate(next, 'lang.name')}
      hitSlop={4}
      testID="language-button"
      style={({ pressed }) => [styles.btn, { borderColor: onDark ? 'rgba(255,255,255,.35)' : c.border, opacity: pressed ? 0.7 : 1 }]}>
      <Icon name="globe" size={18} color={fg} />
      <Text style={[styles.code, { color: fg }]}>{lang.toUpperCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { minWidth: 44, minHeight: 44, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  code: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
});
