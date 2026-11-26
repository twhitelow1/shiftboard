// The managers on duty today (mod.get, worked out on the server from today's posted schedule): every manager on
// the schedule, each with their shift and Call (tel:) and Text (sms:) buttons. Who's on now comes first and is
// highlighted (the one in charge at the top), then later today, then earlier. With nobody on the schedule, the
// restaurant's call-out line. Like the website's ModCard. These are the only coworker phone numbers staff can
// get; everyone else's stays with shift leads and managers (and someone who already went home keeps theirs too).
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import type { ModInfo, ModManager } from '@/lib/types';
import { Icon } from './Icon';
import { Badge, Button, Card, Txt, useColors, useToast } from './ui';

const dial = (phone: string) => String(phone || '').replace(/[^\d+]/g, '');

/** Open tel: or sms:, or say the number when this phone can't (a tablet, the web preview). */
export function usePhoneLink() {
  const toast = useToast();
  const { t } = useI18n();
  return async (kind: 'tel' | 'sms', phone: string) => {
    const url = `${kind}:${dial(phone)}`;
    try {
      await Linking.openURL(url);
    } catch {
      toast(t('mod.cantCall', { number: phone }), 'bad');
    }
  };
}

/** The managers to show: mod.managers, or (an older server) the one person it named. */
export function modManagers(mod: ModInfo): ModManager[] {
  if (mod.managers) return mod.managers;
  if (!mod.person) return [];
  const state = mod.status === 'now' || mod.status === 'override' ? 'now' : mod.status === 'next' ? 'later' : 'planned';
  return [{ ...mod.person, state, inCharge: true }];
}

export function ModCard({ mod: given, compact = false }: { mod?: ModInfo | null; compact?: boolean }) {
  const { t, time, date } = useI18n();
  const c = useColors();
  const loaded = useRpc<ModInfo>('mod.get', {}, [], !given);
  const phone = usePhoneLink();
  const mod = given || loaded.data;
  if (!mod) return null;
  const list = modManagers(mod);
  const anyPhone = list.some((m) => m.phone);
  const line = (m: ModManager) => {
    const s = m.shift;
    if (!s) return m.state === 'now' ? t('mod.today') : '';
    const span = `${time(s.start)}${s.end ? `–${time(s.end)}` : ''}`;
    if (m.state === 'now') return `${t('mod.onNow')} · ${span}`;
    if (m.state === 'later') return `${t('mod.inAt', { time: time(s.start) })}${s.end ? `–${time(s.end)}` : ''}`;
    if (m.state === 'earlier') return t('mod.earlierToday', { time: span });
    return t('mod.planned', { date: date(mod.date), time: time(s.start) });
  };
  return (
    <Card style={{ gap: compact ? 8 : 12, paddingVertical: compact ? 12 : undefined }}>
      <View style={styles.main}>
        {compact ? null : <View style={[styles.icon, { backgroundColor: c.brandSoft }]}><Icon name="phone" size={20} color={c.brand} /></View>}
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="tiny" tone="muted" bold style={styles.kicker}>{list.length > 1 ? t('mod.titleMany', { count: list.length }) : t('mod.title')}</Txt>
          {list.length ? null : <Txt v="small" tone="muted">{t('mod.none')}</Txt>}
        </View>
      </View>
      {list.map((m) => {
        const on = m.state === 'now';
        return (
          <View key={m.id} style={[styles.person, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : 'transparent', opacity: m.state === 'earlier' ? 0.75 : 1 }]}>
            <View style={{ flex: 1, gap: 1 }} accessible accessibilityLabel={[m.name, m.inCharge && list.length > 1 ? t('mod.inCharge') : '', line(m)].filter(Boolean).join(', ')}>
              <View style={styles.nameRow}>
                <Txt bold>{m.name}</Txt>
                {m.inCharge && list.length > 1 ? <Badge text={t('mod.inCharge')} tone="brand" /> : null}
              </View>
              {line(m) ? <Txt v="small" tone="muted">{line(m)}</Txt> : null}
              {m.phone ? <Txt v="small" tone="brand">{m.phone}</Txt> : null}
            </View>
            {m.phone ? (
              <>
                <Pressable onPress={() => phone('tel', m.phone)} accessibilityRole="button" accessibilityLabel={t('mod.callName', { name: m.name })}
                  style={({ pressed }) => [styles.round, { backgroundColor: on ? c.brand : c.surface2, opacity: pressed ? 0.8 : 1 }]}>
                  <Icon name="phone" size={20} color={on ? c.onBrand : c.brand} />
                </Pressable>
                <Pressable onPress={() => phone('sms', m.phone)} accessibilityRole="button" accessibilityLabel={t('mod.textName', { name: m.name })}
                  style={({ pressed }) => [styles.round, { backgroundColor: c.surface2, opacity: pressed ? 0.8 : 1 }]}>
                  <Icon name="message" size={20} color={c.brand} />
                </Pressable>
              </>
            ) : m.state !== 'earlier' ? <Txt v="tiny" tone="faint" style={{ maxWidth: '35%' }}>{t('mod.noPhoneShort')}</Txt> : null}
          </View>
        );
      })}
      {mod.callOutPhone ? (
        <Button small={compact} kind={anyPhone ? 'ghost' : 'secondary'} icon="phone" title={anyPhone ? t('mod.callOutLine') : `${t('mod.callOutLine')} · ${mod.callOutPhone}`}
          label={t('mod.callOutLineNumber', { number: mod.callOutPhone })} onPress={() => phone('tel', mod.callOutPhone)}
          style={compact ? { alignSelf: 'flex-start' } : undefined} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  main: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  kicker: { textTransform: 'uppercase', letterSpacing: 0.6 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
