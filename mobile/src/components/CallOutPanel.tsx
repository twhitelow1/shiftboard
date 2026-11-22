// On your own upcoming shift: "Can't make it? Call out". Opens to the manager on duty with Call and Text buttons,
// and the restaurant's call-out procedure (the manual page marked as the call-out page). Like the website's
// CallOutPanel (web/src/pages/TrainingShared.jsx). Needs the Training feature (the manager on duty is part of it).
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { localize } from '@/lib/training';
import type { ManualPage, ModInfo } from '@/lib/types';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ModCard } from './ModCard';
import { Button, Loading, Txt, useColors } from './ui';

export function CallOutPanel() {
  const { t, lang } = useI18n();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const page = useRpc<ManualPage | null>('manual.get', { callOut: true }, [], open);
  const mod = useRpc<ModInfo>('mod.get', {}, [], open);
  const shown = page.data ? localize(page.data, lang) : null;
  return (
    <View style={[styles.box, { borderColor: open ? c.warn : c.border, backgroundColor: c.surface }]}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.surface2 }]}>
        <View style={[styles.icon, { backgroundColor: c.warnSoft }]}><Icon name="phone" size={18} color={c.warn} /></View>
        <Txt bold style={{ flex: 1 }}>{t('shift.callOut')}</Txt>
        <Icon name={open ? 'up' : 'down'} size={18} color={c.text3} />
      </Pressable>
      {open ? (
        <View style={styles.body}>
          {mod.data ? <ModCard mod={mod.data} compact /> : mod.error ? null : <Loading />}
          {!page.done ? <Loading /> : shown ? (
            <View style={{ gap: 8 }}>
              <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{shown.title}</Txt>
              <Markdown text={shown.body} size={15} />
              <Button kind="ghost" small icon="book" title={t('shift.openInManual')} onPress={() => router.push({ pathname: '/manual/[id]', params: { id: page.data!.id } })}
                style={{ alignSelf: 'flex-start' }} />
            </View>
          ) : <Txt v="small" tone="muted">{t('shift.callOutHelp')}</Txt>}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 56 },
  icon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 12, paddingTop: 0, gap: 12 },
});
