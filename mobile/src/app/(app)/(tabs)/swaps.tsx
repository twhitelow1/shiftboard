// Trades: start a trade or giveaway, shifts up for grabs (accept / pick up), open shifts,
// my requests, and for shift leads and managers, requests to approve.
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { ShiftRow, useShiftTime, useShiftWhat } from '@/components/ShiftRow';
import { Badge, Button, Card, Empty, Field, Loading, Notice, Row, SectionTitle, Tabs, Txt, useColors, type Tone } from '@/components/ui';
import { useI18n, type MsgKey } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { byStart, qualified } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { addDays } from '@/lib/time';
import type { RequestStatus, Shift, ShiftsList, SwapRequest, SwapsList } from '@/lib/types';

type Tab = 'approvals' | 'offers' | 'mine';
const STATUS: Record<RequestStatus, [MsgKey, Tone]> = {
  open: ['swaps.statusOpen', 'warn'], pending_approval: ['swaps.statusPending', 'brand'], approved: ['swaps.statusApproved', 'ok'],
  denied: ['swaps.statusDenied', 'bad'], declined: ['swaps.statusDeclined', 'bad'], cancelled: ['swaps.statusCancelled', 'neutral'],
};
const TYPE: Record<SwapRequest['type'], MsgKey> = { swap: 'swaps.typeSwap', drop: 'swaps.typeDrop', pickup: 'swaps.typePickup' };
const openShift = (s: Shift, mode?: 'swap' | 'drop') => router.push({ pathname: '/shift/[id]', params: { id: s.id, date: s.date, ...(mode ? { mode } : {}) } });

export default function Swaps() {
  const { t } = useI18n();
  const { me, today, canApprove, people } = useApp();
  const swaps = useRpc<SwapsList>('swaps.list');
  const ahead = useRpc<ShiftsList>('shifts.list', { start: today, end: addDays(today, 28) });
  const [tab, setTab] = useState<Tab | null>(null);
  const meFull = people[me.id] || me;

  const mineUpcoming = (ahead.data?.shifts || []).filter((s) => s.userId === me.id && s.published && s.date >= today).sort(byStart);
  const open = (ahead.data?.shifts || []).filter((s) => !s.userId && s.published && s.date >= today && qualified(meFull, s.jobCodeId)).sort(byStart);
  const d = swaps.data;
  const tabs: { value: Tab; label: string; count?: number }[] = [
    ...(canApprove ? [{ value: 'approvals' as Tab, label: t('swaps.approvals'), count: d?.approvals.length }] : []),
    { value: 'offers', label: t('swaps.offers'), count: (d?.offers.length || 0) + open.length },
    { value: 'mine', label: t('swaps.mine'), count: d?.mine.filter((r) => ['open', 'pending_approval'].includes(r.status)).length },
  ];
  const cur = tab || (canApprove && d?.approvals.length ? 'approvals' : 'offers');
  const list = d ? { approvals: d.approvals, offers: d.offers, mine: d.mine }[cur] : [];

  return (
    <Screen title={t('swaps.title')} onRefresh={() => Promise.all([swaps.reload(), ahead.reload()])}>
      <StartTrade shifts={mineUpcoming} loading={!ahead.data} />
      <Tabs tabs={tabs} value={cur} onChange={setTab} />
      {!d && !swaps.error ? <Loading /> : null}
      {swaps.error && !d ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={swaps.reload} /></Empty> : null}
      {d && cur === 'offers' ? (
        <>
          <SectionTitle title={t('swaps.fromCoworkers')} />
          <Txt v="small" tone="muted">{t('swaps.offersHelp')}</Txt>
          {list.length ? list.map((r) => <RequestCard key={r.id} r={r} mode={cur} />) : <Card><Empty icon="swap" title={t('swaps.emptyOffers')} /></Card>}
          <SectionTitle title={t('swaps.openShifts')} right={open.length ? <Badge tone="ok" text={String(open.length)} /> : undefined} />
          {open.length ? (
            <Card pad={false} style={{ overflow: 'hidden' }}>
              {open.map((s) => <ShiftRow key={s.id} s={s} onPress={() => openShift(s)} right={<Badge tone="ok" text={t('myShifts.pickUp')} />} />)}
            </Card>
          ) : <Card><Empty icon="calendar" title={t('swaps.emptyOpen')} /></Card>}
        </>
      ) : d ? (
        list.length ? list.map((r) => <RequestCard key={r.id} r={r} mode={cur} />)
          : <Card><Empty icon="swap" title={t(cur === 'approvals' ? 'swaps.emptyApprovals' : 'swaps.emptyMine')} /></Card>
      ) : null}
    </Screen>
  );
}

