// The manager on duty (mod.get, worked out on the server from today's posted schedule): name, shift, and Call
// (tel:) and Text (sms:) buttons, plus the restaurant's call-out line. Like the website's ModCard. It's the one
// coworker phone number staff can get; everyone else's stays with shift leads and managers.
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { ModInfo } from '@/lib/types';
import { Icon } from './Icon';
import { Button, Card, Txt, useColors, useToast } from './ui';

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

export function ModCard({ mod: given, compact = false }: { mod?: ModInfo | null; compact?: boolean }) {
  const { t, time, date } = useI18n();
  const c = useColors();
  const { has } = useSession();
  const loaded = useRpc<ModInfo>('mod.get', {}, [], !given && has('training'));
  const phone = usePhoneLink();
  const mod = given || loaded.data;
  if (!mod) return null;
  const p = mod.person;
  const s = p?.shift;
  const line = !p ? '' : mod.status === 'now' ? [t('mod.onNow'), s?.end ? t('mod.until', { time: time(s.end) }) : ''].filter(Boolean).join(' · ')
    : mod.status === 'next' && s ? t('mod.inAt', { time: time(s.start) })
      : mod.status === 'planned' && s ? t('mod.planned', { date: date(mod.date), time: time(s.start) })
        : mod.status === 'override' ? (s ? `${t('mod.today')} · ${time(s.start)}${s.end ? `–${time(s.end)}` : ''}` : t('mod.today')) : '';
  if (compact) {
    // One row: who and when, then round Call and Text buttons (My Shifts, the call-out panel).
    return (
      <Card style={{ gap: 8, paddingVertical: 12 }}>
        <View style={styles.main}>
          <View style={{ flex: 1, gap: 1 }} accessible accessibilityLabel={[t('mod.title'), p?.name || t('mod.none'), line].filter(Boolean).join(', ')}>
            <Txt v="tiny" tone="muted" bold style={styles.kicker}>{t('mod.title')}</Txt>
            {p ? <Txt bold>{p.name}</Txt> : <Txt v="small" tone="muted">{t('mod.none')}</Txt>}
            {line ? <Txt v="small" tone="muted">{line}</Txt> : null}
          </View>
          {p?.phone ? (
            <>
              <Pressable onPress={() => phone('tel', p.phone)} accessibilityRole="button" accessibilityLabel={t('mod.callName', { name: p.name })}
                style={({ pressed }) => [styles.round, { backgroundColor: c.brand, opacity: pressed ? 0.8 : 1 }]}>
                <Icon name="phone" size={20} color={c.onBrand} />
              </Pressable>
              <Pressable onPress={() => phone('sms', p.phone)} accessibilityRole="button" accessibilityLabel={t('mod.textName', { name: p.name })}
                style={({ pressed }) => [styles.round, { backgroundColor: c.brandSoft, opacity: pressed ? 0.8 : 1 }]}>
                <Icon name="message" size={20} color={c.brand} />
              </Pressable>
            </>
          ) : null}
        </View>
        {p && !p.phone ? <Txt v="small" tone="muted">{t('mod.noPhone', { name: p.name })}</Txt> : null}
        {mod.callOutPhone && !p?.phone ? (
          <Button small icon="phone" title={`${t('mod.callOutLine')} · ${mod.callOutPhone}`} label={t('mod.callOutLineNumber', { number: mod.callOutPhone })}
            onPress={() => phone('tel', mod.callOutPhone)} style={{ alignSelf: 'flex-start' }} />
        ) : null}
      </Card>
    );
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={styles.main} accessible accessibilityLabel={[t('mod.title'), p?.name || t('mod.none'), line].filter(Boolean).join(', ')}>
        <View style={[styles.icon, { backgroundColor: c.brandSoft }]}><Icon name="phone" size={20} color={c.brand} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="tiny" tone="muted" bold style={styles.kicker}>{t('mod.title')}</Txt>
          {p ? (
            <>
              <Txt v="h3">{p.name}</Txt>
              {line ? <Txt v="small" tone="muted">{line}</Txt> : null}
            </>
          ) : <Txt v="small" tone="muted">{t('mod.none')}</Txt>}
          {mod.alsoOn?.length ? <Txt v="tiny" tone="faint">{t('mod.alsoOn', { names: mod.alsoOn.map((x) => x.name).join(', ') })}</Txt> : null}
        </View>
      </View>
      {p?.phone ? (
        <View style={styles.actions}>
          <Button kind="primary" icon="phone" title={t('mod.call')} label={t('mod.callName', { name: p.name })} onPress={() => phone('tel', p.phone)} style={{ flex: 1 }} />
          <Button icon="message" title={t('mod.text')} label={t('mod.textName', { name: p.name })} onPress={() => phone('sms', p.phone)} style={{ flex: 1 }} />
        </View>
      ) : p ? <Txt v="small" tone="muted">{t('mod.noPhone', { name: p.name })}</Txt> : null}
      {mod.callOutPhone ? (
        <Button kind={p?.phone ? 'ghost' : 'secondary'} icon="phone" title={p?.phone ? t('mod.callOutLine') : `${t('mod.callOutLine')} · ${mod.callOutPhone}`}
          label={t('mod.callOutLineNumber', { number: mod.callOutPhone })} onPress={() => phone('tel', mod.callOutPhone)} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  main: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  kicker: { textTransform: 'uppercase', letterSpacing: 0.6 },
  actions: { flexDirection: 'row', gap: 8 },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
