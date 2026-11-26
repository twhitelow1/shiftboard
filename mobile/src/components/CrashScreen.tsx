// When a screen crashes: "Something went wrong" with Reload and Report this, in the person's language, instead of
// a blank screen. The root layout and the signed-in layout export it as expo-router's ErrorBoundary. It needs
// nothing from the app's providers (they may be what broke): its own language, colors and safe area.
import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { phoneLanguage, translate, type Lang, type MsgKey } from '@/i18n';
import { canReport, reportError, sendReport } from '@/lib/errors';
import { getItem } from '@/lib/storage';

export function CrashScreen({ error, retry }: ErrorBoundaryProps) {
  const [lang, setLang] = useState<Lang>(phoneLanguage);
  const [step, setStep] = useState<'idle' | 'form' | 'sending' | 'sent' | 'failed'>('idle');
  const [text, setText] = useState('');
  const dark = useColorScheme() === 'dark';
  const c = dark
    ? { bg: '#0b1020', card: '#121a2e', text: '#e6ebf5', muted: '#aab5cb', border: '#22304f', brand: '#818cf8', warn: '#fbbf24', warnSoft: '#2a2110' }
    : { bg: '#f4f5f7', card: '#ffffff', text: '#0f172a', muted: '#475569', border: '#e3e7ed', brand: '#4f46e5', warn: '#b45309', warnSoft: '#fff5e1' };
  const t = (k: MsgKey) => translate(lang, k);
  useEffect(() => { getItem('language').then((v) => { if (v === 'en' || v === 'es') setLang(v); }).catch(() => {}); }, []);
  useEffect(() => { reportError(error, 'boundary'); }, [error]);

  const reload = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.reload();
    else retry().catch(() => {});
  };
  const send = async () => {
    setStep('sending');
    try {
      await sendReport({ text: text.trim().length >= 3 ? text.trim() : t('crash.title'), error, lang });
      setStep('sent');
    } catch { setStep('failed'); }
  };
  const button = (label: string, onPress: () => void, primary = false, disabled = false) => (
    <Pressable accessibilityRole="button" onPress={disabled ? undefined : onPress} disabled={disabled}
      style={({ pressed }) => [styles.btn, primary ? { backgroundColor: c.brand, borderColor: c.brand } : { borderColor: c.border, backgroundColor: c.card }, (pressed || disabled) && { opacity: 0.7 }]}>
      <Text style={[styles.btnText, { color: primary ? '#fff' : c.text }]}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.wrap, { backgroundColor: c.bg }]}>
        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]} accessibilityRole="alert">
          <View style={[styles.icon, { backgroundColor: c.warnSoft }]}><Text style={{ color: c.warn, fontSize: 24, fontWeight: '800' }}>!</Text></View>
          <Text style={[styles.title, { color: c.text }]}>{t('crash.title')}</Text>
          <Text style={[styles.body, { color: c.muted }]}>
            {step === 'sent' ? t('crash.sent') : step === 'failed' ? t('crash.notSent') : t('crash.body')}
          </Text>
          {step === 'form' || step === 'sending' ? (
            <TextInput value={text} onChangeText={setText} multiline placeholder={translate(lang, 'report.whatPlaceholder')} placeholderTextColor={c.muted}
              style={[styles.input, { color: c.text, borderColor: c.border }]} maxLength={2000} autoFocus />
          ) : null}
          <View style={styles.row}>
            {button(t('crash.reload'), reload, step !== 'form')}
            {canReport() && (step === 'idle' || step === 'failed') ? button(t('crash.report'), () => setStep('form')) : null}
            {step === 'form' || step === 'sending' ? button(step === 'sending' ? t('crash.sending') : translate(lang, 'common.send'), send, true, step === 'sending') : null}
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: 16, padding: 22, alignItems: 'center', gap: 10 },
  icon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  input: { alignSelf: 'stretch', minHeight: 84, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 16, textAlignVertical: 'top' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 4 },
  btn: { minWidth: 120, minHeight: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
});
