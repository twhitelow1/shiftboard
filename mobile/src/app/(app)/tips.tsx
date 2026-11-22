// My tips: my own share of the tip pool, week by week and day by day, with how each amount was worked out
// (myTips.week, core/tips.js): an estimate until a manager finalizes the week, then final. Never a coworker's
// amount. "How the pool works" lists the pool's rules in plain words.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Empty, Loading, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { useErrorText, useRpc } from '@/lib/hooks';
import { fmtCents } from '@/lib/money';
import { useApp } from '@/lib/session';
import { addDays, weekStart } from '@/lib/time';
import type { MyTipsWeek } from '@/lib/types';

const SOURCE: Record<string, MsgKey> = { toast: 'tips.fromToast', mixed: 'tips.fromToastAndSchedule', schedule: 'tips.fromSchedule' };

export default function Tips() {
  const params = useLocalSearchParams<{ week?: string }>();
  const { t, date, stamp } = useI18n();
  const c = useColors();
  const errorText = useErrorText();
  const { today, settings } = useApp();
  const [ws, setWs] = useState(() => weekStart(params.week || today, settings.weekStartDow));
  useEffect(() => { if (params.week) setWs(weekStart(params.week, settings.weekStartDow)); }, [params.week]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: d, error, reload } = useRpc<MyTipsWeek>('myTips.week', { weekStart: ws }, [ws]);
  const [rules, setRules] = useState(false);
  const current = weekStart(today, settings.weekStartDow);
  const fresh = d && d.weekStart === ws;

  return (
    <Screen title={t('tips.title')} back bottomInset onRefresh={reload}>
      <Row>
        <Pressable onPress={() => setWs(addDays(ws, -7))} style={styles.arrow} accessibilityRole="button" accessibilityLabel={t('schedule.prevWeek')}><Icon name="left" color={c.text} /></Pressable>
        <Txt v="h3" style={{ flex: 1, textAlign: 'center' }}>{date(ws, 'dayMonth')} – {date(addDays(ws, 6), 'dayMonth')}</Txt>
        <Pressable onPress={() => setWs(addDays(ws, 7))} disabled={ws >= current} style={[styles.arrow, ws >= current && { opacity: 0.3 }]} accessibilityRole="button" accessibilityLabel={t('schedule.nextWeek')}>
          <Icon name="right" color={c.text} />
        </Pressable>
      </Row>
      {!fresh && !error ? <Loading /> : null}
      {error && !fresh ? <Empty icon="alert" title={errorText(error)}><Button title={t('common.retry')} onPress={reload} /></Empty> : null}
      {fresh && !d.pools.length ? <Card><Empty icon="dollar" title={t('tips.noPool')} body={t('tips.noPoolBody')} /></Card> : null}
      {fresh && d.pools.length ? (
        <>
          <View style={[styles.hero, { backgroundColor: c.brand }]} accessible accessibilityLabel={`${t('tips.yourTips', { label: d.label })}: ${fmtCents(d.total)}, ${d.final ? t('tips.final') : t('tips.estimateBadge')}`}>
            <Txt v="small" tone="onBrand" bold style={{ opacity: 0.85 }}>{t('tips.yourTips', { label: d.label })}</Txt>
            <Text style={[styles.big, { color: c.onBrand }]}>{fmtCents(d.total)}</Text>
            <View style={[styles.pill, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
              {d.final ? <Icon name="check" size={14} color={c.onBrand} /> : null}
              <Txt v="small" tone="onBrand" bold>{d.final ? (d.finalAt ? t('tips.finalOn', { date: stamp(d.finalAt) }) : t('tips.final')) : t('tips.estimate')}</Txt>
            </View>
          </View>
          {d.waiting.map((name) => <Notice key={name} tone="brand" icon="clock" text={t('tips.waiting', { name })} />)}
          {!d.items.length && !d.waiting.length ? <Card><Empty icon="dollar" title={t('tips.none')} body={t('tips.noneBody')} /></Card> : null}
          {d.items.map((it) => (
            <Card key={`${it.poolId}-${it.start}`} style={{ gap: 8 }}>
              <Row style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt bold>{it.label}</Txt>
                  <Txt v="small" tone="muted">{[it.poolName, it.period === 'week' ? t('tips.wholeWeek') : '', t('tips.pool', { amount: fmtCents(it.poolTotal) })].filter(Boolean).join(' · ')}</Txt>
                </View>
                <Txt v="h2">{fmtCents(it.me.amount)}</Txt>
              </Row>
              <View style={[styles.formula, { backgroundColor: c.surface2 }]} accessible accessibilityLabel={`${t('tips.howWorkedOut')}: ${it.lines.join('. ')}`}>
                <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('tips.howWorkedOut')}</Txt>
                {it.lines.map((l) => <Txt key={l} v="small">{l}</Txt>)}
              </View>
              <Row style={{ flexWrap: 'wrap' }}>
                {!d.final ? <Badge tone="warn" text={t('tips.estimateBadge')} /> : <Badge tone="ok" text={t('tips.final')} />}
                {SOURCE[it.me.source] ? <Txt v="tiny" tone="faint">{it.me.source === 'schedule' && it.me.estimated ? t('tips.fromScheduleEstimated') : t(SOURCE[it.me.source])}</Txt> : null}
              </Row>
            </Card>
          ))}
          <Card pad={false} style={{ overflow: 'hidden' }}>
            <Pressable onPress={() => setRules(!rules)} accessibilityRole="button" accessibilityState={{ expanded: rules }} style={({ pressed }) => [styles.rulesHead, pressed && { backgroundColor: c.surface2 }]}>
              <Txt bold style={{ flex: 1 }}>{t('tips.howItWorks')}</Txt>
              <Icon name={rules ? 'up' : 'down'} size={18} color={c.text3} />
            </Pressable>
            {rules ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
                {d.pools.map((p) => (
                  <View key={p.id} style={{ gap: 4 }}>
                    {d.pools.length > 1 ? <Txt bold>{p.name}</Txt> : null}
                    {p.rules.map((r) => <Row key={r} style={{ alignItems: 'flex-start' }}><Txt v="small">•</Txt><Txt v="small" style={{ flex: 1 }}>{r}</Txt></Row>)}
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hero: { borderRadius: 18, padding: 18, gap: 6 },
  big: { fontSize: 40, fontWeight: '800', letterSpacing: -0.5 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  formula: { borderRadius: 10, padding: 10, gap: 4 },
  rulesHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 52 },
});
