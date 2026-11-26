// Pieces the Feedback box screens share (app/(app)/feedback*.tsx): the status badge, "How anonymous is this?" and
// the conversation (readers' replies with their name and time; the writer's messages with the date only).
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Badge, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import type { FeedbackMessage, FeedbackStatus } from '@/lib/feedback';

export function StatusBadge({ status, label }: { status?: FeedbackStatus; label?: string }) {
  const tone = ({ new: 'brand', in_progress: 'warn', done: 'ok' } as Record<string, 'brand' | 'warn' | 'ok'>)[status || ''] || 'neutral';
  return <Badge tone={tone} text={label || ''} />;
}

/** "How anonymous is this?", folded. */
export function HowAnonymous() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ minHeight: 40, justifyContent: 'center' }}>
        <Txt v="small" tone="brand" bold>{t('feedback.howAnon')}</Txt>
      </Pressable>
      {open ? (['howAnon1', 'howAnon2', 'howAnon3', 'howAnon4'] as const).map((k) => <Txt key={k} v="small" tone="muted">{t(`feedback.${k}`)}</Txt>) : null}
    </View>
  );
}

export function Thread({ items, mine }: { items: FeedbackMessage[]; mine: string }) {
  const { t, date, stamp } = useI18n();
  const c = useColors();
  if (!items.length) return <Txt v="small" tone="faint">{t('feedback.noReplies')}</Txt>;
  return (
    <View style={{ gap: 8 }}>
      {items.map((m) => (
        <View key={m.id} style={[styles.bubble, m.from === 'reader' ? { backgroundColor: c.brandSoft, alignSelf: 'flex-start' } : { backgroundColor: c.surface2, alignSelf: 'flex-end' }]}>
          <Txt v="tiny" tone="faint">{m.from === 'reader' ? `${m.name || ''}${m.at ? ` · ${stamp(m.at)}` : ''}` : `${mine}${m.date ? ` · ${date(m.date)}` : ''}`}</Txt>
          <Txt v="small">{m.text}</Txt>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, maxWidth: '92%', gap: 2 },
});
