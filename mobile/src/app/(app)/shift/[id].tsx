// One shift: details, its server section on the room's floor plan, who's working with you, the event's BEO,
// and what you can do with it: trade it with a coworker, give it away, call out (the manager on duty and the
// call-out procedure), or ask to pick it up if it's open. Same rules as the website
// (web/src/pages/ShiftDialog.jsx); the server checks everything again.
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CallOutPanel } from '@/components/CallOutPanel';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { ShiftSectionCard } from '@/components/ShiftSection';
import { useShiftTime, useShiftWhat } from '@/components/ShiftRow';
import { Badge, Button, Card, Empty, Field, JobDot, Loading, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useAction, useRpc } from '@/lib/hooks';
import { byStart, qualified } from '@/lib/schedule';
import { useApp } from '@/lib/session';
import { addDays } from '@/lib/time';
import type { Shift, ShiftsList } from '@/lib/types';

type Mode = null | 'drop' | 'swap';

export default function ShiftScreen() {
  const { id, date: day, mode: startMode } = useLocalSearchParams<{ id: string; date: string; mode?: string }>();
  const { t, date } = useI18n();
  const c = useColors();
  const { me, today, settings, jobs, people, client, has } = useApp();
  const shiftTime = useShiftTime();
  const what = useShiftWhat();
  const [run, busy] = useAction();
  const [mode, setMode] = useState<Mode>(startMode === 'drop' || startMode === 'swap' ? startMode : null);
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<Shift | null>(null);
  const [filter, setFilter] = useState('');
  const [sent, setSent] = useState<null | 'swap' | 'drop' | 'pickup'>(null);

  // From a notification there may be no date: look a few weeks around today.
  const span = day ? { start: day, end: day } : { start: addDays(today, -14), end: addDays(today, 60) };
  const dayList = useRpc<ShiftsList>('shifts.list', span, [day]);
  const ahead = useRpc<ShiftsList>('shifts.list', { start: today, end: addDays(today, 21) }, [], mode === 'swap');
  const shift = dayList.data?.shifts.find((s) => s.id === id);
  const job = shift ? jobs[shift.jobCodeId] : undefined;
  const meFull = people[me.id] || me;
  const approval = settings.requireSwapApproval !== false;
  const pickupApproval = settings.requirePickupApproval !== false;

  const coworkers = useMemo(() => (shift ? (dayList.data?.shifts || []).filter((s) => s.id !== shift.id && s.date === shift.date && s.published && s.userId && s.userId !== shift.userId
    && (s.jobCodeId === shift.jobCodeId || (shift.eventId && s.eventId === shift.eventId))).sort(byStart) : []), [dayList.data, shift]);
  const candidates = useMemo(() => {
    if (!shift || mode !== 'swap' || !ahead.data) return null;
    return ahead.data.shifts.filter((s) => s.userId && s.userId !== me.id && s.published && s.date >= today && !s.pending
      && qualified(meFull, s.jobCodeId) && qualified(people[s.userId], shift.jobCodeId)).sort(byStart);
  }, [ahead.data, mode, shift, me.id, meFull, people, today]);

  if (!shift) {
    return (
      <Screen title={t('shift.title')} back bottomInset>
        {dayList.data ? <Empty icon="calendar" title={t('shift.notFound')} /> : dayList.error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={dayList.reload} /></Empty> : <Loading />}
      </Screen>
    );
  }

  const mine = shift.userId === me.id;
  const isOpen = !shift.userId;
  const future = shift.date >= today;
  const submit = async (type: 'swap' | 'drop' | 'pickup') => {
    const r = await run(() => client.call('swaps.create', { shiftId: shift.id, type, targetShiftId: target?.id, note }));
    if (r) setSent(type);
  };

  if (sent) {
    const who = target?.userId ? people[target.userId]?.name || '' : '';
    const steps = (sent === 'swap'
      ? [t('shift.stepTradeAccept', { name: who }), approval && t('shift.stepManager'), t('shift.stepUpdate')]
      : sent === 'drop'
        ? [t('shift.stepNotified', { job: job?.name || '' }), t('shift.stepSomeone'), approval && t('shift.stepManager'), t('shift.stepUpdate')]
        : [pickupApproval ? t('shift.stepPickupApprove') : t('shift.stepYours'), t('shift.stepUpdate')]).filter(Boolean) as string[];
    return (
      <Screen title={sent === 'swap' ? t('shift.sentTrade') : sent === 'drop' ? t('shift.sentGive') : t('shift.sentPickup')} back bottomInset>
        <Notice tone="ok" icon="check" text={sent === 'pickup' ? t('shift.sentRequested') : t('shift.sentStill', { date: date(shift.date), state: approval ? t('shift.stateApproved') : t('shift.stateTaken') })} />
        <Card style={{ gap: 10 }}>
          <Txt v="h3">{t('shift.nextSteps')}</Txt>
          {steps.map((s, i) => (
            <Row key={s} style={{ alignItems: 'flex-start' }}>
              <View style={[styles.step, { backgroundColor: c.brandSoft }]}><Txt v="small" tone="brand" bold>{i + 1}</Txt></View>
              <Txt style={{ flex: 1 }}>{s}</Txt>
            </Row>
          ))}
        </Card>
        <Button kind="primary" title={t('common.done')} onPress={() => router.back()} />
        <Button kind="ghost" title={t('shift.seeRequests')} onPress={() => router.replace('/swaps')} />
      </Screen>
    );
  }

  const header = (
    <Card style={{ gap: 6 }}>
      <Row>
        <JobDot color={job?.color} />
        <Txt v="small" tone="muted" bold style={{ flex: 1 }}>{what(shift)}</Txt>
        {!shift.published ? <Badge text={t('common.draft')} /> : null}
      </Row>
      <Txt v="title">{date(shift.date, 'long')}</Txt>
      <Txt v="h2">{shiftTime(shift)}</Txt>
      <Txt tone="muted">{isOpen ? t('shift.openShift') : people[shift.userId!]?.name}</Txt>
      {shift.notes ? <Txt v="small" tone="muted">{t('common.notesLabel')}: {shift.notes}</Txt> : null}
    </Card>
  );

  if (mode === 'drop') {
    return (
      <Screen title={t('shift.giveTitle')} back bottomInset>
        {header}
        <Notice tone="brand" icon="hand" text={t('shift.giveInfo', { job: job?.name || '', approval: approval ? t('shift.giveApprovalSuffix') : '' })} />
        <Field label={t('shift.noteToCoworkers')} value={note} onChangeText={setNote} placeholder={t('shift.notePlaceholder')} multiline maxLength={300} />
        <Button kind="primary" icon="send" title={t('shift.postIt')} busy={busy} onPress={() => submit('drop')} />
        <Button kind="ghost" title={t('common.back')} onPress={() => setMode(null)} />
      </Screen>
    );
  }

  if (mode === 'swap') {
    const shown = (candidates || []).filter((s) => !filter || (people[s.userId!]?.name || '').toLowerCase().includes(filter.toLowerCase()));
    return (
      <Screen title={t('shift.tradeTitle')} back bottomInset>
        {header}
        <Txt tone="muted">{t('shift.tradeLead')}</Txt>
        {!candidates ? <Loading /> : null}
        {candidates && !candidates.length ? (
          <Notice tone="warn" text={t('shift.noCandidates')}>
            <Button small kind="primary" icon="hand" title={t('shift.giveInstead')} onPress={() => setMode('drop')} />
          </Notice>
        ) : null}
        {(candidates?.length || 0) > 6 ? <Field label={t('shift.findCoworker')} value={filter} onChangeText={setFilter} placeholder={t('shift.findCoworker')} /> : null}
        {shown.length ? (
          <Card pad={false} style={{ overflow: 'hidden' }}>
            {shown.map((s, i) => {
              const on = target?.id === s.id;
              return (
                <View key={s.id}>
                  {s.date !== shown[i - 1]?.date ? <View style={[styles.dayHead, { backgroundColor: c.surface2 }]}><Txt v="small" tone="muted" bold>{date(s.date)}</Txt></View> : null}
                  <Pressable onPress={() => setTarget(s)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                    style={[styles.pick, { borderColor: c.border, backgroundColor: on ? c.brandSoft : 'transparent' }]}>
                    <View style={[styles.radio, { borderColor: on ? c.brand : c.text3 }]}>{on ? <View style={[styles.radioDot, { backgroundColor: c.brand }]} /> : null}</View>
                    <View style={{ flex: 1 }}>
                      <Txt style={{ fontWeight: '700' }}>{people[s.userId!]?.name}</Txt>
                      <Txt v="small" tone="muted">{shiftTime(s)} · {what(s)}</Txt>
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </Card>
        ) : null}
        {target ? <Notice tone="brand" icon="swap" text={t('shift.youWouldWork', { mine: `${date(target.date)} · ${shiftTime(target)}`, name: people[target.userId!]?.name || '', theirs: `${date(shift.date)} · ${shiftTime(shift)}` })} /> : null}
        {candidates?.length ? <Field label={t('shift.note')} value={note} onChangeText={setNote} placeholder={t('shift.tradeNotePlaceholder')} maxLength={300} /> : null}
        {candidates?.length ? (
          <Button kind="primary" icon="swap" disabled={!target} busy={busy} onPress={() => submit('swap')}
            title={target ? t('shift.sendTrade', { name: (people[target.userId!]?.name || '').split(' ')[0] }) : t('shift.pickFirst')} />
        ) : null}
        <Button kind="ghost" title={t('common.back')} onPress={() => { setMode(null); setTarget(null); }} />
      </Screen>
    );
  }

  return (
    <Screen title={job?.name || t('shift.title')} back bottomInset onRefresh={dayList.reload}>
      {header}
      {shift.pending ? <Notice tone="warn" icon="clock" text={t('shift.pendingNote')} /> : null}
      {!shift.end && !settings.startTimesOnly ? <Txt v="small" tone="faint">{t('shift.untilCloseNote')}</Txt> : null}
      {shift.eventId && has('events') ? (
        <Button icon="glass" title={t('shift.seeEvent')} onPress={() => router.push({ pathname: '/events/[id]', params: { id: shift.eventId! } })} />
      ) : null}
      {has('venue') && shift.published ? <ShiftSectionCard shift={shift} mine={mine} /> : null}
      {coworkers.length ? (
        <Card style={{ gap: 8 }}>
          <Txt v="small" tone="muted" bold>{t('shift.workingWith')}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {coworkers.map((s) => <Badge key={s.id} text={`${people[s.userId!]?.name || ''} · ${shiftTime(s).split('–')[0]}`} />)}
          </View>
        </Card>
      ) : null}

      {future && mine && !shift.pending && !shift.published ? <Notice tone="brand" icon="clock" text={t('shift.draftNote')} /> : null}
      {future && mine && !shift.pending && shift.published ? (
        <View style={{ gap: 10 }}>
          <Txt v="h3">{t('shift.cantMake')}</Txt>
          <Choice icon="swap" title={t('shift.trade')} body={t('shift.tradeHelp', { approval: approval ? t('shift.approvalSuffix') : '' })} onPress={() => setMode('swap')} />
          <Choice icon="hand" title={t('shift.give')} body={t('shift.giveHelp', { job: job?.name || '', approval: approval ? t('shift.approvalSuffix') : '' })} onPress={() => setMode('drop')} />
          <Txt v="small" tone="faint">{t('shift.keepIt')}{settings.minSwapNoticeHours ? ` ${t('shift.notice', { hours: settings.minSwapNoticeHours })}` : ''}</Txt>
        </View>
      ) : null}
      {future && mine && shift.published && has('training') ? <CallOutPanel /> : null}
      {future && isOpen && shift.published && qualified(meFull, shift.jobCodeId) ? <Button kind="primary" icon="plus" title={t('shift.pickUp')} busy={busy} onPress={() => submit('pickup')} /> : null}
      {future && isOpen && !qualified(meFull, shift.jobCodeId) ? <Txt v="small" tone="muted">{t('shift.notTrained', { job: job?.name || '' })}</Txt> : null}
    </Screen>
  );
}

function Choice({ icon, title, body, onPress }: { icon: 'swap' | 'hand'; title: string; body: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => [styles.choice, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface }]}>
      <View style={[styles.choiceIcon, { backgroundColor: c.brandSoft }]}><Icon name={icon} size={22} color={c.brand} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt style={{ fontWeight: '700' }}>{title}</Txt>
        <Txt v="small" tone="muted">{body}</Txt>
      </View>
      <Icon name="right" size={18} color={c.text3} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  step: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dayHead: { paddingHorizontal: 14, paddingVertical: 6 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, minHeight: 64 },
  choiceIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