/** The way in: my upcoming posted shifts, each with Trade and Give away. */
function StartTrade({ shifts, loading }: { shifts: Shift[]; loading: boolean }) {
  const { t, date } = useI18n();
  const c = useColors();
  const { settings } = useApp();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  const [all, setAll] = useState(false);
  const shown = all ? shifts : shifts.slice(0, 3);
  return (
    <Card style={{ gap: 10 }}>
      <Txt v="h3">{t('swaps.start')}</Txt>
      <Txt v="small" tone="muted">{settings.requireSwapApproval !== false ? t('swaps.stepsApproval') : t('swaps.steps')}</Txt>
      {loading ? <Loading /> : !shifts.length ? <Txt v="small" tone="faint">{t('swaps.noUpcoming')}</Txt> : null}
      {shown.map((s) => (
        <View key={s.id} style={[styles.tradeRow, { borderColor: c.border }]}>
          <View style={{ gap: 2 }}>
            <Txt style={{ fontWeight: '700' }}>{date(s.date)} · {shiftTime(s)}</Txt>
            <Txt v="small" tone="muted">{what(s)}</Txt>
          </View>
          {s.pending ? <Badge tone="warn" text={t('swaps.inProgress')} /> : (
            <Row style={{ flexWrap: 'wrap' }}>
              <Button small kind="primary" icon="swap" title={t('swaps.trade')} onPress={() => openShift(s, 'swap')} style={{ flexGrow: 1 }} />
              <Button small icon="hand" title={t('swaps.give')} onPress={() => openShift(s, 'drop')} style={{ flexGrow: 1 }} />
            </Row>
          )}
        </View>
      ))}
      {shifts.length > 3 ? <Button kind="ghost" small title={all ? t('swaps.showFewer') : t('swaps.showAll', { count: shifts.length })} onPress={() => setAll(!all)} /> : null}
    </Card>
  );
}

function MiniShift({ s, who }: { s: Shift | null; who: string }) {
  const { t, date } = useI18n();
  const c = useColors();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  const { jobs } = useApp();
  if (!s) return <View style={[styles.mini, { borderColor: c.border }]}><Txt v="small" tone="faint">{t('swaps.removed')}</Txt></View>;
  return (
    <View style={[styles.mini, { borderColor: c.border, borderLeftColor: jobs[s.jobCodeId]?.color || c.border }]}>
      <Txt v="small" bold lines={1}>{who}</Txt>
      <Txt v="small"><Txt v="small" bold>{date(s.date)}</Txt> · {shiftTime(s)}</Txt>
      <Txt v="tiny" tone="muted">{what(s)}</Txt>
    </View>
  );
}

function RequestCard({ r, mode }: { r: SwapRequest; mode: Tab }) {
  const { t, stamp } = useI18n();
  const c = useColors();
  const { me, people, client } = useApp();
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const [label, tone] = STATUS[r.status] || ['swaps.statusOpen', 'neutral'];
  const name = (id?: string | null) => (id ? people[id]?.name || '—' : t('schedule.openShift'));
  const receiver = r.type === 'swap' ? r.targetUserId : r.pickupUserId;
  const act = (method: string, ok: string) => run(() => client.call(method, { requestId: r.id, note }), ok);
  const warnings = mode === 'approvals' ? r.warnings || [] : mode === 'offers' ? (r.myConflicts || []).map((w) => t('swaps.you', { warning: w })) : [];

  return (
    <Card style={{ gap: 10 }}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Badge text={t(TYPE[r.type])} />
        <Badge tone={tone} text={t(label)} />
        <View style={{ flex: 1 }} />
        <Txt v="tiny" tone="faint">{stamp(r.createdAt)}</Txt>
      </Row>
      <View style={styles.flow}>
        <MiniShift s={r.shift} who={r.type === 'pickup' ? t('schedule.openShift') : name(r.requesterId)} />
        <Icon name={r.type === 'swap' ? 'swap' : 'right'} size={20} color={c.text3} />
        {r.type === 'swap' ? <MiniShift s={r.targetShift} who={name(r.targetUserId)} /> : (
          <View style={[styles.mini, { borderColor: c.border }]}>
            <Txt v="small" tone={receiver ? 'text' : 'muted'}>{receiver ? t(r.type === 'pickup' ? 'swaps.wantsIt' : 'swaps.takesIt', { name: name(receiver) }) : t('swaps.anyone')}</Txt>
          </View>
        )}
      </View>
      {r.note ? <Txt v="small">“{r.note}” <Txt v="small" tone="faint">{t('common.by', { name: name(r.requesterId) })}</Txt></Txt> : null}
      {r.resolution ? <Txt v="small" tone="muted">{t('swaps.resolution', { text: r.resolution })}</Txt> : null}
      {warnings.length ? <Notice tone="warn" text={warnings.join('\n')} /> : null}

      {mode === 'approvals' ? (
        <View style={{ gap: 8 }}>
          <Field label={t('shift.note')} value={note} onChangeText={setNote} maxLength={300} />
          <Row>
            <Button kind="danger" icon="x" title={t('swaps.deny')} busy={busy} onPress={() => act('swaps.deny', t('swaps.deniedToast'))} style={{ flex: 1 }} />
            <Button kind="ok" icon="check" title={t('swaps.approve')} busy={busy} onPress={() => act('swaps.approve', t('swaps.approvedToast'))} style={{ flex: 1 }} />
          </Row>
        </View>
      ) : null}
      {mode === 'offers' ? (
        <Row>
          {r.type === 'swap' ? <Button title={t('swaps.decline')} busy={busy} onPress={() => act('swaps.decline', t('swaps.declinedToast'))} style={{ flex: 1 }} /> : null}
          <Button kind="primary" icon="check" busy={busy} style={{ flex: 1 }}
            title={r.type === 'swap' ? t('swaps.accept') : t('swaps.pickUp')}
            onPress={() => act('swaps.accept', r.type === 'swap' ? t('swaps.accepted') : t('swaps.pickedUp'))} />
        </Row>
      ) : null}
      {mode === 'mine' && ['open', 'pending_approval'].includes(r.status) && r.requesterId === me.id ? (
        <Button kind="danger" title={t('swaps.cancelRequest')} busy={busy} onPress={() => act('swaps.cancel', t('swaps.cancelledToast'))} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  tradeRow: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  flow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mini: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4, borderRadius: 10, padding: 8, gap: 2, minHeight: 64, justifyContent: 'center' },
});
