// My Shifts: the next shift, open shifts I can pick up, my shifts week by week, my time off.
import { router } from 'expo-router';
import { View } from 'react-native';

import { Screen } from '@/components/Screen';
import { EightySixBanner } from '@/components/EightySixBanner';
import { ShiftRow, useShiftTime, useShiftWhat } from '@/components/ShiftRow';
import { Badge, Button, Card, Empty, Loading, Row, SectionTitle, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { byStart, canTrade, qualified } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { addDays, weekStart } from '@/lib/time';
import type { Shift, ShiftsList, TimeOff } from '@/lib/types';

const openShift = (s: Shift) => router.push({ pathname: '/shift/[id]', params: { id: s.id, date: s.date } });

export default function MyShifts() {
  const { t, tn, date } = useI18n();
  const c = useColors();
  const { me, today, settings, people } = useApp();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  const thisWeek = weekStart(today, settings.weekStartDow);
  const start = thisWeek < addDays(today, -1) ? thisWeek : addDays(today, -1);
  const list = useRpc<ShiftsList>('shifts.list', { start, end: addDays(today, 35) });
  const timeOff = useRpc<TimeOff[]>('timeOff.list');

  const data = list.data;
  const mine = (data?.shifts || []).filter((s) => s.userId === me.id && s.date >= thisWeek).sort(byStart);
  const upcoming = mine.filter((s) => s.date >= today);
  const next = upcoming[0];
  const meFull = people[me.id] || me;
  const open = (data?.shifts || []).filter((s) => !s.userId && s.published && s.date >= today && qualified(meFull, s.jobCodeId)).sort(byStart);
  const myOff = (timeOff.data || []).filter((x) => x.userId === me.id && x.endDate >= today && ['pending', 'approved'].includes(x.status));
  const weeks = new Map<string, Shift[]>();
  for (const s of mine) {
    const w = weekStart(s.date, settings.weekStartDow);
    weeks.set(w, [...(weeks.get(w) || []), s]);
  }
  const weekLabel = (w: string) => (w === thisWeek ? t('myShifts.thisWeek') : w === addDays(thisWeek, 7) ? t('myShifts.nextWeek') : t('myShifts.weekOf', { date: date(w, 'dayMonth') }));

  return (
    <Screen title={t('myShifts.title')} onRefresh={() => Promise.all([list.reload(), timeOff.reload()])}>
      {!data && !list.error ? <Loading label={t('common.loading')} /> : null}
      {list.error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={list.reload} /></Empty> : null}

      {next ? (
        <View style={{ backgroundColor: c.brand, borderRadius: 18, padding: 18, gap: 6 }} accessible accessibilityLabel={`${next.date === today ? t('myShifts.today') : t('myShifts.next')}: ${date(next.date, 'long')}, ${shiftTime(next)}, ${what(next)}`}>
          <Txt v="small" tone="onBrand" bold style={{ opacity: 0.85 }}>{next.date === today ? t('myShifts.today') : t('myShifts.next')}</Txt>
          <Txt v="h2" tone="onBrand">{date(next.date, 'long')}</Txt>
          <Txt v="title" tone="onBrand">{shiftTime(next)}</Txt>
          <Txt tone="onBrand" style={{ opacity: 0.9 }}>{what(next)}</Txt>
          {canTrade(next, me.id, today) ? (
            <View style={{ flexDirection: 'row', marginTop: 8 }}>
              <Button small icon="swap" title={t('myShifts.tradeOrGive')} onPress={() => openShift(next)}
                style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'transparent' }} />
            </View>
          ) : null}
        </View>
      ) : null}

      <EightySixBanner />

      <Row style={{ flexWrap: 'wrap' }}>
        <Button icon="sun" title={t('myShifts.requestOff')} onPress={() => router.push('/request-time-off')} style={{ flexGrow: 1 }} />
        <Button icon="swap" title={t('myShifts.tradeShift')} onPress={() => router.push('/swaps')} style={{ flexGrow: 1 }} />
      </Row>

      {open.length > 0 ? (
        <>
          <SectionTitle title={t('myShifts.openShifts')} right={<Badge tone="ok" text={String(open.length)} />} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {open.slice(0, 5).map((s) => <ShiftRow key={s.id} s={s} onPress={() => openShift(s)} right={<Badge tone="ok" text={t('myShifts.pickUp')} />} />)}
          </Card>
        </>
      ) : null}

      {data ? <SectionTitle title={t('myShifts.mine')} /> : null}
      {data && !mine.length ? <Card><Empty title={t('myShifts.empty')} body={t('myShifts.emptyBody')} /></Card> : null}
      {[...weeks.entries()].map(([w, shifts]) => {
        const hours = shifts.reduce((sum, s) => sum + (s.hours || 0), 0);
        return (
          <View key={w} style={{ gap: 6 }}>
            <Row style={{ paddingHorizontal: 4, flexWrap: 'wrap' }}>
              <Txt v="small" tone="muted" bold style={{ flex: 1 }}>{weekLabel(w)}</Txt>
              <Txt v="small" tone="muted">{t('myShifts.weekTotal', { shifts: tn('common.shifts', shifts.length), hours: tn('common.hours', Math.round(hours * 10) / 10) })}</Txt>
            </Row>
            <Card pad={false} style={{ overflow: 'hidden' }}>
              {shifts.map((s) => (
                <ShiftRow key={s.id} s={s} past={s.date < today} onPress={() => openShift(s)}
                  right={s.pending ? <Badge tone="warn" text={t('myShifts.pending')} />
                    : !s.published ? <Badge text={t('common.draft')} />
                      : s.date < today ? <Txt v="small" tone="faint">{t('myShifts.done')}</Txt>
                        : canTrade(s, me.id, today) ? <Badge tone="brand" text={t('myShifts.trade')} /> : null} />
              ))}
            </Card>
          </View>
        );
      })}

      {myOff.length > 0 ? (
        <>
          <SectionTitle title={t('myShifts.timeOffTitle')} right={<Button kind="ghost" small title={t('myShifts.seeAll')} onPress={() => router.push('/time-off')} />} />
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {myOff.map((x) => (
              <Row key={x.id} style={{ padding: 14, borderBottomWidth: 0.5, borderColor: c.border }}>
                <Txt style={{ flex: 1 }}>{x.endDate !== x.startDate ? t('timeOff.summary', { start: date(x.startDate), end: date(x.endDate) }) : date(x.startDate)}</Txt>
                <Badge tone={x.status === 'approved' ? 'ok' : 'warn'} text={t(x.status === 'approved' ? 'timeOff.approved' : 'timeOff.pending')} />
              </Row>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
