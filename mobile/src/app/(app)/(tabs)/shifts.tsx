// My Shifts: the next shift (with its room and tables), requests waiting for shift leads and managers, the
// manager on duty, the 86 List, my tips this week, open shifts I can pick up, my shifts week by week, my time off.
// The last data seen is kept on the phone: with no signal it still shows, saying when it's from.
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { EightySixBanner } from '@/components/EightySixBanner';
import { Icon } from '@/components/Icon';
import { ModCard } from '@/components/ModCard';
import { Screen } from '@/components/Screen';
import { sectionLine, useShiftSection } from '@/components/ShiftSection';
import { ShiftRow, useShiftTime, useShiftWhat } from '@/components/ShiftRow';
import { Badge, Button, Card, Empty, Loading, OfflineNote, Row, SectionTitle, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useRpc } from '@/lib/hooks';
import { fmtCents } from '@/lib/money';
import { byStart, canTrade, qualified } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { addDays, weekStart } from '@/lib/time';
import type { MyTipsWeek, Shift, ShiftsList, TimeOff } from '@/lib/types';

const openShift = (s: Shift) => router.push({ pathname: '/shift/[id]', params: { id: s.id, date: s.date } });

export default function MyShifts() {
  const { t, tn, date, stamp } = useI18n();
  const c = useColors();
  const { me, boot, today, settings, people, has, canApprove, isLead } = useApp();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  const thisWeek = weekStart(today, settings.weekStartDow);
  const start = thisWeek < addDays(today, -1) ? thisWeek : addDays(today, -1);
  const list = useRpc<ShiftsList>('shifts.list', { start, end: addDays(today, 35) }, [], true, { cache: 'myShifts' });
  const timeOff = useRpc<TimeOff[]>('timeOff.list', {}, [], true, { cache: 'myTimeOff' });
  const tips = useRpc<MyTipsWeek>('myTips.week', { weekStart: thisWeek }, [], has('tips'));

  const data = list.data;
  const mine = (data?.shifts || []).filter((s) => s.userId === me.id && s.date >= thisWeek).sort(byStart);
  const upcoming = mine.filter((s) => s.date >= today && s.published);
  const next = upcoming[0];
  const section = useShiftSection(next);
  const meFull = people[me.id] || me;
  const open = (data?.shifts || []).filter((s) => !s.userId && s.published && s.date >= today && qualified(meFull, s.jobCodeId)).sort(byStart);
  const myOff = (timeOff.data || []).filter((x) => x.userId === me.id && x.endDate >= today && ['pending', 'approved'].includes(x.status));
  const weeks = new Map<string, Shift[]>();
  for (const s of mine) {
    const w = weekStart(s.date, settings.weekStartDow);
    weeks.set(w, [...(weeks.get(w) || []), s]);
  }
  const weekLabel = (w: string) => (w === thisWeek ? t('myShifts.thisWeek') : w === addDays(thisWeek, 7) ? t('myShifts.nextWeek') : t('myShifts.weekOf', { date: date(w, 'dayMonth') }));
  const approvals = canApprove ? boot.pendingApprovals : 0;
  const myTips = tips.data && tips.data.pools.length && (tips.data.total || tips.data.items.length) ? tips.data : null;

  return (
    <Screen title={t('myShifts.title')} onRefresh={() => Promise.all([list.reload(), timeOff.reload(), tips.reload()])}>
      {list.offline && list.updatedAt ? <OfflineNote text={t('common.offline', { when: stamp(list.updatedAt) })} /> : null}
      {!data && !list.error ? <Loading label={t('common.loading')} /> : null}
      {list.error && !data ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={list.reload} /></Empty> : null}

      {next ? (
        <View style={{ backgroundColor: c.brand, borderRadius: 18, padding: 18, gap: 6 }} accessible
          accessibilityLabel={[next.date === today ? t('myShifts.today') : t('myShifts.next'), date(next.date, 'long'), shiftTime(next), what(next), section ? sectionLine(section, t, tn, true) : ''].filter(Boolean).join(', ')}>
          <Txt v="small" tone="onBrand" bold style={{ opacity: 0.85 }}>{next.date === today ? t('myShifts.today') : t('myShifts.next')}</Txt>
          <Txt v="h2" tone="onBrand">{date(next.date, 'long')}</Txt>
          <Txt v="title" tone="onBrand">{shiftTime(next)}</Txt>
          <Txt tone="onBrand" style={{ opacity: 0.9 }}>{what(next)}</Txt>
          {section ? (
            <Row style={{ alignItems: 'flex-start' }}>
              <Icon name="pin" size={16} color={c.onBrand} />
              <Txt v="small" tone="onBrand" bold style={{ flex: 1 }}>{sectionLine(section, t, tn, true)}</Txt>
            </Row>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <Button small icon="right" title={t('common.open')} onPress={() => openShift(next)}
              style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'transparent' }} label={`${t('common.open')}: ${date(next.date, 'long')}`} />
            {canTrade(next, me.id, today) ? (
              <Button small icon="swap" title={t('myShifts.tradeOrGive')} onPress={() => openShift(next)}
                style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'transparent' }} />
            ) : null}
          </View>
        </View>
      ) : null}

      {approvals ? (
        <Pressable onPress={() => router.push(isLead ? '/floor' : '/swaps')} accessibilityRole="button"
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, minHeight: 52, borderRadius: 14, borderWidth: 1, borderColor: c.warn, backgroundColor: pressed ? c.surface2 : c.warnSoft })}>
          <Icon name="check" size={18} color={c.warn} />
          <Txt bold style={{ flex: 1, color: c.warn }}>{tn('myShifts.approvals', approvals)}</Txt>
          <Icon name="right" size={18} color={c.text3} />
        </Pressable>
      ) : null}

      {has('eightySix') ? <EightySixBanner /> : null}
      {has('training') ? <ModCard compact /> : null}

      {myTips ? (
        <Pressable onPress={() => router.push('/tips')} accessibilityRole="button"
          accessibilityLabel={`${t('myShifts.tipsThisWeek')}: ${fmtCents(myTips.total)}${myTips.final ? '' : `, ${t('myShifts.tipsEstimate')}`}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, minHeight: 52, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface })}>
          <Icon name="dollar" size={18} color={c.ok} />
          <Txt style={{ flex: 1 }} bold>{t('myShifts.tipsThisWeek')}</Txt>
          <Txt v="h3">{fmtCents(myTips.total)}</Txt>
          {!myTips.final ? <Badge tone="warn" text={t('myShifts.tipsEstimate')} /> : null}
          <Icon name="right" size={16} color={c.text3} />
        </Pressable>
      ) : null}

      <Row style={{ flexWrap: 'wrap' }}>
        <Button icon="sun" title={t('myShifts.requestOff')} onPress={() => router.push('/request-time-off')} style={{ flexGrow: 1 }} />
        <Button icon="swap" title={t('myShifts.tradeShift')} onPress={() => router.push('/swaps')} style={{ flexGrow: 1 }} />
        <Button icon="clock" title={t('myShifts.availability')} onPress={() => router.push('/availability')} style={{ flexGrow: 1 }} />
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
